import { describe, expect, it } from "vitest";
import { channelIdFromThreadId, decodeThreadId, encodeThreadId } from "../src/thread-id";

describe("thread-id", () => {
  it("round-trips a plain chat id", () => {
    const encoded = encodeThreadId({ chatId: "chat-123" });
    expect(encoded).toBe("salt:chat-123");
    expect(decodeThreadId(encoded)).toEqual({ chatId: "chat-123" });
  });

  it("round-trips a chat id with a lane id", () => {
    const encoded = encodeThreadId({ chatId: "chat-123", laneId: "lane-456" });
    expect(encoded).toBe("salt:chat-123:lane:lane-456");
    expect(decodeThreadId(encoded)).toEqual({ chatId: "chat-123", laneId: "lane-456" });
  });

  it("channelIdFromThreadId strips the lane, since a chat is its own channel", () => {
    const encoded = encodeThreadId({ chatId: "chat-123", laneId: "lane-456" });
    expect(channelIdFromThreadId(encoded)).toBe("salt:chat-123");
  });

  it("rejects a threadId with no chatId", () => {
    expect(() => encodeThreadId({ chatId: "" })).toThrow();
  });

  it("rejects a threadId from a different platform", () => {
    expect(() => decodeThreadId("telegram:12345")).toThrow();
  });

  it("rejects a malformed lane threadId", () => {
    expect(() => decodeThreadId("salt:chat-123:lane:")).toThrow();
    expect(() => decodeThreadId("salt:chat-123:extra:segment:too:many")).toThrow();
  });
});
