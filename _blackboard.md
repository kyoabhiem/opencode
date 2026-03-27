---

## Analysis: Merge anomalyco/dev into feat/context-optimization | 2026-03-27 10:00

### White Hat

## White Hat Analysis: 14 Conflicting Files

### File 1: `bus/index.ts` — Full rewrite conflict

- **Ours:** Set-based subscriptions, log.debug, `subscribeAllSerialized()`
- **Theirs:** Complete Effect.js rewrite (Bus.Service, PubSub, InstanceState)
- **At stake:** subscribeAllSerialized(), Set perf, log.debug

### File 2: `app.tsx` — Structural conflict

- **Ours:** SIGHUP handler, 300ms timeout
- **Theirs:** TUI plugin system, new renderer API, plugin routes
- **At stake:** SIGHUP graceful cleanup, 300ms timeout

### File 3: `sidebar.tsx` — MAXIMUM conflict

- **Ours:** +924 lines — full sidebar overhaul (usage, modelGroups, breakdown, cacheStats, orSim, anthropicSim, turns, context gauge)
- **Theirs:** Gutted ALL inline content → replaced with `<TuiPluginRuntime.Slot>` plugin system
- **At stake:** ALL sidebar usage UI — the primary surface for context-optimization

### File 4: `mcp/index.ts` — Full rewrite

- **Ours:** +18 lines — debug log for tools listing, toast on disconnect
- **Theirs:** +767/-830 — complete Effect.js rewrite
- **At stake:** MCP debug logging, disconnect toast

### File 5: `event.ts` — Moderate

- **Ours:** Bounded AsyncQueue(10K), subscribeAllSerialized
- **Theirs:** Cache-Control header, code reordering
- **At stake:** subscribeAllSerialized, bounded queue

### File 6: `global.ts` — Low-moderate

- **Ours:** Bounded AsyncQueue(10K)
- **Theirs:** streamEvents() helper, /sync-event route, Cache-Control
- **At stake:** Bounded queue

### File 7: `session.ts` (routes) — Moderate

- **Ours:** Direct 204 response, fire-and-forget prompt
- **Theirs:** .catch() error handler, Session.Event.Error
- **At stake:** Direct 204 pattern

### File 8: `compaction.ts` — Low overlap

- **Ours:** +85 lines — capacity(), estimateMessages(), shouldCompact(), batch writes, 1M context
- **Theirs:** +6 lines — .catch() on Session.messages()
- **At stake:** Incremental compaction, 1M context support

### File 9: `session/index.ts` — Very high conflict

- **Ours:** +78 lines — usage field, addUsage(), subtractUsage(), mutateUsage() with atomic SQL
- **Theirs:** +111/-183 — SyncEvent.define, SyncEvent.run(), removes WorkspaceContext
- **At stake:** ALL session-level usage tracking

### File 10: `llm.ts` — Moderate

- **Ours:** Duck-type workflow, copilot maxOutputTokens fix, debug logging
- **Theirs:** instanceof GitLabWorkflowLanguageModel, workflow system prompt
- **At stake:** Lazy-load gitlab-ai-provider, copilot fix, debug logging

### File 11: `message-v2.ts` — Moderate

- **Ours:** SSE read timeout as retryable error
- **Theirs:** SyncEvent.define, ZlibError handling, errorMessage() helper
- **At stake:** SSE timeout error handling

### File 12: `revert.ts` — High

- **Ours:** Usage subtraction during revert
- **Theirs:** Database.use() → SyncEvent.run()
- **At stake:** Usage subtraction during revert

### File 13: `snapshot/index.ts` — Moderate

- **Ours:** Exclude file caching, skip re-write unchanged
- **Theirs:** Semaphore locking, large file filtering (>2MB), Hash-based gitdir
- **At stake:** Exclude file caching

### File 14: `tool/registry.ts` — Moderate

- **Ours:** Tool resolution caching by (providerID, modelID, agentName)
- **Theirs:** Effect deps injection, Effect.fn, Effect.forEach with concurrency
- **At stake:** Tool resolution caching

### Summary Table

