import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"

const id = "internal:sidebar-context"

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k"
  return String(n)
}

function formatCost(n: number): string {
  if (n >= 1) return "$" + n.toFixed(2)
  if (n >= 0.01) return "$" + n.toFixed(3)
  if (n >= 0.001) return "$" + n.toFixed(4)
  if (n === 0) return "$0.00"
  return "$" + n.toFixed(5)
}

const gauge = (pct: number) => {
  const n = Math.round((pct / 100) * 18)
  return "█".repeat(n) + "░".repeat(18 - n)
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const [expanded, setExpanded] = createStore({
    detail: false,
    orSim: false,
    anthropicSim: false,
    turns: false,
  })

  // ---------- core data ----------

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

  // ---------- context window ----------

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

  const contextPct = createMemo(() => {
    const model = lastModel()
    if (!model || !model.limit.context) return 0
    return Math.min(100, Math.round((contextSize() / model.limit.context) * 100))
  })

  // ---------- token totals ----------

  const totals = createMemo(() => {
    const msgs = messages()
    let input = 0
    let output = 0
    let reasoning = 0
    let cacheRead = 0
    let cacheWrite = 0
    for (const m of msgs) {
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

  // ---------- model groups ----------

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

  // ---------- per-type cost breakdown ----------

  const breakdown = createMemo(() => {
    const groups = modelGroups()
    let inputCost = 0
    let outputCost = 0
    let reasoningCost = 0
    let cacheReadCost = 0
    let cacheWriteCost = 0
    for (const g of groups) {
      const model = props.api.state.provider.find((p) => p.id === g.providerID)?.models[g.modelID]
      if (!model) continue
      inputCost += g.input * model.cost.input
      outputCost += (g.output + g.reasoning) * model.cost.output
      cacheReadCost += g.cacheRead * model.cost.cache.read
      cacheWriteCost += g.cacheWrite * model.cost.cache.write
    }
    return {
      input: inputCost,
      output: outputCost,
      reasoning: reasoningCost,
      cacheRead: cacheReadCost,
      cacheWrite: cacheWriteCost,
    }
  })

  // ---------- cache stats ----------

  const cacheStats = createMemo(() => {
    const t = totals()
    const total = t.cacheRead + t.cacheWrite
    if (total === 0) return undefined
    const rate = (t.cacheRead / (t.cacheRead + t.input)) * 100
    const b = breakdown()
    const savings = b.input > 0 ? b.input - b.cacheRead : 0
    return { rate, savings, read: t.cacheRead, write: t.cacheWrite }
  })

  // ---------- OpenRouter simulation ----------

  const orSim = createMemo(() => {
    const or = props.api.state.provider.find((p) => p.id === "openrouter")
    if (!or) return undefined
    const groups = modelGroups()
    if (groups.length === 0) return undefined
    const rows: Array<{
      label: string
      tokens: number
      actual: number
      sim: number
    }> = []
    let totalActual = 0
    let totalSim = 0
    for (const g of groups) {
      const src = props.api.state.provider.find((p) => p.id === g.providerID)?.models[g.modelID]
      if (!src) continue
      const family = (src as any).family as string | undefined
      let match = or.models[g.modelID]
      if (!match && family) {
        const normalized = g.modelID.replace(/\./g, "-")
        match = or.models[normalized]
        if (!match) {
          const candidates = Object.values(or.models).filter((m) => (m as any).family === family)
          if (candidates.length > 0) {
            match = candidates.reduce((best, c) =>
              ((c as any).release_date ?? "") > ((best as any).release_date ?? "") ? c : best,
            )
          }
        }
      }
      if (!match) continue
      const tokens = g.input + g.output + g.reasoning + g.cacheRead + g.cacheWrite
      const actual = g.cost
      const sim =
        g.input * match.cost.input +
        (g.output + g.reasoning) * match.cost.output +
        g.cacheRead * match.cost.cache.read +
        g.cacheWrite * match.cost.cache.write
      rows.push({ label: g.modelID, tokens, actual, sim })
      totalActual += actual
      totalSim += sim
    }
    if (rows.length === 0) return undefined
    return { rows, actual: totalActual, sim: totalSim }
  })

  // ---------- Anthropic simulation ----------

  const anthropicSim = createMemo(() => {
    const anth = props.api.state.provider.find((p) => p.id === "anthropic")
    if (!anth) return undefined
    const groups = modelGroups()
    if (groups.length === 0) return undefined
    const rows: Array<{
      label: string
      tokens: number
      actual: number
      sim: number
    }> = []
    let totalActual = 0
    let totalSim = 0
    for (const g of groups) {
      if (g.providerID === "anthropic") continue
      const src = props.api.state.provider.find((p) => p.id === g.providerID)?.models[g.modelID]
      if (!src) continue
      const family = (src as any).family as string | undefined
      let match = anth.models[g.modelID]
      if (!match && family) {
        const normalized = g.modelID.replace(/\./g, "-")
        match = anth.models[normalized]
        if (!match) {
          const candidates = Object.values(anth.models).filter((m) => (m as any).family === family)
          if (candidates.length > 0) {
            match = candidates.reduce((best, c) =>
              ((c as any).release_date ?? "") > ((best as any).release_date ?? "") ? c : best,
            )
          }
        }
      }
      if (!match) continue
      const tokens = g.input + g.output + g.reasoning + g.cacheRead + g.cacheWrite
      const actual = g.cost
      const sim =
        g.input * match.cost.input +
        (g.output + g.reasoning) * match.cost.output +
        g.cacheRead * match.cost.cache.read +
        g.cacheWrite * match.cost.cache.write
      rows.push({ label: g.modelID, tokens, actual, sim })
      totalActual += actual
      totalSim += sim
    }
    if (rows.length === 0) return undefined
    return { rows, actual: totalActual, sim: totalSim }
  })

  // ---------- turns ----------

  const turns = createMemo(() => {
    const msgs = messages()
    return msgs.map((m, i) => {
      const dur =
        m.time.completed && m.time.created ? ((m.time.completed - m.time.created) / 1000).toFixed(1) + "s" : "…"
      return {
        idx: i + 1,
        cost: m.cost,
        dur,
        tokens: m.tokens.input + m.tokens.output + m.tokens.reasoning + m.tokens.cache.read + m.tokens.cache.write,
      }
    })
  })

  // ---------- render ----------

  return (
    <box>
      {/* ---- Usage header ---- */}
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text}>
          <b>Usage</b>
        </text>
        <text fg={theme().success}>{formatCost(cost())}</text>
      </box>

      {/* ---- Context gauge ---- */}
      <Show when={contextSize() > 0}>
        <box>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme().textMuted}>Context</text>
            <text fg={theme().textMuted}>
              {formatTokens(contextSize())} / {lastModel() ? formatTokens(lastModel()!.limit.context) : "?"}
            </text>
          </box>
          <box flexDirection="row" gap={1}>
            <text fg={contextPct() > 90 ? theme().error : contextPct() > 70 ? theme().warning : theme().success}>
              {gauge(contextPct())}
            </text>
            <text fg={theme().textMuted}>{contextPct()}%</text>
          </box>
        </box>
      </Show>

      {/* ---- Token summary ---- */}
      <box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme().textMuted}>Tokens</text>
          <text fg={theme().text}>{formatTokens(totals().total)}</text>
        </box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme().textMuted}> Input</text>
          <text fg={theme().textMuted}>{formatTokens(totals().input)}</text>
        </box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme().textMuted}> Output</text>
          <text fg={theme().textMuted}>{formatTokens(totals().output)}</text>
        </box>
        <Show when={totals().reasoning > 0}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme().textMuted}> Reasoning</text>
            <text fg={theme().textMuted}>{formatTokens(totals().reasoning)}</text>
          </box>
        </Show>
      </box>

      {/* ---- Cache summary ---- */}
      <Show when={cacheStats()}>
        {(stats) => (
          <box>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().textMuted}>Cache Read</text>
              <text fg={theme().textMuted}>{formatTokens(stats().read)}</text>
            </box>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().textMuted}>Cache Write</text>
              <text fg={theme().textMuted}>{formatTokens(stats().write)}</text>
            </box>
          </box>
        )}
      </Show>

      {/* ---- Cost detail toggle ---- */}
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => setExpanded("detail", !expanded.detail)}>
          <text fg={theme().text}>{expanded.detail ? "▼" : "▶"}</text>
          <text fg={theme().text}>Cost Breakdown</text>
        </box>
        <Show when={expanded.detail}>
          <box>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().textMuted}> Input</text>
              <text fg={theme().textMuted}>{formatCost(breakdown().input)}</text>
            </box>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().textMuted}> Output</text>
              <text fg={theme().textMuted}>{formatCost(breakdown().output)}</text>
            </box>
            <Show when={breakdown().cacheRead > 0}>
              <box flexDirection="row" justifyContent="space-between">
                <text fg={theme().textMuted}> Cache Read</text>
                <text fg={theme().textMuted}>{formatCost(breakdown().cacheRead)}</text>
              </box>
            </Show>
            <Show when={breakdown().cacheWrite > 0}>
              <box flexDirection="row" justifyContent="space-between">
                <text fg={theme().textMuted}> Cache Write</text>
                <text fg={theme().textMuted}>{formatCost(breakdown().cacheWrite)}</text>
              </box>
            </Show>

            {/* ---- Cache efficiency ---- */}
            <Show when={cacheStats()}>
              {(stats) => (
                <box>
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={theme().textMuted}> Hit Rate</text>
                    <text fg={theme().success}>{stats().rate.toFixed(1)}%</text>
                  </box>
                  <Show when={stats().savings > 0}>
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={theme().textMuted}> Net Savings</text>
                      <text fg={theme().success}>{formatCost(stats().savings)}</text>
                    </box>
                  </Show>
                </box>
              )}
            </Show>
          </box>
        </Show>
      </box>

      {/* ---- OpenRouter price simulation ---- */}
      <Show when={orSim()}>
        {(sim) => (
          <box>
            <box flexDirection="row" gap={1} onMouseDown={() => setExpanded("orSim", !expanded.orSim)}>
              <text fg={theme().text}>{expanded.orSim ? "▼" : "▶"}</text>
              <text fg={theme().text}>OpenRouter Estimate</text>
            </box>
            <Show when={expanded.orSim}>
              <box>
                <For each={sim().rows}>
                  {(row) => (
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={theme().textMuted} wrapMode="none">
                        {"  "}
                        {row.label}
                      </text>
                      <box flexDirection="row" gap={1} flexShrink={0}>
                        <text fg={theme().textMuted}>{formatTokens(row.tokens)}</text>
                        <text fg={theme().textMuted}>{formatCost(row.sim)}</text>
                      </box>
                    </box>
                  )}
                </For>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme().textMuted}> Actual</text>
                  <text fg={theme().text}>{formatCost(sim().actual)}</text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme().textMuted}> Simulated</text>
                  <text fg={sim().sim > sim().actual ? theme().error : theme().success}>{formatCost(sim().sim)}</text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme().textMuted}> Difference</text>
                  <text fg={sim().sim - sim().actual > 0 ? theme().error : theme().success}>
                    {sim().sim - sim().actual >= 0 ? "+" : ""}
                    {formatCost(Math.abs(sim().sim - sim().actual))}
                  </text>
                </box>
              </box>
            </Show>
          </box>
        )}
      </Show>

      {/* ---- Anthropic price simulation ---- */}
      <Show when={anthropicSim()}>
        {(sim) => (
          <box>
            <box flexDirection="row" gap={1} onMouseDown={() => setExpanded("anthropicSim", !expanded.anthropicSim)}>
              <text fg={theme().text}>{expanded.anthropicSim ? "▼" : "▶"}</text>
              <text fg={theme().text}>Anthropic Estimate</text>
            </box>
            <Show when={expanded.anthropicSim}>
              <box>
                <For each={sim().rows}>
                  {(row) => (
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={theme().textMuted} wrapMode="none">
                        {"  "}
                        {row.label}
                      </text>
                      <box flexDirection="row" gap={1} flexShrink={0}>
                        <text fg={theme().textMuted}>{formatTokens(row.tokens)}</text>
                        <text fg={theme().textMuted}>{formatCost(row.sim)}</text>
                      </box>
                    </box>
                  )}
                </For>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme().textMuted}> Actual</text>
                  <text fg={theme().text}>{formatCost(sim().actual)}</text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme().textMuted}> Simulated</text>
                  <text fg={sim().sim > sim().actual ? theme().error : theme().success}>{formatCost(sim().sim)}</text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme().textMuted}> Difference</text>
                  <text fg={sim().sim - sim().actual > 0 ? theme().error : theme().success}>
                    {sim().sim - sim().actual >= 0 ? "+" : ""}
                    {formatCost(Math.abs(sim().sim - sim().actual))}
                  </text>
                </box>
              </box>
            </Show>
          </box>
        )}
      </Show>

      {/* ---- Turns ---- */}
      <Show when={turns().length > 0}>
        <box>
          <box flexDirection="row" gap={1} onMouseDown={() => setExpanded("turns", !expanded.turns)}>
            <text fg={theme().text}>{expanded.turns ? "▼" : "▶"}</text>
            <text fg={theme().text}>Turns</text>
            <text fg={theme().textMuted}>({turns().length})</text>
          </box>
          <Show when={expanded.turns}>
            <For each={turns()}>
              {(turn) => (
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme().textMuted}>
                    {"  "}#{turn.idx}
                  </text>
                  <box flexDirection="row" gap={1} flexShrink={0}>
                    <text fg={theme().textMuted}>{formatTokens(turn.tokens)}</text>
                    <text fg={theme().textMuted}>{formatCost(turn.cost)}</text>
                    <text fg={theme().textMuted}>{turn.dur}</text>
                  </box>
                </box>
              )}
            </For>
          </Show>
        </box>
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

export default {
  id,
  tui,
}
