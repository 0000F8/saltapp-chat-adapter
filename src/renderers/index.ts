import { ADAPTIVE_DATA_KEY } from "./adaptive";
import { type HashResolver, type SaltCardInteraction, decodeCallback } from "./common";

export { toSlackBlocks, SLACK_LIMITS, type SlackMessage } from "./slack";
export { toAdaptiveCard, ADAPTIVE_LIMITS, ADAPTIVE_DATA_KEY, type AdaptiveCardMessage } from "./adaptive";
export { toDiscordMessage, DISCORD_LIMITS, escapeDiscord, type DiscordMessage } from "./discord";
export { toTelegramMessage, TELEGRAM_LIMITS, escapeHtml, type TelegramMessage } from "./telegram";
export {
  openInSaltUrl,
  type HashResolver,
  type HashedCallbacks,
  type RenderMeta,
  type RenderOptions,
  type SaltCardInteraction,
  type SaltCardLike,
} from "./common";

export type SaltCardPlatform = "slack" | "teams" | "adaptive" | "discord" | "telegram";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function maybeJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const t = raw.trim();
  if (t.startsWith("{")) {
    try {
      return JSON.parse(t);
    } catch {
      return raw;
    }
  }
  return raw;
}

/**
 * Turns the raw payload a platform sends when a person taps a card button back
 * into the shape of Salt's `card_interaction`, or null when the tap was not on
 * one of these buttons (a link button, someone else's component).
 *
 *  - slack: the `block_actions` payload (object or its JSON string)
 *  - teams / adaptive: the activity, or the Action.Submit `data` object
 *  - discord: the interaction object (or just its `data`)
 *  - telegram: the `callback_query` (or its `data` string)
 *
 * Pass `{ hashed }` (the `hashedCallbacks` the renderer returned, or a lookup
 * function) so a callback that was too long to carry in full can be resolved.
 */
export function parseInteraction(
  platform: SaltCardPlatform,
  rawPayload: unknown,
  options: { hashed?: HashResolver } = {}
): SaltCardInteraction | null {
  const raw = maybeJson(rawPayload);
  const done = (data: unknown, values?: Record<string, string>): SaltCardInteraction | null => {
    const hit = decodeCallback(data, options.hashed);
    if (!hit) return null;
    return values && Object.keys(values).length ? { ...hit, values } : hit;
  };

  switch (platform) {
    case "slack": {
      if (!isObj(raw)) return null;
      const action = Array.isArray(raw.actions) ? raw.actions[0] : undefined;
      if (!isObj(action)) return null;
      const values: Record<string, string> = {};
      const state = isObj(raw.state) ? raw.state.values : undefined;
      if (isObj(state)) {
        for (const [blockId, byAction] of Object.entries(state)) {
          if (!isObj(byAction)) continue;
          for (const el of Object.values(byAction)) {
            if (isObj(el) && el.type === "plain_text_input" && typeof el.value === "string" && el.value) {
              values[blockId] = el.value;
            }
          }
        }
      }
      return done(action.value ?? action.action_id, values);
    }
    case "teams":
    case "adaptive": {
      if (!isObj(raw)) return null;
      const data = isObj(raw.value) ? raw.value : raw;
      const values: Record<string, string> = {};
      for (const [k, v] of Object.entries(data)) {
        if (k !== ADAPTIVE_DATA_KEY && typeof v === "string" && v) values[k] = v;
      }
      return done(data[ADAPTIVE_DATA_KEY], values);
    }
    case "discord": {
      if (!isObj(raw)) return null;
      const data = isObj(raw.data) ? raw.data : raw;
      return done(data.custom_id);
    }
    case "telegram": {
      if (typeof raw === "string") return done(raw);
      if (!isObj(raw)) return null;
      const q = isObj(raw.callback_query) ? raw.callback_query : raw;
      return done(q.data);
    }
    default:
      return null;
  }
}
