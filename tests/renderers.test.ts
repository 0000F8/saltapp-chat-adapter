import { describe, expect, it } from "vitest";
import {
  parseInteraction,
  toAdaptiveCard,
  toDiscordMessage,
  toSlackBlocks,
  toTelegramMessage,
  DISCORD_LIMITS,
  SLACK_LIMITS,
  TELEGRAM_LIMITS,
} from "../src/renderers";

const CARD_ID = "7d2f3c1e-5b7a-4c1e-9f0a-2a1b3c4d5e6f";
const CHAT_ID = "c0ffee00-1111-4222-8333-444455556666";
const MSG_ID = "m-1234";
const OPEN = `https://saltapp.ai/chats/${CHAT_ID}?message=${MSG_ID}`;

function fixture(extra: unknown[] = []) {
  return {
    id: CARD_ID,
    chat_id: CHAT_ID,
    message_id: MSG_ID,
    state: {
      blocks: [
        { type: "section", text: "Order <#42> from @everyone *bold*", fields: [{ label: "Total", value: "1.50 ETH" }, { label: "Item", value: "Salt & pepper" }] },
        { type: "image", url: "https://example.com/p.png", alt: "Product" },
        { type: "image", url: "http://insecure.example/p.png", alt: "Insecure" },
        { type: "divider" },
        { type: "input", block_id: "note", label: "Add a note", placeholder: "optional", multiline: true, max_length: 200 },
        {
          type: "actions",
          elements: [
            { type: "button", action_id: "approve", label: "Approve", style: "primary" },
            { type: "button", action_id: "reject", label: "Reject", style: "danger" },
            { type: "button", action_id: "pay", label: "Pay 1.50", action_type: "pay", pay: { amount: "1.50", currency: "ETH" } },
            { type: "button", action_id: "hand", label: "Ask Ada", action_type: "handoff", handoff_target_agent_id: "x" },
            { type: "button", action_id: "docs", label: "Docs", action_type: "link", url: "https://saltapp.ai/docs" },
          ],
        },
        { type: "mystery", text: "from the future" },
        ...extra,
      ],
    },
  };
}

const callbackActions = ["approve", "reject"];

describe("slack", () => {
  const r = toSlackBlocks(fixture());
  const actions = r.blocks.find((b) => b.type === "actions") as { elements: Array<Record<string, any>> };

  it("renders every block type", () => {
    const types = r.blocks.map((b) => b.type);
    expect(types).toEqual(["section", "image", "section", "divider", "input", "actions", "section"]);
    expect((r.blocks[0] as any).fields).toHaveLength(2);
    expect((r.blocks[0] as any).text.type).toBe("plain_text");
    expect((r.blocks[2] as any).text.text).toBe("Insecure");
    expect((r.blocks[6] as any).text.text).toBe("from the future");
  });

  it("renders pay, handoff as links to Salt and never callbacks", () => {
    const byLabel = Object.fromEntries(actions.elements.map((e) => [e.text.text, e]));
    for (const l of ["Pay 1.50", "Ask Ada"]) {
      expect(byLabel[l].url).toBe(OPEN);
      expect(byLabel[l].value).toBeUndefined();
      expect(byLabel[l].action_id).not.toMatch(/^salt/);
    }
    expect(byLabel.Docs.url).toBe("https://saltapp.ai/docs");
    expect(byLabel.Approve.style).toBe("primary");
    expect(byLabel.Reject.style).toBe("danger");
  });

  it("round-trips a tap with input values", () => {
    const approve = actions.elements[0];
    const payload = {
      type: "block_actions",
      actions: [{ action_id: approve.action_id, value: approve.value }],
      state: { values: { note: { note: { type: "plain_text_input", value: "thanks" } } } },
    };
    expect(parseInteraction("slack", payload)).toEqual({ card_id: CARD_ID, action_id: "approve", values: { note: "thanks" } });
    expect(parseInteraction("slack", JSON.stringify(payload))?.action_id).toBe("approve");
  });

  it("ignores a link button click", () => {
    expect(parseInteraction("slack", { actions: [{ action_id: "open-1" }] })).toBeNull();
  });

  it("truncates to 50 blocks and 3000-char text with an ellipsis", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ type: "section", text: "x".repeat(i === 0 ? 5000 : 3) }));
    const big = toSlackBlocks({ id: CARD_ID, blocks: many });
    expect(big.blocks).toHaveLength(SLACK_LIMITS.MAX_BLOCKS);
    expect(big.truncated).toBe(true);
    const first = (big.blocks[0] as any).text.text as string;
    expect(first).toHaveLength(SLACK_LIMITS.SECTION_TEXT);
    expect(first.endsWith("…")).toBe(true);
  });
});

