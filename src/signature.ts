// Verifies the HMAC salt-api signs every webhook callback with.
//
// salt-agent-sdk (crypto.ts, client.ts) is what this whole package leans on
// for PGP and the REST client, but its own webhook verification lives
// INSIDE createWebhookServer (src/webhook.ts's `rejectionReason`) and is
// never exported as a standalone function -- that server is a complete,
// opinionated Express app (delegation, hand-offs, sessions, mediator
// gating) built for a native Salt agent process, not something you mount
// inside a different framework's `handleWebhook(request: Request)`
// contract, which is what the chat-sdk Adapter interface requires.
//
// So this function exists to do exactly the one thing createWebhookServer's
// internal check does, and it is written to match it byte for byte:
//   - header `X-Salt-Signature: t=<unix-seconds>,v1=<hex hmac-sha256>`
//   - signed bytes are `${t}.${rawBody}` (the exact bytes salt-api sent,
//     not a re-serialization of the parsed JSON)
//   - HMAC-SHA256 keyed with this agent's own webhook secret
//     (salt-agent-sdk's `client.getWebhookSecret(apiKey)` -- one secret per
//     agent, fetched with that agent's own api-key, never a shared value)
//   - constant-time comparison, and a bounded replay window on `t`
// If salt-agent-sdk ever exports this verification standalone, this file
// should be deleted in favor of it (see HANDOFF.md).

import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifySaltSignatureOptions {
  /** The exact raw request body bytes salt-api signed (not JSON.stringify(parsed)). */
  rawBody: string;
  /** The `X-Salt-Signature` header value, e.g. "t=1700000000,v1=abcd...". */
  signatureHeader: string | null | undefined;
  /** This agent's webhook secret (salt-agent-sdk client.getWebhookSecret). */
  secret: string;
  /** Reject a signature older (or newer) than this many seconds. Default 300. */
  toleranceSeconds?: number;
  /** Clock override for tests. */
  now?: () => number;
}

/** Returns null when the signature is valid, or a short reason it was rejected. */
export function verifySaltSignature(options: VerifySaltSignatureOptions): string | null {
  const { rawBody, signatureHeader, secret } = options;
  const toleranceSeconds = options.toleranceSeconds ?? 300;
  const now = options.now ?? Date.now;

  if (!signatureHeader) return "missing signature";

  const t = /t=(\d+)/.exec(signatureHeader)?.[1];
  const v1 = /v1=([0-9a-f]+)/.exec(signatureHeader)?.[1];
  if (!t || !v1) return "malformed signature";

  const age = Math.abs(Math.floor(now() / 1000) - Number(t));
  if (age > toleranceSeconds) return `stale signature (${age}s old)`;

  if (!secret) return "no signing key for this agent";

  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");

  const a = Buffer.from(v1, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "bad signature";

  return null;
}
