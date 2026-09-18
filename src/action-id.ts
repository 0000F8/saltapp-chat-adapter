// A chat-sdk ButtonElement carries a free-form `id` and an optional `value`
// (see cards.ts's mapping notes). Salt's own card schema (CARD_PROTOCOL_SPEC.md,
// salt-api's Card model) has no per-button `value` field at all, and its
// `action_id` is constrained to `/^[a-z0-9_-]{1,40}$/` -- lowercase only, no
// separators beyond `_`/`-`, 40 chars max.
//
// So both id and value have to travel inside that one 40-char slot. When
// there's no value, the id (sanitized) travels as-is. When there is one,
// they're packed as `h<hex(JSON.stringify([id, value]))>` -- hex because
// it's the only common encoding whose alphabet (0-9a-f) is already a subset
// of what Salt allows, so no further sanitizing can corrupt it. This is the
// same shape Telegram's adapter uses for callback_data (see its cards.ts),
// adapted to a much tighter length budget: Telegram throws a ValidationError
// when a payload overflows its 64-byte callback_data limit, and this does
// the same at 40 chars.

import { ValidationError } from "@chat-adapter/shared";

const PLATFORM = "salt";
export const SALT_ACTION_ID_MAX_LENGTH = 40;
const ENCODED_PREFIX = "h";

/** Lowercases and strips anything outside Salt's action_id charset. */
export function sanitizeSaltActionId(id: string): string {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return (cleaned || "action").slice(0, SALT_ACTION_ID_MAX_LENGTH);
}

/**
 * Encodes a chat-sdk button's `(id, value)` pair into a Salt-legal
 * action_id. Throws ValidationError if the encoded form would overflow
 * Salt's 40-char limit -- same failure mode Telegram's adapter uses for its
 * own callback_data limit, so a card author gets a build-time error rather
 * than a button that silently can't be tapped.
 */
export function encodeSaltActionId(id: string, value?: string): string {
  if (value === undefined) {
    return sanitizeSaltActionId(id);
  }
  const hex = Buffer.from(JSON.stringify([id, value]), "utf8").toString("hex");
  const encoded = `${ENCODED_PREFIX}${hex}`;
  if (encoded.length > SALT_ACTION_ID_MAX_LENGTH) {
    throw new ValidationError(
      PLATFORM,
      `Card action id "${id}" + value is too large for Salt (button action_id is capped at ${SALT_ACTION_ID_MAX_LENGTH} chars; encoded this pair needs ${encoded.length}). Shorten the action id or its value.`
    );
  }
  return encoded;
}

/**
 * Reverses encodeSaltActionId. Anything that isn't a recognized encoded
 * payload is returned as a bare action id with no value -- this is what
 * lets a plain (no-value) button's action_id round-trip untouched, and
 * fails safe on anything unexpected (a hand-authored card, a future Salt
 * card this adapter didn't create).
 */
export function decodeSaltActionId(actionId: string): { actionId: string; value?: string } {
  if (actionId.startsWith(ENCODED_PREFIX) && /^[0-9a-f]+$/.test(actionId.slice(1))) {
    try {
      const raw = Buffer.from(actionId.slice(1), "hex").toString("utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
        return { actionId: parsed[0], value: parsed[1] };
      }
    } catch {
      // Fall through to the passthrough below.
    }
  }
  return { actionId };
}
