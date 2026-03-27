import { useSync } from "@tui/context/sync"
import { createMemo, For, Show, Switch, Match } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../../context/theme"
import type { AssistantMessage, StepFinishPart } from "@opencode-ai/sdk/v2"
import { Installation } from "@/installation"
import { useDirectory } from "../../context/directory"
import { useKV } from "../../context/kv"
import { TodoItem } from "../../component/todo-item"
import { formatTokens, formatCost } from "@/util/format"

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const sync = useSync()
  const { theme } = useTheme()
  const session = createMemo(() => sync.session.get(props.sessionID)!)
  const diff = createMemo(() => sync.data.session_diff[props.sessionID] ?? [])
  const todo = createMemo(() => sync.data.todo[props.sessionID] ?? [])
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])

  const [expanded, setExpanded] = createStore({
    mcp: true,
    diff: true,
    todo: true,
    lsp: true,
    turns: false,
    detail: false,
    orSim: false,
    anthropicSim: false,
  })

  const mcpEntries = createMemo(() => Object.entries(sync.data.mcp).sort(([a], [b]) => a.localeCompare(b)))
  const connectedMcpCount = createMemo(() => mcpEntries().filter(([_, v]) => v.status === "connected").length)
  const errorMcpCount = createMemo(
    () =>
      mcpEntries().filter(
        ([_, v]) => v.status === "failed" || v.status === "needs_auth" || v.status === "needs_client_registration",
      ).length,
  )

  const lastAssistant = createMemo(
    () => messages().findLast((x) => x.role === "assistant" && x.tokens.output > 0) as AssistantMessage | undefined,
  )

  // Model info for the last turn — used only for context window limit
  const lastModel = createMemo(() => {
    const msg = lastAssistant()
    if (!msg) return undefined
    return sync.data.provider.find((x) => x.id === msg.providerID)?.models[msg.modelID]
  })

  // Accurate context window: sum StepFinishParts of last assistant message
  const contextSize = createMemo(() => {
    const msg = lastAssistant()
    if (!msg) return 0
    const parts = sync.data.part[msg.id] ?? []
    const steps = parts.filter((p): p is StepFinishPart => p.type === "step-finish")
    if (steps.length > 0)
      return steps.reduce(
        (a, s) =>
          a + s.tokens.input + s.tokens.output + s.tokens.reasoning + s.tokens.cache.read + s.tokens.cache.write,
        0,
      )
    return msg.tokens.input + msg.tokens.output + msg.tokens.reasoning + msg.tokens.cache.read + msg.tokens.cache.write
  })

  const contextPct = createMemo(() => {
    const limit = lastModel()?.limit.context
    if (!limit) return null
    return Math.min(100, Math.round((contextSize() / limit) * 100))
  })

  // Session cumulative usage
  const usage = createMemo(() => session().usage)

  // Per-model token aggregation across all assistant messages in the session.
  // A session can switch models mid-conversation — each model must be priced
  // with its own rates, not the last model's rates.
  const modelGroups = createMemo(() => {
    const msgs = messages().filter((m): m is AssistantMessage => m.role === "assistant")
    const map = new Map<
      string,
      {
        providerID: string
        modelID: string
        name: string
        tok: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
        cost: number
      }
    >()

    for (const m of msgs) {
      const key = `${m.providerID}/${m.modelID}`
      if (!map.has(key)) {
        const name = sync.data.provider.find((x) => x.id === m.providerID)?.models[m.modelID]?.name ?? m.modelID
        map.set(key, {
          providerID: m.providerID,
          modelID: m.modelID,
          name,
          tok: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
        })
      }
      const g = map.get(key)!
      g.tok.input += m.tokens.input
      g.tok.output += m.tokens.output
      g.tok.reasoning += m.tokens.reasoning
      g.tok.cacheRead += m.tokens.cache.read
      g.tok.cacheWrite += m.tokens.cache.write
      g.cost += m.cost
    }
    return [...map.values()]
  })

  // Per-type costs from session usage + per-model pricing (multi-model aware)
  const breakdown = createMemo(() => {
    const u = usage()
    if (!u) return undefined
    const total = u.input + u.output + u.reasoning + u.cache.read + u.cache.write
    if (total === 0) return undefined

    // Sum costs per token type across all model groups using their own pricing
    let inputCost = 0,
      outputCost = 0,
      reasoningCost = 0,
      writeCost = 0,
      readCost = 0
    let hasPricing = false

    for (const g of modelGroups()) {
      const p = sync.data.provider.find((x) => x.id === g.providerID)?.models[g.modelID]?.cost
      if (p) {
        hasPricing = true
        inputCost += (g.tok.input * p.input) / 1_000_000
        outputCost += (g.tok.output * p.output) / 1_000_000
        reasoningCost += (g.tok.reasoning * p.output) / 1_000_000
        writeCost += (g.tok.cacheWrite * (p.cache?.write ?? 0)) / 1_000_000
        readCost += (g.tok.cacheRead * (p.cache?.read ?? 0)) / 1_000_000
      }
    }

    return {
      input: { tok: u.input, cost: inputCost },
      output: { tok: u.output, cost: outputCost },
      reasoning: u.reasoning > 0 ? { tok: u.reasoning, cost: reasoningCost } : null,
      cacheWrite: { tok: u.cache.write, cost: writeCost },
      cacheRead: { tok: u.cache.read, cost: readCost },
      total,
      hasPricing,
    }
  })

  // Cache efficiency (only when both sides exist)
  const cacheStats = createMemo(() => {
    const u = usage()
    if (!u || u.cache.read + u.cache.write === 0) return undefined
    const ratio = Math.round((u.cache.read / (u.cache.read + u.cache.write)) * 100)

    // Compute net savings per model group
    let saved = 0,
      extra = 0,
      hasPricing = false
    for (const g of modelGroups()) {
      const p = sync.data.provider.find((x) => x.id === g.providerID)?.models[g.modelID]?.cost
      if (p) {
        hasPricing = true
        saved += (g.tok.cacheRead * (p.input - (p.cache?.read ?? 0))) / 1_000_000
        extra += (g.tok.cacheWrite * ((p.cache?.write ?? 0) - p.input)) / 1_000_000
      }
    }
    return { ratio, net: hasPricing ? saved - extra : null }
  })

  // OpenRouter price simulation — per model group, with full token breakdown.
  const orSim = createMemo(() => {
    const u = usage()
    if (!u) return undefined
    const total = u.input + u.output + u.reasoning + u.cache.read + u.cache.write
    if (total === 0) return undefined

    const orProvider = sync.data.provider.find((x) => x.id === "openrouter")
    if (!orProvider) return undefined

    const norm = (s: string) => s.replace(/\./g, "-")

    const rows: {
      name: string
      actual: number
      or: number
      input: { tok: number; cost: number }
      output: { tok: number; cost: number }
      reasoning: { tok: number; cost: number } | null
      cacheWrite: { tok: number; cost: number }
      cacheRead: { tok: number; cost: number }
    }[] = []

    for (const g of modelGroups()) {
      const curModel = sync.data.provider.find((x) => x.id === g.providerID)?.models[g.modelID]
      const family = (curModel as any)?.family as string | undefined
      if (!family) continue

      const candidates = Object.values(orProvider.models).filter((m) => (m as any).family === family)
      if (candidates.length === 0) continue

      const bare = g.modelID
      const variants = new Set([`anthropic/${bare}`, `anthropic/${norm(bare)}`, bare, norm(bare)])
      const exact = candidates.find((m) => variants.has(m.id) || variants.has(norm(m.id)))
      const newest = candidates.reduce((best, m) =>
        ((m as any).release_date ?? "") > ((best as any).release_date ?? "") ? m : best,
      )
      const match = exact ?? newest
      const p = match.cost
      if (!p) continue

      const inputCost = (g.tok.input * p.input) / 1_000_000
      const outputCost = (g.tok.output * p.output) / 1_000_000
      const reasoningCost = (g.tok.reasoning * p.output) / 1_000_000
      const writeCost = (g.tok.cacheWrite * (p.cache?.write ?? 0)) / 1_000_000
      const readCost = (g.tok.cacheRead * (p.cache?.read ?? 0)) / 1_000_000

      rows.push({
        name: match.name ?? match.id,
        actual: g.cost,
        or: inputCost + outputCost + reasoningCost + writeCost + readCost,
        input: { tok: g.tok.input, cost: inputCost },
        output: { tok: g.tok.output, cost: outputCost },
        reasoning: g.tok.reasoning > 0 ? { tok: g.tok.reasoning, cost: reasoningCost } : null,
        cacheWrite: { tok: g.tok.cacheWrite, cost: writeCost },
        cacheRead: { tok: g.tok.cacheRead, cost: readCost },
      })
    }

    if (rows.length === 0) return undefined

    const orTotal = rows.reduce((a, r) => a + r.or, 0)
    const actual = u.cost ?? 0
    const diff = orTotal - actual

    return { rows, cost: orTotal, diff, same: Math.abs(diff) < 0.0001 }
  })

  // Anthropic direct price simulation — per model group, with full token breakdown.
  // Only appears when models in the session have Anthropic family equivalents.
  // Uses provider_next.all (full models.dev catalog) so it works even without ANTHROPIC_API_KEY.
  const anthropicSim = createMemo(() => {
    const u = usage()
    if (!u) return undefined
    const total = u.input + u.output + u.reasoning + u.cache.read + u.cache.write
    if (total === 0) return undefined

    // Look up anthropic from connected providers first, fall back to full catalog
    const antProvider =
      sync.data.provider.find((x) => x.id === "anthropic") ??
      sync.data.provider_next.all.find((x) => x.id === "anthropic")
    if (!antProvider) return undefined

    const norm = (s: string) => s.replace(/\./g, "-")

    const rows: {
      name: string
      actual: number
      ant: number
      input: { tok: number; cost: number }
      output: { tok: number; cost: number }
      reasoning: { tok: number; cost: number } | null
      cacheWrite: { tok: number; cost: number }
      cacheRead: { tok: number; cost: number }
    }[] = []

    for (const g of modelGroups()) {
      // skip if already using anthropic directly — prices would be identical
      if (g.providerID === "anthropic") continue

      // Look up current model from connected providers first, then full catalog
      const curModel =
        sync.data.provider.find((x) => x.id === g.providerID)?.models[g.modelID] ??
        sync.data.provider_next.all.find((x) => x.id === g.providerID)?.models[g.modelID]
      const family = curModel?.family as string | undefined
      if (!family) continue

      const candidates = Object.values(antProvider.models).filter((m) => (m as any).family === family)
      if (candidates.length === 0) continue

      const bare = g.modelID
      const variants = new Set([bare, norm(bare)])
      const exact = candidates.find((m) => variants.has(m.id) || variants.has(norm(m.id)))
      const newest = candidates.reduce((best, m) =>
        ((m as any).release_date ?? "") > ((best as any).release_date ?? "") ? m : best,
      )
      const match = exact ?? newest
      const p = match.cost
      if (!p) continue

      const inputCost = (g.tok.input * p.input) / 1_000_000
      const outputCost = (g.tok.output * p.output) / 1_000_000
      const reasoningCost = (g.tok.reasoning * p.output) / 1_000_000
      const writeCost = (g.tok.cacheWrite * (p.cache?.write ?? 0)) / 1_000_000
      const readCost = (g.tok.cacheRead * (p.cache?.read ?? 0)) / 1_000_000

      rows.push({
        name: match.name ?? match.id,
        actual: g.cost,
        ant: inputCost + outputCost + reasoningCost + writeCost + readCost,
        input: { tok: g.tok.input, cost: inputCost },
        output: { tok: g.tok.output, cost: outputCost },
        reasoning: g.tok.reasoning > 0 ? { tok: g.tok.reasoning, cost: reasoningCost } : null,
        cacheWrite: { tok: g.tok.cacheWrite, cost: writeCost },
        cacheRead: { tok: g.tok.cacheRead, cost: readCost },
      })
    }

    if (rows.length === 0) return undefined

    const antTotal = rows.reduce((a, r) => a + r.ant, 0)
    const actual = rows.reduce((a, r) => a + r.actual, 0)
    const diff = antTotal - actual

    return { rows, cost: antTotal, diff, same: Math.abs(diff) < 0.0001 }
  })

  // Per-turn list
  const turns = createMemo(() =>
    messages()
      .filter((m): m is AssistantMessage => m.role === "assistant" && !m.error)
      .map((m, i) => {
        const dur = m.time.completed ? Math.round((m.time.completed - m.time.created) / 1000) : null
        const name = sync.data.provider.find((x) => x.id === m.providerID)?.models[m.modelID]?.name ?? m.modelID
        return { n: i + 1, cost: m.cost, dur, name }
      }),
  )

  const avgCost = createMemo(() => {
    const t = turns()
    return t.length ? t.reduce((a, x) => a + x.cost, 0) / t.length : 0
  })

  const directory = useDirectory()
  const kv = useKV()

  const hasProviders = createMemo(() =>
    sync.data.provider.some((x) => x.id !== "opencode" || Object.values(x.models).some((y) => y.cost?.input !== 0)),
  )
  const dismissed = createMemo(() => kv.get("dismissed_getting_started", false))

  // Gauge: 18 filled chars to stay within 42-char sidebar
  const gauge = (pct: number) => {
    const n = Math.round((pct / 100) * 18)
    return "█".repeat(n) + "░".repeat(18 - n)
  }

  const gaugeColor = (pct: number) => (pct >= 80 ? theme.error : pct >= 60 ? theme.warning : theme.success)

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox
          flexGrow={1}
          verticalScrollbarOptions={{
            trackOptions: { backgroundColor: theme.background, foregroundColor: theme.borderActive },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            {/* ── Title ── */}
            <box paddingRight={1}>
              <text fg={theme.text}>
                <b>{session().title}</b>
              </text>
              <Show when={session().share?.url}>
                <text fg={theme.textMuted}>{session().share!.url}</text>
              </Show>
            </box>

            {/* ── Usage (merged context + session + cost) ── */}
            <Show when={breakdown()}>
              <box>
                {/* Header row: label + total cost */}
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.text}>
                    <b>Usage</b>
                  </text>
                  <text fg={theme.text}>
                    <b>{formatCost(usage()?.cost ?? 0)}</b>
                  </text>
                </box>

                {/* Context gauge — only when limit is known */}
                <Show when={contextPct() !== null}>
                  <box flexDirection="row" gap={1}>
                    <text fg={gaugeColor(contextPct()!)}>{gauge(contextPct()!)}</text>
                    <text fg={theme.textMuted}>{contextPct()}%</text>
                  </box>
                </Show>

                {/* One-line token summary */}
                <text fg={theme.textMuted}>
                  {formatTokens(breakdown()!.total)} tok
                  {" · "}in {formatTokens(breakdown()!.input.tok)}
                  {" · "}out {formatTokens(breakdown()!.output.tok)}
                </text>

                {/* Cache summary — only when cache tokens exist */}
                <Show when={breakdown()!.cacheRead.tok > 0 || breakdown()!.cacheWrite.tok > 0}>
                  <text fg={theme.textMuted}>
                    cache read {formatTokens(breakdown()!.cacheRead.tok)}
                    {" · "}write {formatTokens(breakdown()!.cacheWrite.tok)}
                  </text>
                </Show>

                {/* Reasoning — only when present */}
                <Show when={breakdown()!.reasoning}>
                  <text fg={theme.textMuted}>think {formatTokens(breakdown()!.reasoning!.tok)}</text>
                </Show>

                {/* Cost detail toggle */}
                <box flexDirection="row" gap={1} onMouseDown={() => setExpanded("detail", !expanded.detail)}>
                  <text fg={theme.textMuted}>{expanded.detail ? "▼" : "▶"}</text>
                  <text fg={theme.textMuted}>cost detail</text>
                </box>

                <Show when={expanded.detail}>
                  <Show
                    when={breakdown()!.hasPricing}
                    fallback={<text fg={theme.textMuted}>no pricing for this model</text>}
                  >
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={theme.textMuted}>input {formatTokens(breakdown()!.input.tok)}</text>
                      <text fg={theme.textMuted}>{formatCost(breakdown()!.input.cost)}</text>
                    </box>
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={theme.textMuted}>output {formatTokens(breakdown()!.output.tok)}</text>
                      <text fg={theme.textMuted}>{formatCost(breakdown()!.output.cost)}</text>
                    </box>
                    <Show when={breakdown()!.reasoning}>
                      <box flexDirection="row" justifyContent="space-between">
                        <text fg={theme.textMuted}>think {formatTokens(breakdown()!.reasoning!.tok)}</text>
                        <text fg={theme.textMuted}>{formatCost(breakdown()!.reasoning!.cost)}</text>
                      </box>
                    </Show>
                    <Show when={breakdown()!.cacheWrite.tok > 0}>
                      <box flexDirection="row" justifyContent="space-between">
                        <text fg={theme.textMuted}>write {formatTokens(breakdown()!.cacheWrite.tok)}</text>
                        <text fg={theme.textMuted}>{formatCost(breakdown()!.cacheWrite.cost)}</text>
                      </box>
                    </Show>
                    <Show when={breakdown()!.cacheRead.tok > 0}>
                      <box flexDirection="row" justifyContent="space-between">
                        <text fg={theme.textMuted}>read {formatTokens(breakdown()!.cacheRead.tok)}</text>
                        <text fg={theme.textMuted}>{formatCost(breakdown()!.cacheRead.cost)}</text>
                      </box>
                    </Show>

                    {/* Cache efficiency inside detail */}
                    <Show when={cacheStats()}>
                      <box flexDirection="row" justifyContent="space-between">
                        <text fg={theme.textMuted}>hit rate</text>
                        <text fg={cacheStats()!.ratio >= 50 ? theme.success : theme.textMuted}>
                          {cacheStats()!.ratio}%
                        </text>
                      </box>
                      <Show when={cacheStats()!.net !== null}>
                        <box flexDirection="row" justifyContent="space-between">
                          <text fg={theme.textMuted}>cache net</text>
                          <text fg={cacheStats()!.net! >= 0 ? theme.success : theme.warning}>
                            {cacheStats()!.net! >= 0 ? "saved " : "cost "}
                            {formatCost(Math.abs(cacheStats()!.net!))}
                          </text>
                        </box>
                      </Show>
                    </Show>
                  </Show>
                </Show>
              </box>
            </Show>

            {/* ── OpenRouter simulation ── */}
            <Show when={orSim()}>
              <box>
                <box flexDirection="row" gap={1} onMouseDown={() => setExpanded("orSim", !expanded.orSim)}>
                  <text fg={theme.text}>{expanded.orSim ? "▼" : "▶"}</text>
                  <text fg={theme.text}>
                    <b>via OpenRouter</b>
                  </text>
                  <Show when={!expanded.orSim}>
                    <text fg={orSim()!.same ? theme.textMuted : orSim()!.diff < 0 ? theme.success : theme.warning}>
                      {orSim()!.same
                        ? "same price"
                        : orSim()!.diff < 0
                          ? `−${formatCost(Math.abs(orSim()!.diff))}`
                          : `+${formatCost(orSim()!.diff)}`}
                    </text>
                  </Show>
                </box>
                <Show when={expanded.orSim}>
                  <For each={orSim()!.rows}>
                    {(row) => (
                      <box>
                        {/* Model name + OR cost vs actual diff */}
                        <box flexDirection="row" justifyContent="space-between">
                          <text fg={theme.text}>{row.name.length > 20 ? row.name.slice(0, 19) + "…" : row.name}</text>
                          <text
                            fg={
                              row.or === row.actual
                                ? theme.textMuted
                                : row.or < row.actual
                                  ? theme.success
                                  : theme.warning
                            }
                          >
                            {formatCost(row.or)}
                          </text>
                        </box>
                        {/* Token breakdown per type */}
                        <box flexDirection="row" justifyContent="space-between">
                          <text fg={theme.textMuted}> input {formatTokens(row.input.tok)}</text>
                          <text fg={theme.textMuted}>{formatCost(row.input.cost)}</text>
                        </box>
                        <box flexDirection="row" justifyContent="space-between">
                          <text fg={theme.textMuted}> output {formatTokens(row.output.tok)}</text>
                          <text fg={theme.textMuted}>{formatCost(row.output.cost)}</text>
                        </box>
                        <Show when={row.reasoning}>
                          <box flexDirection="row" justifyContent="space-between">
                            <text fg={theme.textMuted}> think {formatTokens(row.reasoning!.tok)}</text>
                            <text fg={theme.textMuted}>{formatCost(row.reasoning!.cost)}</text>
                          </box>
                        </Show>
                        <Show when={row.cacheWrite.tok > 0}>
                          <box flexDirection="row" justifyContent="space-between">
                            <text fg={theme.textMuted}> write {formatTokens(row.cacheWrite.tok)}</text>
                            <text fg={theme.textMuted}>{formatCost(row.cacheWrite.cost)}</text>
                          </box>
                        </Show>
                        <Show when={row.cacheRead.tok > 0}>
                          <box flexDirection="row" justifyContent="space-between">
                            <text fg={theme.textMuted}> read {formatTokens(row.cacheRead.tok)}</text>
                            <text fg={theme.textMuted}>{formatCost(row.cacheRead.cost)}</text>
                          </box>
                        </Show>
                        {/* Per-model diff vs actual */}
                        <box flexDirection="row" justifyContent="space-between">
                          <text fg={theme.textMuted}> vs actual</text>
                          <text
                            fg={
                              Math.abs(row.or - row.actual) < 0.0001
                                ? theme.textMuted
                                : row.or < row.actual
                                  ? theme.success
                                  : theme.warning
                            }
                          >
                            {Math.abs(row.or - row.actual) < 0.0001
                              ? "same"
                              : row.or < row.actual
                                ? `save ${formatCost(row.actual - row.or)}`
                                : `+${formatCost(row.or - row.actual)}`}
                          </text>
                        </box>
                      </box>
                    )}
                  </For>
                  {/* Grand total — only meaningful when multiple models */}
                  <Show when={orSim()!.rows.length > 1}>
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={theme.text}>
                        <b>total</b>
                      </text>
                      <text fg={theme.text}>
                        <b>{formatCost(orSim()!.cost)}</b>
                      </text>
                    </box>
                  </Show>
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={theme.textMuted}>vs actual</text>
                    <text fg={orSim()!.same ? theme.textMuted : orSim()!.diff < 0 ? theme.success : theme.warning}>
                      {orSim()!.same
                        ? "no difference"
                        : orSim()!.diff < 0
                          ? `save ${formatCost(Math.abs(orSim()!.diff))}`
                          : `+${formatCost(orSim()!.diff)} more`}
                    </text>
                  </box>
                </Show>
              </box>
            </Show>

            {/* ── Anthropic direct simulation ── */}
            <Show when={anthropicSim()}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => setExpanded("anthropicSim", !expanded.anthropicSim)}
                >
                  <text fg={theme.text}>{expanded.anthropicSim ? "▼" : "▶"}</text>
                  <text fg={theme.text}>
                    <b>via Anthropic</b>
                  </text>
                  <Show when={!expanded.anthropicSim}>
                    <text
                      fg={
                        anthropicSim()!.same
                          ? theme.textMuted
                          : anthropicSim()!.diff < 0
                            ? theme.success
                            : theme.warning
                      }
                    >
                      {anthropicSim()!.same
                        ? "same price"
                        : anthropicSim()!.diff < 0
                          ? `−${formatCost(Math.abs(anthropicSim()!.diff))}`
                          : `+${formatCost(anthropicSim()!.diff)}`}
                    </text>
                  </Show>
                </box>
                <Show when={expanded.anthropicSim}>
                  <For each={anthropicSim()!.rows}>
                    {(row) => (
                      <box>
                        <box flexDirection="row" justifyContent="space-between">
                          <text fg={theme.text}>{row.name.length > 20 ? row.name.slice(0, 19) + "…" : row.name}</text>
                          <text
                            fg={
                              row.ant === row.actual
                                ? theme.textMuted
                                : row.ant < row.actual
                                  ? theme.success
                                  : theme.warning
                            }
                          >
                            {formatCost(row.ant)}
                          </text>
                        </box>
                        <box flexDirection="row" justifyContent="space-between">
                          <text fg={theme.textMuted}> input {formatTokens(row.input.tok)}</text>
                          <text fg={theme.textMuted}>{formatCost(row.input.cost)}</text>
                        </box>
                        <box flexDirection="row" justifyContent="space-between">
                          <text fg={theme.textMuted}> output {formatTokens(row.output.tok)}</text>
                          <text fg={theme.textMuted}>{formatCost(row.output.cost)}</text>
                        </box>
                        <Show when={row.reasoning}>
                          <box flexDirection="row" justifyContent="space-between">
                            <text fg={theme.textMuted}> think {formatTokens(row.reasoning!.tok)}</text>
                            <text fg={theme.textMuted}>{formatCost(row.reasoning!.cost)}</text>
                          </box>
                        </Show>
                        <Show when={row.cacheWrite.tok > 0}>
                          <box flexDirection="row" justifyContent="space-between">
                            <text fg={theme.textMuted}> write {formatTokens(row.cacheWrite.tok)}</text>
                            <text fg={theme.textMuted}>{formatCost(row.cacheWrite.cost)}</text>
                          </box>
                        </Show>
                        <Show when={row.cacheRead.tok > 0}>
                          <box flexDirection="row" justifyContent="space-between">
                            <text fg={theme.textMuted}> read {formatTokens(row.cacheRead.tok)}</text>
                            <text fg={theme.textMuted}>{formatCost(row.cacheRead.cost)}</text>
                          </box>
                        </Show>
                        <box flexDirection="row" justifyContent="space-between">
                          <text fg={theme.textMuted}> vs actual</text>
                          <text
                            fg={
                              Math.abs(row.ant - row.actual) < 0.0001
                                ? theme.textMuted
                                : row.ant < row.actual
                                  ? theme.success
                                  : theme.warning
                            }
                          >
                            {Math.abs(row.ant - row.actual) < 0.0001
                              ? "same"
                              : row.ant < row.actual
                                ? `save ${formatCost(row.actual - row.ant)}`
                                : `+${formatCost(row.ant - row.actual)}`}
                          </text>
                        </box>
                      </box>
                    )}
                  </For>
                  <Show when={anthropicSim()!.rows.length > 1}>
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={theme.text}>
                        <b>total</b>
                      </text>
                      <text fg={theme.text}>
                        <b>{formatCost(anthropicSim()!.cost)}</b>
                      </text>
                    </box>
                  </Show>
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={theme.textMuted}>vs actual</text>
                    <text
                      fg={
                        anthropicSim()!.same
                          ? theme.textMuted
                          : anthropicSim()!.diff < 0
                            ? theme.success
                            : theme.warning
                      }
                    >
                      {anthropicSim()!.same
                        ? "no difference"
                        : anthropicSim()!.diff < 0
                          ? `save ${formatCost(Math.abs(anthropicSim()!.diff))}`
                          : `+${formatCost(anthropicSim()!.diff)} more`}
                    </text>
                  </box>
                </Show>
              </box>
            </Show>

            {/* ── Turns ── */}
            <Show when={turns().length > 0}>
              <box>
                <box flexDirection="row" gap={1} onMouseDown={() => setExpanded("turns", !expanded.turns)}>
                  <text fg={theme.text}>{expanded.turns ? "▼" : "▶"}</text>
                  <text fg={theme.text}>
                    <b>Turns</b>
                    <span style={{ fg: theme.textMuted }}>
                      {" "}
                      {turns().length} · avg {formatCost(avgCost())}
                    </span>
                  </text>
                </box>
                <Show when={expanded.turns}>
                  <For each={turns()}>
                    {(t) => (
                      <box flexDirection="row" gap={1}>
                        <text fg={theme.textMuted} flexShrink={0}>
                          #{t.n}
                        </text>
                        <text fg={theme.textMuted} flexGrow={1} wrapMode="none">
                          {t.name.length > 13 ? t.name.slice(0, 12) + "…" : t.name}
                        </text>
                        <text fg={theme.text} flexShrink={0}>
                          {formatCost(t.cost)}
                        </text>
                        <Show when={t.dur !== null}>
                          <text fg={theme.textMuted} flexShrink={0}>
                            {t.dur}s
                          </text>
                        </Show>
                      </box>
                    )}
                  </For>
                </Show>
              </box>
            </Show>

            {/* ── MCP ── */}
            <Show when={mcpEntries().length > 0}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => mcpEntries().length > 2 && setExpanded("mcp", !expanded.mcp)}
                >
                  <Show when={mcpEntries().length > 2}>
                    <text fg={theme.text}>{expanded.mcp ? "▼" : "▶"}</text>
                  </Show>
                  <text fg={theme.text}>
                    <b>MCP</b>
                    <Show when={!expanded.mcp}>
                      <span style={{ fg: theme.textMuted }}>
                        {" "}
                        ({connectedMcpCount()} active
                        {errorMcpCount() > 0 ? `, ${errorMcpCount()} err` : ""})
                      </span>
                    </Show>
                  </text>
                </box>
                <Show when={mcpEntries().length <= 2 || expanded.mcp}>
                  <For each={mcpEntries()}>
                    {([key, item]) => (
                      <box flexDirection="row" gap={1}>
                        <text
                          flexShrink={0}
                          style={{
                            fg: (
                              {
                                connected: theme.success,
                                failed: theme.error,
                                disabled: theme.textMuted,
                                needs_auth: theme.warning,
                                needs_client_registration: theme.error,
                              } as Record<string, typeof theme.success>
                            )[item.status],
                          }}
                        >
                          •
                        </text>
                        <text fg={theme.text} wrapMode="word">
                          {key}{" "}
                          <span style={{ fg: theme.textMuted }}>
                            <Switch fallback={item.status}>
                              <Match when={item.status === "connected"}>Connected</Match>
                              <Match when={item.status === "failed" && item}>{(v) => <i>{v().error}</i>}</Match>
                              <Match when={item.status === "disabled"}>Disabled</Match>
                              <Match when={(item.status as string) === "needs_auth"}>Needs auth</Match>
                              <Match when={(item.status as string) === "needs_client_registration"}>
                                Needs client ID
                              </Match>
                            </Switch>
                          </span>
                        </text>
                      </box>
                    )}
                  </For>
                </Show>
              </box>
            </Show>

            {/* ── LSP ── */}
            <box>
              <box
                flexDirection="row"
                gap={1}
                onMouseDown={() => sync.data.lsp.length > 2 && setExpanded("lsp", !expanded.lsp)}
              >
                <Show when={sync.data.lsp.length > 2}>
                  <text fg={theme.text}>{expanded.lsp ? "▼" : "▶"}</text>
                </Show>
                <text fg={theme.text}>
                  <b>LSP</b>
                </text>
              </box>
              <Show when={sync.data.lsp.length <= 2 || expanded.lsp}>
                <Show when={sync.data.lsp.length === 0}>
                  <text fg={theme.textMuted}>
                    {sync.data.config.lsp === false ? "LSPs disabled in settings" : "LSPs activate as files are read"}
                  </text>
                </Show>
                <For each={sync.data.lsp}>
                  {(item) => (
                    <box flexDirection="row" gap={1}>
                      <text
                        flexShrink={0}
                        style={{ fg: { connected: theme.success, error: theme.error }[item.status] }}
                      >
                        •
                      </text>
                      <text fg={theme.textMuted}>
                        {item.id} {item.root}
                      </text>
                    </box>
                  )}
                </For>
              </Show>
            </box>

            {/* ── Todo ── */}
            <Show when={todo().length > 0 && todo().some((t) => t.status !== "completed")}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => todo().length > 2 && setExpanded("todo", !expanded.todo)}
                >
                  <Show when={todo().length > 2}>
                    <text fg={theme.text}>{expanded.todo ? "▼" : "▶"}</text>
                  </Show>
                  <text fg={theme.text}>
                    <b>Todo</b>
                  </text>
                </box>
                <Show when={todo().length <= 2 || expanded.todo}>
                  <For each={todo()}>{(t) => <TodoItem status={t.status} content={t.content} />}</For>
                </Show>
              </box>
            </Show>

            {/* ── Modified Files ── */}
            <Show when={diff().length > 0}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => diff().length > 2 && setExpanded("diff", !expanded.diff)}
                >
                  <Show when={diff().length > 2}>
                    <text fg={theme.text}>{expanded.diff ? "▼" : "▶"}</text>
                  </Show>
                  <text fg={theme.text}>
                    <b>Modified Files</b>
                  </text>
                </box>
                <Show when={diff().length <= 2 || expanded.diff}>
                  <For each={diff()}>
                    {(item) => (
                      <box flexDirection="row" gap={1} justifyContent="space-between">
                        <text fg={theme.textMuted} wrapMode="none">
                          {item.file}
                        </text>
                        <box flexDirection="row" gap={1} flexShrink={0}>
                          <Show when={item.additions}>
                            <text fg={theme.diffAdded}>+{item.additions}</text>
                          </Show>
                          <Show when={item.deletions}>
                            <text fg={theme.diffRemoved}>-{item.deletions}</text>
                          </Show>
                        </box>
                      </box>
                    )}
                  </For>
                </Show>
              </box>
            </Show>
          </box>
        </scrollbox>

        {/* ── Footer ── */}
        <box flexShrink={0} gap={1} paddingTop={1}>
          <Show when={!hasProviders() && !dismissed()}>
            <box
              backgroundColor={theme.backgroundElement}
              paddingTop={1}
              paddingBottom={1}
              paddingLeft={2}
              paddingRight={2}
              flexDirection="row"
              gap={1}
            >
              <text flexShrink={0} fg={theme.text}>
                ⬖
              </text>
              <box flexGrow={1} gap={1}>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.text}>
                    <b>Getting started</b>
                  </text>
                  <text fg={theme.textMuted} onMouseDown={() => kv.set("dismissed_getting_started", true)}>
                    ✕
                  </text>
                </box>
                <text fg={theme.textMuted}>OpenCode includes free models to start immediately.</text>
                <text fg={theme.textMuted}>Connect from 75+ providers to use Claude, GPT, Gemini etc</text>
                <box flexDirection="row" gap={1} justifyContent="space-between">
                  <text fg={theme.text}>Connect provider</text>
                  <text fg={theme.textMuted}>/connect</text>
                </box>
              </box>
            </box>
          </Show>
          <text>
            <span style={{ fg: theme.textMuted }}>{directory().split("/").slice(0, -1).join("/")}/</span>
            <span style={{ fg: theme.text }}>{directory().split("/").at(-1)}</span>
          </text>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.success }}>•</span> <b>Open</b>
            <span style={{ fg: theme.text }}>
              <b>Code</b>
            </span>{" "}
            <span>{Installation.VERSION}</span>
          </text>
        </box>
      </box>
    </Show>
  )
}
