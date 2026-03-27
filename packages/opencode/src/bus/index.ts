import z from "zod"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { BusEvent } from "./bus-event"
import { GlobalBus } from "./global"

export namespace Bus {
  const log = Log.create({ service: "bus" })
  type Subscription = (event: any) => void

  export const InstanceDisposed = BusEvent.define(
    "server.instance.disposed",
    z.object({
      directory: z.string(),
    }),
  )

  const state = Instance.state(
    () => {
      const subscriptions = new Map<string, Set<Subscription>>()

      return {
        subscriptions,
      }
    },
    async (entry) => {
      const wildcard = entry.subscriptions.get("*")
      if (!wildcard) return
      const event = {
        type: InstanceDisposed.type,
        properties: {
          directory: Instance.directory,
        },
      }
      for (const sub of wildcard) {
        sub(event)
      }
    },
  )

  export async function publish<Definition extends BusEvent.Definition>(
    def: Definition,
    properties: z.output<Definition["properties"]>,
  ) {
    const payload = {
      type: def.type,
      properties,
    }
    log.debug("publishing", {
      type: def.type,
    })
    const pending = []
    for (const key of [def.type, "*"]) {
      const subs = state().subscriptions.get(key)
      if (!subs) continue
      for (const sub of subs) {
        pending.push(sub(payload))
      }
    }
    GlobalBus.emit("event", {
      directory: Instance.directory,
      payload,
    })
    return Promise.all(pending)
  }

  export function subscribe<Definition extends BusEvent.Definition>(
    def: Definition,
    callback: (event: { type: Definition["type"]; properties: z.infer<Definition["properties"]> }) => void,
  ) {
    return raw(def.type, callback)
  }

  export function once<Definition extends BusEvent.Definition>(
    def: Definition,
    callback: (event: {
      type: Definition["type"]
      properties: z.infer<Definition["properties"]>
    }) => "done" | undefined,
  ) {
    const unsub = subscribe(def, (event) => {
      if (callback(event)) unsub()
    })
  }

  export function subscribeAll(callback: (event: any) => void) {
    return raw("*", callback)
  }

  /** Subscribe to all events as pre-serialized JSON strings. Avoids redundant JSON.stringify per subscriber. */
  export function subscribeAllSerialized(callback: (data: string) => void) {
    let cached: { ref: any; data: string } | undefined
    return raw("*", (event) => {
      if (cached && cached.ref === event) {
        callback(cached.data)
        return
      }
      const data = JSON.stringify(event)
      cached = { ref: event, data }
      callback(data)
    })
  }

  function raw(type: string, callback: (event: any) => void) {
    log.debug("subscribing", { type })
    const subscriptions = state().subscriptions
    let subs = subscriptions.get(type)
    if (!subs) {
      subs = new Set()
      subscriptions.set(type, subs)
    }
    subs.add(callback)

    return () => {
      log.debug("unsubscribing", { type })
      const subs = subscriptions.get(type)
      if (!subs) return
      subs.delete(callback)
    }
  }
}
