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

// Telegram Bot API limits (core.telegram.org/bots/api): message text 1-4096
// characters after entity parsing; callback_data 1-64 bytes; an inline keyboard
// takes at most 8 buttons a row and 100 in all.
export const TELEGRAM_LIMITS = {
  TEXT: 4096,
  CALLBACK_DATA: 64,
  BUTTONS_PER_ROW: 8,
  BUTTONS_TOTAL: 100,
  LABEL: 40,
  URL: 2048,
} as const;

export interface TelegramMessage extends RenderMeta {
  /** HTML-formatted text, to send with `parse_mode: "HTML"`. */
  text: string;
  parse_mode: "HTML";
  reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string } | { text: string; url: string }>> };
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Longest prefix of `source` whose HTML-escaped form fits `max`, with an ellipsis when cut. */
function fitEscaped(source: string, max: number): { html: string; cut: boolean } {
  if (escapeHtml(source).length <= max) return { html: escapeHtml(source), cut: false };
  // Escaped length grows with the prefix, so binary-search the longest one that leaves room for the ellipsis.
  let lo = 0;
  let hi = Math.min(source.length, max);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (escapeHtml(source.slice(0, mid)).length + 1 <= max) lo = mid;
    else hi = mid - 1;
  }
  const len = lo;
  return { html: escapeHtml(source.slice(0, Math.max(len, 0)).trimEnd()) + ELLIPSIS, cut: true };
}

export function toTelegramMessage(card: SaltCardLike, options: RenderOptions = {}): TelegramMessage {
  const n = normalizeCard(card, options);
  const hashedCallbacks: HashedCallbacks = {};
  let truncated = false;
  const keyboard: TelegramMessage["reply_markup"]["inline_keyboard"] = [];
  let buttonCount = 0;

  // Each part is [source-for-escaping, wrapper]; built as final HTML strings with a running budget.
  const parts: string[] = [];
  let used = 0;
  const push = (render: (escaped: string) => string, source: string, overhead = 0) => {
    const sepLen = parts.length ? 2 : 0;
    const room = TELEGRAM_LIMITS.TEXT - used - sepLen - overhead;
    if (room <= 0) {
      truncated = true;
      return;
    }
    const { html, cut } = fitEscaped(source, room);
    if (cut) truncated = true;
    const piece = render(html);
    parts.push(piece);
    used += sepLen + piece.length;
  };

  for (const b of n.blocks) {
    switch (b.type) {
      case "section":
        if (b.text) push((h) => h, b.text);
        for (const f of b.fields ?? []) push((h) => `<b>${escapeHtml(f.label)}</b>: ${h}`, f.value, escapeHtml(f.label).length + 11);
        break;
      case "text":
        push((h) => h, b.text);
        break;
      case "divider":
        push((h) => h, "\u2500\u2500\u2500\u2500\u2500\u2500");
        break;
      case "image": {
        const href = b.url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
        push((h) => `<a href="${href}">${h}</a>`, b.alt, href.length + 15);
        break;
      }
      case "input":
        push((h) => `<i>${h}</i>`, b.label, 7);
        break;
      case "actions": {
        const row: TelegramMessage["reply_markup"]["inline_keyboard"][number] = [];
        for (const x of b.buttons) {
          if (row.length >= TELEGRAM_LIMITS.BUTTONS_PER_ROW || buttonCount >= TELEGRAM_LIMITS.BUTTONS_TOTAL) {
            truncated = true;
            break;
          }
          const text = truncate(x.label, TELEGRAM_LIMITS.LABEL);
          if (text !== x.label) truncated = true;
          if (x.kind === "link") row.push({ text, url: truncate(x.url, TELEGRAM_LIMITS.URL) });
          else
            row.push({
              text,
              callback_data: encodeCallback(n.cardId, x.actionId, TELEGRAM_LIMITS.CALLBACK_DATA, hashedCallbacks),
            });
          buttonCount++;
        }
        if (row.length) keyboard.push(row);
        break;
      }
    }
  }

  // Telegram refuses an empty message; an actions-only card still needs a line.
  const text = parts.join("\n\n") || escapeHtml(truncate(plainText(n) || "Salt card", TELEGRAM_LIMITS.TEXT));
  return {
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard },
    fallbackText: plainText(n),
    truncated,
    hashedCallbacks,
  };
}
