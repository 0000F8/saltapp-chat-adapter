import { describe, expect, it } from "vitest";
import { SaltAdapter } from "../src/adapter";
import { getInstalledSaltAgentSdkVersion, isAtLeast, MIN_SOCKET_SDK_VERSION } from "../src/socket";

const BASE_CONFIG = {
  host: "https://fake.saltapp.test",
  apiKey: "key",
  agentId: "agent-1",
  privateKey: "priv",
  publicKey: "pub",
  pgpPassphrase: "pass",
};

describe("SaltAdapter construction", () => {
  it("throws when a required field is missing", () => {
    const { host, ...rest } = BASE_CONFIG;
    expect(() => new SaltAdapter(rest as unknown as typeof BASE_CONFIG)).toThrow(/host is required/);
  });

  it("throws on an unrecognized delivery mode", () => {
    expect(() => new SaltAdapter({ ...BASE_CONFIG, mode: "carrier-pigeon" as never })).toThrow(/Invalid mode/);
  });

  it("throws a clear, actionable error for mode: \"socket\" against today's salt-agent-sdk", () => {
    expect(() => new SaltAdapter({ ...BASE_CONFIG, mode: "socket" })).toThrow(
      new RegExp(`needs salt-agent-sdk >= ${MIN_SOCKET_SDK_VERSION.replace(/\./g, "\\.")}`)
    );
  });

  it("accepts the default webhook mode with no extra config", () => {
    expect(() => new SaltAdapter(BASE_CONFIG)).not.toThrow();
  });
});

describe("socket.ts version comparison", () => {
  it("compares major.minor.patch correctly", () => {
    expect(isAtLeast("0.8.0", "0.8.0")).toBe(true);
    expect(isAtLeast("0.8.1", "0.8.0")).toBe(true);
    expect(isAtLeast("0.9.0", "0.8.0")).toBe(true);
    expect(isAtLeast("1.0.0", "0.8.0")).toBe(true);
    expect(isAtLeast("0.7.9", "0.8.0")).toBe(false);
    expect(isAtLeast("0.7.1", "0.8.0")).toBe(false);
  });

  it("reads the real installed salt-agent-sdk's own declared version", () => {
    // Whatever is actually installed today -- this just proves the reader works,
    // not any particular version.
    expect(getInstalledSaltAgentSdkVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
