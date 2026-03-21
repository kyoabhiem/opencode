import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { CopilotAuthPlugin } from "../../src/plugin/copilot"

function input() {
  return {
    client: {
      session: {
        get: async () => ({ data: {} }),
      },
    },
    project: {},
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("https://opencode.test"),
    $: {},
  } as unknown as PluginInput
}

function provider() {
  return {
    models: {
      "claude-sonnet-4.6": {
        id: "claude-sonnet-4.6",
        name: "Claude Sonnet 4.6",
        providerID: "github-copilot",
        api: {
          id: "claude-sonnet-4.6",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
        cost: {
          input: 0,
          output: 0,
          cache: {
            read: 0,
            write: 0,
          },
        },
        limit: {
          context: 128_000,
          output: 32_000,
        },
      },
      "claude-opus-4.6": {
        id: "claude-opus-4.6",
        name: "Claude Opus 4.6",
        providerID: "github-copilot",
        api: {
          id: "claude-opus-4.6",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
        cost: {
          input: 0,
          output: 0,
          cache: {
            read: 0,
            write: 0,
          },
        },
        limit: {
          context: 128_000,
          output: 64_000,
        },
      },
    },
  } as {
    models: Record<
      string,
      {
        id: string
        name: string
        providerID: string
        api: {
          id: string
          url: string
          npm: string
        }
        cost: {
          input: number
          output: number
          cache: {
            read: number
            write: number
          }
        }
        limit: {
          context: number
          output: number
        }
      }
    >
  }
}

describe("plugin.copilot", () => {
  test("adds Sonnet 4.6 1M alias", async () => {
    const hooks = await CopilotAuthPlugin(input())
    if (!hooks.auth?.loader) throw new Error("Missing auth loader")

    const p = provider()
    await hooks.auth.loader(
      async () => ({
        type: "oauth",
        access: "test-access",
        refresh: "test-refresh",
        expires: 0,
      }),
      p as never,
    )

    const model = p.models["claude-sonnet-4.6-1m"]
    expect(model).toBeDefined()
    expect(model.id).toBe("claude-sonnet-4.6-1m")
    expect(model.name).toBe("Claude Sonnet 4.6 1M")
    expect(model.api.id).toBe("claude-sonnet-4.6")
    expect(model.api.npm).toBe("@ai-sdk/anthropic")
    expect(model.api.url).toBe("https://api.githubcopilot.com/v1")
    expect(model.limit.context).toBe(1_000_000)
    expect(model.limit.output).toBe(64_000)
  })

  test("uses existing Copilot anthropic beta header", async () => {
    const hooks = await CopilotAuthPlugin(input())
    const fn = hooks["chat.headers"]
    if (!fn) throw new Error("Missing chat.headers hook")

    const out = { headers: {} as Record<string, string> }
    await fn(
      {
        sessionID: "sess",
        agent: "build",
        model: {
          id: "claude-sonnet-4.6-1m",
          providerID: "github-copilot",
          api: {
            npm: "@ai-sdk/anthropic",
          },
        },
        message: {
          role: "user",
        },
      } as never,
      out,
    )

    expect(out.headers["anthropic-beta"]).toBe(
      "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
    )

    const plain = { headers: {} as Record<string, string> }
    await fn(
      {
        sessionID: "sess",
        agent: "build",
        model: {
          id: "claude-sonnet-4.6",
          providerID: "github-copilot",
          api: {
            npm: "@ai-sdk/anthropic",
          },
        },
        message: {
          role: "user",
        },
      } as never,
      plain,
    )

    expect(plain.headers["anthropic-beta"]).toBe(
      "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
    )
  })
})
