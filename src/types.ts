// Salt-specific types for the adapter. Kept separate from adapter.ts so
// tests and consumers can import the shapes without pulling in the whole
// Adapter implementation.

import type { Logger } from "chat";
import type { CursorStore, DedupeStore, SaltClient } from "salt-agent-sdk";
import type { WebSocket as WS } from "ws";

/**
 * Salt's own thread identity: a chat is a flat conversation (1:1 or group),
 * with no Slack-style channel/thread nesting. `chatId` is the only real
 * axis; `laneId` distinguishes a private sidechain/advisor/consult lane
 * living "under" a room from the room itself, when this adapter is asked to
 * post into one (see CLAUDE.md's "sidechains" section). Most bots never see
 * a laneId.
 */
export interface SaltThreadId {
  chatId: string;
  laneId?: string;
}

/**
 * The exact JSON body salt-api's WebhookJob posts for an ordinary message
 * (Message#send_webhook / Message#formatted_message -- see salt-api's
 * app/models/message.rb). This is also, byte for byte, the shape of one
 * row's `body` in the socket-mode outbox (LANES.md's K2 contract), so the
 * same parser serves both delivery paths.
 */
export interface SaltRawMessage {
  chat_id: string;
  message: string; // armored PGP ciphertext, or plaintext for an open room / a system event
  sender_message?: string;
  /** Open rooms (salt-api 0.8x): false means `message` is plain text, not
   *  a PGP blob -- see README.md's "Open rooms" section. Absent (or true)
   *  is an ordinary end-to-end encrypted chat. */
  encrypted?: boolean;
  /** Interests: why this open-room message was delivered to this identity
   *  (see SaltClient.setChatSubscription's `mode`). Absent for an ordinary
   *  encrypted chat, and absent until salt-api's open-rooms rollout starts
   *  sending it on the wire -- not yet in salt-agent-sdk 0.10.0's own typed
   *  MessageContext as of this writing, so this is read defensively. */
  delivered_because?: "mention" | "reply" | "keyword" | "all" | string;
  message_id: string;
  seq?: number;
  message_type?: string;
  version?: number;
  event_type?: string | null;
  reply_to_message_id?: string | null;
  user: SaltRawSender;
  created_at: string;
  resource_type?: string;
  resource_id?: string;
  resource?: Record<string, unknown>;
  reactions?: Array<{ emoji: string; count: number; user_ids: string[] }>;
  delegations?: unknown[];
  coaching_for_chat_id?: string;
  quiet?: boolean;
  deleted_at?: string | null;
  deleted_by?: { id: string; display_name: string } | null;
  locked_at?: string | null;
  locked_by?: { id: string; display_name: string } | null;
  can_delete_for_everyone?: boolean;
  /** Not actually sent by salt-api today (see HANDOFF.md) -- read defensively. */
  mentions?: string[];
  [key: string]: unknown;
}

export interface SaltRawSender {
  id: string;
  username?: string;
  display_name?: string;
  account_type?: "User" | "Agent";
  system?: boolean;
  avatar_url?: string;
  [key: string]: unknown;
}

/** The `chat` sub-object salt-api's WebhookJob posts alongside `message`. */
export interface SaltRawChatMeta {
  id: string;
  name?: string | null;
  public?: boolean;
  managed?: boolean;
  open_invite?: boolean;
  mode?: "auto" | "manual";
  active_agent_id?: string;
  mediator_agent_id?: string;
  coaching_for_chat_id?: string;
  private_lane?: boolean;
  lane_kind?: string;
  /** Open rooms (salt-api 0.8x): false marks a plain chat with no
   *  end-to-end encryption. Absent (or true) is an ordinary encrypted
   *  chat -- see SaltRawMessage.encrypted and README.md's "Open rooms". */
  encrypted?: boolean;
  [key: string]: unknown;
}

/** The full webhook POST body for an ordinary message delivery. */
export interface SaltMessageWebhookBody {
  chat: SaltRawChatMeta;
  message: SaltRawMessage;
}

/** The webhook POST body for a card button tap (cards_controller#actions). */
export interface SaltCardInteractionWebhookBody {
  type: "card_interaction";
  owner_id: string;
  chat_id: string;
  card_id: string;
  action_id: string;
  user: SaltRawSender;
  value?: string;
  state?: { blocks?: unknown };
  [key: string]: unknown;
}

