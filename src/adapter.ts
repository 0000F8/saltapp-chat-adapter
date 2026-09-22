// The Salt platform adapter: implements chat-sdk's `Adapter` interface so
// any bot written against `chat` (echo bots, AI-SDK agents, whatever) runs
// on Salt (saltapp.ai) as one more platform, the same way it runs on Slack
// or Telegram. Protocol mechanics -- PGP decrypt/encrypt, the signed REST
// client, the wire shapes of a webhook payload -- come from salt-agent-sdk;
// this file's job is normalizing those into chat-sdk's Message/Thread/
// Author model and back.

import { ValidationError, extractCard } from "@chat-adapter/shared";
import {
  ConsoleLogger,
  Message,
  isCardElement,
  parseMarkdown,
  stringifyMarkdown,
} from "chat";
import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  Author,
  ChannelInfo,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FormattedContent,
  Logger,
  RawMessage,
  StreamChunk,
  StreamOptions,
  ThreadInfo,
  TypingOptions,
  WebhookOptions,
} from "chat";
import {
  createSaltClient,
  decrypt as pgpDecrypt,
  encryptFor as pgpEncryptFor,
  sameId,
  type SaltClient,
  type SaltUser,
} from "salt-agent-sdk";

import { decodeSaltActionId } from "./action-id";
import { cardElementToSaltBlocks } from "./cards";
import { verifySaltSignature } from "./signature";
import { assertSocketModeSupported, createSaltSocketPoller, type SaltSocketPoller } from "./socket";
import { createSaltExtraRest, type SaltExtraRestClient } from "./salt-rest";
import { channelIdFromThreadId, decodeThreadId, encodeThreadId } from "./thread-id";
import type {
  SaltAdapterConfig,
  SaltCardInteractionWebhookBody,
  SaltMessageWebhookBody,
  SaltRawMessage,
  SaltRawSender,
  SaltThreadId,
  SaltWebhookBody,
} from "./types";

const PLATFORM = "salt";
const PGP_MESSAGE_RE = /^-----BEGIN PGP MESSAGE/;
const DECRYPTED_CACHE_LIMIT = 500;
const SEEN_DELIVERY_LIMIT = 2000;

function isCardInteractionBody(body: SaltWebhookBody): body is SaltCardInteractionWebhookBody {
  return (body as Record<string, unknown>)?.type === "card_interaction";
}

