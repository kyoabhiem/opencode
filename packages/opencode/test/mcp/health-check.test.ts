import { test, expect, mock, beforeEach } from "bun:test"
import { Bus } from "../../src/bus"

interface MockClientState {
  tools: Array<{ name: string; description?: string; inputSchema: object }>
  listToolsCalls: number
  listToolsShouldFail: boolean
  listToolsError: string
  listPromptsShouldFail: boolean
  listResourcesShouldFail: boolean
  prompts: Array<{ name: string; description?: string }>
  resources: Array<{ name: string; uri: string; description?: string }>
  closed: boolean
  notificationHandlers: Map<unknown, (...args: any[]) => any>
}

const clientStates = new Map<string, MockClientState>()
let lastCreatedClientName: string | undefined
let connectShouldFail = false
let connectShouldHang = false
let connectError = "Mock transport cannot connect"
let clientCreateCount = 0
let transportCloseCount = 0

function getOrCreateClientState(name?: string): MockClientState {
  const key = name ?? "default"
  let state = clientStates.get(key)
  if (!state) {
    state = {
      tools: [{ name: "test_tool", description: "A test tool", inputSchema: { type: "object", properties: {} } }],
      listToolsCalls: 0,
      listToolsShouldFail: false,
      listToolsError: "listTools failed",
      listPromptsShouldFail: false,
      listResourcesShouldFail: false,
      prompts: [],
      resources: [],
      closed: false,
      notificationHandlers: new Map(),
    }
    clientStates.set(key, state)
  }
  return state
}

class MockStdioTransport {
  stderr: null = null
  pid = 12345
  constructor(_opts: any) {}
  async start() {
    if (connectShouldHang) return new Promise<void>(() => {})
    if (connectShouldFail) throw new Error(connectError)
  }
  async close() {
    transportCloseCount++
  }
}

class MockStreamableHTTP {
  constructor(_url: URL, _opts?: any) {}
  async start() {
    if (connectShouldHang) return new Promise<void>(() => {})
    if (connectShouldFail) throw new Error(connectError)
  }
  async close() {
    transportCloseCount++
  }
  async finishAuth() {}
}

class MockSSE {
  constructor(_url: URL, _opts?: any) {}
  async start() {
    if (connectShouldHang) return new Promise<void>(() => {})
    if (connectShouldFail) throw new Error(connectError)
  }
  async close() {
    transportCloseCount++
  }
}

mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: MockStdioTransport,
}))

mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: MockStreamableHTTP,
}))

mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: MockSSE,
}))

mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: class extends Error {
    constructor() {
      super("Unauthorized")
    }
  },
}))

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    _state!: MockClientState
    transport: any

    constructor(_opts: any) {
      clientCreateCount++
    }

    async connect(transport: { start: () => Promise<void> }) {
      this.transport = transport
      await transport.start()
      this._state = getOrCreateClientState(lastCreatedClientName)
    }

    setNotificationHandler(schema: unknown, handler: (...args: any[]) => any) {
      this._state?.notificationHandlers.set(schema, handler)
    }

    async listTools() {
      if (this._state) this._state.listToolsCalls++
      if (this._state?.listToolsShouldFail) {
        throw new Error(this._state.listToolsError)
      }
      return { tools: this._state?.tools ?? [] }
    }

    async listPrompts() {
      if (this._state?.listPromptsShouldFail) {
        throw new Error("listPrompts failed")
      }
      return { prompts: this._state?.prompts ?? [] }
    }

    async listResources() {
      if (this._state?.listResourcesShouldFail) {
        throw new Error("listResources failed")
      }
      return { resources: this._state?.resources ?? [] }
    }

    async close() {
      if (this._state) this._state.closed = true
    }
  },
}))

beforeEach(() => {
  clientStates.clear()
  lastCreatedClientName = undefined
  connectShouldFail = false
  connectShouldHang = false
  connectError = "Mock transport cannot connect"
  clientCreateCount = 0
  transportCloseCount = 0
})

const { MCP } = await import("../../src/mcp/index")
const { Instance } = await import("../../src/project/instance")
const { tmpdir } = await import("../fixture/fixture")

function withInstance(config: Record<string, any>, fn: () => Promise<void>) {
  return async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          `${dir}/opencode.json`,
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            mcp: config,
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await fn()
        await Instance.dispose()
      },
    })
  }
}

test(
  "health check reconnects failed server",
  withInstance(
    {
      "recovering-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    async () => {
      connectShouldFail = true
      lastCreatedClientName = "recovering-server"

      await MCP.add("recovering-server", {
        type: "local",
        command: ["echo", "test"],
      })

      const status1 = await MCP.status()
      expect(status1["recovering-server"]?.status).toBe("failed")

      connectShouldFail = false
      lastCreatedClientName = "recovering-server"
      await MCP.add("recovering-server", {
        type: "local",
        command: ["echo", "test"],
      })

      const status2 = await MCP.status()
      expect(status2["recovering-server"]?.status).toBe("connected")
    },
  ),
)

