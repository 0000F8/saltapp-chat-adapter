// Test-only fake for salt-api's REST surface. Rather than hand-stubbing
// every method of salt-agent-sdk's SaltClient (most of which this adapter
// never calls), this intercepts at the `fetch` layer -- the same seam
// SaltAdapterConfig.fetchImpl exposes -- and answers the handful of
// endpoints the adapter actually hits. That keeps the mock honest about
// request shape (method, path, JSON body) while never touching the network.

import { createHmac } from "node:crypto";

export interface FakeUser {
  id: string;
  username: string;
  display_name: string;
  account_type: "User" | "Agent";
  public_key?: string;
}

export interface FakeMessage {
  message_id: string;
  chat_id: string;
  message: string;
  sender_message?: string;
  user: FakeUser;
  created_at: string;
  seq: number;
  event_type?: string | null;
  reactions: Array<{ emoji: string; count: number; user_ids: string[] }>;
  [key: string]: unknown;
}

export interface FakeChat {
  id: string;
  name?: string | null;
  session: { users: FakeUser[] };
  messages: FakeMessage[];
}

export interface PostedMessage {
  chat_id: string;
  message: string;
  sender_message?: string;
  mentions?: string[];
}

export interface PostedCard {
  chat_id: string;
  blocks: unknown[];
  text: string;
}

export class FakeSaltApi {
  readonly host = "https://fake.saltapp.test";
  readonly chats = new Map<string, FakeChat>();
  readonly postedMessages: PostedMessage[] = [];
  readonly postedCards: PostedCard[] = [];
  readonly typingPings: string[] = [];
  readonly deletedMessageIds: string[] = [];
  webhookSecret: string | undefined;
  agentId = "agent-1";
  private seq = 0;
  private messageCounter = 0;
  private cardCounter = 0;

  setChat(chat: FakeChat): void {
    this.chats.set(chat.id, chat);
  }

  addMessage(chatId: string, message: Partial<FakeMessage> & { message_id: string; user: FakeUser; message: string }): FakeMessage {
    const chat = this.chats.get(chatId);
    if (!chat) throw new Error(`test setup error: no fake chat ${chatId}`);
    const full: FakeMessage = {
      chat_id: chatId,
      created_at: new Date().toISOString(),
      seq: this.seq++,
      reactions: [],
      ...message,
    };
    chat.messages.push(full);
    return full;
  }

  get fetchImpl(): typeof fetch {
    return this.handle.bind(this) as unknown as typeof fetch;
  }

  private async handle(url: string | URL, init?: RequestInit): Promise<Response> {
    const u = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;

    if (method === "GET" && u.pathname === "/api/v1/agents/webhook_secret") {
      return json({ agent_id: this.agentId, webhook_secret: this.webhookSecret });
    }

    const chatMatch = /^\/api\/v1\/chats\/([^/]+)$/.exec(u.pathname);
    if (method === "GET" && chatMatch) {
      const chat = this.chats.get(chatMatch[1]!);
      if (!chat) return json({ error: "not found" }, 404);
      return json(chat);
    }

    if (method === "POST" && u.pathname === "/api/v1/messages") {
      this.postedMessages.push(body as unknown as PostedMessage);
      const chatId = String(body!.chat_id);
      const id = `posted-msg-${++this.messageCounter}`;
      const posted = this.addMessage(chatId, {
        message_id: id,
        message: String(body!.message),
        sender_message: body!.sender_message as string | undefined,
        user: { id: this.agentId, username: "bot", display_name: "Bot", account_type: "Agent" },
      });
      return json(posted);
    }

    if (method === "POST" && u.pathname === "/api/v1/cards") {
      this.postedCards.push(body as unknown as PostedCard);
      const chatId = String(body!.chat_id);
      const msgId = `posted-card-msg-${++this.cardCounter}`;
      const cardId = `card-${this.cardCounter}`;
      const posted = this.addMessage(chatId, {
        message_id: msgId,
        message: String(body!.text ?? ""),
        user: { id: this.agentId, username: "bot", display_name: "Bot", account_type: "Agent" },
        resource_type: "Card",
        resource_id: cardId,
        resource: { id: cardId, card_type: "blocks", state: { blocks: body!.blocks }, owner: { id: this.agentId } },
      });
      return json(posted);
    }

    if (method === "POST" && u.pathname === "/api/v1/chats") {
      const contactId = String(body!.contact_id);
      const chatId = `dm-${contactId}`;
      if (!this.chats.has(chatId)) {
        this.setChat({ id: chatId, session: { users: [] }, messages: [] });
      }
      return json({ id: chatId });
    }

    const typingMatch = /^\/api\/v1\/chats\/([^/]+)\/typing$/.exec(u.pathname);
    if (method === "POST" && typingMatch) {
      this.typingPings.push(typingMatch[1]!);
      return json({});
    }

    const reactionMatch = /^\/api\/v1\/messages\/([^/]+)\/reactions$/.exec(u.pathname);
    if (method === "POST" && reactionMatch) {
      const messageId = reactionMatch[1]!;
      const emoji = String(body!.emoji);
      const message = this.findMessage(messageId);
      if (!message) return json({ error: "not found" }, 404);
      let entry = message.reactions.find((r) => r.emoji === emoji);
      if (!entry) {
        entry = { emoji, count: 0, user_ids: [] };
        message.reactions.push(entry);
      }
      const idx = entry.user_ids.indexOf(this.agentId);
      if (idx >= 0) {
        entry.user_ids.splice(idx, 1);
      } else {
        entry.user_ids.push(this.agentId);
      }
      entry.count = entry.user_ids.length;
      message.reactions = message.reactions.filter((r) => r.count > 0);
      return json({ message_id: messageId, reactions: message.reactions });
    }

    const deleteMatch = /^\/api\/v1\/messages\/([^/]+)$/.exec(u.pathname);
    if (method === "DELETE" && deleteMatch) {
      this.deletedMessageIds.push(deleteMatch[1]!);
      return new Response(null, { status: 204 });
    }

    return json({ error: `fake api has no route for ${method} ${u.pathname}` }, 404);
  }

  private findMessage(messageId: string): FakeMessage | undefined {
    for (const chat of this.chats.values()) {
      const found = chat.messages.find((m) => m.message_id === messageId);
      if (found) return found;
    }
    return undefined;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Builds a minimal fetch-API Request the way salt-api's webhook POST would arrive, with a real HMAC signature. */
export function buildSignedWebhookRequest(url: string, body: unknown, opts: { agentId: string; secret: string; deliveryId?: string }): Request {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", opts.secret).update(`${t}.${raw}`).digest("hex");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Salt-Agent-Id": opts.agentId,
    "X-Salt-Signature": `t=${t},v1=${v1}`,
  };
  if (opts.deliveryId) headers["X-Salt-Delivery-Id"] = opts.deliveryId;
  return new Request(url, { method: "POST", headers, body: raw });
}
