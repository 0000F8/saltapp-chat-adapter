// Open rooms (salt-api 0.8x, task contract): a chat with no end-to-end
// encryption. Covers plaintext in/out, encrypted/delivered_because exposed
// on the normalized Message's `raw` escape hatch (chat-sdk's
// MessageMetadata is a closed shape -- see adapter.ts's buildMessage), and
// interests (client.setChatSubscription applied the first time this
// adapter observes handling a given plain chat).
import { generateKeypair, encryptFor } from "salt-agent-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { SaltAdapter } from "../src/adapter";
import { encodeThreadId } from "../src/thread-id";
import { buildSignedWebhookRequest, FakeSaltApi } from "./helpers";
import type { ChatInstance, Message } from "chat";

const WEBHOOK_URL = "https://bot.example.com/webhooks/salt";

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
    processAction: () => Promise.resolve(),
  };
  return { chat: chat as unknown as ChatInstance, messages, settle: () => Promise.all(pending) };
}

describe("SaltAdapter open rooms", () => {
  let agentKeys: Awaited<ReturnType<typeof generateKeypair>>;
  let humanKeys: Awaited<ReturnType<typeof generateKeypair>>;
  const secret = "open-room-secret";

  beforeAll(async () => {
    agentKeys = await generateKeypair("agent-pass");
    humanKeys = await generateKeypair("human-pass");
  });

  function buildAdapter(api: FakeSaltApi): SaltAdapter {
    return new SaltAdapter({
      host: api.host,
      apiKey: "test-api-key",
      agentId: api.agentId,
      privateKey: agentKeys.privateKey,
      publicKey: agentKeys.publicKey,
      pgpPassphrase: "agent-pass",
      fetchImpl: api.fetchImpl,
    });
  }

  function openRoomBody(text: string, opts: { messageId?: string; senderId?: string; chatId?: string; deliveredBecause?: string } = {}) {
    return {
      chat: { id: opts.chatId ?? "room-1", name: "General", public: true, managed: false, open_invite: false, mode: "auto", encrypted: false },
      message: {
        chat_id: opts.chatId ?? "room-1",
        message_id: opts.messageId ?? "msg-open-1",
        message: text,
        encrypted: false,
        ...(opts.deliveredBecause ? { delivered_because: opts.deliveredBecause } : {}),
        user: { id: opts.senderId ?? "human-1", username: "dan", display_name: "Dan", account_type: "User" },
        created_at: new Date().toISOString(),
        seq: 1,
      },
    };
  }

  it("passes an open-room message straight through with no decrypt attempt, and exposes raw.encrypted === false", async () => {
    const api = new FakeSaltApi();
    api.webhookSecret = secret;
    const adapter = buildAdapter(api);
    const fake = createFakeChatInstance();
    await adapter.initialize(fake.chat);

    const body = openRoomBody("hello, this room has no encryption");
    const req = buildSignedWebhookRequest(WEBHOOK_URL, body, { agentId: api.agentId, secret });
    const res = await adapter.handleWebhook(req);
    expect(res.status).toBe(200);
    await fake.settle();

    expect(fake.messages).toHaveLength(1);
    const { message } = fake.messages[0]!;
    expect(message.text).toBe("hello, this room has no encryption");
    expect((message.raw as { encrypted?: boolean }).encrypted).toBe(false);
  });

  it("exposes delivered_because on raw when salt-api sends it", async () => {
    const api = new FakeSaltApi();
    api.webhookSecret = secret;
    const adapter = buildAdapter(api);
    const fake = createFakeChatInstance();
    await adapter.initialize(fake.chat);

    const body = openRoomBody("bot, what's the weather", { deliveredBecause: "keyword" });
    const req = buildSignedWebhookRequest(WEBHOOK_URL, body, { agentId: api.agentId, secret });
    await adapter.handleWebhook(req);
    await fake.settle();

    const { message } = fake.messages[0]!;
    expect((message.raw as { delivered_because?: string }).delivered_because).toBe("keyword");
  });

  it("marks an ordinary encrypted-chat message's raw.encrypted true (no delivered_because)", async () => {
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
    const adapter = buildAdapter(api);
    const fake = createFakeChatInstance();
    await adapter.initialize(fake.chat);

    const ciphertext = await encryptFor("hello from an encrypted chat", [agentKeys.publicKey]);
    const body = {
      chat: { id: "chat-1", name: null, public: false, managed: false, open_invite: false, mode: "auto" },
      message: {
        chat_id: "chat-1",
        message_id: "msg-1",
        message: ciphertext,
        user: { id: "human-1", username: "dan", display_name: "Dan", account_type: "User" },
        created_at: new Date().toISOString(),
        seq: 1,
      },
    };
    const req = buildSignedWebhookRequest(WEBHOOK_URL, body, { agentId: api.agentId, secret });
    await adapter.handleWebhook(req);
    await fake.settle();

    const { message } = fake.messages[0]!;
    expect((message.raw as { encrypted?: boolean }).encrypted).not.toBe(false);
    expect((message.raw as { delivered_because?: string }).delivered_because).toBeUndefined();
  });

  it("posts a reply into an open room via postPlainMessage (no PGP), never through the encrypted path", async () => {
    const api = new FakeSaltApi();
    api.webhookSecret = secret;
    api.setChat({ id: "room-1", session: { users: [] }, messages: [] });
    const adapter = buildAdapter(api);
    const fake = createFakeChatInstance();
    await adapter.initialize(fake.chat);

    // Observe the room as open first, the way an inbound message would.
    const body = openRoomBody("hi");
    const req = buildSignedWebhookRequest(WEBHOOK_URL, body, { agentId: api.agentId, secret });
    await adapter.handleWebhook(req);
    await fake.settle();

    await adapter.postMessage(encodeThreadId({ chatId: "room-1" }), "the weather here is sunny");

    expect(api.postedMessages).toHaveLength(1);
    expect(api.postedMessages[0]!.message).toBe("the weather here is sunny");
    expect(api.postedMessages[0]!.sender_message).toBeUndefined(); // postPlainMessage sends no sender_message
  });

  it("still encrypts a reply into a chat never observed as open (the safe default)", async () => {
    const api = new FakeSaltApi();
    api.webhookSecret = secret;
    api.setChat({
      id: "chat-1",
      session: { users: [{ id: "human-1", username: "dan", display_name: "Dan", account_type: "User", public_key: humanKeys.publicKey }] },
      messages: [],
    });
    const adapter = buildAdapter(api);
    const fake = createFakeChatInstance();
    await adapter.initialize(fake.chat);

    await adapter.postMessage(encodeThreadId({ chatId: "chat-1" }), "encrypted by default");

    expect(api.postedMessages).toHaveLength(1);
    // A PGP-armored blob, not the plain text.
    expect(api.postedMessages[0]!.message).toMatch(/^-----BEGIN PGP MESSAGE/);
  });
});

