import { generateKeypair, encryptFor, MemoryCursorStore, MemoryDedupeStore } from "salt-agent-sdk";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { SaltAdapter } from "../src/adapter";
import { createSaltSocketPoller } from "../src/socket";
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

/** Polls a real (short) interval until `predicate()` is true or `timeoutMs` elapses -- the socket poller's async chain (fetch -> verify -> decrypt) has no single promise this test can await directly. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe("SaltAdapter construction", () => {
  it("throws when a required field is missing", () => {
    const { host, ...rest } = BASE_CONFIG;
    expect(() => new SaltAdapter(rest as unknown as typeof BASE_CONFIG)).toThrow(/host is required/);
  });

  it("throws on an unrecognized delivery mode", () => {
    expect(() => new SaltAdapter({ ...BASE_CONFIG, mode: "carrier-pigeon" as never })).toThrow(/Invalid mode/);
  });

  it('constructs successfully for mode: "socket" now that salt-agent-sdk >= 0.8 is installed', () => {
    // socket.ts's assertSocketModeSupported() re-checks the installed
    // salt-agent-sdk's own declared version at construction time; the
    // adapter no longer throws once that's >= MIN_SOCKET_SDK_VERSION
    // (package.json pins ^0.8.0, and this repo's node_modules is a real
    // 0.8.0 checkout -- see getInstalledSaltAgentSdkVersion's own test
    // below). The poller itself only starts on initialize().
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
  });

  it("reads the real installed salt-agent-sdk's own declared version", () => {
    // Whatever is actually installed today -- this just proves the reader works,
    // not any particular version.
    expect(getInstalledSaltAgentSdkVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("createSaltSocketPoller", () => {
  function fakeLogger() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
  }

  it("fetches, verifies, and hands each row's (headers, rawBody) to onEnvelope, then persists the cursor", async () => {
    const extra = { fetchAgentUpdates: vi.fn() };
    extra.fetchAgentUpdates.mockResolvedValueOnce({
      updates: [{ id: 5, delivery_id: "d-5", event: "message", headers: { "X-Salt-Signature": "t=1,v1=x" }, body: "{}", created_at: "now" }],
      cursor: 5,
    });
    extra.fetchAgentUpdates.mockResolvedValue({ updates: [], cursor: 5 }); // subsequent polls, until stop()

    const cursorStore = MemoryCursorStore();
    const dedupeStore = MemoryDedupeStore();
    const onEnvelope = vi.fn().mockResolvedValue(undefined);
    const logger = fakeLogger();

    const poller = createSaltSocketPoller({
      host: "https://fake.saltapp.test",
      apiKey: "key",
      agentId: "agent-1",
      extra: extra as never,
      logger: logger as never,
      cursorStore,
      dedupeStore,
      onEnvelope,
    });

    poller.start();
    await waitFor(() => onEnvelope.mock.calls.length > 0);
    await poller.stop();

    expect(onEnvelope).toHaveBeenCalledTimes(1);
    expect(onEnvelope).toHaveBeenCalledWith({ "X-Salt-Signature": "t=1,v1=x" }, "{}");
    expect(await cursorStore.get("agent-1")).toBe(5);
  });

  it("omits `after` on a fresh cursor and sends the real cursor afterward", async () => {
    const seenAfters: Array<number | undefined> = [];
    const extra = {
      fetchAgentUpdates: vi.fn().mockImplementation(async (_apiKey: string, opts: { after?: number }) => {
        seenAfters.push(opts.after);
        if (seenAfters.length === 1) return { updates: [{ id: 1, delivery_id: "d-1", event: "message", headers: {}, body: "{}", created_at: "now" }], cursor: 1 };
        return { updates: [], cursor: 1 };
      }),
    };

    const poller = createSaltSocketPoller({
      host: "https://fake.saltapp.test",
      apiKey: "key",
      agentId: "agent-1",
      extra: extra as never,
      logger: fakeLogger() as never,
      cursorStore: MemoryCursorStore(),
      dedupeStore: MemoryDedupeStore(),
      onEnvelope: vi.fn().mockResolvedValue(undefined),
    });

    poller.start();
    await waitFor(() => seenAfters.length >= 2);
    await poller.stop();

    expect(seenAfters[0]).toBeUndefined();
    expect(seenAfters[1]).toBe(1);
  });

  it("skips a delivery already recorded in the dedupe store", async () => {
    const extra = { fetchAgentUpdates: vi.fn() };
    extra.fetchAgentUpdates.mockResolvedValueOnce({
      updates: [{ id: 1, delivery_id: "dup-1", event: "message", headers: {}, body: "{}", created_at: "now" }],
      cursor: 1,
    });
    extra.fetchAgentUpdates.mockResolvedValue({ updates: [], cursor: 1 });

    const dedupeStore = MemoryDedupeStore();
    await dedupeStore.add("agent-1", "dup-1"); // already processed, e.g. by a previous run

    const onEnvelope = vi.fn().mockResolvedValue(undefined);
    const poller = createSaltSocketPoller({
      host: "https://fake.saltapp.test",
      apiKey: "key",
      agentId: "agent-1",
      extra: extra as never,
      logger: fakeLogger() as never,
      cursorStore: MemoryCursorStore(),
      dedupeStore,
      onEnvelope,
    });

    poller.start();
    await waitFor(() => extra.fetchAgentUpdates.mock.calls.length >= 2);
    await poller.stop();

    expect(onEnvelope).not.toHaveBeenCalled();
  });

  it("stop() is idempotent and start() is a no-op while already running", async () => {
    const extra = { fetchAgentUpdates: vi.fn().mockResolvedValue({ updates: [], cursor: 0 }) };
    const poller = createSaltSocketPoller({
      host: "https://fake.saltapp.test",
      apiKey: "key",
      agentId: "agent-1",
      extra: extra as never,
      logger: fakeLogger() as never,
      cursorStore: MemoryCursorStore(),
      dedupeStore: MemoryDedupeStore(),
      onEnvelope: vi.fn().mockResolvedValue(undefined),
    });

    poller.start();
    poller.start(); // no-op
    await waitFor(() => extra.fetchAgentUpdates.mock.calls.length > 0);
    await poller.stop();
    await poller.stop(); // no-op, must not throw
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

  it("initialize() starts the poller, which decrypts a queued outbox row into a chat-sdk Message; disconnect() stops it", async () => {
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
    api.queueAgentUpdate({ event: "message", headers: envelope.headers, body: envelope.rawBody, created_at: new Date().toISOString() });

    await adapter.initialize(fake.chat);
    await waitFor(() => fake.messages.length > 0);
    await fake.settle();
    await adapter.disconnect();

    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]!.message.text).toBe("hello over the socket");
    // The poller's own dedupe advanced past this delivery -- a second
    // initialize() against the same (now-empty) outbox must not redeliver it.
    expect(api.agentUpdates).toHaveLength(1);
  }, 10000);
});
