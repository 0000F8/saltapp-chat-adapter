import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySaltSignature } from "../src/signature";

const SECRET = "webhook-secret-abc123";

function sign(rawBody: string, secret: string, t: number): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

describe("verifySaltSignature", () => {
  it("accepts a correctly signed body", () => {
    const rawBody = JSON.stringify({ hello: "world" });
    const now = 1_700_000_000_000;
    const signatureHeader = sign(rawBody, SECRET, Math.floor(now / 1000));
    const reason = verifySaltSignature({ rawBody, signatureHeader, secret: SECRET, now: () => now });
    expect(reason).toBeNull();
  });

  it("rejects a tampered body (signature covers the exact bytes, not the parsed object)", () => {
    const now = 1_700_000_000_000;
    const signatureHeader = sign(JSON.stringify({ hello: "world" }), SECRET, Math.floor(now / 1000));
    const tamperedBody = JSON.stringify({ hello: "world!!" });
    const reason = verifySaltSignature({ rawBody: tamperedBody, signatureHeader, secret: SECRET, now: () => now });
    expect(reason).toBe("bad signature");
  });

  it("rejects a signature made with the wrong secret", () => {
    const rawBody = JSON.stringify({ hello: "world" });
    const now = 1_700_000_000_000;
    const signatureHeader = sign(rawBody, "someone-elses-secret", Math.floor(now / 1000));
    const reason = verifySaltSignature({ rawBody, signatureHeader, secret: SECRET, now: () => now });
    expect(reason).toBe("bad signature");
  });

  it("rejects a missing signature header", () => {
    const reason = verifySaltSignature({ rawBody: "{}", signatureHeader: undefined, secret: SECRET });
    expect(reason).toBe("missing signature");
  });

  it("rejects a malformed signature header", () => {
    const reason = verifySaltSignature({ rawBody: "{}", signatureHeader: "not-a-real-signature", secret: SECRET });
    expect(reason).toBe("malformed signature");
  });

  it("rejects a stale signature outside the replay window", () => {
    const rawBody = JSON.stringify({ hello: "world" });
    const signedAt = 1_700_000_000; // seconds
    const signatureHeader = sign(rawBody, SECRET, signedAt);
    const tenMinutesLater = (signedAt + 601) * 1000;
    const reason = verifySaltSignature({
      rawBody,
      signatureHeader,
      secret: SECRET,
      toleranceSeconds: 300,
      now: () => tenMinutesLater,
    });
    expect(reason).toMatch(/stale signature/);
  });

  it("rejects when this agent has no signing secret on file", () => {
    const rawBody = JSON.stringify({ hello: "world" });
    const now = 1_700_000_000_000;
    const signatureHeader = sign(rawBody, SECRET, Math.floor(now / 1000));
    const reason = verifySaltSignature({ rawBody, signatureHeader, secret: "", now: () => now });
    expect(reason).toBe("no signing key for this agent");
  });
});
