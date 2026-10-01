import {
  type HashedCallbacks,
  type RenderMeta,
  type RenderOptions,
  type SaltCardLike,
  encodeCallback,
  normalizeCard,
  plainText,
  truncate,
} from "./common";

// Adaptive Card 1.5 (renders in Teams and Outlook actionable messages). Salt's
// own limits already bound the card (<= 20 blocks, text 2000); Adaptive adds no
// per-element count we can exceed except the 28 KB payload cap, which 20 blocks
// of <= 2000 chars stays under. Titles are held to Salt's 40-char label cap.
export const ADAPTIVE_LIMITS = { TITLE: 40, TEXT: 2000, DATA: 1000 } as const;

/** Key under which an Action.Submit carries the callback string; input values ride beside it under their own ids. */
export const ADAPTIVE_DATA_KEY = "__salt";

export interface AdaptiveCardMessage extends RenderMeta {
  card: Record<string, unknown>;
}

export function toAdaptiveCard(card: SaltCardLike, options: RenderOptions = {}): AdaptiveCardMessage {
  const n = normalizeCard(card, options);
  const hashedCallbacks: HashedCallbacks = {};
  let truncated = false;
  const t = (s: string, max: number) => {
    if (s.length > max) truncated = true;
    return truncate(s, max);
  };

  const body: Array<Record<string, unknown>> = [];
  for (const b of n.blocks) {
    switch (b.type) {
      case "section":
        if (b.text) body.push({ type: "TextBlock", text: t(b.text, ADAPTIVE_LIMITS.TEXT), wrap: true });
        if (b.fields)
          body.push({
            type: "FactSet",
            facts: b.fields.map((f) => ({ title: f.label, value: f.value })),
          });
        break;
      case "text":
        body.push({ type: "TextBlock", text: t(b.text, ADAPTIVE_LIMITS.TEXT), wrap: true });
        break;
      case "image":
        body.push({ type: "Image", url: b.url, altText: b.alt, size: "Stretch" });
        break;
      case "divider":
        body.push({ type: "TextBlock", text: " ", separator: true });
        break;
      case "actions":
        body.push({
          type: "ActionSet",
          actions: b.buttons.map((x) => {
            const style = x.style === "primary" ? "positive" : x.style === "danger" ? "destructive" : undefined;
            const base: Record<string, unknown> = { title: t(x.label, ADAPTIVE_LIMITS.TITLE) };
            if (style) base.style = style;
            if (x.kind === "link") return { type: "Action.OpenUrl", ...base, url: x.url };
            return {
              type: "Action.Submit",
              ...base,
              data: { [ADAPTIVE_DATA_KEY]: encodeCallback(n.cardId, x.actionId, ADAPTIVE_LIMITS.DATA, hashedCallbacks) },
            };
          }),
        });
        break;
      case "input":
        body.push({
          type: "Input.Text",
          id: b.blockId,
          label: b.label,
          isMultiline: b.multiline,
          maxLength: b.maxLength,
          ...(b.placeholder ? { placeholder: b.placeholder } : {}),
        });
        break;
    }
  }

  return {
    card: {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.5",
      body,
    },
    fallbackText: plainText(n),
    truncated,
    hashedCallbacks,
  };
}
