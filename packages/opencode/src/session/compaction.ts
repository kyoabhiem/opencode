import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "."
import { SessionID, MessageID, PartID } from "./schema"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { Token } from "../util/token"
import { Log } from "../util/log"
import { SessionProcessor } from "./processor"
import { fn } from "@/util/fn"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { Database } from "@/storage/db"
import { ProviderTransform } from "@/provider/transform"
import { ModelID, ProviderID } from "@/provider/schema"

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  export const Event = {
    Compacted: BusEvent.define(
      "session.compacted",
      z.object({
        sessionID: SessionID.zod,
      }),
    ),
  }

  const COMPACTION_BUFFER = 20_000

  async function capacity(model: Provider.Model) {
    const config = await Config.get()
    if (config.compaction?.auto === false) return undefined
    const context = model.limit.context
    if (context === 0) return undefined
    const output = ProviderTransform.maxOutputTokens(model)
    const reserved = config.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, output)
    const gap = model.limit.input ? context - model.limit.input : 0
    return model.limit.input ? model.limit.input - reserved - Math.max(0, output - gap) : context - output
  }

  export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
    const usable = await capacity(input.model)
    if (usable === undefined) return false
    // When limit.input is set, only count input tokens against that limit
    // (output/thinking tokens don't consume the input window).
    const count = input.model.limit.input
      ? input.tokens.input + input.tokens.cache.read + input.tokens.cache.write
      : input.tokens.total ||
        input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
    return count >= usable
  }

  export function estimateMessages(messages: import("ai").ModelMessage[]): number {
    let total = 0
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        total += Token.estimate(msg.content)
        continue
      }
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if ("text" in part && typeof part.text === "string") total += Token.estimate(part.text)
          else if ("value" in part && typeof part.value === "string") total += Token.estimate(part.value)
          else if ("input" in part && part.input)
            total += Token.estimate(typeof part.input === "string" ? part.input : JSON.stringify(part.input))
          else if ("output" in part) {
            const out = part.output
            if (typeof out === "string") total += Token.estimate(out)
            else if (out && typeof out === "object" && "value" in out && typeof out.value === "string")
              total += Token.estimate(out.value)
          }
        }
      }
    }
    return total
  }

  export async function shouldCompact(input: {
    messages: import("ai").ModelMessage[]
    model: Provider.Model
    system?: number
  }) {
    const usable = await capacity(input.model)
    if (usable === undefined) return false
    return estimateMessages(input.messages) + (input.system ?? 0) >= usable
  }

  export const PRUNE_MINIMUM = 20_000
  export const PRUNE_PROTECT = 40_000

  const PRUNE_PROTECTED_TOOLS = ["skill"]

  // goes backwards through parts until there are 40_000 tokens worth of tool
  // calls. then erases output of previous tool calls. idea is to throw away old
  // tool calls that are no longer relevant.
  export async function prune(input: { sessionID: SessionID }) {
    const config = await Config.get()
    if (config.compaction?.prune === false) return
    log.info("pruning")
    const msgs = await Session.messages({ sessionID: input.sessionID })
    let total = 0
    let pruned = 0
    const toPrune: MessageV2.ToolPart[] = []
    let turns = 0

    loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
      const msg = msgs[msgIndex]
      if (msg.info.role === "user") turns++
      if (turns < 2) continue
      if (msg.info.role === "assistant" && msg.info.summary) break loop
      for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
        const part = msg.parts[partIndex]
        if (part.type === "tool")
          if (part.state.status === "completed") {
            if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue

            if (part.state.time.compacted) break loop
            const estimate = Token.estimate(part.state.output)
            total += estimate
            if (total > PRUNE_PROTECT) {
              pruned += estimate
              toPrune.push(part)
            }
          }
      }
    }
    log.info("found", { pruned, total })
    if (pruned > PRUNE_MINIMUM) {
      Database.transaction(() => {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            Session.updatePart.force(part)
          }
        }
      })
      log.info("pruned", { count: toPrune.length })
    }
  }

  export async function process(input: {
    parentID: MessageID
    messages: MessageV2.WithParts[]
    sessionID: SessionID
    abort: AbortSignal
    auto: boolean
    overflow?: boolean
  }) {
    const userMessage = input.messages.findLast((m) => m.info.id === input.parentID)!.info as MessageV2.User

    let messages = input.messages
    let replay: MessageV2.WithParts | undefined
    if (input.overflow) {
      const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
      for (let i = idx - 1; i >= 0; i--) {
        const msg = input.messages[i]
        if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
          replay = msg
          messages = input.messages.slice(0, i)
          break
        }
      }
      const hasContent =
        replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
      if (!hasContent) {
        replay = undefined
        messages = input.messages
      }
    }

    const agent = await Agent.get("compaction")
    const model = agent.model
      ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
      : await Provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
    const msg = (await Session.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: input.parentID,
      sessionID: input.sessionID,
      mode: "compaction",
      agent: "compaction",
      variant: userMessage.variant,
      summary: true,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.id,
      providerID: model.providerID,
      time: {
        created: Date.now(),
      },
    })) as MessageV2.Assistant
    const processor = SessionProcessor.create({
      assistantMessage: msg,
      sessionID: input.sessionID,
      model,
      abort: input.abort,
    })
    // Allow plugins to inject context or replace compaction prompt
    const compacting = await Plugin.trigger(
      "experimental.session.compacting",
      { sessionID: input.sessionID },
      { context: [], prompt: undefined },
    )
    const defaultPrompt = `Provide a detailed prompt for continuing our conversation above.
Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next.
The summary that you construct will be used so that another agent can read it and continue the work.

When constructing the summary, try to stick to this template:
---
## Goal

[What goal(s) is the user trying to accomplish?]

## Instructions

- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Discoveries

[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]

## Accomplished

[What work has been completed, what work is still in progress, and what work is left?]

## Relevant files / directories

[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]
---`

    const incrementalPrompt = `You are updating an existing conversation summary with new information.
Below is the previous summary followed by new messages since that summary was created.
Produce an updated summary that incorporates the new information while preserving important context from the original.

Use the same template as the original summary. Merge new accomplishments, discoveries, and file changes into the appropriate sections.
Remove information that is no longer relevant and add new details from the recent messages.`

    const msgs = structuredClone(messages)
    await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

    // Find previous summary for incremental compaction
    let prior: string | undefined
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.info.role === "assistant" && m.info.summary && m.info.finish && !m.info.error) {
        const text = m.parts
          .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
          .map((p) => p.text)
          .join("\n")
        if (text.trim()) {
          prior = text
          // Only send messages after the summary for incremental compaction
          const remaining = msgs.slice(i + 1)
          if (remaining.length > 0) msgs.splice(0, msgs.length, ...remaining)
          else prior = undefined // no new messages since last summary, skip incremental
        }
        break
      }
    }

    const base = prior
      ? [
          { role: "user" as const, content: [{ type: "text" as const, text: `Previous summary:\n\n${prior}` }] },
          ...MessageV2.toModelMessages(msgs, model, { stripMedia: true }),
        ]
      : MessageV2.toModelMessages(msgs, model, { stripMedia: true })

    const promptText =
      compacting.prompt ?? [prior ? incrementalPrompt : defaultPrompt, ...compacting.context].join("\n\n")
    const result = await processor.process({
      user: userMessage,
      agent,
      abort: input.abort,
      sessionID: input.sessionID,
      tools: {},
      system: [],
      messages: [
        ...base,
        {
          role: "user",
          content: [
            {
              type: "text",
              text: promptText,
            },
          ],
        },
      ],
      model,
    })

    if (result === "compact") {
      processor.message.error = new MessageV2.ContextOverflowError({
        message: replay
          ? "Conversation history too large to compact - exceeds model context limit"
          : "Session too large to compact - context exceeds model limit even after stripping media",
      }).toObject()
      processor.message.finish = "error"
      await Session.updateMessage(processor.message)
      return "stop"
    }

    if (result === "continue" && input.auto) {
      if (replay) {
        const original = replay.info as MessageV2.User
        const replayMsg = await Session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: input.sessionID,
          time: { created: Date.now() },
          agent: original.agent,
          model: original.model,
          format: original.format,
          tools: original.tools,
          system: original.system,
          variant: original.variant,
        })
        for (const part of replay.parts) {
          if (part.type === "compaction") continue
          const replayPart =
            part.type === "file" && MessageV2.isMedia(part.mime)
              ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
              : part
          await Session.updatePart({
            ...replayPart,
            id: PartID.ascending(),
            messageID: replayMsg.id,
            sessionID: input.sessionID,
          })
        }
      } else {
        const continueMsg = await Session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: input.sessionID,
          time: { created: Date.now() },
          agent: userMessage.agent,
          model: userMessage.model,
        })
        const text =
          (input.overflow
            ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
            : "") +
          "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
        await Session.updatePart({
          id: PartID.ascending(),
          messageID: continueMsg.id,
          sessionID: input.sessionID,
          type: "text",
          synthetic: true,
          text,
          time: {
            start: Date.now(),
            end: Date.now(),
          },
        })
      }
    }
    if (processor.message.error) return "stop"
    Bus.publish(Event.Compacted, { sessionID: input.sessionID })
    return "continue"
  }

  export const create = fn(
    z.object({
      sessionID: SessionID.zod,
      agent: z.string(),
      model: z.object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      }),
      auto: z.boolean(),
      overflow: z.boolean().optional(),
    }),
    async (input) => {
      const msg = await Session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: {
          created: Date.now(),
        },
      })
      await Session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
    },
  )
}
