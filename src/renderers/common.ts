// Shared half of the card renderers: reads a Salt card (the `Card#as_chat_resource`
// shape, or a bare `{blocks}`), normalizes it into one small intermediate
// form, and owns the two rules every platform shares.
//
// THE DISPATCH RULE. In Salt a button dispatches on its TYPE, never its label.
// `pay` creates a real payment request and money UI is always Salt's own
// first-party chrome, so on every other platform a `pay` button is a LINK that
// opens the card in Salt, never a callback. `handoff` and `signup` are likewise
// executed by salt-api itself (they are never forwarded to the agent), so a
// callback on another platform could not do what the button says; they open
// Salt too. `link` opens its own url (Salt hosts only, re-checked here). Only
// `default` (or no type) becomes a callback button.
//
// Pure functions only: no I/O, no SDK clients.

import { createHash } from "node:crypto";

export interface SaltCardLike {
  id?: string | number;
  card_id?: string | number;
  chat_id?: string | number;
  message_id?: string | number;
  state?: { blocks?: unknown } | null;
  blocks?: unknown;
  [key: string]: unknown;
}

export interface RenderOptions {
  /** Overrides `card.chat_id`; used for the "open in Salt" link. */
  chatId?: string | number;
  /** Overrides `card.message_id`; used for the "open in Salt" link. */
  messageId?: string | number;
  /** Overrides `card.id`; carried in every callback so a tap names its card. */
  cardId?: string | number;
  /** Salt web origin. Default https://saltapp.ai. */
  baseUrl?: string;
}

/** Callbacks whose `{card_id, action_id}` did not fit the platform's size cap travel as a short hash; this maps the hash back. */
export type HashedCallbacks = Record<string, { card_id: string; action_id: string }>;

export interface RenderMeta {
  /** Plain-text version of the whole card, for notifications and clients that cannot render the rich form. */
  fallbackText: string;
  /** True when a platform limit forced something to be cut. */
  truncated: boolean;
  /** Keep this next to the sent message and hand it to `parseInteraction` (see README, "Callback encoding"). Empty unless a hash was needed. */
  hashedCallbacks: HashedCallbacks;
}

/** What `parseInteraction` returns: the shape of Salt's `card_interaction` webhook. */
export interface SaltCardInteraction {
  card_id: string;
  action_id: string;
  values?: Record<string, string>;
}

export type ButtonStyle = "primary" | "danger";

export type NormButton =
  | { kind: "callback"; label: string; style?: ButtonStyle; actionId: string }
  | { kind: "link"; label: string; style?: ButtonStyle; url: string };

export type NormBlock =
  | { type: "section"; text?: string; fields?: Array<{ label: string; value: string }> }
  | { type: "image"; url: string; alt: string }
  | { type: "divider" }
  | { type: "actions"; buttons: NormButton[] }
  | { type: "input"; blockId: string; label: string; placeholder?: string; multiline: boolean; maxLength: number }
  | { type: "text"; text: string };

export interface Normalized {
  cardId: string;
  openUrl: string;
  blocks: NormBlock[];
}

export const ELLIPSIS = "\u2026";
const DEFAULT_BASE = "https://saltapp.ai";
const SALT_HOSTS = new Set(["saltapp.ai", "www.saltapp.ai", "saltfor.com"]);
const DEFAULT_INPUT_MAX = 500;

export function truncate(value: string, max: number): string {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  if (max === 1) return ELLIPSIS;
  return value.slice(0, max - 1).trimEnd() + ELLIPSIS;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const idStr = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined;

/** `https://saltapp.ai/chats/<chat_id>?message=<message_id>`; degrades to the chat, then to the origin. */
export function openInSaltUrl(chatId?: string, messageId?: string, baseUrl = DEFAULT_BASE): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (!chatId) return base + "/";
  const url = `${base}/chats/${encodeURIComponent(chatId)}`;
  return messageId ? `${url}?message=${encodeURIComponent(messageId)}` : url;
}

function isSaltHttps(url: unknown): url is string {
  if (typeof url !== "string" || url.length > 500) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && SALT_HOSTS.has(u.hostname.toLowerCase()) && !u.username && !u.password;
  } catch {
    return false;
  }
}

