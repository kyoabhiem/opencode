import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createMemo, createEffect, For, Show } from "solid-js"
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

const TOK_COL = 8
const COST_COL = 9

function rowRight(tok: string, cost: string): string {
  return tok.padStart(TOK_COL) + "  " + cost.padStart(COST_COL)
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const [expanded, setExpanded] = createStore({ tokens: false, subagents: false, orSim: false })

  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const children = createMemo(() => props.api.state.session.children(props.session_id))
  const descendants = createMemo(() => props.api.state.session.descendants(props.session_id))

  const synced = new Set<string>()
  createEffect(() => {
    for (const d of descendants()) {
      if (synced.has(d.id)) continue
      synced.add(d.id)
      props.api.state.session.sync(d.id)
    }
  })

  const messages = createMemo(() =>
    props.api.state.session.messages(props.session_id).filter((m): m is AssistantMessage => m.role === "assistant"),
  )

  const allMessages = createMemo(() => {
    const result = [...messages()]
    for (const d of descendants()) {
      const msgs = props.api.state.session.messages(d.id).filter((m): m is AssistantMessage => m.role === "assistant")
      result.push(...msgs)
    }
    return result
  })

  const cost = createMemo(() => session()?.usage?.cost ?? messages().reduce((sum, m) => sum + m.cost, 0))

  const parentCost = createMemo(() => messages().reduce((sum, m) => sum + m.cost, 0))

  const subagents = createMemo(() => {
    const list: Array<{ agent: string; title: string; cost: number; tokens: number }> = []
    for (const child of children()) {
      if (!child.usage) continue
      const u = child.usage
      const tok = u.input + u.output + u.reasoning + u.cache.read + u.cache.write
      const agentMatch = child.title.match(/\(@(\w+) subagent\)$/)
      const agent = agentMatch ? agentMatch[1] : "task"
      const label = child.title.replace(/ \(@\w+ subagent\)$/, "")
      list.push({ agent, title: label, cost: u.cost, tokens: tok })
    }
    return list
  })

  const subagentTotals = createMemo(() => {
    const sa = subagents()
    return { tokens: sa.reduce((s, x) => s + x.tokens, 0), cost: sa.reduce((s, x) => s + x.cost, 0) }
  })

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
    for (const m of allMessages()) {
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
    for (const m of allMessages()) {
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

  type SimResult = {
    rows: Array<{
      label: string
      context: number
      tokens: number
      cost: number
      count: number
      detail: {
        input: number
        output: number
        cacheRead: number
        cacheWrite: number
        diff: number
        tokIn: number
        tokOut: number
        tokRead: number
        tokWrite: number
      }
    }>
    actual: number
    sim: number
    tokens: number
  }

  function simulate(providerID: string, skip?: string): SimResult | undefined {
    const target = props.api.state.provider.find((p) => p.id === providerID)
    if (!target) return undefined
    const groups = modelGroups()
    if (groups.length === 0) return undefined
    const rows: SimResult["rows"] = []
    let totalActual = 0
    let totalSim = 0
    let totalTokens = 0
    for (const g of groups) {
      if (skip && g.providerID === skip) continue
      const src = props.api.state.provider.find((p) => p.id === g.providerID)?.models[g.modelID]
      if (!src) continue
      const family = (src as any).family as string | undefined
      let match = target.models[g.modelID]
      if (!match) {
        match = target.models[g.modelID.replace(/\./g, "-")]
      }
      if (!match) {
        const norm = g.modelID.replace(/\./g, "-")
        for (const [tid, m] of Object.entries(target.models)) {
          if (tid.endsWith("/" + g.modelID) || tid.endsWith("/" + norm)) {
            match = m
            break
          }
        }
      }
      if (!match && family) {
        const candidates = Object.values(target.models).filter((m) => (m as any).family === family)
        if (candidates.length > 0)
          match = candidates.reduce((best, c) =>
            ((c as any).release_date ?? "") > ((best as any).release_date ?? "") ? c : best,
          )
      }
      if (!match) continue
      const m = 1_000_000
      const inputCost = (g.input * match.cost.input) / m
      const outputCost = ((g.output + g.reasoning) * match.cost.output) / m
      const readCost = (g.cacheRead * match.cost.cache.read) / m
      const writeCost = (g.cacheWrite * match.cost.cache.write) / m
      const sim = inputCost + outputCost + readCost + writeCost
      const tokens = g.input + g.output + g.reasoning + g.cacheRead + g.cacheWrite
      rows.push({
        label: match.name ?? g.modelID,
        context: match.limit.context,
        tokens,
        cost: sim,
        count: g.count,
        detail: {
          input: inputCost,
          output: outputCost,
          cacheRead: readCost,
          cacheWrite: writeCost,
          diff: sim - g.cost,
          tokIn: g.input,
          tokOut: g.output + g.reasoning,
          tokRead: g.cacheRead,
          tokWrite: g.cacheWrite,
        },
      })
      totalActual += g.cost
      totalSim += sim
      totalTokens += tokens
    }
    if (rows.length === 0) return undefined
    return { rows, actual: totalActual, sim: totalSim, tokens: totalTokens }
  }

  const orSim = createMemo(() => simulate("openrouter"))

  return (
    <box>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text}>
          <b>Usage</b>
        </text>
        <text fg={theme().success}>{fmtCost(cost())}</text>
      </box>

      {contextSize() > 0 && (
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme().textMuted}>
            Context (
            {lastModel() ? Math.min(100, Math.round((contextSize() / lastModel()!.limit.context) * 100)) + "%" : "…"})
          </text>
          <text fg={theme().textMuted}>
            {fmtTok(contextSize())} / {lastModel() ? fmtTok(lastModel()!.limit.context) : "?"}
          </text>
        </box>
      )}

      <box>
        <box
          flexDirection="row"
          justifyContent="space-between"
          onMouseDown={() => setExpanded("tokens", !expanded.tokens)}
        >
          <text fg={theme().text}>
            <span>{expanded.tokens ? "▼" : "▶"}</span> Tokens
          </text>
          <text fg={theme().text}>{fmtTok(totals().total)}</text>
        </box>
        {expanded.tokens && (
          <box>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().textMuted}> in</text>
              <text fg={theme().textMuted}>
                {rowRight(
                  fmtTok(totals().input),
                  fmtCost(
                    modelGroups().reduce((s, g) => {
                      const m = props.api.state.provider.find((p) => p.id === g.providerID)?.models[g.modelID]
                      return s + (m ? (g.input * m.cost.input) / 1e6 : 0)
                    }, 0),
                  ),
                )}
              </text>
            </box>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().textMuted}> out</text>
              <text fg={theme().textMuted}>
                {rowRight(
                  fmtTok(totals().output),
                  fmtCost(
                    modelGroups().reduce((s, g) => {
                      const m = props.api.state.provider.find((p) => p.id === g.providerID)?.models[g.modelID]
                      return s + (m ? ((g.output + g.reasoning) * m.cost.output) / 1e6 : 0)
                    }, 0),
                  ),
                )}
              </text>
            </box>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().textMuted}> read</text>
              <text fg={theme().textMuted}>
                {rowRight(
                  fmtTok(totals().cacheRead),
                  fmtCost(
                    modelGroups().reduce((s, g) => {
                      const m = props.api.state.provider.find((p) => p.id === g.providerID)?.models[g.modelID]
                      return s + (m ? (g.cacheRead * m.cost.cache.read) / 1e6 : 0)
                    }, 0),
                  ),
                )}
              </text>
            </box>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().textMuted}> write</text>
              <text fg={theme().textMuted}>
                {rowRight(
                  fmtTok(totals().cacheWrite),
                  fmtCost(
                    modelGroups().reduce((s, g) => {
                      const m = props.api.state.provider.find((p) => p.id === g.providerID)?.models[g.modelID]
                      return s + (m ? (g.cacheWrite * m.cost.cache.write) / 1e6 : 0)
                    }, 0),
                  ),
                )}
              </text>
            </box>
            {cacheStats() && (
              <box flexDirection="row" justifyContent="space-between">
                <text fg={theme().textMuted}> hit rate</text>
                <text fg={theme().success}>{cacheStats()!.rate.toFixed(0)}%</text>
              </box>
            )}
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().textMuted}> turn</text>
              <text fg={theme().textMuted}>{allMessages().length}</text>
            </box>
          </box>
        )}
      </box>

      {subagents().length > 0 && (
        <box>
          <box
            flexDirection="row"
            justifyContent="space-between"
            onMouseDown={() => setExpanded("subagents", !expanded.subagents)}
          >
            <text fg={theme().text}>
              <span>{expanded.subagents ? "▼" : "▶"}</span> Subagents ({subagents().length})
            </text>
            <text fg={theme().text}>{rowRight(fmtTok(subagentTotals().tokens), fmtCost(subagentTotals().cost))}</text>
          </box>
          {expanded.subagents &&
            subagents().map((sa) => (
              <box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme().textMuted}> @{sa.agent}</text>
                  <text fg={theme().textMuted}>{rowRight(fmtTok(sa.tokens), fmtCost(sa.cost))}</text>
                </box>
                <text fg={theme().textMuted} wrapMode="none">
                  {"   "}
                  {sa.title.length > 30 ? sa.title.slice(0, 28) + ".." : sa.title}
                </text>
              </box>
            ))}
        </box>
      )}

      {orSim() && (
        <box>
          <box
            flexDirection="row"
            justifyContent="space-between"
            onMouseDown={() => setExpanded("orSim", !expanded.orSim)}
          >
            <text fg={theme().text}>
              <span>{expanded.orSim ? "▼" : "▶"}</span> via OpenRouter {fmtTok(orSim()!.tokens)}
            </text>
            <text fg={orSim()!.sim - orSim()!.actual >= 0 ? theme().error : theme().success}>
              {fmtDiff(orSim()!.sim - orSim()!.actual)}
            </text>
          </box>
          {expanded.orSim &&
            orSim()!.rows.map((row) => (
              <box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme().text} wrapMode="none">
                    {" "}
                    {row.label} ({fmtTok(row.context)}) {fmtTok(row.tokens)}
                  </text>
                  <text fg={theme().text}>{fmtCost(row.cost)}</text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme().textMuted}> in</text>
                  <text fg={theme().textMuted}>{rowRight(fmtTok(row.detail.tokIn), fmtCost(row.detail.input))}</text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme().textMuted}> out</text>
                  <text fg={theme().textMuted}>{rowRight(fmtTok(row.detail.tokOut), fmtCost(row.detail.output))}</text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme().textMuted}> cache read</text>
                  <text fg={theme().textMuted}>
                    {rowRight(fmtTok(row.detail.tokRead), fmtCost(row.detail.cacheRead))}
                  </text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme().textMuted}> cache write</text>
                  <text fg={theme().textMuted}>
                    {rowRight(fmtTok(row.detail.tokWrite), fmtCost(row.detail.cacheWrite))}
                  </text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme().textMuted}> turns</text>
                  <text fg={theme().textMuted}>{row.count}</text>
                </box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme().textMuted}> vs actual</text>
                  <text fg={row.detail.diff >= 0 ? theme().error : theme().success}>{fmtDiff(row.detail.diff)}</text>
                </box>
              </box>
            ))}
        </box>
      )}
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