describe("adaptive", () => {
  const r = toAdaptiveCard(fixture());
  const body = r.card.body as Array<Record<string, any>>;
  const set = body.find((b) => b.type === "ActionSet")!;

  it("renders every block type as Adaptive Card 1.5", () => {
    expect(r.card.version).toBe("1.5");
    expect(body.map((b) => b.type)).toEqual(["TextBlock", "FactSet", "Image", "TextBlock", "TextBlock", "Input.Text", "ActionSet", "TextBlock"]);
    expect(body[5].id).toBe("note");
  });

  it("renders pay as Action.OpenUrl", () => {
    const pay = set.actions.find((a: any) => a.title === "Pay 1.50");
    expect(pay).toMatchObject({ type: "Action.OpenUrl", url: OPEN });
    expect(pay.data).toBeUndefined();
    expect(set.actions.find((a: any) => a.title === "Approve").style).toBe("positive");
  });

  it("round-trips a submit (activity or bare data) with inputs", () => {
    const data = { ...set.actions[0].data, note: "ok" };
    expect(parseInteraction("adaptive", data)).toEqual({ card_id: CARD_ID, action_id: "approve", values: { note: "ok" } });
    expect(parseInteraction("teams", { type: "message", value: data })?.action_id).toBe("approve");
  });
});

describe("discord", () => {
  const r = toDiscordMessage(fixture());
  const buttons = (r.components[0] as any).components as Array<Record<string, any>>;

  it("renders embeds, fields and components", () => {
    expect(r.embeds[0].fields).toHaveLength(2);
    expect(r.embeds.some((e) => e.image?.url === "https://example.com/p.png")).toBe(true);
    expect(r.embeds[0].description).toContain("@​everyone");
    expect(r.allowed_mentions).toEqual({ parse: [] });
    expect(buttons).toHaveLength(5);
  });

  it("renders pay as a link button (style 5, no custom_id)", () => {
    const pay = buttons.find((b) => b.label === "Pay 1.50")!;
    expect(pay).toMatchObject({ type: 2, style: 5, url: OPEN });
    expect(pay.custom_id).toBeUndefined();
    expect(buttons.find((b) => b.label === "Approve")!.style).toBe(1);
  });

  it("keeps custom_id within 100 chars and round-trips", () => {
    for (const b of buttons.filter((b) => b.custom_id)) expect(b.custom_id.length).toBeLessThanOrEqual(DISCORD_LIMITS.CUSTOM_ID);
    const approve = buttons.find((b) => b.label === "Approve")!;
    expect(parseInteraction("discord", { type: 3, data: { custom_id: approve.custom_id, component_type: 2 } })).toEqual({
      card_id: CARD_ID,
      action_id: "approve",
    });
  });

  it("hashes an oversized id and resolves it through hashedCallbacks", () => {
    const longId = "c".repeat(100);
    const big = toDiscordMessage({ id: longId, blocks: [{ type: "actions", elements: [{ type: "button", action_id: "go", label: "Go" }] }] });
    const cid = (big.components[0] as any).components[0].custom_id as string;
    expect(cid.length).toBeLessThanOrEqual(100);
    expect(cid.startsWith("salt#")).toBe(true);
    expect(parseInteraction("discord", { data: { custom_id: cid } })).toBeNull();
    expect(parseInteraction("discord", { data: { custom_id: cid } }, { hashed: big.hashedCallbacks })).toEqual({ card_id: longId, action_id: "go" });
  });

  it("caps embed chars, rows and buttons", () => {
    const blocks = [
      ...Array.from({ length: 4 }, () => ({ type: "section", text: "y".repeat(2000) })),
      ...Array.from({ length: 7 }, () => ({
        type: "actions",
        elements: Array.from({ length: 5 }, (_, i) => ({ type: "button", action_id: `a${i}`, label: "B" })),
      })),
    ];
    const big = toDiscordMessage({ id: CARD_ID, blocks });
    const chars = big.embeds.reduce((n, e) => n + (e.description?.length ?? 0), 0);
    expect(chars).toBeLessThanOrEqual(DISCORD_LIMITS.EMBED_TOTAL + 1);
    expect(big.components).toHaveLength(DISCORD_LIMITS.ROWS);
    expect(big.truncated).toBe(true);
  });
});

