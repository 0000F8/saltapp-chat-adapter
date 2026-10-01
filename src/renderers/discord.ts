import {
  type HashedCallbacks,
  type RenderMeta,
  type RenderOptions,
  type SaltCardLike,
  ELLIPSIS,
  encodeCallback,
  normalizeCard,
  plainText,
  truncate,
} from "./common";

// Discord limits (docs.discord.com/developers/resources/message,
// .../components/reference): 10 embeds per message and 6000 characters across
// all of them; embed description 4096; 25 fields, name 256, value 1024; an
// action row holds 5 buttons and a message 5 action rows; button label 80,
// custom_id 100, link url 512.
export const DISCORD_LIMITS = {
  EMBEDS: 10,
  EMBED_TOTAL: 6000,
  DESCRIPTION: 4096,
  FIELDS: 25,
  FIELD_NAME: 256,
  FIELD_VALUE: 1024,
  ROWS: 5,
  BUTTONS_PER_ROW: 5,
  LABEL: 80,
  CUSTOM_ID: 100,
  URL: 512,
} as const;

const BRAND_BLUE = 0x2563eb;

interface Embed {
  description?: string;
  fields?: Array<{ name: string; value: string; inline: boolean }>;
  image?: { url: string };
  color: number;
}

export interface DiscordMessage extends RenderMeta {
  embeds: Embed[];
  components: Array<Record<string, unknown>>;
  /** Pings are inert: nothing a card says can mention anyone. */
  allowed_mentions: { parse: never[] };
}

/** Discord renders markdown in embeds; card text is data, so neutralize it. */
export function escapeDiscord(s: string): string {
  return s.replace(/([\\*_~`|>#\[\]()])/g, "\\$1").replace(/@/g, "@\u200b");
}

export function toDiscordMessage(card: SaltCardLike, options: RenderOptions = {}): DiscordMessage {
  const n = normalizeCard(card, options);
  const hashedCallbacks: HashedCallbacks = {};
  let truncated = false;
  let budget: number = DISCORD_LIMITS.EMBED_TOTAL;

  const embeds: Embed[] = [];
  const components: Array<Record<string, unknown>> = [];
  let cur: Embed = { color: BRAND_BLUE };
  const curUsed = () => Boolean(cur.description || cur.fields?.length);
  const flush = () => {
    if (curUsed()) embeds.push(cur);
    cur = { color: BRAND_BLUE };
  };
  const spend = (s: string, max: number): string => {
    let out = truncate(s, max);
    if (out !== s) truncated = true;
    if (out.length > budget) {
      out = truncate(out, Math.max(budget, 0));
      truncated = true;
    }
    budget -= out.length;
    return out;
  };
  const addDescription = (text: string) => {
    const sep = cur.description ? "\n\n" : "";
    const room = DISCORD_LIMITS.DESCRIPTION - (cur.description?.length ?? 0) - sep.length;
    if (room <= 0) {
      truncated = true;
      return;
    }
    const piece = spend(escapeDiscord(text), room);
    if (piece) cur.description = (cur.description ?? "") + sep + piece;
  };

  for (const b of n.blocks) {
    if (embeds.length >= DISCORD_LIMITS.EMBEDS) {
      truncated = true;
      break;
    }
    switch (b.type) {
      case "section":
        if (b.text) addDescription(b.text);
        for (const f of b.fields ?? []) {
          cur.fields ??= [];
          if (cur.fields.length >= DISCORD_LIMITS.FIELDS) {
            truncated = true;
            break;
          }
          cur.fields.push({
            name: spend(escapeDiscord(f.label) || "\u200b", DISCORD_LIMITS.FIELD_NAME),
            value: spend(escapeDiscord(f.value) || "\u200b", DISCORD_LIMITS.FIELD_VALUE),
            inline: false,
          });
        }
        break;
      case "text":
        addDescription(b.text);
        break;
      case "divider":
        addDescription("\u2500\u2500\u2500\u2500\u2500\u2500");
        break;
      case "input":
        // Discord cannot carry a text field on a message (only in a modal); say what was asked.
        addDescription(`${b.label} (answer in Salt)`);
        break;
      case "image":
        flush();
        embeds.push({ image: { url: b.url }, color: BRAND_BLUE });
        break;
      case "actions": {
        if (components.length >= DISCORD_LIMITS.ROWS) {
          truncated = true;
          break;
        }
        if (b.buttons.length > DISCORD_LIMITS.BUTTONS_PER_ROW) truncated = true;
        const row = b.buttons.slice(0, DISCORD_LIMITS.BUTTONS_PER_ROW).map((x) => {
          const label = truncate(x.label, DISCORD_LIMITS.LABEL);
          if (label !== x.label) truncated = true;
          if (x.kind === "link") return { type: 2, style: 5, label, url: truncate(x.url, DISCORD_LIMITS.URL) };
          return {
            type: 2,
            // 1 primary (blurple), 4 danger (red), 2 secondary (grey).
            style: x.style === "primary" ? 1 : x.style === "danger" ? 4 : 2,
            label,
            custom_id: encodeCallback(n.cardId, x.actionId, DISCORD_LIMITS.CUSTOM_ID, hashedCallbacks),
          };
        });
        components.push({ type: 1, components: row });
        break;
      }
    }
  }
  flush();
  if (truncated && embeds.length) {
    const last = embeds[embeds.length - 1];
    if (last.description !== undefined && last.description.length < DISCORD_LIMITS.DESCRIPTION) {
      last.description += ELLIPSIS;
    }
  }
  return {
    embeds: embeds.slice(0, DISCORD_LIMITS.EMBEDS),
    components,
    allowed_mentions: { parse: [] },
    fallbackText: plainText(n),
    truncated,
    hashedCallbacks,
  };
}