test(
  "health check skips disabled servers",
  withInstance(
    {
      "disabled-server": {
        type: "local",
        command: ["echo", "test"],
        enabled: false,
      },
    },
    async () => {
      const countBefore = clientCreateCount

      await MCP.add("disabled-server", {
        type: "local",
        command: ["echo", "test"],
        enabled: false,
      } as any)

      expect(clientCreateCount).toBe(countBefore)

      const status = await MCP.status()
      expect(status["disabled-server"]?.status).toBe("disabled")

      await MCP.add("disabled-server", {
        type: "local",
        command: ["echo", "test"],
        enabled: false,
      } as any)

      expect(clientCreateCount).toBe(countBefore)
    },
  ),
)

test(
  "health check tracks status transitions correctly",
  withInstance(
    {
      "transition-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    async () => {
      connectShouldFail = true
      lastCreatedClientName = "transition-server"

      await MCP.add("transition-server", {
        type: "local",
        command: ["echo", "test"],
      })

      const status1 = await MCP.status()
      expect(status1["transition-server"]?.status).toBe("failed")

      connectShouldFail = false
      lastCreatedClientName = "transition-server"

      await MCP.add("transition-server", {
        type: "local",
        command: ["echo", "test"],
      })

      const status2 = await MCP.status()
      expect(status2["transition-server"]?.status).toBe("connected")

      const state = getOrCreateClientState("transition-server")
      expect(state.closed).toBe(false)
    },
  ),
)

test(
  "health check doesn't leak transports on repeated failures",
  withInstance(
    {
      "leaky-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    async () => {
      connectShouldFail = true

      const closeCountBefore = transportCloseCount

      for (let i = 0; i < 5; i++) {
        lastCreatedClientName = "leaky-server"
        await MCP.add("leaky-server", {
          type: "local",
          command: ["echo", "test"],
        })
      }

      expect(transportCloseCount).toBeGreaterThan(closeCountBefore)

      const status = await MCP.status()
      expect(status["leaky-server"]?.status).toBe("failed")
    },
  ),
)

test(
  "health check handles all servers failing gracefully",
  withInstance(
    {
      "failing-a": {
        type: "local",
        command: ["echo", "a"],
      },
      "failing-b": {
        type: "local",
        command: ["echo", "b"],
      },
      "failing-c": {
        type: "local",
        command: ["echo", "c"],
      },
    },
    async () => {
      connectShouldFail = true

      lastCreatedClientName = "failing-a"
      await MCP.add("failing-a", {
        type: "local",
        command: ["echo", "a"],
      })

      lastCreatedClientName = "failing-b"
      await MCP.add("failing-b", {
        type: "local",
        command: ["echo", "b"],
      })

      lastCreatedClientName = "failing-c"
      await MCP.add("failing-c", {
        type: "local",
        command: ["echo", "c"],
      })

      const status = await MCP.status()
      expect(status["failing-a"]?.status).toBe("failed")
      expect(status["failing-b"]?.status).toBe("failed")
      expect(status["failing-c"]?.status).toBe("failed")

      const tools = await MCP.tools()
      expect(tools).toBeDefined()
      expect(typeof tools).toBe("object")
    },
  ),
)

test(
  "health check closes old client when reconnecting",
  withInstance(
    {
      "reconnect-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    async () => {
      const state1 = getOrCreateClientState("reconnect-server")
      state1.tools = [{ name: "tool1", description: "first", inputSchema: { type: "object", properties: {} } }]

      connectShouldFail = false
      lastCreatedClientName = "reconnect-server"

      await MCP.add("reconnect-server", {
        type: "local",
        command: ["echo", "test"],
      })

      const status1 = await MCP.status()
      expect(status1["reconnect-server"]?.status).toBe("connected")
      expect(state1.closed).toBe(false)

      clientStates.delete("reconnect-server")
      const state2 = getOrCreateClientState("reconnect-server")
      state2.tools = [{ name: "tool2", description: "second", inputSchema: { type: "object", properties: {} } }]

      lastCreatedClientName = "reconnect-server"
      await MCP.add("reconnect-server", {
        type: "local",
        command: ["echo", "test"],
      })

      expect(state1.closed).toBe(true)
      expect(state2.closed).toBe(false)

      const status2 = await MCP.status()
      expect(status2["reconnect-server"]?.status).toBe("connected")
    },
  ),
)
