import { Actions, Button, Card, CardText } from "chat";
import type { ChatInstance } from "chat";
import { decrypt, generateKeypair } from "salt-agent-sdk";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { SaltAdapter } from "../src/adapter";
import { decodeSaltActionId } from "../src/action-id";
import { encodeThreadId } from "../src/thread-id";
import { FakeSaltApi } from "./helpers";

describe("SaltAdapter posting", () => {
  let api: FakeSaltApi;
  let adapter: SaltAdapter;
  let agentKeys: Awaited<ReturnType<typeof generateKeypair>>;
  let human1Keys: Awaited<ReturnType<typeof generateKeypair>>;
  let human2Keys: Awaited<ReturnType<typeof generateKeypair>>;
  const threadId = encodeThreadId({ chatId: "chat-1" });

  beforeAll(async () => {
    agentKeys = await generateKeypair("agent-pass");
    human1Keys = await generateKeypair("human1-pass");
    human2Keys = await generateKeypair("human2-pass");
  });

  function buildAdapter(): SaltAdapter {
    api = new FakeSaltApi();
    api.webhookSecret = "secret";
    api.setChat({
      id: "chat-1",
      session: {
        users: [
          { id: api.agentId, username: "bot", display_name: "Bot", account_type: "Agent", public_key: agentKeys.publicKey },
          { id: "human-1", username: "ada", display_name: "Ada", account_type: "User", public_key: human1Keys.publicKey },
          { id: "human-2", username: "bea", display_name: "Bea", account_type: "User", public_key: human2Keys.publicKey },
        ],
      },
      messages: [],
    });
    const built = new SaltAdapter({
      host: api.host,
      apiKey: "test-api-key",
      agentId: api.agentId,
      privateKey: agentKeys.privateKey,
      publicKey: agentKeys.publicKey,
      pgpPassphrase: "agent-pass",
      fetchImpl: api.fetchImpl,
    });
    return built;
  }

  it("encrypts a posted text message so every chat member's own key can decrypt it", async () => {
    adapter = buildAdapter();
    await adapter.initialize({ getUserName: () => "bot" } as unknown as ChatInstance);

    const result = await adapter.postMessage(threadId, "Hello everyone");
    expect(result.threadId).toBe(threadId);
    expect(api.postedMessages).toHaveLength(1);
    const posted = api.postedMessages[0]!;

    const recipients = [
      { keys: agentKeys, passphrase: "agent-pass" },
      { keys: human1Keys, passphrase: "human1-pass" },
      { keys: human2Keys, passphrase: "human2-pass" },
    ];
    for (const { keys, passphrase } of recipients) {
      const plaintext = await decrypt(posted.message, keys.privateKey, passphrase);
      expect(plaintext).toBe("Hello everyone");
    }
  });

  it("also encrypts the sender's own readable copy (sender_message)", async () => {
    adapter = buildAdapter();
    await adapter.initialize({ getUserName: () => "bot" } as unknown as ChatInstance);
    await adapter.postMessage(threadId, "For my own record");
    const posted = api.postedMessages[0]!;
    expect(posted.sender_message).toBeTruthy();
    const plaintext = await decrypt(posted.sender_message!, agentKeys.privateKey, "agent-pass");
    expect(plaintext).toBe("For my own record");
  });

  describe("send guard", () => {
    const stale = (members: unknown[]) => Object.assign(new Error("stale"), { status: 409, code: "stale_recipient_keys", body: { code: "stale_recipient_keys", members } });

    async function guarded(fingerprints: boolean) {
      adapter = buildAdapter();
      await adapter.initialize({ getUserName: () => "bot" } as unknown as ChatInstance);
      const users = api.chats.get("chat-1")!.session.users;
      if (fingerprints) for (const u of users) (u as { public_fingerprint?: string }).public_fingerprint = `fp-${u.id}`;
      // The installed SDK predates the guard fields and drops them on the wire, so assert on the call itself.
      const post = vi.spyOn((adapter as unknown as { client: { postMessage: (...a: unknown[]) => Promise<unknown> } }).client, "postMessage");
      return post;
    }

    it("sends every other member's fingerprint and the sender's own", async () => {
      const post = await guarded(true);
      await adapter.postMessage(threadId, "hi");
      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0]![6]).toEqual({
        recipientFingerprints: { "human-1": "fp-human-1", "human-2": "fp-human-2" },
        senderFingerprint: `fp-${api.agentId}`,
      });
    });

    it("re-encrypts once to the keys a stale_recipient_keys refusal returns, then resends", async () => {
      const post = await guarded(true);
      const rotated = await generateKeypair("rotated-pass");
      post.mockRejectedValueOnce(stale([{ id: "human-1", public_key: rotated.publicKey, public_fingerprint: "fp-new", key_generation: 2 }]));
      await adapter.postMessage(threadId, "hi");
      expect(post).toHaveBeenCalledTimes(2);
      const [, , message] = post.mock.calls[1]!;
      expect(await decrypt(message as string, rotated.privateKey, "rotated-pass")).toBe("hi");
      expect((post.mock.calls[1]![6] as { recipientFingerprints: Record<string, string> }).recipientFingerprints["human-1"]).toBe("fp-new");
    });

    it("throws a second refusal instead of looping", async () => {
      const post = await guarded(true);
      post.mockRejectedValue(stale([]));
      await expect(adapter.postMessage(threadId, "hi")).rejects.toThrow("stale");
      expect(post).toHaveBeenCalledTimes(2);
    });

    it("sends no guard fields when a keyed member lacks a fingerprint", async () => {
      const post = await guarded(false);
      await adapter.postMessage(threadId, "hi");
      expect(post.mock.calls[0]![6]).toEqual({});
    });
  });

  it("posts a CardElement through the cards endpoint instead of the plain message endpoint", async () => {
    adapter = buildAdapter();
    await adapter.initialize({ getUserName: () => "bot" } as unknown as ChatInstance);

    const card = Card({ title: "Pick one", children: [CardText("Choose an option:"), Actions([Button({ id: "yes", label: "Yes" }), Button({ id: "no", label: "No" })])] });
    const result = await adapter.postMessage(threadId, card);

    expect(api.postedMessages).toHaveLength(0);
    expect(api.postedCards).toHaveLength(1);
    const postedCard = api.postedCards[0]!;
    expect(postedCard.chat_id).toBe("chat-1");
    const actionsBlock = (postedCard.blocks as Array<{ type: string; elements?: Array<{ action_id: string }> }>).find((b) => b.type === "actions");
    expect(actionsBlock?.elements).toHaveLength(2);
    expect(decodeSaltActionId(actionsBlock!.elements![0]!.action_id)).toEqual({ actionId: "yes" });
    expect(result.id).toMatch(/^posted-card-msg-/);
  });

  it("throws when asked to edit a message (Salt has no edit endpoint)", async () => {
    adapter = buildAdapter();
    await adapter.initialize({ getUserName: () => "bot" } as unknown as ChatInstance);
    await expect(adapter.editMessage(threadId, "some-message-id", "new text")).rejects.toThrow(/no message-edit endpoint/);
  });

  it("deletes a message for everyone via DELETE /api/v1/messages/:id", async () => {
    adapter = buildAdapter();
    await adapter.initialize({ getUserName: () => "bot" } as unknown as ChatInstance);
    await adapter.deleteMessage(threadId, "message-to-delete");
    expect(api.deletedMessageIds).toEqual(["message-to-delete"]);
  });

  it("signals typing via POST /api/v1/chats/:id/typing", async () => {
    adapter = buildAdapter();
    await adapter.initialize({ getUserName: () => "bot" } as unknown as ChatInstance);
    await adapter.startTyping(threadId);
    expect(api.typingPings).toEqual(["chat-1"]);
  });

  it("addReaction/removeReaction stay idempotent even though Salt's own endpoint toggles", async () => {
    adapter = buildAdapter();
    await adapter.initialize({ getUserName: () => "bot" } as unknown as ChatInstance);
    const message = api.addMessage("chat-1", {
      message_id: "reactable-1",
      message: "irrelevant",
      user: { id: "human-1", username: "ada", display_name: "Ada", account_type: "User" },
    });

    await adapter.addReaction(threadId, message.message_id, "thumbs_up");
    expect(message.reactions).toEqual([{ emoji: "thumbs_up", count: 1, user_ids: [api.agentId] }]);

    // Calling addReaction again must NOT toggle it back off.
    await adapter.addReaction(threadId, message.message_id, "thumbs_up");
    expect(message.reactions).toEqual([{ emoji: "thumbs_up", count: 1, user_ids: [api.agentId] }]);

    await adapter.removeReaction(threadId, message.message_id, "thumbs_up");
    expect(message.reactions).toEqual([]);

    // Calling removeReaction again when nothing is reacted must be a no-op.
    await adapter.removeReaction(threadId, message.message_id, "thumbs_up");
    expect(message.reactions).toEqual([]);
  });
});