export type SaltWebhookBody =
  | SaltMessageWebhookBody
  | SaltCardInteractionWebhookBody
  | Record<string, unknown>;

/**
 * How this identity receives webhook deliveries. "webhook" (default) means
 * salt-api POSTs to a public URL synchronously; "socket" is LANES.md's K2
 * contract -- a live Action Cable websocket this adapter holds open
 * itself (never a poll; see socket.ts), for a bot with no public URL.
 * Socket mode needs salt-agent-sdk >= 0.10.0 -- see socket.ts.
 */
export type SaltDeliveryMode = "webhook" | "socket";

export interface SaltAdapterConfig {
  /** Salt API base URL, e.g. "https://saltapp.ai" (no trailing slash). */
  host: string;
  /** This agent's own api-key (salt-api's `apikeys` table). */
  apiKey: string;
  /** This agent's own Salt user id (`X-Salt-Agent-Id` on every webhook). */
  agentId: string;
  /** Armored PGP private key for this agent (see `UserKey`). */
  privateKey: string;
  /** Armored PGP public key for this agent -- used to encrypt this agent's own readable copy of every message it sends. */
  publicKey: string;
  /** Passphrase the private key was generated with. */
  pgpPassphrase: string;
  /** Cosmetic only -- not looked up automatically. Falls back to chat.getUserName(). */
  username?: string;
  displayName?: string;
  /**
   * "webhook" (default) or "socket". See SaltDeliveryMode above. A bot that
   * wants socket mode passes `mode: "socket"`; this adapter checks whether
   * the installed salt-agent-sdk exposes a socket client and throws a clear
   * error naming the required version if it doesn't (see socket.ts).
   */
  mode?: SaltDeliveryMode;
  /**
   * Verify the HMAC signature salt-api sends on every webhook callback.
   * Defaults on. Set false only against a local dev salt-api that has
   * signature verification disabled.
   */
  verifySignatures?: boolean;
  /** Reject signatures older than this many seconds (replay protection). Default 300. */
  signatureToleranceSeconds?: number;
  /** Inject a Salt REST client (tests only). Built from `host` otherwise. */
  client?: SaltClient;
  /** Inject a logger (tests only). Falls back to chat-sdk's own console logger. */
  logger?: Logger;
  /** Override `fetch` (tests only). */
  fetchImpl?: typeof fetch;
  /**
   * `mode: "socket"` only: where the resume cursor persists across
   * restarts/reconnects. Defaults to salt-agent-sdk's
   * `FileCursorStore(~/.salt/agents/<agentId>)`; pass `MemoryCursorStore()`
   * explicitly to opt out of disk I/O (tests, or a host that wants no
   * local state). See socket.ts.
   */
  cursorStore?: CursorStore;
  /** `mode: "socket"` only: persistent per-agent delivery_id dedupe, same
   *  reasoning as `cursorStore`. Defaults to `FileDedupeStore`. */
  dedupeStore?: DedupeStore;
  /** `mode: "socket"` only: override the WebSocket implementation
   *  socket.ts connects with (tests -- drives Action Cable frames without
   *  a real connection). Defaults to `ws`'s own WebSocket. */
  webSocketImpl?: typeof WS;
  /**
   * Open rooms: this identity's own subscription preference for a plain
   * chat, applied via `client.setChatSubscription` the first time this
   * adapter observes it handling that chat -- `"addressed"` (default; only
   * a direct reply/@mention, the closest analogue to how an encrypted chat
   * already gates delivery, and the one mode that never calls the
   * subscription API at all), `"keywords"` (any message containing one of
   * `subscriptionKeywords`), or `"all"` (every message). No effect on an
   * ordinary encrypted chat. See README.md's "Interests" section.
   */
  subscriptionMode?: SaltSubscriptionMode;
  /** Keywords this identity follows when subscriptionMode is "keywords". */
  subscriptionKeywords?: string[];
}

/** See SaltAdapterConfig.subscriptionMode. */
export type SaltSubscriptionMode = "addressed" | "keywords" | "all";
