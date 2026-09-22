// Socket mode (`mode: "socket"` in SaltAdapterConfig) is for a bot with no
// public URL: instead of salt-api POSTing to a webhook, the agent pulls its
// deliveries from an outbox. The wire contract -- an `outbox` table, a
// `GET /api/v1/agent/updates?after=&timeout=&limit=` short-poll, and an
// Action Cable `AgentUpdatesChannel` -- is specified in
// design-fleet/runs/2026-09-17-distribution/LANES.md's "Socket mode
// contract (K2)".
//
// salt-agent-sdk 0.8 ships its OWN socket client, `createSocketClient` --
// but it's built around a full `IdentityStore` and a decrypt/session/
// hand-off dispatcher (`createDispatcher`'s `MessageContext`, with its own
// `reply()`/`ask()`/`approve()`) meant for a native Salt agent process, not
// a bridge into a different framework's own Adapter interface. This
// adapter already has its own translation layer (adapter.ts's
// `handleWebhook`/`dispatchMessage`/`dispatchCardInteraction`, feeding
// chat-sdk's `ChatInstance.processMessage`/`processAction`) built around
// RAW, still-encrypted webhook bodies -- decrypting lazily, per chat-sdk's
// own "lazy async parsing" contract. Reusing the SDK's dispatcher would
// mean decrypting twice under two different session models, so this file
// instead builds a poller directly against `GET /api/v1/agent/updates`
// (salt-rest.ts's `fetchAgentUpdates`) and reuses exactly the pieces of
// salt-agent-sdk 0.8 that ARE transport-only and genuinely fit:
//   - `CursorStore`/`FileCursorStore`/`MemoryCursorStore` for cursor
//     persistence (same file-per-agent-id shape createSocketClient itself
//     uses internally).
//   - `DedupeStore`/`FileDedupeStore`/`MemoryDedupeStore` for delivery-id
//     dedupe across restarts.
//   - `ACTIVE_POLL_DELAY_MS`/`IDLE_POLL_DELAY_MS` for the same adaptive
//     pacing createSocketClient's own loop uses, so a fleet mixing this
//     adapter with native salt-agent-sdk hosts polls at one shared cadence.
// Signature verification stays this adapter's own `verifySaltSignature`
// (signature.ts) -- salt-agent-sdk still has no standalone verifier
// export, only `createDispatcher`'s Express-shaped one.

import {
  ACTIVE_POLL_DELAY_MS,
  IDLE_POLL_DELAY_MS,
  FileCursorStore,
  FileDedupeStore,
  MemoryCursorStore,
  MemoryDedupeStore,
  type CursorStore,
  type DedupeStore,
} from "salt-agent-sdk";
import type { Logger } from "chat";

import type { SaltExtraRestClient } from "./salt-rest";

export const MIN_SOCKET_SDK_VERSION = "0.8.0";

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

export function socketModeUnavailableError(installedVersion: string): Error {
  return new Error(
    `mode: "socket" needs salt-agent-sdk >= ${MIN_SOCKET_SDK_VERSION} (installed: ${installedVersion}). ` +
      "This adapter's socket-mode poller (socket.ts) reuses salt-agent-sdk's CursorStore/DedupeStore " +
      "primitives and adaptive-poll constants, all added in 0.8.0. Upgrade salt-agent-sdk, or use the " +
      'default mode: "webhook" (set a public callback via `PATCH /api/v1/agents/callback`).'
  );
}

/**
 * Throws socketModeUnavailableError unless the installed salt-agent-sdk
 * declares itself >= MIN_SOCKET_SDK_VERSION. package.json already pins a
 * hard `^0.8.0` dependency, so this is a defensive re-check (a stale
 * hoisted copy in a monorepo, a manual override, ...) rather than the
 * primary guarantee.
 */
export function assertSocketModeSupported(): void {
  let installedVersion = "unknown";
  try {
    installedVersion = getInstalledSaltAgentSdkVersion();
  } catch {
    // leave "unknown" -- the error message below still tells the caller what to do
  }
  if (!isAtLeast(installedVersion, MIN_SOCKET_SDK_VERSION)) {
    throw socketModeUnavailableError(installedVersion);
  }
}

// --- The poller --------------------------------------------------------

export interface SaltSocketPollerOptions {
  host: string;
  apiKey: string;
  agentId: string;
  extra: SaltExtraRestClient;
  logger: Logger;
  /** Verified, non-duplicate envelope handler -- same (headers, rawBody)
   *  shape adapter.ts's handleWebhook already parses a webhook POST from,
   *  so both delivery paths share one dispatch implementation. */
  onEnvelope(headers: Record<string, string | undefined>, rawBody: string): Promise<void>;
  /** Where the poll cursor persists across restarts. Defaults to
   *  salt-agent-sdk's FileCursorStore(~/.salt/agents/<agentId>) --
   *  pass MemoryCursorStore() explicitly to opt out (tests; a consumer
   *  that wants no disk I/O). */
  cursorStore?: CursorStore;
  /** Persistent per-agent delivery_id dedupe, same reasoning as
   *  cursorStore. Defaults to salt-agent-sdk's FileDedupeStore. */
  dedupeStore?: DedupeStore;
  /** Seconds the server should hold the request open. Clamped server-side
   *  to 0..2 regardless of what's sent (LANES.md's H1 short-poll
   *  revision) -- defaults to 2. */
  timeoutSeconds?: number;
  limit?: number;
  /** Base retry delay after a failed poll, doubling up to maxBackoffMs. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface SaltSocketPoller {
  /** Starts the poll loop in the background. A no-op if already running. */
  start(): void;
  /** Stops the loop and resolves once it has actually exited. */
  stop(): Promise<void>;
}

