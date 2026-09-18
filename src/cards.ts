// Maps a chat-sdk CardElement (the cross-platform rich-message abstraction:
// `Card`/`Section`/`Actions`/`Button`/... from the "chat" package) onto
// Salt's own declarative card block vocabulary -- section / fields / image /
// divider / actions+buttons, exactly as CARD_PROTOCOL_SPEC.md and salt-api's
// Card model (app/models/card.rb) validate it. Nothing here talks to the
// network; salt-rest.ts's postCard/updateCard take the blocks this produces.
//
// Salt's vocabulary is deliberately smaller than the generic one (no links,
// tables, charts, selects, or link-buttons as first-class blocks -- see
// CARD_PROTOCOL_SPEC.md section 2.2: "the schema IS the author's entire
// vocabulary"). Anything chat-sdk can express that Salt can't render
// natively degrades to plain text inside a `section` block rather than
// being dropped silently, so a card built for Slack still says something
// useful on Salt.

import { ValidationError, cardToFallbackText } from "@chat-adapter/shared";
import type {
  ActionsElement,
  ButtonElement,
  CardChild,
  CardElement,
} from "chat";
import { chartElementToFallbackText, tableElementToAscii } from "chat";
import { encodeSaltActionId } from "./action-id";

const PLATFORM = "salt";

// Mirrors salt-api's app/models/card.rb constants exactly -- keep these two
// files in sync if the server-side limits ever change.
export const SALT_CARD_LIMITS = {
  MAX_BLOCKS: 20,
  MAX_BUTTONS_PER_ACTIONS: 5,
  MAX_FIELDS: 10,
  MAX_TEXT: 2000,
  MAX_LABEL: 40,
  MAX_FIELD_VALUE: 160, // MAX_LABEL * 4 in card.rb
  MAX_URL: 500,
} as const;

export type SaltButtonStyle = "primary" | "danger";
export type SaltActionType = "default" | "pay" | "handoff";

export interface SaltButtonBlockElement {
  type: "button";
  action_id: string;
  label: string;
  style?: SaltButtonStyle;
  action_type?: SaltActionType;
  restricted_to?: string[];
}

export type SaltCardBlock =
  | { type: "section"; text?: string; fields?: Array<{ label: string; value: string }> }
  | { type: "image"; url: string; alt?: string }
  | { type: "divider" }
  | { type: "actions"; elements: SaltButtonBlockElement[] };

export interface SaltCardBlocks {
  blocks: SaltCardBlock[];
  /** Plain-text preview for the message bubble every card rides on (cards_controller#create's `text` param). */
  fallbackText: string;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function textSection(text: string): SaltCardBlock {
  return { type: "section", text: truncate(text, SALT_CARD_LIMITS.MAX_TEXT) };
}

function mapActionsChild(child: ActionsElement): { blocks: SaltCardBlock[] } {
  const buttons: SaltButtonBlockElement[] = [];
  const unsupported: string[] = [];

  for (const el of child.children) {
    if (el.type === "button") {
      const button = el as ButtonElement;
      buttons.push({
        type: "button",
        action_id: encodeSaltActionId(button.id, button.value),
        label: truncate(button.label, SALT_CARD_LIMITS.MAX_LABEL),
        style: button.style === "primary" || button.style === "danger" ? button.style : undefined,
        action_type: "default",
      });
      continue;
    }
    if (el.type === "link-button") {
      unsupported.push(`${el.label} (opens ${el.url})`);
      continue;
    }
    // SelectElement / RadioSelectElement: Salt's card schema has no
    // interactive select equivalent (only buttons). Named rather than
    // dropped, same instinct as the link-button fallback above.
    const label = "label" in el && typeof (el as { label?: unknown }).label === "string" ? (el as { label: string }).label : el.type;
    unsupported.push(`${label}: choice not supported on Salt`);
  }

  const blocks: SaltCardBlock[] = [];
  // Salt caps 5 buttons per `actions` block (MAX_BUTTONS_PER_ACTIONS); split
  // a larger row into consecutive blocks rather than truncating buttons off.
  for (let i = 0; i < buttons.length; i += SALT_CARD_LIMITS.MAX_BUTTONS_PER_ACTIONS) {
    blocks.push({ type: "actions", elements: buttons.slice(i, i + SALT_CARD_LIMITS.MAX_BUTTONS_PER_ACTIONS) });
  }
  if (unsupported.length > 0) {
    blocks.push(textSection(unsupported.join("\n")));
  }
  return { blocks };
}

/** Flattens one CardChild into zero or more Salt blocks. Recurses into a nested `section` (Salt has no nested containers). */
function mapChild(child: CardChild): SaltCardBlock[] {
  switch (child.type) {
    case "text":
      return [textSection(child.content)];
    case "image":
      return [{ type: "image", url: truncate(child.url, SALT_CARD_LIMITS.MAX_URL), alt: child.alt ? truncate(child.alt, SALT_CARD_LIMITS.MAX_LABEL * 4) : undefined }];
    case "divider":
      return [{ type: "divider" }];
    case "fields":
      return [
        {
          type: "section",
          fields: child.children.slice(0, SALT_CARD_LIMITS.MAX_FIELDS).map((f) => ({
            label: truncate(f.label, SALT_CARD_LIMITS.MAX_LABEL),
            value: truncate(f.value, SALT_CARD_LIMITS.MAX_FIELD_VALUE),
          })),
        },
      ];
    case "link":
      // No native link block -- render as visible text (same fallback chat-sdk's
      // own cardChildToFallbackText uses for a "link" child).
      return [textSection(`${child.label} (${child.url})`)];
    case "table":
      return [textSection(tableElementToAscii(child.headers, child.rows))];
    case "chart":
      return [textSection(chartElementToFallbackText(child))];
    case "actions":
      return mapActionsChild(child).blocks;
    case "section":
      return child.children.flatMap(mapChild);
    default:
      return [];
  }
}

/**
 * Converts a chat-sdk CardElement into Salt's `state.blocks` array plus a
 * plain-text fallback (used both as the message bubble's plaintext preview
 * and as what a client that can't render blocks would show).
 *
 * Throws ValidationError when the result would exceed Salt's own limits
 * (block count, or a button whose id+value can't fit in Salt's 40-char
 * action_id -- see action-id.ts) -- the same fail-fast precedent Telegram's
 * adapter sets for its callback_data size limit, so an author finds out at
 * build/post time rather than via a silent server-side 422.
 */
export function cardElementToSaltBlocks(card: CardElement): SaltCardBlocks {
  const blocks: SaltCardBlock[] = [];

  const titleLine = [card.title, card.subtitle].filter((v): v is string => !!v).join("\n");
  if (titleLine) blocks.push(textSection(titleLine));
  if (card.imageUrl) blocks.push({ type: "image", url: truncate(card.imageUrl, SALT_CARD_LIMITS.MAX_URL), alt: card.title });

  for (const child of card.children) {
    blocks.push(...mapChild(child));
  }

  if (blocks.length === 0) {
    // Card model requires at least one block -- an empty card (e.g. a bare
    // Card() with no children yet) would otherwise 422 with no useful clue.
    blocks.push(textSection(card.title || card.subtitle || " "));
  }

  if (blocks.length > SALT_CARD_LIMITS.MAX_BLOCKS) {
    throw new ValidationError(
      PLATFORM,
      `Card has ${blocks.length} blocks after conversion; Salt allows at most ${SALT_CARD_LIMITS.MAX_BLOCKS}. Split it into a smaller card or a follow-up message.`
    );
  }

  return { blocks, fallbackText: truncate(cardToFallbackText(card), 200) };
}
