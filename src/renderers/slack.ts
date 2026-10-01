import {
  type HashedCallbacks,
  type NormBlock,
  type RenderMeta,
  type RenderOptions,
  type SaltCardLike,
  ELLIPSIS,
  encodeCallback,
  normalizeCard,
  plainText,
  truncate,
} from "./common";

// Slack Block Kit limits (docs.slack.dev/reference/block-kit): 50 blocks per
// message; section text 3000, up to 10 fields of 2000; button text 75;
// action_id 255; button value 2000; url 3000; an actions block holds 25.
export const SLACK_LIMITS = {
  MAX_BLOCKS: 50,
  SECTION_TEXT: 3000,
  FIELDS: 10,
  FIELD_TEXT: 2000,
  BUTTON_TEXT: 75,
  ACTION_ID: 255,
  ACTION_ELEMENTS: 25,
  ALT_TEXT: 2000,
  LABEL: 2000,
} as const;

export interface SlackMessage extends RenderMeta {
  blocks: Array<Record<string, unknown>>;
}

const plain = (text: string, max: number) => ({ type: "plain_text", text: truncate(text, max), emoji: false });

export function toSlackBlocks(card: SaltCardLike, options: RenderOptions = {}): SlackMessage {
  const n = normalizeCard(card, options);
  const hashedCallbacks: HashedCallbacks = {};
  let truncated = false;
  const out: Array<Record<string, unknown>> = [];
  let linkSeq = 0;

  const note = (cut: boolean) => {
    if (cut) truncated = true;
  };

  for (const b of n.blocks as NormBlock[]) {
    switch (b.type) {
      case "section": {
        const block: Record<string, unknown> = { type: "section" };
        if (b.text) {
          note(b.text.length > SLACK_LIMITS.SECTION_TEXT);
          block.text = plain(b.text, SLACK_LIMITS.SECTION_TEXT);
        }
        if (b.fields) {
          note(b.fields.length > SLACK_LIMITS.FIELDS);
          const fields = b.fields.slice(0, SLACK_LIMITS.FIELDS).map((f) => {
            const t = `${f.label}: ${f.value}`;
            note(t.length > SLACK_LIMITS.FIELD_TEXT);
            return plain(t, SLACK_LIMITS.FIELD_TEXT);
          });
          block.fields = fields;
        }
        out.push(block);
        break;
      }
      case "text":
        note(b.text.length > SLACK_LIMITS.SECTION_TEXT);
        out.push({ type: "section", text: plain(b.text, SLACK_LIMITS.SECTION_TEXT) });
        break;
      case "image":
        out.push({ type: "image", image_url: b.url, alt_text: truncate(b.alt, SLACK_LIMITS.ALT_TEXT) });
        break;
      case "divider":
        out.push({ type: "divider" });
        break;
      case "actions": {
        note(b.buttons.length > SLACK_LIMITS.ACTION_ELEMENTS);
        const elements = b.buttons.slice(0, SLACK_LIMITS.ACTION_ELEMENTS).map((x) => {
          note(x.label.length > SLACK_LIMITS.BUTTON_TEXT);
          const el: Record<string, unknown> = { type: "button", text: plain(x.label, SLACK_LIMITS.BUTTON_TEXT) };
          if (x.style === "primary") el.style = "primary";
          if (x.style === "danger") el.style = "danger";
          if (x.kind === "link") {
            el.url = x.url;
            // Slack requires an action_id; it is deliberately not a salt: callback, so parseInteraction ignores the click.
            el.action_id = `open-${++linkSeq}`;
          } else {
            const enc = encodeCallback(n.cardId, x.actionId, SLACK_LIMITS.ACTION_ID, hashedCallbacks);
            el.action_id = enc;
            el.value = enc;
          }
          return el;
        });
        out.push({ type: "actions", elements });
        break;
      }
      case "input":
        out.push({
          type: "input",
          block_id: b.blockId,
          optional: true,
          label: plain(b.label, SLACK_LIMITS.LABEL),
          element: {
            type: "plain_text_input",
            action_id: b.blockId,
            multiline: b.multiline,
            max_length: b.maxLength,
            ...(b.placeholder ? { placeholder: plain(b.placeholder, 150) } : {}),
          },
        });
        break;
    }
  }

  if (out.length > SLACK_LIMITS.MAX_BLOCKS) {
    truncated = true;
    out.length = SLACK_LIMITS.MAX_BLOCKS - 1;
    out.push({ type: "section", text: plain(ELLIPSIS, 10) });
  }
  return { blocks: out, fallbackText: plainText(n), truncated, hashedCallbacks };
}
