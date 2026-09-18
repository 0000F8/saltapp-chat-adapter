import { generateKeypair } from "salt-agent-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { SaltAdapter } from "../src/adapter";
import { encodeSaltActionId } from "../src/action-id";
import { encodeThreadId } from "../src/thread-id";
import type { ActionEvent, ChatInstance, Message } from "chat";
import { encryptFor } from "salt-agent-sdk";
import { buildSignedWebhookRequest, FakeSaltApi } from "./helpers";

const WEBHOOK_URL = "https://bot.example.com/webhooks/salt";

/** A minimal ChatInstance test double. Only processMessage/processAction/getUserName are ever called by SaltAdapter. */
function createFakeChatInstance() {
  const pending: Promise<unknown>[] = [];
  const messages: Array<{ threadId: string; message: Message }> = [];
  const actions: Array<Omit<ActionEvent, "thread" | "openModal"> & { adapter: unknown }> = [];

  const chat = {
    getUserName: () => "bot",
    processMessage: (
      _adapter: unknown,
      threadId: string,
      message: Message | (() => Promise<Message>)
    ) => {
      const p = (async () => {
        const resolved = typeof message === "function" ? await message() : message;
        messages.push({ threadId, message: resolved });
      })();
      pending.push(p);
      return p;
    },
    processAction: (event: Omit<ActionEvent, "thread" | "openModal"> & { adapter: unknown }) => {
      const p = (async () => {
        actions.push(event);
      })();
      pending.push(p);
      return p;
    },
  };

  return {
    chat: chat as unknown as ChatInstance,
    messages,
    actions,
    settle: () => Promise.all(pending),
  };
}

