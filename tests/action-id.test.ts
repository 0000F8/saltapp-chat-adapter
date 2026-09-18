import { describe, expect, it } from "vitest";
import {
  SALT_ACTION_ID_MAX_LENGTH,
  decodeSaltActionId,
  encodeSaltActionId,
  sanitizeSaltActionId,
} from "../src/action-id";

describe("action-id", () => {
  it("passes a plain, already-legal action id through unchanged", () => {
    const encoded = encodeSaltActionId("approve");
    expect(encoded).toBe("approve");
    expect(decodeSaltActionId(encoded)).toEqual({ actionId: "approve" });
  });

  it("sanitizes an id with characters Salt's action_id doesn't allow", () => {
    expect(sanitizeSaltActionId("Approve Order!")).toBe("approve-order");
    expect(sanitizeSaltActionId("UPPER_CASE-id")).toBe("upper_case-id");
  });

  it("round-trips an id + value pair through the encoded form", () => {
    const encoded = encodeSaltActionId("buy", "sku-42");
    expect(encoded).toMatch(/^h[0-9a-f]+$/);
    expect(encoded.length).toBeLessThanOrEqual(SALT_ACTION_ID_MAX_LENGTH);
    expect(decodeSaltActionId(encoded)).toEqual({ actionId: "buy", value: "sku-42" });
  });

  it("throws when the encoded id + value would overflow Salt's action_id limit", () => {
    expect(() => encodeSaltActionId("this_is_a_fairly_long_action_id", "and-an-equally-long-value-string")).toThrow(
      /too large for Salt/
    );
  });

  it("treats a bare, non-encoded action id tapped back as itself with no value", () => {
    // A hand-authored Salt card (not built by this adapter) has ordinary
    // action ids with no "h<hex>" wrapper -- must still decode cleanly.
    expect(decodeSaltActionId("confirm")).toEqual({ actionId: "confirm" });
  });

  it("falls back to a plain passthrough for something that merely looks encoded", () => {
    // Starts with "h" and is all hex, but isn't valid JSON underneath --
    // must fail safe rather than throw.
    expect(decodeSaltActionId("hdeadbeef")).toEqual({ actionId: "hdeadbeef" });
  });
});
