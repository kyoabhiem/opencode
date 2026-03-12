import type { Tiktoken } from "js-tiktoken"

export namespace Token {
  let enc: Tiktoken | undefined
  const SAMPLE = 1000

  function encoder() {
    if (enc) return enc
    const { encodingForModel } = require("js-tiktoken") as typeof import("js-tiktoken")
    enc = encodingForModel("gpt-4o")
    return enc
  }

  export function estimate(input: string) {
    if (!input) return 0
    try {
      const e = encoder()
      if (input.length <= SAMPLE) return e.encode(input).length
      const head = e.encode(input.slice(0, SAMPLE)).length
      const mid = e.encode(input.slice(Math.floor(input.length / 2), Math.floor(input.length / 2) + SAMPLE)).length
      const tail = e.encode(input.slice(-SAMPLE)).length
      return Math.round(((head + mid + tail) / 3 / SAMPLE) * input.length)
    } catch {
      return Math.max(0, Math.round(input.length / 4))
    }
  }

  /** Max share of context window a single tool output should occupy */
  export const TRUNCATION_RATIO = 0.25

  export function budget(context?: number) {
    if (!context) return undefined
    return Math.floor(context * (context <= 64_000 ? 0.3 : TRUNCATION_RATIO))
  }
}