describe("telegram", () => {
  const r = toTelegramMessage(fixture());
  const kb = r.reply_markup.inline_keyboard.flat() as Array<Record<string, any>>;

  it("renders escaped HTML text and a keyboard", () => {
    expect(r.parse_mode).toBe("HTML");
    expect(r.text).toContain("Order &lt;#42&gt; from @everyone *bold*");
    expect(r.text).toContain("<b>Item</b>: Salt &amp; pepper");
    expect(r.text).toContain('<a href="https://example.com/p.png">Product</a>');
    expect(r.text).not.toContain("<#42>");
  });

  it("renders pay as a url button", () => {
    const pay = kb.find((b) => b.text === "Pay 1.50")!;
    expect(pay.url).toBe(OPEN);
    expect(pay.callback_data).toBeUndefined();
    expect(kb.find((b) => b.text === "Ask Ada")!.url).toBe(OPEN);
  });

  it("keeps callback_data within 64 bytes, hashing when needed, and round-trips", () => {
    for (const b of kb.filter((b) => b.callback_data)) {
      expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(TELEGRAM_LIMITS.CALLBACK_DATA);
    }
    const approve = kb.find((b) => b.text === "Approve")!;
    expect(approve.callback_data).toBe(`salt:${CARD_ID}:approve`);
    expect(parseInteraction("telegram", { callback_query: { data: approve.callback_data } })).toEqual({
      card_id: CARD_ID,
      action_id: "approve",
    });
    const longAction = "a".repeat(40);
    const over = toTelegramMessage({ id: CARD_ID, blocks: [{ type: "actions", elements: [{ type: "button", action_id: longAction, label: "Go" }] }] });
    const hashed = (over.reply_markup.inline_keyboard[0][0] as any).callback_data as string;
    expect(hashed.startsWith("salt#")).toBe(true);
    expect(Buffer.byteLength(hashed)).toBeLessThanOrEqual(64);
    expect(parseInteraction("telegram", hashed)).toBeNull();
    expect(parseInteraction("telegram", hashed, { hashed: (k) => over.hashedCallbacks[k] })).toEqual({ card_id: CARD_ID, action_id: longAction });
    const short = toTelegramMessage({ id: "42", blocks: [{ type: "actions", elements: [{ type: "button", action_id: "yes", label: "Yes" }] }] });
    const data = (short.reply_markup.inline_keyboard[0][0] as any).callback_data;
    expect(data).toBe("salt:42:yes");
    expect(parseInteraction("telegram", data)).toEqual({ card_id: "42", action_id: "yes" });
  });

  it("truncates text to 4096 after escaping, with an ellipsis", () => {
    const big = toTelegramMessage({ id: "1", blocks: [{ type: "section", text: "<".repeat(3000) }, { type: "section", text: "tail" }] });
    expect(big.text.length).toBeLessThanOrEqual(TELEGRAM_LIMITS.TEXT);
    expect(big.text).toContain("…");
    expect(big.truncated).toBe(true);
  });
});

describe("pay is never a callback, on any platform", () => {
  const card = { id: CARD_ID, chat_id: CHAT_ID, blocks: [{ type: "actions", elements: [{ type: "button", action_id: "pay", label: "Pay", action_type: "pay", pay: { amount: "1", currency: "ETH" } }] }] };
  const url = `https://saltapp.ai/chats/${CHAT_ID}`;
  it("slack/adaptive/discord/telegram all link out", () => {
    expect(JSON.stringify(toSlackBlocks(card).blocks)).toContain(url);
    expect(JSON.stringify(toSlackBlocks(card).blocks)).not.toContain("salt:");
    expect(JSON.stringify(toAdaptiveCard(card).card)).not.toContain("Action.Submit");
    expect(JSON.stringify(toDiscordMessage(card).components)).not.toContain("custom_id");
    expect(JSON.stringify(toTelegramMessage(card).reply_markup)).not.toContain("callback_data");
  });
  it("options supply the ids and base url", () => {
    const r = toTelegramMessage({ blocks: card.blocks }, { chatId: "9", messageId: "8", baseUrl: "https://x.test/" });
    expect((r.reply_markup.inline_keyboard[0][0] as any).url).toBe("https://x.test/chats/9?message=8");
  });
});

describe("fallback text and bad input", () => {
  it("every renderer returns plain text", () => {
    for (const r of [toSlackBlocks(fixture()), toAdaptiveCard(fixture()), toDiscordMessage(fixture()), toTelegramMessage(fixture())]) {
      expect(r.fallbackText).toContain("Total: 1.50 ETH");
      expect(r.fallbackText).toContain(`[Pay 1.50] ${OPEN}`);
    }
  });
  it("does not throw on garbage", () => {
    for (const c of [{}, { blocks: "x" }, { blocks: [null, 3, { type: "actions" }] }]) {
      expect(() => toSlackBlocks(c as any)).not.toThrow();
      expect(() => toTelegramMessage(c as any)).not.toThrow();
    }
    expect(parseInteraction("slack", null)).toBeNull();
    expect(parseInteraction("telegram", "nope")).toBeNull();
  });
  it("a link button with a non-Salt url opens Salt instead", () => {
    const r = toTelegramMessage({ id: "1", chat_id: "2", blocks: [{ type: "actions", elements: [{ type: "button", action_id: "x", label: "Go", action_type: "link", url: "https://evil.example/" }] }] });
    expect((r.reply_markup.inline_keyboard[0][0] as any).url).toBe("https://saltapp.ai/chats/2");
  });
});
