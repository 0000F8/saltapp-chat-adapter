import { generateKeypair, encryptFor, MemoryCursorStore, MemoryDedupeStore } from "salt-agent-sdk";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { SaltAdapter } from "../src/adapter";
import { createSaltSocketClient } from "../src/socket";
import { getInstalledSaltAgentSdkVersion, isAtLeast, MIN_SOCKET_SDK_VERSION } from "../src/socket";
import { buildSignedAgentUpdateEnvelope, FakeSaltApi } from "./helpers";
import type { ActionEvent, ChatInstance, Message } from "chat";

const BASE_CONFIG = {
  host: "https://fake.saltapp.test",
  apiKey: "key",
  agentId: "agent-1",
  privateKey: "priv",
  publicKey: "pub",
  pgpPassphrase: "pass",
};

/** A minimal ChatInstance test double, same shape webhook.test.ts uses. */
function createFakeChatInstance() {
  const pending: Promise<unknown>[] = [];
  const messages: Array<{ threadId: string; message: Message }> = [];

  const chat = {
    getUserName: () => "bot",
    processMessage: (_adapter: unknown, threadId: string, message: Message | (() => Promise<Message>)) => {
      const p = (async () => {
        const resolved = typeof message === "function" ? await message() : message;
        messages.push({ threadId, message: resolved });
      })();
      pending.push(p);
      return p;
    },
    processAction: (_event: Omit<ActionEvent, "thread" | "openModal"> & { adapter: unknown }) => Promise.resolve(),
  };

  return { chat: chat as unknown as ChatInstance, messages, settle: () => Promise.all(pending) };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

type Listener = (...args: unknown[]) => void;

/** A minimal stand-in for `ws`'s WebSocket -- enough of the surface
 *  socket.ts actually uses (`on`, `send`, `terminate`, `close`) plus test
 *  helpers to simulate the server side (`serverOpen`, `serverSend`,
 *  `serverClose`), so these tests drive the real Action Cable frame
 *  sequence (subscribe/replay/replay_done/reconnect) with no real network
 *  connection. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  listeners = new Map<string, Listener[]>();
  sent: string[] = [];

  constructor(url: string, _opts: unknown) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  on(event: string, listener: Listener): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }
  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  terminate(): void {
    this.emit("close");
  }
  close(): void {
    this.emit("close");
  }
  serverOpen(): void {
    this.emit("open");
  }
  serverSend(frame: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }
  serverClose(): void {
    this.emit("close");
  }
}

function subscribeIdentifier(sent: string[]): { after?: number } | undefined {
  const cmd = sent.map((s) => JSON.parse(s)).find((f) => f.command === "subscribe");
  if (!cmd) return undefined;
  return JSON.parse(cmd.identifier);
}

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("SaltAdapter construction", () => {
  it("throws when a required field is missing", () => {
    const { host, ...rest } = BASE_CONFIG;
    expect(() => new SaltAdapter(rest as unknown as typeof BASE_CONFIG)).toThrow(/host is required/);
  });

  it("throws on an unrecognized delivery mode", () => {
    expect(() => new SaltAdapter({ ...BASE_CONFIG, mode: "carrier-pigeon" as never })).toThrow(/Invalid mode/);
  });

  it('constructs successfully for mode: "socket" now that salt-agent-sdk >= 0.10 is installed', () => {
    // socket.ts's assertSocketModeSupported() re-checks the installed
    // salt-agent-sdk's own declared version at construction time; the
    // adapter no longer throws once that's >= MIN_SOCKET_SDK_VERSION
    // (package.json pins ^0.10.0, and this repo's node_modules resolves to
    // a real 0.10.0 checkout -- see getInstalledSaltAgentSdkVersion's own
    // test below). The socket connection itself only starts on initialize().
    expect(() => new SaltAdapter({ ...BASE_CONFIG, mode: "socket" })).not.toThrow();
  });

  it("accepts the default webhook mode with no extra config", () => {
    expect(() => new SaltAdapter(BASE_CONFIG)).not.toThrow();
  });
});

describe("socket.ts version comparison", () => {
  it("compares major.minor.patch correctly", () => {
    expect(isAtLeast("0.8.0", "0.8.0")).toBe(true);
    expect(isAtLeast("0.8.1", "0.8.0")).toBe(true);
    expect(isAtLeast("0.9.0", "0.8.0")).toBe(true);
    expect(isAtLeast("1.0.0", "0.8.0")).toBe(true);
    expect(isAtLeast("0.7.9", "0.8.0")).toBe(false);
    expect(isAtLeast("0.7.1", "0.8.0")).toBe(false);
    expect(isAtLeast(MIN_SOCKET_SDK_VERSION, MIN_SOCKET_SDK_VERSION)).toBe(true);
  });

  it("reads the real installed salt-agent-sdk's own declared version", () => {
    // Whatever is actually installed today -- this just proves the reader works,
    // not any particular version.
    expect(getInstalledSaltAgentSdkVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("createSaltSocketClient", () => {
  function fakeLogger() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
  }

  it("subscribes with no `after` on a fresh cursor, hands a replayed row's (headers, rawBody) to onEnvelope, and persists the cursor from replay_done -- no HTTP polling", async () => {
    FakeWebSocket.instances = [];
    const extra = { fetchAgentUpdates: vi.fn() };
    const cursorStore = MemoryCursorStore();
    const dedupeStore = MemoryDedupeStore();
    const onEnvelope = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();

    const client = createSaltSocketClient({
      host: "https://fake.saltapp.test",
      apiKey: "key",
      agentId: "agent-1",
      extra: extra as never,
      logger: logger as never,
      cursorStore,
      dedupeStore,
      onEnvelope,
      webSocketImpl: FakeWebSocket as never,
    });
    client.start();
    await flush();

    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toBe("wss://fake.saltapp.test/cable");
    ws.serverOpen();
    await flush();
    expect(subscribeIdentifier(ws.sent)?.after).toBeUndefined();

    ws.serverSend({ message: { id: 5, delivery_id: "d-5", event: "message", headers: { "X-Salt-Signature": "t=1,v1=x" }, body: "{}", created_at: "now" } });
    ws.serverSend({ message: { type: "replay_done", cursor: 5, more: false } });
    await flush();

    expect(onEnvelope).toHaveBeenCalledTimes(1);
    expect(onEnvelope).toHaveBeenCalledWith({ "X-Salt-Signature": "t=1,v1=x" }, "{}");
    expect(await cursorStore.get("agent-1")).toBe(5);
    expect(extra.fetchAgentUpdates).not.toHaveBeenCalled(); // never polled

    await client.stop();
  });

  it("resubscribes with the persisted cursor as `after` instead of replaying from scratch", async () => {
    FakeWebSocket.instances = [];
    const cursorStore = MemoryCursorStore();
    await cursorStore.put("agent-1", 1);

    const client = createSaltSocketClient({
      host: "https://fake.saltapp.test",
      apiKey: "key",
      agentId: "agent-1",
      extra: { fetchAgentUpdates: vi.fn() } as never,
      logger: fakeLogger() as never,
      cursorStore,
      dedupeStore: MemoryDedupeStore(),
      onEnvelope: vi.fn().mockResolvedValue(undefined),
      webSocketImpl: FakeWebSocket as never,
    });
    client.start();
    await flush();
    const ws = FakeWebSocket.instances[0]!;
    ws.serverOpen();
    await flush();
    expect(subscribeIdentifier(ws.sent)?.after).toBe(1);
    await client.stop();
  });

  it("skips a delivery already recorded in the dedupe store", async () => {
    FakeWebSocket.instances = [];
    const dedupeStore = MemoryDedupeStore();
    await dedupeStore.add("agent-1", "dup-1"); // already processed, e.g. by a previous run

    const onEnvelope = vi.fn().mockResolvedValue(undefined);
    const client = createSaltSocketClient({
      host: "https://fake.saltapp.test",
      apiKey: "key",
      agentId: "agent-1",
      extra: { fetchAgentUpdates: vi.fn() } as never,
      logger: fakeLogger() as never,
      cursorStore: MemoryCursorStore(),
      dedupeStore,
      onEnvelope,
      webSocketImpl: FakeWebSocket as never,
    });
    client.start();
    await flush();
    const ws = FakeWebSocket.instances[0]!;
    ws.serverOpen();
    await flush();
    ws.serverSend({ message: { id: 1, delivery_id: "dup-1", event: "message", headers: {}, body: "{}", created_at: "now" } });
    ws.serverSend({ message: { type: "replay_done", cursor: 1, more: false } });
    await flush();

    expect(onEnvelope).not.toHaveBeenCalled();
    await client.stop();
  });

  it("stop() is idempotent and start() is a no-op while already running", async () => {
    FakeWebSocket.instances = [];
    const client = createSaltSocketClient({
      host: "https://fake.saltapp.test",
      apiKey: "key",
      agentId: "agent-1",
      extra: { fetchAgentUpdates: vi.fn() } as never,
      logger: fakeLogger() as never,
      cursorStore: MemoryCursorStore(),
      dedupeStore: MemoryDedupeStore(),
      onEnvelope: vi.fn().mockResolvedValue(undefined),
      webSocketImpl: FakeWebSocket as never,
    });
    client.start();
    client.start(); // no-op
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    await client.stop();
    await client.stop(); // no-op, must not throw
  });

  it("never fires a single HTTP request while idle and caught up -- no setInterval/sleep-poll mechanic", async () => {
    FakeWebSocket.instances = [];
    const extra = { fetchAgentUpdates: vi.fn() };
    const client = createSaltSocketClient({
      host: "https://fake.saltapp.test",
      apiKey: "key",
      agentId: "agent-1",
      extra: extra as never,
      logger: fakeLogger() as never,
      cursorStore: MemoryCursorStore(),
      dedupeStore: MemoryDedupeStore(),
      onEnvelope: vi.fn().mockResolvedValue(undefined),
      webSocketImpl: FakeWebSocket as never,
    });
    client.start();
    await flush();
    const ws = FakeWebSocket.instances[0]!;
    ws.serverOpen();
    await flush();
    ws.serverSend({ message: { type: "replay_done", cursor: 0, more: false } });
    await flush();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(extra.fetchAgentUpdates).not.toHaveBeenCalled();

    await client.stop();
  });
});

describe("SaltAdapter socket mode end to end", () => {
  let agentKeys: Awaited<ReturnType<typeof generateKeypair>>;
  let humanKeys: Awaited<ReturnType<typeof generateKeypair>>;
  const secret = "socket-signing-secret";

  beforeAll(async () => {
    agentKeys = await generateKeypair("agent-pass");
    humanKeys = await generateKeypair("human-pass");
  });

  it("initialize() holds a live socket that decrypts a pushed envelope into a chat-sdk Message; disconnect() stops it", async () => {
    FakeWebSocket.instances = [];
    const api = new FakeSaltApi();
    api.webhookSecret = secret;
    api.setChat({
      id: "chat-1",
      session: {
        users: [
          { id: api.agentId, username: "bot", display_name: "Bot", account_type: "Agent", public_key: agentKeys.publicKey },
          { id: "human-1", username: "dan", display_name: "Dan", account_type: "User", public_key: humanKeys.publicKey },
        ],
      },
      messages: [],
    });

    const adapter = new SaltAdapter({
      host: api.host,
      apiKey: "test-api-key",
      agentId: api.agentId,
      privateKey: agentKeys.privateKey,
      publicKey: agentKeys.publicKey,
      pgpPassphrase: "agent-pass",
      fetchImpl: api.fetchImpl,
      mode: "socket",
      cursorStore: MemoryCursorStore(),
      dedupeStore: MemoryDedupeStore(),
      webSocketImpl: FakeWebSocket as never,
    });
    const fake = createFakeChatInstance();

    const ciphertext = await encryptFor("hello over the socket", [agentKeys.publicKey]);
    const body = {
      chat: { id: "chat-1", name: null, public: false, managed: false, open_invite: false, mode: "auto" },
      message: {
        chat_id: "chat-1",
        message_id: "msg-socket-1",
        message: ciphertext,
        user: { id: "human-1", username: "dan", display_name: "Dan", account_type: "User" },
        created_at: new Date().toISOString(),
        seq: 1,
      },
    };
    const envelope = buildSignedAgentUpdateEnvelope(body, { agentId: api.agentId, secret, deliveryId: "delivery-socket-1" });

    await adapter.initialize(fake.chat);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0]!;
    ws.serverOpen();
    await flush();
    ws.serverSend({
      message: { id: 1, delivery_id: envelope.headers["X-Salt-Delivery-Id"], event: "message", headers: envelope.headers, body: envelope.rawBody, created_at: new Date().toISOString() },
    });
    ws.serverSend({ message: { type: "replay_done", cursor: 1, more: false } });

    await waitFor(() => fake.messages.length > 0);
    await fake.settle();
    await adapter.disconnect();

    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]!.message.text).toBe("hello over the socket");
    // No poll ever happened against the outbox endpoint.
    expect(api.agentUpdatesAfterSeen).toHaveLength(0);
  }, 10000);
});