describe("SaltAdapter.handleWebhook", () => {
  let api: FakeSaltApi;
  let agentKeys: Awaited<ReturnType<typeof generateKeypair>>;
  let humanKeys: Awaited<ReturnType<typeof generateKeypair>>;
  const secret = "webhook-signing-secret";

  beforeAll(async () => {
    agentKeys = await generateKeypair("agent-pass");
    humanKeys = await generateKeypair("human-pass");
  });

  function buildAdapter() {
    api = new FakeSaltApi();
    api.webhookSecret = secret;
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

  it("normalizes a signed message webhook into a decrypted chat-sdk Message", async () => {
    const adapter = buildAdapter();
    const fake = createFakeChatInstance();
    await adapter.initialize(fake.chat);

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

    const ciphertext = await encryptFor("hello from a human", [agentKeys.publicKey]);
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
    const res = await adapter.handleWebhook(req);
    expect(res.status).toBe(200);

    await fake.settle();

    expect(fake.messages).toHaveLength(1);
    const [{ threadId, message }] = fake.messages;
    expect(threadId).toBe(encodeThreadId({ chatId: "chat-1" }));
    expect(message.text).toBe("hello from a human");
    expect(message.author.userId).toBe("human-1");
    expect(message.author.isBot).toBe(false);
    expect(message.author.isMe).toBe(false);
    // Salt's own server never delivers a group message webhook to an agent
    // unless it was @mentioned -- so a delivered message is a mention by construction.
    expect(message.isMention).toBe(true);
  });

  it("rejects a webhook whose signature doesn't match (unsigned or tampered)", async () => {
    const adapter = buildAdapter();
    const fake = createFakeChatInstance();
    await adapter.initialize(fake.chat);

    const body = {
      chat: { id: "chat-1" },
      message: {
        chat_id: "chat-1",
        message_id: "msg-bad-sig",
        message: "not even ciphertext",
        user: { id: "human-1", username: "dan", display_name: "Dan", account_type: "User" },
        created_at: new Date().toISOString(),
      },
    };
    // Signed with the WRONG secret.
    const req = buildSignedWebhookRequest(WEBHOOK_URL, body, { agentId: api.agentId, secret: "wrong-secret" });
    const res = await adapter.handleWebhook(req);
    expect(res.status).toBe(401);

    await fake.settle();
    expect(fake.messages).toHaveLength(0);
  });

  it("never dispatches a self-authored (echoed) message", async () => {
    const adapter = buildAdapter();
    const fake = createFakeChatInstance();
    await adapter.initialize(fake.chat);

    const ciphertext = await encryptFor("echo of my own reply", [agentKeys.publicKey]);
    const body = {
      chat: { id: "chat-1" },
      message: {
        chat_id: "chat-1",
        message_id: "msg-echo",
        message: ciphertext,
        user: { id: api.agentId, username: "bot", display_name: "Bot", account_type: "Agent" },
        created_at: new Date().toISOString(),
      },
    };
    const req = buildSignedWebhookRequest(WEBHOOK_URL, body, { agentId: api.agentId, secret });
    const res = await adapter.handleWebhook(req);
    expect(res.status).toBe(200);
    await fake.settle();
    expect(fake.messages).toHaveLength(0);
  });

  it("ignores a system event message (event_type set) rather than treating it as a prompt", async () => {
    const adapter = buildAdapter();
    const fake = createFakeChatInstance();
    await adapter.initialize(fake.chat);

    const body = {
      chat: { id: "chat-1" },
      message: {
        chat_id: "chat-1",
        message_id: "msg-event",
        message: "member_added",
        event_type: "member_added",
        user: { id: "human-1", username: "dan", display_name: "Dan", account_type: "User" },
        created_at: new Date().toISOString(),
      },
    };
    const req = buildSignedWebhookRequest(WEBHOOK_URL, body, { agentId: api.agentId, secret });
    await adapter.handleWebhook(req);
    await fake.settle();
    expect(fake.messages).toHaveLength(0);
  });

  it("does not reprocess a retried delivery carrying the same X-Salt-Delivery-Id", async () => {
    const adapter = buildAdapter();
    const fake = createFakeChatInstance();
    await adapter.initialize(fake.chat);

    const ciphertext = await encryptFor("hi", [agentKeys.publicKey]);
    const body = {
      chat: { id: "chat-1" },
      message: {
        chat_id: "chat-1",
        message_id: "msg-retry",
        message: ciphertext,
        user: { id: "human-1", username: "dan", display_name: "Dan", account_type: "User" },
        created_at: new Date().toISOString(),
      },
    };
    const req1 = buildSignedWebhookRequest(WEBHOOK_URL, body, { agentId: api.agentId, secret, deliveryId: "delivery-1" });
    const req2 = buildSignedWebhookRequest(WEBHOOK_URL, body, { agentId: api.agentId, secret, deliveryId: "delivery-1" });

    await adapter.handleWebhook(req1);
    await adapter.handleWebhook(req2);
    await fake.settle();

    expect(fake.messages).toHaveLength(1);
  });

  it("dispatches a card button tap as a processAction event with the decoded action id and value", async () => {
    const adapter = buildAdapter();
    const fake = createFakeChatInstance();
    await adapter.initialize(fake.chat);

    const actionId = encodeSaltActionId("buy", "sku-7");
    const body = {
      type: "card_interaction",
      owner_id: api.agentId,
      chat_id: "chat-1",
      card_id: "card-9",
      action_id: actionId,
      user: { id: "human-1", username: "dan", display_name: "Dan", account_type: "User" },
    };
    const req = buildSignedWebhookRequest(WEBHOOK_URL, body, { agentId: api.agentId, secret });
    const res = await adapter.handleWebhook(req);
    expect(res.status).toBe(200);
    await fake.settle();

    expect(fake.actions).toHaveLength(1);
    const [action] = fake.actions;
    expect(action.actionId).toBe("buy");
    expect(action.value).toBe("sku-7");
    expect(action.threadId).toBe(encodeThreadId({ chatId: "chat-1" }));
    expect((action.user as { userId: string }).userId).toBe("human-1");
  });
});