function isMessageBody(body: SaltWebhookBody): body is SaltMessageWebhookBody {
  return typeof (body as Record<string, unknown>)?.message === "object" && (body as Record<string, unknown>).message !== null;
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Case-insensitive lookup into a socket-mode update row's `headers`
 *  object: it's whatever JSON salt-api stored, and JSON key casing isn't
 *  guaranteed to survive the way a real HTTP Headers object's is. */
function lookupHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

/** Salt's own reaction string (max 16 chars, see Reaction model): an EmojiValue reduces to its normalized `.name`; a plain string passes through unchanged. */
function emojiToSaltString(emoji: EmojiValue | string): string {
  return typeof emoji === "string" ? emoji : emoji.name;
}

export class SaltAdapter implements Adapter<SaltThreadId, SaltRawMessage> {
  readonly name = PLATFORM;
  readonly persistThreadHistory = false; // Salt has real server-side history (GET /api/v1/chats/:id)

  private readonly config: SaltAdapterConfig;
  private readonly client: SaltClient;
  private readonly extra: SaltExtraRestClient;
  private readonly logger: Logger;
  private readonly verifySignatures: boolean;
  private readonly signatureToleranceSeconds: number;

  private chatInstance: ChatInstance | null = null;
  private _userName: string;
  private webhookSecret: string | undefined;
  private webhookSecretPromise: Promise<string | undefined> | null = null;

  /** message_id -> decrypted plaintext, so a repeat parseMessage() call (a reply preview, a rehydrated queue entry) sees real content instead of "[Encrypted]". Bounded FIFO. */
  private readonly decryptedCache = new Map<string, string>();
  /** X-Salt-Delivery-Id values already processed -- Salt's own retry guarantee, not an edge case (see LANES.md). Bounded FIFO. */
  private readonly seenDeliveryIds = new Set<string>();
  /** chatId -> best-effort "is this a 1:1", learned the first time fetchThread() resolves real membership. isDM() answers `false` (unknown) until then. */
  private readonly isDmCache = new Map<string, boolean>();
  private warnedNoVerification = false;
  private readonly mode: SaltAdapterConfig["mode"];
  private socketPoller: SaltSocketPoller | undefined;

  constructor(config: SaltAdapterConfig) {
    for (const field of ["host", "apiKey", "agentId", "privateKey", "publicKey", "pgpPassphrase"] as const) {
      if (!config[field]) {
        throw new ValidationError(PLATFORM, `${field} is required`);
      }
    }
    const mode = config.mode ?? "webhook";
    if (mode !== "webhook" && mode !== "socket") {
      throw new ValidationError(PLATFORM, `Invalid mode: ${String(mode)}. Expected "webhook" or "socket".`);
    }
    if (mode === "socket") {
      assertSocketModeSupported();
    }
    this.mode = mode;

    this.config = config;
    this._userName = config.username ?? "bot";
    this.client = config.client ?? createSaltClient({ host: config.host, fetchImpl: config.fetchImpl });
    this.extra = createSaltExtraRest({ host: config.host, fetchImpl: config.fetchImpl });
    this.logger = config.logger ?? new ConsoleLogger("info").child(PLATFORM);
    this.verifySignatures = config.verifySignatures !== false;
    this.signatureToleranceSeconds = config.signatureToleranceSeconds ?? 300;
  }

  get userName(): string {
    return this._userName;
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chatInstance = chat;
    if (!this.config.username) {
      const fromChat = chat.getUserName?.();
      if (typeof fromChat === "string" && fromChat.trim()) {
        this._userName = fromChat;
      }
    }
    if (this.mode === "socket" && !this.socketPoller) {
      this.socketPoller = createSaltSocketPoller({
        host: this.config.host,
        apiKey: this.config.apiKey,
        agentId: this.config.agentId,
        extra: this.extra,
        logger: this.logger,
        cursorStore: this.config.cursorStore,
        dedupeStore: this.config.dedupeStore,
        onEnvelope: (headers, rawBody) =>
          this.processEnvelope((name) => lookupHeader(headers, name), rawBody).then(() => undefined),
      });
      this.socketPoller.start();
    }
  }

  async disconnect(): Promise<void> {
    if (this.socketPoller) {
      await this.socketPoller.stop();
      this.socketPoller = undefined;
    }
  }

  // ---------------------------------------------------------------------
  // Thread ids
  // ---------------------------------------------------------------------

  encodeThreadId(platformData: SaltThreadId): string {
    return encodeThreadId(platformData);
  }

  decodeThreadId(threadId: string): SaltThreadId {
    return decodeThreadId(threadId);
  }

  channelIdFromThreadId(threadId: string): string {
    return channelIdFromThreadId(threadId);
  }

  isDM(threadId: string): boolean {
    const { chatId } = decodeThreadId(threadId);
    return this.isDmCache.get(chatId) ?? false;
  }

  async openDM(userId: string): Promise<string> {
    const chat = await this.client.createOrGetChat(this.config.apiKey, userId);
    return encodeThreadId({ chatId: String(chat.id) });
  }

  // ---------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------

  renderFormatted(content: FormattedContent): string {
    return stringifyMarkdown(content);
  }

  /**
   * Required by the Adapter interface, but genuinely synchronous decryption
   * isn't possible here: Salt message content is PGP ciphertext, and every
   * PGP library (openpgp included) decrypts asynchronously. The real,
   * decrypted normalization always happens through the async factory this
   * adapter hands `chat.processMessage()` in handleWebhook/fetchMessages
   * (exactly the "lazy async parsing" escape hatch `ChatInstance.
   * processMessage`'s own type signature documents). This method covers
   * the synchronous contract: if that async path already ran for this
   * message (decryptedCache), return the real text; otherwise the same
   * "[Encrypted]" placeholder Salt's own frontend shows for content it
   * can't read yet.
   */
  parseMessage(raw: SaltRawMessage): Message<SaltRawMessage> {
    return this.buildMessage(raw, this.decryptedCache.get(raw.message_id) ?? "[Encrypted]");
  }

  private buildMessage(raw: SaltRawMessage, text: string): Message<SaltRawMessage> {
    const threadId = encodeThreadId({ chatId: raw.chat_id });
    // Salt's own server never delivers a group-chat message webhook to an
    // agent unless it was @mentioned (salt-api's Message#send_webhook --
    // see CLAUDE.md's "In group chats agents only receive webhooks when
    // @mentioned"), so every message this adapter is ever asked to
    // normalize is, by the platform's own construction, one Salt decided
    // this agent should see. `mentions` isn't actually present on the wire
    // today (see HANDOFF.md), but read it defensively in case that changes.
    const isMention = Array.isArray(raw.mentions) ? raw.mentions.some((id) => sameId(id, this.config.agentId)) : true;
    return new Message<SaltRawMessage>({
      id: raw.message_id,
      threadId,
      text,
      formatted: parseMarkdown(text),
      raw,
      author: this.toAuthor(raw.user),
      metadata: {
        dateSent: new Date(raw.created_at),
        edited: false,
      },
      attachments: [],
      isMention,
    });
  }

  private toAuthor(sender: SaltRawSender): Author {
    const id = String(sender.id);
    return {
      userId: id,
      userName: sender.username || sender.display_name || id,
      fullName: sender.display_name || sender.username || id,
      isBot: sender.account_type === "Agent",
      isMe: sameId(id, this.config.agentId),
      isSystem: !!sender.system,
    };
  }

  private rememberDecrypted(messageId: string, text: string): void {
    this.decryptedCache.set(messageId, text);
    if (this.decryptedCache.size > DECRYPTED_CACHE_LIMIT) {
      const oldest = this.decryptedCache.keys().next().value;
      if (oldest !== undefined) this.decryptedCache.delete(oldest);
    }
  }

  private async decryptAndNormalize(raw: SaltRawMessage): Promise<Message<SaltRawMessage>> {
    let text = "[Encrypted]";
    if (typeof raw.message === "string" && PGP_MESSAGE_RE.test(raw.message)) {
      try {
        text = await pgpDecrypt(raw.message, this.config.privateKey, this.config.pgpPassphrase);
      } catch (err) {
        this.logger.error(`Failed to decrypt Salt message ${raw.message_id}: ${(err as Error).message}`);
      }
    } else if (typeof raw.message === "string") {
      text = raw.message;
    }
    this.rememberDecrypted(raw.message_id, text);
    return this.buildMessage(raw, text);
  }

  // ---------------------------------------------------------------------
  // Webhook
  // ---------------------------------------------------------------------

  private async getWebhookSecret(): Promise<string | undefined> {
    if (this.webhookSecret) return this.webhookSecret;
    if (!this.webhookSecretPromise) {
      this.webhookSecretPromise = this.client
        .getWebhookSecret(this.config.apiKey)
        .then((secret) => {
          this.webhookSecret = secret;
          return secret;
        })
        .finally(() => {
          this.webhookSecretPromise = null;
        });
    }
    return this.webhookSecretPromise;
  }

  private rememberDelivery(deliveryId: string): void {
    this.seenDeliveryIds.add(deliveryId);
    if (this.seenDeliveryIds.size > SEEN_DELIVERY_LIMIT) {
      const oldest = this.seenDeliveryIds.values().next().value;
      if (oldest !== undefined) this.seenDeliveryIds.delete(oldest);
    }
  }

  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    const rawBody = await request.text();
    const outcome = await this.processEnvelope((name) => request.headers.get(name), rawBody, options);
    switch (outcome) {
      case "invalid_signature":
        return jsonResponse({ error: "invalid signature" }, 401);
      case "invalid_json":
        return jsonResponse({ error: "invalid JSON" }, 400);
      case "accepted":
        return jsonResponse({ status: "accepted" }, 200);
    }
  }

  /**
   * Verify (webhook: HMAC over the raw body; socket: already verified by
   * the poller upstream -- see socket.ts's header comment) is NOT this
   * method's job by delivery mode; SIGNATURE verification is, for both,
   * since salt-api signs a socket-mode envelope exactly the way it signs a
   * webhook POST (LANES.md's K2 contract: "SDK clients verify each
   * envelope with the same HMAC check they apply to webhooks"). This is
   * the one place both `handleWebhook` (a live POST) and socket.ts's
   * poller (a fetched outbox row) converge, so dedupe, JSON parsing, and
   * dispatch happen exactly once regardless of delivery mode.
   */
  private async processEnvelope(
    getHeader: (name: string) => string | null | undefined,
    rawBody: string,
    options?: WebhookOptions
  ): Promise<"accepted" | "invalid_signature" | "invalid_json"> {
    if (this.verifySignatures) {
      let secret: string | undefined;
      try {
        secret = await this.getWebhookSecret();
      } catch (err) {
        this.logger.error(`Salt webhook: could not fetch signing key: ${(err as Error).message}`);
      }
      const reason = verifySaltSignature({
        rawBody,
        signatureHeader: getHeader("X-Salt-Signature"),
        secret: secret ?? "",
        toleranceSeconds: this.signatureToleranceSeconds,
      });
      if (reason) {
        this.logger.warn(`Salt webhook rejected: ${reason}`);
        return "invalid_signature";
      }
    } else if (!this.warnedNoVerification) {
      this.warnedNoVerification = true;
      this.logger.warn("Salt webhook signature verification is explicitly disabled");
    }

    let body: SaltWebhookBody;
    try {
      body = JSON.parse(rawBody) as SaltWebhookBody;
    } catch {
      return "invalid_json";
    }

    // Salt's guarantee, not an edge case: a delivery can arrive more than
    // once (retries, or an unacked/replayed outbox row in socket mode). A
    // missing X-Salt-Delivery-Id is treated as always-new rather than
    // always-duplicate.
    const deliveryId = getHeader("X-Salt-Delivery-Id");
    if (deliveryId) {
      if (this.seenDeliveryIds.has(deliveryId)) {
        return "accepted";
      }
      this.rememberDelivery(deliveryId);
    }

    if (!this.chatInstance) {
      this.logger.warn("Salt event received before initialize(); ignoring.");
      return "accepted";
    }

    if (isCardInteractionBody(body)) {
      void this.dispatchCardInteraction(body, options).catch((err) =>
        this.logger.error(`Salt card_interaction handling failed: ${(err as Error).message}`)
      );
    } else if (isMessageBody(body)) {
      this.dispatchMessage(body, options);
    }
    // chat_opened / invoice_paid / handoff_confirmed / handoff_received:
    // Salt-specific events with no chat-sdk equivalent. Acknowledged, not
    // dispatched -- see README's "What this adapter does not cover".

    return "accepted";
  }

  private dispatchMessage(body: SaltMessageWebhookBody, options?: WebhookOptions): void {
    const raw = body.message;
    if (raw.event_type) return; // system events aren't prompts
    if (sameId(raw.user.id, this.config.agentId)) return; // never react to our own echoed message
    if (!this.chatInstance) return;
    const threadId = encodeThreadId({ chatId: raw.chat_id });
    // "Handles waitUntil registration and error catching internally" per
    // ChatInstance.processMessage's own doc comment -- call it and return
    // fast, per chat-sdk's own webhook-handling guidance.
    void this.chatInstance.processMessage(this, threadId, () => this.decryptAndNormalize(raw), options);
  }

  private async dispatchCardInteraction(body: SaltCardInteractionWebhookBody, options?: WebhookOptions): Promise<void> {
    if (!this.chatInstance) return;
    if (!sameId(body.owner_id, this.config.agentId)) return; // not addressed to us
    const { actionId, value } = decodeSaltActionId(body.action_id);
    const threadId = encodeThreadId({ chatId: body.chat_id });
    await this.chatInstance.processAction(
      {
        actionId,
        adapter: this,
        // Salt's card_interaction payload names the Card, not the wrapping
        // Message -- the two have different ids (see cards_controller#create's
        // response vs. this event). Using the card id here is the closest
        // stable analog to "the message containing the card" chat-sdk asks for.
        messageId: body.card_id,
        raw: body,
        threadId,
        triggerId: undefined,
        user: this.toAuthor(body.user),
        value,
      },
      options
    );
  }

  // ---------------------------------------------------------------------
  // Posting
  // ---------------------------------------------------------------------

  private renderPostableText(message: AdapterPostableMessage): string {
    if (typeof message === "string") return message;
    if (isCardElement(message)) return ""; // handled by the card branch in postMessage
    if ("raw" in message) return message.raw;
    if ("markdown" in message) return message.markdown;
    if ("ast" in message) return stringifyMarkdown(message.ast);
    if ("card" in message) return message.fallbackText ?? "";
    return "";
  }

  private toRawMessage(posted: unknown, threadId: string): RawMessage<SaltRawMessage> {
    const p = (posted ?? {}) as { message_id?: string; id?: string };
    return {
      id: String(p.message_id ?? p.id ?? ""),
      raw: posted as SaltRawMessage,
      threadId,
    };
  }

  private async encryptForChat(chatId: string, text: string): Promise<{ message: string; senderMessage: string }> {
    let members: SaltUser[] = [];
    try {
      members = await this.client.getChatMembers(this.config.apiKey, chatId);
    } catch (err) {
      this.logger.error(`[chat ${chatId}] fetching members to encrypt failed: ${(err as Error).message}`);
    }
    const recipientKeys = members.map((m) => m.public_key).filter((k): k is string => typeof k === "string" && k.length > 0);
    const encryptTo = recipientKeys.length > 0 ? recipientKeys : [this.config.publicKey];
    const [message, senderMessage] = await Promise.all([
      pgpEncryptFor(text, encryptTo),
      pgpEncryptFor(text, [this.config.publicKey]),
    ]);
    return { message, senderMessage };
  }

  async postMessage(threadId: string, message: AdapterPostableMessage): Promise<RawMessage<SaltRawMessage>> {
    const { chatId } = decodeThreadId(threadId);
    const card = extractCard(message);
    if (card) {
      const { blocks, fallbackText } = cardElementToSaltBlocks(card);
      const posted = await this.client.postCard(this.config.apiKey, chatId, blocks, fallbackText);
      return this.toRawMessage(posted, threadId);
    }
    const text = this.renderPostableText(message);
    const { message: encryptedMessage, senderMessage } = await this.encryptForChat(chatId, text);
    const posted = await this.client.postMessage(this.config.apiKey, chatId, encryptedMessage, senderMessage);
    return this.toRawMessage(posted, threadId);
  }

  async postChannelMessage(channelId: string, message: AdapterPostableMessage): Promise<RawMessage<SaltRawMessage>> {
    return this.postMessage(channelId, message);
  }

  async editMessage(_threadId: string, _messageId: string, _message: AdapterPostableMessage): Promise<RawMessage<SaltRawMessage>> {
    throw new ValidationError(
      PLATFORM,
      "Salt has no message-edit endpoint. A message can be sent, reacted to, locked/pinned, or deleted for everyone (within 24h) -- never edited in place."
    );
  }

  async deleteMessage(_threadId: string, messageId: string): Promise<void> {
    await this.extra.deleteMessage(this.config.apiKey, messageId);
  }

  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
    _options?: StreamOptions
  ): Promise<RawMessage<SaltRawMessage> | null> {
    // Salt can't edit a message in place, so there's no incremental
    // streaming update to send -- buffer the whole reply and post it once,
    // same fallback Messenger's adapter uses for the same reason.
    let accumulated = "";
    for await (const chunk of textStream) {
      if (typeof chunk === "string") accumulated += chunk;
      else if (chunk.type === "markdown_text") accumulated += chunk.text;
    }
    return this.postMessage(threadId, { markdown: accumulated });
  }

  // ---------------------------------------------------------------------
  // Reactions
  // ---------------------------------------------------------------------

  private async hasOwnReaction(chatId: string, messageId: string, emoji: string): Promise<boolean> {
    const chat = await this.extra.getChat(this.config.apiKey, chatId);
    const messages = (Array.isArray(chat.messages) ? chat.messages : []) as SaltRawMessage[];
    const target = messages.find((m) => String(m.message_id) === messageId);
    const entry = target?.reactions?.find((r) => r.emoji === emoji);
    return !!entry?.user_ids?.some((id) => sameId(id, this.config.agentId));
  }

  async addReaction(threadId: string, messageId: string, emoji: EmojiValue | string): Promise<void> {
    const { chatId } = decodeThreadId(threadId);
    const emojiStr = emojiToSaltString(emoji);
    // Salt's reaction endpoint TOGGLES (see salt-rest.ts): only call it when
    // it would actually add, so this method stays idempotent the way every
    // other adapter's addReaction is.
    if (await this.hasOwnReaction(chatId, messageId, emojiStr)) return;
    await this.extra.toggleReaction(this.config.apiKey, messageId, emojiStr);
  }

  async removeReaction(threadId: string, messageId: string, emoji: EmojiValue | string): Promise<void> {
    const { chatId } = decodeThreadId(threadId);
    const emojiStr = emojiToSaltString(emoji);
    if (!(await this.hasOwnReaction(chatId, messageId, emojiStr))) return;
    await this.extra.toggleReaction(this.config.apiKey, messageId, emojiStr);
  }

  // ---------------------------------------------------------------------
  // Typing
  // ---------------------------------------------------------------------

  async startTyping(threadId: string, _status?: string, _options?: TypingOptions): Promise<void> {
    const { chatId } = decodeThreadId(threadId);
    // client.signalTyping already swallows its own errors (fire-and-forget
    // by design -- see salt-agent-sdk's client.ts), so nothing more to do here.
    await this.client.signalTyping(this.config.apiKey, chatId);
  }

  // ---------------------------------------------------------------------
  // Fetching
  // ---------------------------------------------------------------------

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { chatId } = decodeThreadId(threadId);
    const chat = await this.extra.getChat(this.config.apiKey, chatId);
    const users = chat.session?.users ?? [];
    const isDM = users.length > 0 && users.length <= 2;
    this.isDmCache.set(chatId, isDM);
    return {
      id: threadId,
      channelId: threadId,
      channelName: typeof chat.name === "string" ? chat.name : undefined,
      isDM,
      metadata: { memberCount: users.length },
    };
  }

  async fetchChannelInfo(channelId: string): Promise<ChannelInfo> {
    const info = await this.fetchThread(channelId);
    return {
      id: channelId,
      name: info.channelName,
      isDM: info.isDM,
      memberCount: (info.metadata as { memberCount?: number }).memberCount,
      metadata: info.metadata,
    };
  }

  async fetchMessage(threadId: string, messageId: string): Promise<Message<SaltRawMessage> | null> {
    const { chatId } = decodeThreadId(threadId);
    const chat = await this.extra.getChat(this.config.apiKey, chatId);
    const messages = (Array.isArray(chat.messages) ? chat.messages : []) as SaltRawMessage[];
    const raw = messages.find((m) => String(m.message_id) === messageId);
    if (!raw) return null;
    return this.decryptAndNormalize(raw);
  }

  async fetchMessages(threadId: string, options: FetchOptions = {}): Promise<FetchResult<SaltRawMessage>> {
    const { chatId } = decodeThreadId(threadId);
    const chat = await this.extra.getChat(this.config.apiKey, chatId);
    const raw = (Array.isArray(chat.messages) ? chat.messages : []) as SaltRawMessage[];
    const sorted = [...raw].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const limit = options.limit ?? 50;
    const direction = options.direction ?? "backward";

    let windowed = sorted;
    if (options.cursor) {
      const idx = sorted.findIndex((m) => m.message_id === options.cursor);
      if (idx >= 0) {
        windowed = direction === "forward" ? sorted.slice(idx + 1) : sorted.slice(0, idx);
      }
    }

    const page = direction === "forward" ? windowed.slice(0, limit) : windowed.slice(Math.max(0, windowed.length - limit));

    let nextCursor: string | undefined;
    if (page.length > 0) {
      if (direction === "forward") {
        const consumedThrough = windowed.indexOf(page[page.length - 1]!) + 1;
        if (consumedThrough < windowed.length) nextCursor = page[page.length - 1]!.message_id;
      } else {
        const remainingBefore = windowed.indexOf(page[0]!);
        if (remainingBefore > 0) nextCursor = page[0]!.message_id;
      }
    }

    const messages = await Promise.all(page.map((m) => this.decryptAndNormalize(m)));
    return { messages, nextCursor };
  }

  async fetchChannelMessages(channelId: string, options?: FetchOptions): Promise<FetchResult<SaltRawMessage>> {
    return this.fetchMessages(channelId, options);
  }

  rehydrateAttachment(attachment: Attachment): Attachment {
    // Attachment re-fetching isn't wired up in this version (see HANDOFF.md);
    // return it unchanged rather than pretending to rebuild fetchData.
    return attachment;
  }
}

export function createSaltAdapter(config: SaltAdapterConfig): SaltAdapter {
  return new SaltAdapter(config);
}