describe("SaltAdapter interests (open-room subscription)", () => {
  let agentKeys: Awaited<ReturnType<typeof generateKeypair>>;
  const secret = "interests-secret";

  beforeAll(async () => {
    agentKeys = await generateKeypair("agent-pass");
  });

  function openRoomBody(chatId: string, messageId: string) {
    return {
      chat: { id: chatId, name: "General", public: true, managed: false, open_invite: false, mode: "auto", encrypted: false },
      message: {
        chat_id: chatId,
        message_id: messageId,
        message: "hello",
        encrypted: false,
        user: { id: "human-1", username: "dan", display_name: "Dan", account_type: "User" },
        created_at: new Date().toISOString(),
        seq: 1,
      },
    };
  }

  it("calls setChatSubscription once, the first time this adapter observes an open room, when a non-default mode is configured", async () => {
    const api = new FakeSaltApi();
    api.webhookSecret = secret;
    const adapter = new SaltAdapter({
      host: api.host,
      apiKey: "test-api-key",
      agentId: api.agentId,
      privateKey: agentKeys.privateKey,
      publicKey: agentKeys.publicKey,
      pgpPassphrase: "agent-pass",
      fetchImpl: api.fetchImpl,
      subscriptionMode: "keywords",
      subscriptionKeywords: ["weather", "price"],
    });
    const fake = createFakeChatInstance();
    await adapter.initialize(fake.chat);

    const req1 = buildSignedWebhookRequest("https://bot.example.com/webhooks/salt", openRoomBody("room-1", "m1"), { agentId: api.agentId, secret });
    await adapter.handleWebhook(req1);
    const req2 = buildSignedWebhookRequest("https://bot.example.com/webhooks/salt", openRoomBody("room-1", "m2"), { agentId: api.agentId, secret });
    await adapter.handleWebhook(req2);
    await fake.settle();

    expect(api.subscriptionCalls).toEqual([{ chatId: "room-1", mode: "keywords", keywords: ["weather", "price"] }]);
  });

  it("never calls setChatSubscription for an ordinary encrypted chat", async () => {
    const api = new FakeSaltApi();
    api.webhookSecret = secret;
    api.setChat({ id: "chat-1", session: { users: [] }, messages: [] });
    const adapter = new SaltAdapter({
      host: api.host,
      apiKey: "test-api-key",
      agentId: api.agentId,
      privateKey: agentKeys.privateKey,
      publicKey: agentKeys.publicKey,
      pgpPassphrase: "agent-pass",
      fetchImpl: api.fetchImpl,
      subscriptionMode: "keywords",
      subscriptionKeywords: ["weather"],
    });
    const fake = createFakeChatInstance();
    await adapter.initialize(fake.chat);

    const ciphertext = await encryptFor("hi", [agentKeys.publicKey]);
    const body = {
      chat: { id: "chat-1", name: null, public: false, managed: false, open_invite: false, mode: "auto" },
      message: {
        chat_id: "chat-1",
        message_id: "m1",
        message: ciphertext,
        user: { id: "human-1", username: "dan", display_name: "Dan", account_type: "User" },
        created_at: new Date().toISOString(),
        seq: 1,
      },
    };
    const req = buildSignedWebhookRequest("https://bot.example.com/webhooks/salt", body, { agentId: api.agentId, secret });
    await adapter.handleWebhook(req);
    await fake.settle();

    expect(api.subscriptionCalls).toHaveLength(0);
  });

  it("never calls setChatSubscription when no subscriptionMode is configured (the default)", async () => {
    const api = new FakeSaltApi();
    api.webhookSecret = secret;
    const adapter = new SaltAdapter({
      host: api.host,
      apiKey: "test-api-key",
      agentId: api.agentId,
      privateKey: agentKeys.privateKey,
      publicKey: agentKeys.publicKey,
      pgpPassphrase: "agent-pass",
      fetchImpl: api.fetchImpl,
    });
    const fake = createFakeChatInstance();
    await adapter.initialize(fake.chat);

    const req = buildSignedWebhookRequest("https://bot.example.com/webhooks/salt", openRoomBody("room-1", "m1"), { agentId: api.agentId, secret });
    await adapter.handleWebhook(req);
    await fake.settle();

    expect(api.subscriptionCalls).toHaveLength(0);
  });
});
