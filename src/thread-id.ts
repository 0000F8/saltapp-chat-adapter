// Thread id encode/decode. Salt has no channel/thread nesting -- a chat IS
// the thread -- so the id is just `salt:<chatId>`, or `salt:<chatId>:lane:
// <laneId>` for a private sidechain/advisor/consult lane living under a
// room (CLAUDE.md's "sidechains" section). Every adapter in the chat-sdk
// ecosystem uses this "platform:segment:segment" convention (see e.g.
// TelegramAdapter.encodeThreadId) so tooling that inspects a raw thread id
// string can guess the platform without importing the adapter.

import { ValidationError } from "@chat-adapter/shared";
import type { SaltThreadId } from "./types";

const PLATFORM = "salt";

export function encodeThreadId(data: SaltThreadId): string {
  if (!data.chatId) {
    throw new ValidationError(PLATFORM, "encodeThreadId needs a chatId");
  }
  return data.laneId
    ? `${PLATFORM}:${data.chatId}:lane:${data.laneId}`
    : `${PLATFORM}:${data.chatId}`;
}

export function decodeThreadId(threadId: string): SaltThreadId {
  const parts = threadId.split(":");
  if (parts[0] !== PLATFORM || parts.length < 2) {
    throw new ValidationError(PLATFORM, `Invalid Salt thread ID: ${threadId}`);
  }
  const chatId = parts[1];
  if (!chatId) {
    throw new ValidationError(PLATFORM, `Invalid Salt thread ID: ${threadId}`);
  }
  if (parts.length === 2) {
    return { chatId };
  }
  if (parts.length === 4 && parts[2] === "lane" && parts[3]) {
    return { chatId, laneId: parts[3] };
  }
  throw new ValidationError(PLATFORM, `Invalid Salt thread ID: ${threadId}`);
}

/** Every conversation is its own channel on Salt -- there's no separate channel concept. */
export function channelIdFromThreadId(threadId: string): string {
  return encodeThreadId({ chatId: decodeThreadId(threadId).chatId });
}
