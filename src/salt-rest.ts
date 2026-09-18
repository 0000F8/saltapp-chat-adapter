// The handful of salt-api endpoints salt-agent-sdk's REST client
// (createSaltClient in client.ts) doesn't cover yet: reactions and
// delete-for-everyone. Everything else this adapter needs -- posting,
// chat membership, typing, cards, the webhook secret -- goes through
// salt-agent-sdk's own client (see adapter.ts) rather than being
// reimplemented here.
//
// This exists only because those two endpoints have no method on
// SaltClient today. It is written to match createSaltClient's own
// internal `request` helper exactly (same auth header, same error type) so
// it disappears the moment salt-agent-sdk grows `addReaction`/
// `removeReaction`/`deleteMessage` -- see HANDOFF.md's "left for
// salt-agent-sdk" note.

import { SaltApiError, type SaltChat } from "salt-agent-sdk";

export interface SaltExtraRestOptions {
  host: string;
  fetchImpl?: typeof fetch;
}

export interface SaltReactionsSummary {
  emoji: string;
  count: number;
  user_ids: string[];
}

export interface SaltReactionResponse {
  message_id: string;
  reactions: SaltReactionsSummary[];
}

export type SaltExtraRestClient = ReturnType<typeof createSaltExtraRest>;

export function createSaltExtraRest(options: SaltExtraRestOptions) {
  const host = options.host.replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;

  async function request<T>(method: string, path: string, apiKey: string, body?: unknown): Promise<T> {
    const url = `${host}${path}`;
    const headers: Record<string, string> = { "api-key": apiKey };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await doFetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        parsed = await res.text().catch(() => undefined);
      }
      throw new SaltApiError(method, url, res.status, parsed);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return {
    /**
     * POST /api/v1/messages/:id/reactions -- TOGGLE semantics
     * (salt-api's ReactionsController#create): reacting with an emoji this
     * agent already used on this message removes it. addReaction/
     * removeReaction in adapter.ts call this only when it would actually
     * change state, so both stay idempotent from the chat-sdk caller's
     * point of view even though the wire endpoint itself only toggles.
     */
    async toggleReaction(apiKey: string, messageId: string, emoji: string): Promise<SaltReactionResponse> {
      return request("POST", `/api/v1/messages/${messageId}/reactions`, apiKey, { emoji });
    },

    /**
     * DELETE /api/v1/messages/:id -- delete for everyone. Sender-only,
     * within Message::DELETE_FOR_EVERYONE_WINDOW (24h), refused while
     * locked; salt-api leaves a tombstone rather than removing the row.
     */
    async deleteMessage(apiKey: string, messageId: string): Promise<void> {
      await request("DELETE", `/api/v1/messages/${messageId}`, apiKey);
    },

    /**
     * GET /api/v1/chats/:id -- the full chat payload (session.users,
     * messages[], name, ...). salt-agent-sdk's own client.getChatMembers /
     * getChatMessages hit this same endpoint and each throw away half of
     * it; fetchThread/fetchMessages and the reaction-state check above
     * want both halves at once.
     */
    async getChat(apiKey: string, chatId: string): Promise<SaltChat> {
      return request("GET", `/api/v1/chats/${chatId}?_=${Date.now()}`, apiKey);
    },
  };
}