function defaultStateDir(agentId: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const os = require("node:os") as typeof import("node:os");
  const safe = agentId.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  // Same convention salt-agent-sdk's own createSocketClient uses by
  // default (~/.salt/agents/<agentId>) -- a process hosting a Salt
  // identity through this adapter shares the one place any other
  // salt-agent-sdk-based host would look for this identity's state.
  return path.join(os.homedir(), ".salt", "agents", safe);
}

/**
 * Drains this identity's socket-mode outbox by polling
 * GET /api/v1/agent/updates (salt-rest.ts's fetchAgentUpdates), adaptively
 * (ACTIVE_POLL_DELAY_MS/IDLE_POLL_DELAY_MS), handing each verified,
 * non-duplicate row's (headers, rawBody) to `onEnvelope`. Verification and
 * dispatch themselves are NOT this poller's job -- see adapter.ts, which
 * wires `onEnvelope` to the exact same code path handleWebhook uses.
 */
export function createSaltSocketPoller(options: SaltSocketPollerOptions): SaltSocketPoller {
  const { host, apiKey, agentId, extra, logger, onEnvelope } = options;
  const timeoutSeconds = options.timeoutSeconds ?? 2;
  const limit = options.limit ?? 100;
  const minBackoffMs = options.minBackoffMs ?? 1000;
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;

  let cursorStore: CursorStore;
  let dedupeStore: DedupeStore;
  try {
    cursorStore = options.cursorStore ?? FileCursorStore(defaultStateDir(agentId));
    dedupeStore = options.dedupeStore ?? FileDedupeStore(defaultStateDir(agentId));
  } catch (err) {
    logger.warn(`Salt socket poller: falling back to in-memory cursor/dedupe stores: ${(err as Error).message}`);
    cursorStore = options.cursorStore ?? MemoryCursorStore();
    dedupeStore = options.dedupeStore ?? MemoryDedupeStore();
  }

  let stopped = true;
  let loopPromise: Promise<void> | null = null;
  let abortController: AbortController | null = null;
  let wakeSleep: (() => void) | null = null;

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wakeSleep = null;
        resolve();
      }, ms);
      wakeSleep = () => {
        clearTimeout(timer);
        wakeSleep = null;
        resolve();
      };
    });
  }

  async function pollOnce(cursor: number): Promise<{ cursor: number; hadActivity: boolean }> {
    abortController = new AbortController();
    let res: Awaited<ReturnType<SaltExtraRestClient["fetchAgentUpdates"]>>;
    try {
      res = await extra.fetchAgentUpdates(apiKey, {
        after: cursor > 0 ? cursor : undefined,
        timeoutSeconds,
        limit,
        signal: abortController.signal,
      });
    } finally {
      abortController = null;
    }

    let advanced = cursor;
    for (const row of res.updates) {
      const dedupeKey = row.delivery_id;
      const alreadySeen = dedupeKey
        ? await dedupeStore.has(agentId, dedupeKey).catch((err) => {
            logger.error(`Salt socket poller: dedupe lookup for ${dedupeKey} failed: ${(err as Error).message}`);
            return false; // fail open -- a lookup failure must not block real delivery
          })
        : false;
      if (!alreadySeen) {
        try {
          await onEnvelope(row.headers, row.body);
        } catch (err) {
          logger.error(`Salt socket poller: handling update ${row.id} (${row.event}) failed: ${(err as Error).message}`);
        }
        if (dedupeKey) {
          await dedupeStore.add(agentId, dedupeKey).catch((err) => {
            logger.error(`Salt socket poller: recording dedupe for ${dedupeKey} failed: ${(err as Error).message}`);
          });
        }
      }
      advanced = row.id;
    }
    const finalCursor = typeof res.cursor === "number" ? res.cursor : advanced;
    return { cursor: finalCursor, hadActivity: res.updates.length > 0 };
  }

  async function loop(): Promise<void> {
    let cursor = 0;
    try {
      cursor = await cursorStore.get(agentId);
    } catch (err) {
      logger.error(`Salt socket poller: loading cursor failed, starting from 0: ${(err as Error).message}`);
    }
    let backoff = minBackoffMs;
    let idleDelayMs: number = ACTIVE_POLL_DELAY_MS;
    logger.info(`Salt socket poller: polling ${host}/api/v1/agent/updates from cursor ${cursor}`);

    while (!stopped) {
      try {
        const result = await pollOnce(cursor);
        if (result.cursor !== cursor) {
          cursor = result.cursor;
          try {
            await cursorStore.put(agentId, cursor);
          } catch (err) {
            logger.error(`Salt socket poller: persisting cursor ${cursor} failed: ${(err as Error).message}`);
          }
        }
        backoff = minBackoffMs; // a clean round trip always resets the failure backoff
        idleDelayMs = result.hadActivity ? ACTIVE_POLL_DELAY_MS : Math.min(idleDelayMs + ACTIVE_POLL_DELAY_MS, IDLE_POLL_DELAY_MS);
        if (stopped) break;
        await sleep(idleDelayMs);
      } catch (err) {
        if (stopped) break; // an abort from stop() surfaces here as a fetch error -- not a real failure
        logger.error(`Salt socket poller: poll failed: ${(err as Error).message}; retrying in ${backoff}ms`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, maxBackoffMs);
        idleDelayMs = ACTIVE_POLL_DELAY_MS;
      }
    }
  }

  return {
    start() {
      if (loopPromise) return; // already running
      stopped = false;
      loopPromise = loop().catch((err) => logger.error(`Salt socket poller: loop exited unexpectedly: ${(err as Error).message}`));
    },
    async stop() {
      stopped = true;
      abortController?.abort();
      wakeSleep?.();
      if (loopPromise) await loopPromise;
      loopPromise = null;
    },
  };
}