function isHttps(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeCard(card: SaltCardLike, options: RenderOptions = {}): Normalized {
  const raw: SaltCardLike = isObj(card) ? card : {};
  const cardId = idStr(options.cardId) ?? idStr(raw.card_id) ?? idStr(raw.id) ?? "";
  const chatId = idStr(options.chatId) ?? idStr(raw.chat_id);
  const messageId = idStr(options.messageId) ?? idStr(raw.message_id);
  const openUrl = openInSaltUrl(chatId, messageId, options.baseUrl);

  const rawBlocks = Array.isArray(raw.blocks)
    ? raw.blocks
    : isObj(raw.state) && Array.isArray(raw.state.blocks)
      ? raw.state.blocks
      : [];

  const blocks: NormBlock[] = [];
  for (const b of rawBlocks) {
    if (!isObj(b)) continue;
    switch (b.type) {
      case "section": {
        const fields = Array.isArray(b.fields)
          ? b.fields
              .filter((f): f is Record<string, unknown> => isObj(f) && typeof f.label === "string" && typeof f.value === "string")
              .map((f) => ({ label: f.label as string, value: f.value as string }))
          : [];
        const text = str(b.text);
        if (text || fields.length) blocks.push({ type: "section", text, fields: fields.length ? fields : undefined });
        break;
      }
      case "image": {
        const alt = str(b.alt) ?? "Image";
        if (isHttps(b.url)) blocks.push({ type: "image", url: b.url, alt });
        else blocks.push({ type: "text", text: alt });
        break;
      }
      case "divider":
        blocks.push({ type: "divider" });
        break;
      case "actions": {
        const buttons: NormButton[] = [];
        for (const el of Array.isArray(b.elements) ? b.elements : []) {
          if (!isObj(el) || el.type !== "button" || typeof el.label !== "string") continue;
          const style = el.style === "primary" || el.style === "danger" ? el.style : undefined;
          const type = el.action_type;
          if (type === undefined || type === null || type === "default") {
            const actionId = str(el.action_id);
            if (actionId) buttons.push({ kind: "callback", label: el.label, style, actionId });
          } else if (type === "link" && isSaltHttps(el.url)) {
            buttons.push({ kind: "link", label: el.label, style, url: el.url });
          } else {
            // pay, handoff, signup, a link with a bad url, and any type this
            // renderer has never heard of: Salt executes these, so open Salt.
            buttons.push({ kind: "link", label: el.label, style, url: openUrl });
          }
        }
        if (buttons.length) blocks.push({ type: "actions", buttons });
        break;
      }
      case "input": {
        const blockId = str(b.block_id);
        if (!blockId) break;
        blocks.push({
          type: "input",
          blockId,
          label: str(b.label) ?? blockId,
          placeholder: str(b.placeholder),
          multiline: b.multiline === true,
          maxLength: typeof b.max_length === "number" ? b.max_length : DEFAULT_INPUT_MAX,
        });
        break;
      }
      default: {
        // A block type this renderer does not know: say what text it carries.
        const text = str(b.text) ?? str(b.label) ?? str(b.alt) ?? str(b.fallback);
        if (text) blocks.push({ type: "text", text });
      }
    }
  }
  return { cardId, openUrl, blocks };
}

export function plainText(n: Normalized): string {
  const lines: string[] = [];
  for (const b of n.blocks) {
    switch (b.type) {
      case "section":
        if (b.text) lines.push(b.text);
        for (const f of b.fields ?? []) lines.push(`${f.label}: ${f.value}`);
        break;
      case "image":
        lines.push(`${b.alt} ${b.url}`);
        break;
      case "divider":
        lines.push("---");
        break;
      case "actions":
        lines.push(b.buttons.map((x) => (x.kind === "link" ? `[${x.label}] ${x.url}` : `[${x.label}]`)).join("  "));
        break;
      case "input":
        lines.push(`${b.label}:`);
        break;
      case "text":
        lines.push(b.text);
        break;
    }
  }
  return lines.join("\n");
}

const PREFIX = "salt:";
const HASH_PREFIX = "salt#";

/**
 * The callback string a tap sends back: `salt:<card_id>:<action_id>`. When that
 * would exceed the platform's cap it becomes `salt#<16 chars of sha256>` and the
 * pair is recorded in `hashed` so `parseInteraction` can map it back.
 */
export function encodeCallback(
  cardId: string,
  actionId: string,
  maxLength: number,
  hashed: HashedCallbacks
): string {
  const plain = `${PREFIX}${cardId}:${actionId}`;
  if (Buffer.byteLength(plain, "utf8") <= maxLength) return plain;
  const key = HASH_PREFIX + createHash("sha256").update(`${cardId}\n${actionId}`).digest("base64url").slice(0, 16);
  hashed[key] = { card_id: cardId, action_id: actionId };
  return key;
}

export type HashResolver = HashedCallbacks | ((key: string) => { card_id: string; action_id: string } | undefined);

export function decodeCallback(
  data: unknown,
  resolve?: HashResolver
): { card_id: string; action_id: string } | null {
  if (typeof data !== "string") return null;
  if (data.startsWith(HASH_PREFIX)) {
    const hit = typeof resolve === "function" ? resolve(data) : resolve?.[data];
    return hit ? { card_id: hit.card_id, action_id: hit.action_id } : null;
  }
  if (!data.startsWith(PREFIX)) return null;
  const rest = data.slice(PREFIX.length);
  const i = rest.lastIndexOf(":");
  if (i < 0) return null;
  const action_id = rest.slice(i + 1);
  if (!action_id) return null;
  return { card_id: rest.slice(0, i), action_id };
}
