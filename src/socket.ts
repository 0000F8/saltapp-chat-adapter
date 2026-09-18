// Socket mode (`mode: "socket"` in SaltAdapterConfig) is for a bot with no
// public URL: instead of salt-api POSTing to a webhook, the agent pulls its
// deliveries from an outbox. The wire contract for this -- an `outbox`
// table, `GET /api/v1/agent/updates?after=&timeout=&limit=` long-poll, and
// an Action Cable `AgentUpdatesChannel` -- is specified in
// design-fleet/runs/2026-09-17-distribution/LANES.md's "Socket mode
// contract (K2)" and is being BUILT in a sibling lane, not this one. This
// file's only job is to fail loudly and usefully when that client isn't
// there yet, and to pick it up automatically the moment it is, without this
// adapter needing a version bump of its own.
//
// Deliberately not vendored or guessed at here: LANES.md fixes the HTTP/WS
// shape but not salt-agent-sdk's client-side export name, and getting that
// wrong would be worse than the clear error below -- a caller can't tell
// "wired up wrong" from "not implemented yet". Once salt-agent-sdk ships
// one, add its real name to CANDIDATE_EXPORT_NAMES (or replace the
// detection with a direct import) and this starts working with no other
// change.

export const MIN_SOCKET_SDK_VERSION = "0.8.0";

/** Plausible export names a future salt-agent-sdk socket client might use. */
const CANDIDATE_EXPORT_NAMES = [
  "createSocketClient",
  "createAgentSocketClient",
  "createAgentUpdatesClient",
  "SocketClient",
  "AgentUpdatesClient",
] as const;

function parseVersion(version: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when `installed` is >= `required` (major.minor.patch, no prerelease handling -- salt-agent-sdk doesn't publish prereleases). */
export function isAtLeast(installed: string, required: string): boolean {
  const [im, in_, ip] = parseVersion(installed);
  const [rm, rn, rp] = parseVersion(required);
  if (im !== rm) return im > rm;
  if (in_ !== rn) return in_ > rn;
  return ip >= rp;
}

/** The installed salt-agent-sdk's own declared version, read from its package.json. */
export function getInstalledSaltAgentSdkVersion(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require("salt-agent-sdk/package.json") as { version: string };
  return pkg.version;
}

/**
 * Looks for a socket-client factory on the installed salt-agent-sdk by
 * trying each name in CANDIDATE_EXPORT_NAMES. Returns undefined rather than
 * throwing when nothing is found (today, always) -- callers decide what
 * that means.
 */
export function detectSaltAgentSdkSocketClient(): unknown {
  let sdk: Record<string, unknown>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sdk = require("salt-agent-sdk") as Record<string, unknown>;
  } catch {
    return undefined;
  }
  for (const name of CANDIDATE_EXPORT_NAMES) {
    if (typeof sdk[name] === "function") return sdk[name];
  }
  return undefined;
}

export function socketModeUnavailableError(installedVersion: string): Error {
  return new Error(
    `mode: "socket" needs salt-agent-sdk >= ${MIN_SOCKET_SDK_VERSION} (installed: ${installedVersion}). ` +
      'Salt\'s socket-mode contract (an outbox table, a long-poll GET /api/v1/agent/updates, and an Action Cable ' +
      "AgentUpdatesChannel -- see design-fleet/runs/2026-09-17-distribution/LANES.md's \"Socket mode contract (K2)\") " +
      "is being built in a sibling lane and isn't in this installed salt-agent-sdk yet. " +
      'Use the default mode: "webhook" (set a public callback via `PATCH /api/v1/agents/callback`) until it ships, ' +
      "or upgrade salt-agent-sdk once it does."
  );
}

/**
 * Throws socketModeUnavailableError unless BOTH the installed
 * salt-agent-sdk declares itself >= MIN_SOCKET_SDK_VERSION AND actually
 * exports one of CANDIDATE_EXPORT_NAMES -- requiring both avoids a
 * false-positive activation against some unrelated future 0.8.x that
 * doesn't happen to ship this feature. Returns the detected factory
 * function on success.
 */
export function assertSocketModeSupported(): unknown {
  let installedVersion = "unknown";
  try {
    installedVersion = getInstalledSaltAgentSdkVersion();
  } catch {
    // leave "unknown" -- the error message below still tells the caller what to do
  }
  const factory = detectSaltAgentSdkSocketClient();
  if (!factory || !isAtLeast(installedVersion, MIN_SOCKET_SDK_VERSION)) {
    throw socketModeUnavailableError(installedVersion);
  }
  return factory;
}