| File              | Severity     | Our key feature        |
| ----------------- | ------------ | ---------------------- |
| bus               | Full rewrite | subscribeAllSerialized |
| app.tsx           | Structural   | SIGHUP handler         |
| sidebar.tsx       | MAXIMUM      | ALL usage UI           |
| mcp               | Full rewrite | debug log + toast      |
| event.ts          | Moderate     | bounded queue          |
| global.ts         | Low          | bounded queue          |
| session.ts routes | Moderate     | 204 pattern            |
| compaction.ts     | Low          | 1M compaction          |
| session/index.ts  | Very high    | usage tracking         |
| llm.ts            | Moderate     | lazy-load, copilot fix |
| message-v2.ts     | Moderate     | SSE timeout            |
| revert.ts         | High         | usage subtraction      |
| snapshot          | Moderate     | exclude cache          |
| tool/registry.ts  | Moderate     | tool caching           |

### Black Hat

## Critical Risks

1. **Architectural incompatibility** — SyncEvent (theirs) vs Database.use+Bus.publish (ours). Two different persistence paradigms — must choose one.
2. **Usage tracking has zero counterpart** — Our 6 SQL columns, mutateUsage(), addUsage(), subtractUsage() don't exist on anomalyco/dev. Silent data drift if any call missed.
3. **Sidebar irreconcilable** — 968 lines inline UI vs 68 lines plugin slots. Must choose architecture.
4. **Bus paradigm breaks downstream** — Our plain-function bus breaks every Effect-based consumer on anomalyco/dev.
5. **Rebase is dangerous** — 10 commits × 14 conflicts with architectural divergence = cascade failures.

## Key Conclusion

This is NOT a file-by-file merge — it's an architectural choice. Must accept anomalyco/dev's architecture as base, then surgically re-implement our features within their patterns.

## Merge Strategy Risk

| Strategy                     | Risk                                                    |
| ---------------------------- | ------------------------------------------------------- |
| git merge                    | Medium-High — atomic but 14 conflicts at once           |
| git rebase                   | **Very High** — wrong tool for architectural divergence |
| Merge + cherry-pick features | Medium — most flexible                                  |

## Should defer to anomalyco/dev

- bus/index.ts (Effect bus is load-bearing)
- mcp/index.ts (full rewrite, our 18 lines not worth fighting)
- TUI plugin system (project direction)
- snapshot/index.ts (correctness improvements)
- tool/registry.ts Effect structure

### Yellow Hat

## Yellow Hat: Benefits & Strategy

### 7 of 10 features are ADDITIVE — easily re-applied after merge (~3 hours)

- Session usage SQL columns (30 min)
- mutateUsage/addUsage/subtractUsage (1 hr)
- Compaction improvements (30 min)
- SIGHUP handler (10 min)
- Copilot maxOutputTokens fix (10 min)
- Debug logging, bounded queues, SSE timeout, perf test (30 min)
- formatTokens/formatCost utility (5 min)

### anomalyco/dev IMPROVES our foundations

- SyncEvent unifies DB write + event publish atomically
- Effect-based bus provides structured cleanup
- Snapshot semaphore + >2MB filter = correctness
- TUI plugin system = right long-term direction

### Sidebar IS portable as a plugin

- 700+ lines of business logic (createMemo chains + JSX) transfers verbatim
- Only wrapper changes for plugin slot

### Recommended Strategy: Merge-then-patch

1. `git merge anomalyco/dev` — accept theirs for conflicting files
2. Re-apply our features as clean commits on top
3. ~1-2 days total vs 3-5 days fighting rebase conflicts
4. **We lose zero features and gain a better architecture**

### Blue Synthesis

## Blue Synthesis

**Decision: Merge-then-patch strategy**

Accept anomalyco/dev's architecture as base (Effect.js services, SyncEvent, TUI plugins), then surgically re-apply our features as clean commits on top.

For the merge step: `git merge anomalyco/dev` with conflict resolution favoring theirs.
Then re-apply our features incrementally.

This preserves ALL our features while gaining a better architectural foundation.
