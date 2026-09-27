import { createHmac } from "node:crypto";
import { generateKeypair } from "salt-agent-sdk";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

// Regression coverage for the webhook-hardening fix.
//
// getWebhookSecret() caches forever once ANY fetch returns a truthy
// secret (`if (this.webhookSecret) return this.webhookSecret;`), so a
// garbage POST arriving after that point was already free even before
// this fix -- the real amplification only shows up while no secret has
// EVER been successfully cached yet (right after this adapter starts,
// or while Salt's fetch keeps coming back empty/erroring). In that
// state, `processEnvelope` used to call getWebhookSecret() UNCONDITIONALLY
// on every single POST -- including ones with no signature at all, which
// never needed a secret to reject -- with no cooldown between attempts.
// Every test below leaves `api.webhookSecret` unset to put the adapter in
// exactly that persistently-uncached state.
describe("SaltAdapter.handleWebhook: cost of a rejected signature while no secret is cached yet", () => {
  let api: FakeSaltApi;
  let agentKeys: Awaited<ReturnType<typeof generateKeypair>>;

  beforeAll(async () => {
    agentKeys = await generateKeypair("agent-pass");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Wraps a FakeSaltApi's fetchImpl to count real
   *  GET /api/v1/agents/webhook_secret calls, without touching the
   *  shared test helper. `api.webhookSecret` is deliberately left unset --
   *  see this block's header comment. */
  function buildCountingAdapter(): { adapter: SaltAdapter; secretFetchCount: () => number } {
    api = new FakeSaltApi();
    let count = 0;
    const inner = api.fetchImpl;
    const counting = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/api/v1/agents/webhook_secret")) count += 1;
      return inner(url as never, init);
    }) as unknown as typeof fetch;

    const adapter = new SaltAdapter({
      host: api.host,
      apiKey: "test-api-key",
      agentId: api.agentId,
      privateKey: agentKeys.privateKey,
      publicKey: agentKeys.publicKey,
      pgpPassphrase: "agent-pass",
      fetchImpl: counting,
    });
    return { adapter, secretFetchCount: () => count };
  }

  function requestWith(headers: Record<string, string> = {}, body?: string): Request {
    return new Request(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Salt-Agent-Id": api.agentId, ...headers },
      body: body ?? JSON.stringify({ chat: { id: "chat-1" }, message: { chat_id: "chat-1", message_id: "m1" } }),
    });
  }

  it("spends zero network calls on a POST with no X-Salt-Signature header at all", async () => {
    const { adapter, secretFetchCount } = buildCountingAdapter();
    const res = await adapter.handleWebhook(requestWith());
    expect(res.status).toBe(401);
    expect(secretFetchCount()).toBe(0);
  });

  it("spends zero network calls on a malformed signature header", async () => {
    const { adapter, secretFetchCount } = buildCountingAdapter();
    const res = await adapter.handleWebhook(requestWith({ "X-Salt-Signature": "not-a-real-signature" }));
    expect(res.status).toBe(401);
    expect(secretFetchCount()).toBe(0);
  });

  it("spends zero network calls on a wildly stale (but well-formed) signature", async () => {
    const { adapter, secretFetchCount } = buildCountingAdapter();
    const body = JSON.stringify({ chat: { id: "chat-1" }, message: { chat_id: "chat-1", message_id: "m1" } });
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
    const v1 = createHmac("sha256", "whatever-secret-would-be").update(`${twoHoursAgo}.${body}`).digest("hex");
    const req = requestWith({ "X-Salt-Signature": `t=${twoHoursAgo},v1=${v1}` }, body);
    const res = await adapter.handleWebhook(req);
    expect(res.status).toBe(401);
    expect(secretFetchCount()).toBe(0);
  });

  it("25 garbage POSTs in a row never accumulate a single network call", async () => {
    const { adapter, secretFetchCount } = buildCountingAdapter();
    for (let i = 0; i < 25; i++) {
      const res = await adapter.handleWebhook(requestWith({ "X-Salt-Signature": "garbage" }));
      expect(res.status).toBe(401);
    }
    expect(secretFetchCount()).toBe(0);
  });

  it("a sustained flood of well-formed signatures fetches the secret at most once per cooldown window, not once per request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const { adapter, secretFetchCount } = buildCountingAdapter();

    // Well-formed shape and a fresh timestamp -- this is exactly what a
    // caller who knows the wire format (but not the secret, since Salt's
    // fetch keeps coming back empty in this scenario) can produce for
    // free. Before this fix, EVERY one of these was a real network call:
    // getWebhookSecret() never caches anything while the fetch returns no
    // secret, so nothing ever short-circuited the next attempt. A fresh
    // Request is built each time -- a Request's body can only be read once.
    for (let i = 0; i < 5; i++) {
      const req = buildSignedWebhookRequest(
        WEBHOOK_URL,
        { chat: { id: "chat-1" }, message: { chat_id: "chat-1", message_id: "m1" } },
        { agentId: api.agentId, secret: "guessed-secret" }
      );
      const res = await adapter.handleWebhook(req);
      expect(res.status).toBe(401);
    }
    // Five rejections, but only the FIRST one actually reached Salt's API --
    // the rest fell inside SECRET_FETCH_COOLDOWN_MS of that attempt and
    // were rejected on the shape-and-cooldown path without a second call.
    expect(secretFetchCount()).toBe(1);
  });

  it("a well-formed signature after the cooldown window elapses tries again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const { adapter, secretFetchCount } = buildCountingAdapter();

    // A Request's body can only be read once, so each attempt (even one
    // repeating the exact same signed payload) needs its own fresh Request.
    const buildAttempt = () =>
      buildSignedWebhookRequest(
        WEBHOOK_URL,
        { chat: { id: "chat-1" }, message: { chat_id: "chat-1", message_id: "m1" } },
        { agentId: api.agentId, secret: "guessed-secret" }
      );

    await adapter.handleWebhook(buildAttempt());
    expect(secretFetchCount()).toBe(1);

    // Still within the cooldown: no second call yet.
    await adapter.handleWebhook(buildAttempt());
    expect(secretFetchCount()).toBe(1);

    // Past the cooldown window: this is a genuinely new attempt, not an
    // unbounded retry -- the point of the cooldown is pacing, not a
    // permanent lockout.
    vi.setSystemTime(1_700_000_000_000 + 61_000);
    const secondReq = buildSignedWebhookRequest(
      WEBHOOK_URL,
      { chat: { id: "chat-1" }, message: { chat_id: "chat-1", message_id: "m1" } },
      { agentId: api.agentId, secret: "guessed-secret", deliveryId: "delivery-2" }
    );
    await adapter.handleWebhook(secondReq);
    expect(secretFetchCount()).toBe(2);
  });
});
