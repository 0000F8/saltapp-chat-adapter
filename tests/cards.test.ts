import { Actions, Button, Card, CardText, Divider, Field, Fields, LinkButton, Section } from "chat";
import { describe, expect, it } from "vitest";
import { decodeSaltActionId } from "../src/action-id";
import { cardElementToSaltBlocks, SALT_CARD_LIMITS } from "../src/cards";

describe("cardElementToSaltBlocks", () => {
  it("renders title + subtitle as a leading section block", () => {
    const card = Card({ title: "Order #42", subtitle: "Awaiting payment", children: [CardText("Thanks for your order!")] });
    const { blocks } = cardElementToSaltBlocks(card);
    expect(blocks[0]).toEqual({ type: "section", text: "Order #42\nAwaiting payment" });
    expect(blocks[1]).toEqual({ type: "section", text: "Thanks for your order!" });
  });

  it("maps a header imageUrl to an image block", () => {
    const card = Card({ title: "Product", imageUrl: "https://example.com/product.png", children: [CardText("A great product.")] });
    const { blocks } = cardElementToSaltBlocks(card);
    expect(blocks.some((b) => b.type === "image" && (b as { url: string }).url === "https://example.com/product.png")).toBe(true);
  });

  it("maps a divider and a fields group", () => {
    const card = Card({
      children: [Divider(), Fields([Field({ label: "Amount", value: "$5.00" }), Field({ label: "Status", value: "Pending" })])],
    });
    const { blocks } = cardElementToSaltBlocks(card);
    expect(blocks.find((b) => b.type === "divider")).toEqual({ type: "divider" });
    const fieldsBlock = blocks.find((b) => b.type === "section" && (b as { fields?: unknown }).fields) as {
      fields: Array<{ label: string; value: string }>;
    };
    expect(fieldsBlock.fields).toEqual([
      { label: "Amount", value: "$5.00" },
      { label: "Status", value: "Pending" },
    ]);
  });

  it("maps plain buttons to Salt actions blocks with sanitized action ids", () => {
    const card = Card({
      children: [Section([Actions([Button({ id: "Approve!", label: "Approve" }), Button({ id: "reject", label: "Reject", style: "danger" })])])],
    });
    const { blocks } = cardElementToSaltBlocks(card);
    const actionsBlock = blocks.find((b) => b.type === "actions") as {
      elements: Array<{ action_id: string; label: string; style?: string; action_type?: string }>;
    };
    expect(actionsBlock.elements).toHaveLength(2);
    expect(actionsBlock.elements[0]).toMatchObject({ action_id: "approve", label: "Approve", action_type: "default" });
    expect(actionsBlock.elements[1]).toMatchObject({ action_id: "reject", label: "Reject", style: "danger" });
  });

  it("encodes a button's value into its Salt action_id, decodable on tap", () => {
    const card = Card({ children: [Actions([Button({ id: "buy", label: "Buy", value: "sku-42" })])] });
    const { blocks } = cardElementToSaltBlocks(card);
    const actionsBlock = blocks.find((b) => b.type === "actions") as { elements: Array<{ action_id: string }> };
    const actionId = actionsBlock.elements[0]!.action_id;
    expect(decodeSaltActionId(actionId)).toEqual({ actionId: "buy", value: "sku-42" });
  });

  it("splits more than 5 buttons in one Actions element across multiple Salt actions blocks", () => {
    const buttons = Array.from({ length: 7 }, (_, i) => Button({ id: `opt${i}`, label: `Option ${i}` }));
    const card = Card({ children: [Actions(buttons)] });
    const { blocks } = cardElementToSaltBlocks(card);
    const actionsBlocks = blocks.filter((b) => b.type === "actions") as Array<{ elements: unknown[] }>;
    expect(actionsBlocks).toHaveLength(2);
    expect(actionsBlocks[0]!.elements).toHaveLength(SALT_CARD_LIMITS.MAX_BUTTONS_PER_ACTIONS);
    expect(actionsBlocks[1]!.elements).toHaveLength(2);
  });

  it("degrades a link button to a visible text fallback (Salt has no link-button block)", () => {
    const card = Card({ children: [Actions([LinkButton({ url: "https://example.com", label: "Learn more" })])] });
    const { blocks } = cardElementToSaltBlocks(card);
    const fallback = blocks.find((b) => b.type === "section" && (b as { text?: string }).text?.includes("Learn more"));
    expect(fallback).toBeTruthy();
    expect((fallback as { text: string }).text).toContain("https://example.com");
  });

  it("produces a plain-text fallback for the message bubble", () => {
    const card = Card({ title: "Welcome", children: [CardText("Hello there!")] });
    const { fallbackText } = cardElementToSaltBlocks(card);
    expect(fallbackText).toContain("Welcome");
    expect(fallbackText).toContain("Hello there!");
  });

  it("throws when the resulting card would exceed Salt's block-count limit", () => {
    const children = Array.from({ length: SALT_CARD_LIMITS.MAX_BLOCKS + 5 }, (_, i) => CardText(`line ${i}`));
    const card = Card({ children });
    expect(() => cardElementToSaltBlocks(card)).toThrow(/at most 20/);
  });

  it("never produces an empty blocks array (Salt's Card model requires at least one)", () => {
    const card = Card({ title: "Just a title" });
    const { blocks } = cardElementToSaltBlocks(card);
    expect(blocks.length).toBeGreaterThan(0);
  });
});
