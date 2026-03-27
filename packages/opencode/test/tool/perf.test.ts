import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { createReadStream } from "fs"
import { createInterface } from "readline"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { ReadTool } from "../../src/tool/read"
import { SessionID, MessageID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

// ─── Tier 2 Profiling: Tool Init / resolveTools ─────────────────────────────

describe("perf: ToolRegistry.tools() init cost", () => {
  test("measure cold and warm init timing", async () => {
    const root = path.join(__dirname, "../..")
    await Instance.provide({
      directory: root,
      fn: async () => {
        const model = { providerID: ProviderID.make("anthropic"), modelID: ModelID.make("claude-sonnet-4-20250514") }

        // Cold init
        const cold = performance.now()
        const first = await ToolRegistry.tools(model)
        const coldMs = performance.now() - cold

        // Warm init (same call, no caching — measures re-init cost)
        const times: number[] = []
        for (let i = 0; i < 5; i++) {
          const start = performance.now()
          await ToolRegistry.tools(model)
          times.push(performance.now() - start)
        }
        const warmAvg = times.reduce((a, b) => a + b, 0) / times.length

        console.log("\n┌─────────────────────────────────────────┐")
        console.log("│  ToolRegistry.tools() Profiling Results  │")
        console.log("├─────────────────────────────────────────┤")
        console.log(`│  Tools loaded:     ${first.length.toString().padStart(18)} │`)
        console.log(`│  Cold init:        ${coldMs.toFixed(2).padStart(15)} ms │`)
        console.log(`│  Warm avg (5x):    ${warmAvg.toFixed(2).padStart(15)} ms │`)
        console.log(
          `│  Warm min:         ${Math.min(...times)
            .toFixed(2)
            .padStart(15)} ms │`,
        )
        console.log(
          `│  Warm max:         ${Math.max(...times)
            .toFixed(2)
            .padStart(15)} ms │`,
        )
        console.log(`│  Per-tool avg:     ${(warmAvg / first.length).toFixed(2).padStart(15)} ms │`)
        console.log("└─────────────────────────────────────────┘")
        console.log("\nDecision threshold: if warm avg > 50ms, tool init caching is worthwhile")
        console.log(
          `Result: ${warmAvg > 50 ? "CACHE RECOMMENDED" : warmAvg > 20 ? "BORDERLINE — profile in production" : "CACHING NOT NEEDED (< 20ms)"}\n`,
        )

        expect(first.length).toBeGreaterThan(10)
      },
    })
  }, 30_000)
})

// ─── Tier 2 Profiling: Read tool — readline vs Bun.file() ──────────────────

describe("perf: Read tool — readline vs Bun.file()", () => {
  const sizes = [
    { name: "1KB", lines: 20, lineLen: 50 },
    { name: "10KB", lines: 200, lineLen: 50 },
    { name: "50KB", lines: 1000, lineLen: 50 },
    { name: "200KB", lines: 4000, lineLen: 50 },
  ]

  test.each(sizes)(
    "benchmark $name file",
    async ({ name, lines, lineLen }) => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const content = Array.from({ length: lines }, (_, i) => `${i}: ${"x".repeat(lineLen)}`).join("\n")
          await Bun.write(path.join(dir, "bench.txt"), content)
          return content.length
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const filepath = path.join(tmp.path, "bench.txt")
          const iterations = 20

          // Method A: current readline approach
          const rlTimes: number[] = []
          for (let i = 0; i < iterations; i++) {
            const start = performance.now()
            const stream = createReadStream(filepath, { encoding: "utf8" })
            const rl = createInterface({ input: stream, crlfDelay: Infinity })
            const result: string[] = []
            for await (const line of rl) {
              result.push(line)
              if (result.length >= 2000) break
            }
            rl.close()
            stream.destroy()
            rlTimes.push(performance.now() - start)
          }

          // Method B: Bun.file().text() + split
          const bunTimes: number[] = []
          for (let i = 0; i < iterations; i++) {
            const start = performance.now()
            const text = await Bun.file(filepath).text()
            const result = text.split("\n").slice(0, 2000)
            bunTimes.push(performance.now() - start)
          }

          const rlAvg = rlTimes.reduce((a, b) => a + b, 0) / iterations
          const bunAvg = bunTimes.reduce((a, b) => a + b, 0) / iterations
          const ratio = rlAvg / bunAvg

          console.log(`\n  ${name} (${tmp.extra} bytes, ${lines} lines):`)
          console.log(`    readline avg:   ${rlAvg.toFixed(2)} ms`)
          console.log(`    Bun.file avg:   ${bunAvg.toFixed(2)} ms`)
          console.log(`    Speedup:        ${ratio.toFixed(1)}x ${ratio > 1 ? "(Bun faster)" : "(readline faster)"}`)

          expect(true).toBe(true)
        },
      })
    },
    30_000,
  )
})

// ─── Tier 2 Profiling: Bash realpath sequential vs parallel ─────────────────

describe("perf: Bash realpath sequential vs parallel", () => {
  test("benchmark realpath: sequential vs Promise.all", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // Create 10 files to realpath
        await Promise.all(
          Array.from({ length: 10 }, (_, i) => Bun.write(path.join(dir, `file${i}.txt`), `content${i}`)),
        )
      },
    })

    const files = Array.from({ length: 10 }, (_, i) => path.join(tmp.path, `file${i}.txt`))
    const iterations = 50
    const { realpath } = await import("fs/promises")

    // Sequential
    const seqTimes: number[] = []
    for (let i = 0; i < iterations; i++) {
      const start = performance.now()
      for (const f of files) {
        await realpath(f).catch(() => "")
      }
      seqTimes.push(performance.now() - start)
    }

    // Parallel
    const parTimes: number[] = []
    for (let i = 0; i < iterations; i++) {
      const start = performance.now()
      await Promise.all(files.map((f) => realpath(f).catch(() => "")))
      parTimes.push(performance.now() - start)
    }

    const seqAvg = seqTimes.reduce((a, b) => a + b, 0) / iterations
    const parAvg = parTimes.reduce((a, b) => a + b, 0) / iterations
    const ratio = seqAvg / parAvg

    console.log("\n┌────────────────────────────────────────────┐")
    console.log("│  Bash realpath: Sequential vs Parallel     │")
    console.log("├────────────────────────────────────────────┤")
    console.log(`│  Files:            ${files.length.toString().padStart(21)} │`)
    console.log(`│  Sequential avg:   ${seqAvg.toFixed(2).padStart(18)} ms │`)
    console.log(`│  Parallel avg:     ${parAvg.toFixed(2).padStart(18)} ms │`)
    console.log(`│  Speedup:          ${(ratio.toFixed(1) + "x").padStart(21)} │`)
    console.log("└────────────────────────────────────────────┘")
    console.log(
      `\nDecision: ${ratio > 1.5 ? "PARALLELIZE — significant gain" : "NOT WORTH IT — marginal difference"}\n`,
    )

    expect(true).toBe(true)
  }, 30_000)
})
