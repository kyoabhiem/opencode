import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"

const id = "internal:sidebar-context"

function fmtTok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k"
  return String(n)
}

function fmtCost(n: number): string {
  if (n >= 1) return "$" + n.toFixed(2)
  if (n >= 0.01) return "$" + n.toFixed(3)
  if (n >= 0.001) return "$" + n.toFixed(4)
  if (n === 0) return "$0.00"
  return "$" + n.toFixed(5)
}

function fmtDiff(n: number): string {
  return (n >= 0 ? "+" : "-") + fmtCost(Math.abs(n))
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const [expanded, setExpanded] = createStore({ tokens: false, orSim: false, anthropicSim: false })

  const messages = createMemo(() =>
    props.api.state.session.messages(props.session_id).filter((m): m is AssistantMessage => m.role === "assistant"),
  )

  const cost = createMemo(() => messages().reduce((sum, m) => sum + m.cost, 0))

  const lastAssistant = createMemo(() => messages().findLast((m) => m.tokens.output > 0))

  const lastModel = createMemo(() => {
    const msg = lastAssistant()
    if (!msg) return undefined
    return props.api.state.provider.find((p) => p.id === msg.providerID)?.models[msg.modelID]
  })

  const contextSize = createMemo(() => {
    const msg = lastAssistant()
    if (!msg) return 0
    const parts = props.api.state.part(msg.id)
    const steps = parts.filter((p) => p.type === "step-finish")
    if (steps.length > 0) {
      return steps.reduce((sum, p) => {
        if (p.type !== "step-finish") return sum
        return sum + p.tokens.input + p.tokens.output + p.tokens.reasoning + p.tokens.cache.read + p.tokens.cache.write
      }, 0)
    }
    return msg.tokens.input + msg.tokens.output + msg.tokens.reasoning + msg.tokens.cache.read + msg.tokens.cache.write
  })

  const totals = createMemo(() => {
    let input = 0
    let output = 0
    let reasoning = 0
    let cacheRead = 0
    let cacheWrite = 0
    for (const m of messages()) {
      input += m.tokens.input
      output += m.tokens.output
      reasoning += m.tokens.reasoning
      cacheRead += m.tokens.cache.read
      cacheWrite += m.tokens.cache.write
    }
    return {
      input,
      output,
      reasoning,
      cacheRead,
      cacheWrite,
      total: input + output + reasoning + cacheRead + cacheWrite,
    }
  })

  const modelGroups = createMemo(() => {
    const groups = new Map<
      string,
      {
        providerID: string
        modelID: string
        input: number
        output: number
        reasoning: number
        cacheRead: number
        cacheWrite: number
        cost: number
        count: number
      }
    >()
    for (const m of messages()) {
      const key = m.providerID + ":" + m.modelID
      const g = groups.get(key) ?? {
        providerID: m.providerID,
        modelID: m.modelID,
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        count: 0,
      }
      g.input += m.tokens.input
      g.output += m.tokens.output
      g.reasoning += m.tokens.reasoning
      g.cacheRead += m.tokens.cache.read
      g.cacheWrite += m.tokens.cache.write
      g.cost += m.cost
      g.count += 1
      groups.set(key, g)
    }
    return [...groups.values()]
  })

  const cacheStats = createMemo(() => {
    const t = totals()
    if (t.cacheRead + t.cacheWrite === 0) return undefined
    return { rate: (t.cacheRead / (t.cacheRead + t.input)) * 100, read: t.cacheRead, write: t.cacheWrite }
  })

  // ---------- provider simulation helper ----------

  type SimResult = {
    rows: Array<{
      label: string
      context: number
      cost: number
      detail: { input: number; output: number; cacheRead: number; cacheWrite: number; diff: number }
    }>
    actual: number
    sim: number
  }

  function simulate(providerID: string, skip?: string): SimResult | undefined {
    const target = props.api.state.provider.find((p) => p.id === providerID)
    if (!target) return undefined
    const groups = modelGroups()
    if (groups.length === 0) return undefined
    const rows: SimResult["rows"] = []
    let totalActual = 0
    let totalSim = 0
    for (const g of groups) {
      if (skip && g.providerID === skip) continue
      const src = props.api.state.provider.find((p) => p.id === g.providerID)?.models[g.modelID]
      if (!src) continue
      const family = (src as any).family as string | undefined
      let match = target.models[g.modelID]
      if (!match && family) {
        match = target.models[g.modelID.replace(/\./g, "-")]
        if (!match) {
          const candidates = Object.values(target.models).filter((m) => (m as any).family === family)
          if (candidates.length > 0)
            match = candidates.reduce((best, c) =>
              ((c as any).release_date ?? "") > ((best as any).release_date ?? "") ? c : best,
            )
        }
      }
      if (!match) continue
      const inputCost = g.input * match.cost.input
      const outputCost = (g.output + g.reasoning) * match.cost.output
      const readCost = g.cacheRead * match.cost.cache.read
      const writeCost = g.cacheWrite * match.cost.cache.write
      const sim = inputCost + outputCost + readCost + writeCost
      rows.push({
        label: g.modelID,
        context: match.limit.context,
        cost: sim,
        detail: {
          input: inputCost,
          output: outputCost,
          cacheRead: readCost,
          cacheWrite: writeCost,
          diff: sim - g.cost,
        },
      })
      totalActual += g.cost
      totalSim += sim
    }
    if (rows.length === 0) return undefined
    return { rows, actual: totalActual, sim: totalSim }
  }

  const orSim = createMemo(() => simulate("openrouter"))
  const anthropicSim = createMemo(() => simulate("anthropic", "anthropic"))

  return (
    <box>
      {/* Usage + cost */}
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text}>
          <b>Usage</b>
        </text>
        <text fg={theme().success}>{fmtCost(cost())}</text>
      </box>

      {/* Context line */}
      <Show when={contextSize() > 0}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme().textMuted}>Context</text>
          <text fg={theme().textMuted}>
            {fmtTok(contextSize())} / {lastModel() ? fmtTok(lastModel()!.limit.context) : "?"}
          </text>
        </box>
      </Show>

      {/* Tokens collapsed/expanded */}
      <box>
        <box
          flexDirection="row"
          justifyContent="space-between"
          onMouseDown={() => setExpanded("tokens", !expanded.tokens)}
        >
          <text fg={theme().text}>
            <span fg={theme().textMuted}>{expanded.tokens ? "▼" : "▶"}</span> Tokens
          </text>
          <text fg={theme().text}>{fmtTok(totals().total)}</text>
        </box>
        <Show when={expanded.tokens}>
          <box>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().textMuted}> in</text>
              <text fg={theme().textMuted}>
                {fmtTok(totals().input)}{" "}
                {fmtCost(
                  modelGroups().reduce((s, g) => {
                    const m = props.api.state.provider.find((p) => p.id === g.providerID)?.models[g.modelID]
                    return s + (m ? g.input * m.cost.input : 0)
                  }, 0),
                )}
              </text>
            </box>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().textMuted}> out</text>
              <text fg={theme().textMuted}>
                {fmtTok(totals().output)}{" "}
                {fmtCost(
                  modelGroups().reduce((s, g) => {
                    const m = props.api.state.provider.find((p) => p.id === g.providerID)?.models[g.modelID]
                    return s + (m ? (g.output + g.reasoning) * m.cost.output : 0)
                  }, 0),
                )}
              </text>
            </box>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().textMuted}> read</text>
              <text fg={theme().textMuted}>
                {fmtTok(totals().cacheRead)}{" "}
                {fmtCost(
                  modelGroups().reduce((s, g) => {
                    const m = props.api.state.provider.find((p) => p.id === g.providerID)?.models[g.modelID]
                    return s + (m ? g.cacheRead * m.cost.cache.read : 0)
                  }, 0),
                )}
              </text>
            </box>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().textMuted}> write</text>
              <text fg={theme().textMuted}>
                {fmtTok(totals().cacheWrite)}{" "}
                {fmtCost(
                  modelGroups().reduce((s, g) => {
                    const m = props.api.state.provider.find((p) => p.id === g.providerID)?.models[g.modelID]
                    return s + (m ? g.cacheWrite * m.cost.cache.write : 0)
                  }, 0),
                )}
              </text>
            </box>
            <Show when={cacheStats()}>
              {(stats) => (
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme().textMuted}> hit rate</text>
                  <text fg={theme().success}>{stats().rate.toFixed(0)}%</text>
                </box>
              )}
            </Show>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().textMuted}> turn</text>
              <text fg={theme().textMuted}>{messages().length}</text>
            </box>
          </box>
        </Show>
      </box>

      {/* OpenRouter simulation */}
      <Show when={orSim()}>
        {(sim) => (
          <box>
            <box
              flexDirection="row"
              justifyContent="space-between"
              onMouseDown={() => setExpanded("orSim", !expanded.orSim)}
            >
              <text fg={theme().text}>
                <span fg={theme().textMuted}>{expanded.orSim ? "▼" : "▶"}</span> via OpenRouter
              </text>
              <text fg={sim().sim - sim().actual >= 0 ? theme().error : theme().success}>
                {fmtDiff(sim().sim - sim().actual)}
              </text>
            </box>
            <Show when={expanded.orSim}>
              <For each={sim().rows}>
                {(row) => (
                  <box>
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={theme().text} wrapMode="none">
                        {" "}
                        {row.label} ({fmtTok(row.context)})
                      </text>
                      <text fg={theme().text}>{fmtCost(row.cost)}</text>
                    </box>
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={theme().textMuted}> in</text>
                      <text fg={theme().textMuted}>{fmtCost(row.detail.input)}</text>
                    </box>
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={theme().textMuted}> out</text>
                      <text fg={theme().textMuted}>{fmtCost(row.detail.output)}</text>
                    </box>
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={theme().textMuted}> cache read</text>
                      <text fg={theme().textMuted}>{fmtCost(row.detail.cacheRead)}</text>
                    </box>
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={theme().textMuted}> cache write</text>
                      <text fg={theme().textMuted}>{fmtCost(row.detail.cacheWrite)}</text>
                    </box>
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={theme().textMuted}> vs actual</text>
                      <text fg={row.detail.diff >= 0 ? theme().error : theme().success}>
                        {fmtDiff(row.detail.diff)}
                      </text>
                    </box>
                  </box>
                )}
              </For>
            </Show>
          </box>
        )}
      </Show>

      {/* Anthropic simulation */}
      <Show when={anthropicSim()}>
        {(sim) => (
          <box>
            <box
              flexDirection="row"
              justifyContent="space-between"
              onMouseDown={() => setExpanded("anthropicSim", !expanded.anthropicSim)}
            >
              <text fg={theme().text}>
                <span fg={theme().textMuted}>{expanded.anthropicSim ? "▼" : "▶"}</span> via Anthropic
              </text>
              <text fg={sim().sim - sim().actual >= 0 ? theme().error : theme().success}>
                {fmtDiff(sim().sim - sim().actual)}
              </text>
            </box>
            <Show when={expanded.anthropicSim}>
              <For each={sim().rows}>
                {(row) => (
                  <box>
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={theme().text} wrapMode="none">
                        {" "}
                        {row.label} ({fmtTok(row.context)})
                      </text>
                      <text fg={theme().text}>{fmtCost(row.cost)}</text>
                    </box>
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={theme().textMuted}> in</text>
                      <text fg={theme().textMuted}>{fmtCost(row.detail.input)}</text>
                    </box>
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={theme().textMuted}> out</text>
                      <text fg={theme().textMuted}>{fmtCost(row.detail.output)}</text>
                    </box>
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={theme().textMuted}> cache read</text>
                      <text fg={theme().textMuted}>{fmtCost(row.detail.cacheRead)}</text>
                    </box>
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={theme().textMuted}> cache write</text>
                      <text fg={theme().textMuted}>{fmtCost(row.detail.cacheWrite)}</text>
                    </box>
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={theme().textMuted}> vs actual</text>
                      <text fg={row.detail.diff >= 0 ? theme().error : theme().success}>
                        {fmtDiff(row.detail.diff)}
                      </text>
                    </box>
                  </box>
                )}
              </For>
            </Show>
          </box>
        )}
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

export default { id, tui }
