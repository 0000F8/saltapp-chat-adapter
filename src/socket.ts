// Socket mode (`mode: "socket"` in SaltAdapterConfig) is for a bot with no
// public URL: instead of salt-api POSTing to a webhook, this adapter holds
// a live Action Cable websocket open to salt-api's `AgentUpdatesChannel`
// and salt-api PUSHES each envelope the instant it's written. Owner rule
// (2026-09-22): "DO NOT USE POLLING as a mechanic EVER" -- this file used
// to short-poll `GET /api/v1/agent/updates` adaptively; it now holds a
// persistent connection and makes zero requests while idle and caught up.
// The wire protocol (subscribe/replay/replay_done/ping/disconnect) is
// specified in salt-agent-sdk's own socket.ts header comment, which this
// mirrors.
//
// salt-agent-sdk 0.10.0 ships its OWN socket client, `createSocketClient`
// -- but it's built around a full `IdentityStore` and a decrypt/session/
// hand-off dispatcher (`createDispatcher`'s `MessageContext`, with its own
// `reply()`/`ask()`/`approve()`) meant for a native Salt agent process, not
// a bridge into a different framework's own Adapter interface. Reusing it
// would mean decrypting under a second, different session model than this
// adapter's own lazy per-thread decrypt (adapter.ts's `decryptAndNormalize`,
// chat-sdk's own contract), AND it would drop salt-api's `delivered_because`
// on the floor -- it isn't in the SDK's typed `MessageContext` as of this
// writing, and this adapter needs to read it straight off the raw envelope
// body to honor task item 3 (expose it on the normalized Message). So this
// file keeps its own translation layer, reusing exactly the pieces of
// salt-agent-sdk that ARE transport-only and genuinely fit:
//   - `CursorStore`/`FileCursorStore`/`MemoryCursorStore` for cursor
//     persistence (same file-per-agent-id shape createSocketClient itself
//     uses internally).
//   - `DedupeStore`/`FileDedupeStore`/`MemoryDedupeStore` for delivery-id
//     dedupe across restarts.
//   - `RECONNECT_MIN_DELAY_MS`/`RECONNECT_MAX_DELAY_MS`/`PING_TIMEOUT_MS`
//     for the same reconnect/liveness bounds createSocketClient's own loop
//     uses.
// Signature verification stays this adapter's own `verifySaltSignature`
// (signature.ts) -- salt-agent-sdk still has no standalone verifier
// export, only `createDispatcher`'s Express-shaped one.
//
// SIMPLIFICATION vs salt-agent-sdk's own createSocketClient: when
// `replay_done.more` is true (the backlog exceeded AgentUpdatesChannel's
// own replay cap), this client pages `GET /api/v1/agent/updates` to finish
// the backfill INLINE, as one link in the same ordered frame-handling
// chain, rather than buffering live frames separately and draining them
// after a detached backfill the way the SDK's own client does. That costs
// a little latency on the rare connection that needs backfill at all; it
// does not cost correctness (DedupeStore makes any overlap between a
// backfilled row and a live frame harmless either way), and this adapter's
// own socket-mode identity is not latency-sensitive enough to justify
// carrying that extra machinery a third time, independently maintained,
// in a repo that isn't the SDK itself.

import {
  RECONNECT_MAX_DELAY_MS,
  RECONNECT_MIN_DELAY_MS,
  PING_TIMEOUT_MS,
  FileCursorStore,
  FileDedupeStore,
  MemoryCursorStore,
  MemoryDedupeStore,
  type CursorStore,
  type DedupeStore,
} from "salt-agent-sdk";
import { WebSocket as WS, type RawData } from "ws";
import type { Logger } from "chat";

import type { SaltExtraRestClient, SaltAgentUpdateRow } from "./salt-rest";

export const MIN_SOCKET_SDK_VERSION = "0.10.0";

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
      "This adapter's socket-mode client (socket.ts) reuses salt-agent-sdk's CursorStore/DedupeStore " +
      "primitives and reconnect/ping-timeout constants. Upgrade salt-agent-sdk, or use the " +
      'default mode: "webhook" (set a public callback via `PATCH /api/v1/agents/callback`).'
  );
}

/**
 * Throws socketModeUnavailableError unless the installed salt-agent-sdk
 * declares itself >= MIN_SOCKET_SDK_VERSION. package.json already pins a
 * hard `^0.10.0` dependency, so this is a defensive re-check (a stale
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

// --- The socket client ---------------------------------------------------

export interface SaltSocketClientOptions {
  host: string;
  apiKey: string;
  agentId: string;
  extra: SaltExtraRestClient;
  logger: Logger;
  /** Verified, non-duplicate envelope handler -- same (headers, rawBody)
   *  shape adapter.ts's handleWebhook already parses a webhook POST from,
   *  so both delivery paths share one dispatch implementation. */
  onEnvelope(headers: Record<string, string | undefined>, rawBody: string): Promise<void>;
  /** Where the resume cursor persists across restarts/reconnects. Defaults
   *  to salt-agent-sdk's FileCursorStore(~/.salt/agents/<agentId>) -- pass
   *  MemoryCursorStore() explicitly to opt out (tests; a consumer that
   *  wants no disk I/O). */
  cursorStore?: CursorStore;
  /** Persistent per-agent delivery_id dedupe, same reasoning as
   *  cursorStore. Defaults to salt-agent-sdk's FileDedupeStore. */
  dedupeStore?: DedupeStore;
  /** Rows per backfill page (only used when replay_done.more is true). */
  backfillLimit?: number;
  pingTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Override the WebSocket implementation (tests). Defaults to `ws`'s own WebSocket. */
  webSocketImpl?: typeof WS;
}

export interface SaltSocketClient {
  /** Starts the connection loop in the background. A no-op if already running. */
  start(): void;
  /** Stops the connection and resolves once it has actually exited. */
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

interface ReplayDoneFrame {
  type: "replay_done";
  cursor?: number;
  more?: boolean;
}

function jitter(ms: number): number {
  return Math.round(ms / 2 + Math.random() * (ms / 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drains this identity's socket-mode outbox by holding an Action Cable
 * connection open and pushing every arriving envelope's (headers, rawBody)
 * through `onEnvelope` -- the exact shape `processEnvelope` already
 * consumes from a webhook POST. Verification and dispatch themselves are
 * NOT this client's job -- see adapter.ts.
 */
export function createSaltSocketClient(options: SaltSocketClientOptions): SaltSocketClient {
  const { host, apiKey, agentId, extra, logger, onEnvelope } = options;
  const wsHost = host.replace(/\/$/, "").replace(/^http/, "ws");
  const WSImpl = options.webSocketImpl ?? WS;
  const backfillLimit = options.backfillLimit ?? 100;
  const pingTimeoutMs = options.pingTimeoutMs ?? PING_TIMEOUT_MS;
  const minBackoffMs = options.minBackoffMs ?? RECONNECT_MIN_DELAY_MS;
  const maxBackoffMs = options.maxBackoffMs ?? RECONNECT_MAX_DELAY_MS;

  let cursorStore: CursorStore;
  let dedupeStore: DedupeStore;
  try {
    cursorStore = options.cursorStore ?? FileCursorStore(defaultStateDir(agentId));
    dedupeStore = options.dedupeStore ?? FileDedupeStore(defaultStateDir(agentId));
  } catch (err) {
    logger.warn(`Salt socket client: falling back to in-memory cursor/dedupe stores: ${(err as Error).message}`);
    cursorStore = options.cursorStore ?? MemoryCursorStore();
    dedupeStore = options.dedupeStore ?? MemoryDedupeStore();
  }

  let stopped = true;
  let loopPromise: Promise<void> | null = null;
  let currentSocket: WS | null = null;

  async function persistCursor(cursor: number): Promise<void> {
    try {
      await cursorStore.put(agentId, cursor);
    } catch (err) {
      logger.error(`Salt socket client: persisting cursor ${cursor} failed: ${(err as Error).message}`);
    }
  }

  async function dispatchRow(row: SaltAgentUpdateRow): Promise<void> {
    const dedupeKey = row.delivery_id;
    const alreadySeen = dedupeKey
      ? await dedupeStore.has(agentId, dedupeKey).catch((err) => {
          logger.error(`Salt socket client: dedupe lookup for ${dedupeKey} failed: ${(err as Error).message}`);
          return false; // fail open -- a lookup failure must not block real delivery
        })
      : false;
    if (alreadySeen) return;
    try {
      await onEnvelope(row.headers, row.body);
    } catch (err) {
      logger.error(`Salt socket client: handling update ${row.id} (${row.event}) failed: ${(err as Error).message}`);
    }
    if (dedupeKey) {
      await dedupeStore.add(agentId, dedupeKey).catch((err) => {
        logger.error(`Salt socket client: recording dedupe for ${dedupeKey} failed: ${(err as Error).message}`);
      });
    }
  }

  /** Pages GET /api/v1/agent/updates from `cursor` until a page comes back
   *  empty -- only reached when replay_done.more says the backlog exceeded
   *  the channel's own replay cap. */
  async function backfillFrom(cursor: number): Promise<void> {
    let after = cursor;
    for (;;) {
      if (stopped) return;
      let res: Awaited<ReturnType<SaltExtraRestClient["fetchAgentUpdates"]>>;
      try {
        res = await extra.fetchAgentUpdates(apiKey, { after, timeoutSeconds: 0, limit: backfillLimit });
      } catch (err) {
        logger.error(`Salt socket client: backfill request failed: ${(err as Error).message}`);
        return; // the next reconnect's replay will pick this back up
      }
      for (const row of res.updates) await dispatchRow(row);
      after = typeof res.cursor === "number" ? res.cursor : after;
      await persistCursor(after);
      if (res.updates.length === 0) return; // caught up
    }
  }

  function runConnection(): Promise<{ subscribed: boolean }> {
    return new Promise((resolveConn) => {
      (async () => {
        let localCursor = 0;
        try {
          localCursor = await cursorStore.get(agentId);
        } catch (err) {
          logger.error(`Salt socket client: loading cursor failed, starting from 0: ${(err as Error).message}`);
        }

        let settled = false;
        let subscribed = false;
        let pingTimer: ReturnType<typeof setTimeout> | null = null;
        // Every frame is handled strictly in arrival order: each 'message'
        // event only appends to this chain, never awaits work directly, so
        // a slow handler (e.g. inline backfill) can't let a later frame
        // jump ahead of an earlier one.
        let queue: Promise<void> = Promise.resolve();

        function clearPingTimer(): void {
          if (pingTimer) {
            clearTimeout(pingTimer);
            pingTimer = null;
          }
        }
        function armPingWatchdog(): void {
          clearPingTimer();
          pingTimer = setTimeout(() => {
            logger.error(`Salt socket client: no ping for ${pingTimeoutMs}ms; treating the connection as dead`);
            try {
              socket.terminate();
            } catch {
              // already gone
            }
          }, pingTimeoutMs);
        }

        function finish(): void {
          if (settled) return;
          settled = true;
          clearPingTimer();
          currentSocket = null;
          queue.finally(() => resolveConn({ subscribed }));
        }

        const socket = new WSImpl(`${wsHost}/cable`, { headers: { "api-key": apiKey } });
        currentSocket = socket;

        async function handleReplayDone(frame: ReplayDoneFrame): Promise<void> {
          const serverCursor = typeof frame.cursor === "number" ? frame.cursor : localCursor;
          await persistCursor(serverCursor);
          if (frame.more) await backfillFrom(serverCursor);
        }

        async function handleFrame(raw: RawData): Promise<void> {
          let frame: Record<string, unknown>;
          try {
            frame = JSON.parse(raw.toString());
          } catch (err) {
            logger.error(`Salt socket client: unparseable frame: ${(err as Error).message}`);
            return;
          }

          const type = frame.type as string | undefined;
          if (type === "ping" || type === "welcome") {
            armPingWatchdog();
            return;
          }
          if (type === "confirm_subscription") {
            subscribed = true;
            logger.info(`Salt socket client: subscribed (cursor ${localCursor})`);
            return;
          }
          if (type === "reject_subscription") {
            logger.error("Salt socket client: subscription rejected; reconnecting");
            try {
              socket.close();
            } catch {
              // already gone
            }
            return;
          }
          if (type === "disconnect") {
            logger.info(`Salt socket client: server requested disconnect${frame.reason ? ` (${frame.reason})` : ""}`);
            return; // the 'close' event that follows drives reconnect
          }

          const payload = frame.message as Record<string, unknown> | undefined;
          if (!payload || typeof payload !== "object") return;
          if (payload.type === "replay_done") {
            await handleReplayDone(payload as unknown as ReplayDoneFrame);
            return;
          }
          if (typeof payload.id !== "number") return;
          await dispatchRow(payload as unknown as SaltAgentUpdateRow);
        }

        socket.on("open", () => {
          const identifier =
            localCursor > 0
              ? JSON.stringify({ channel: "AgentUpdatesChannel", after: localCursor })
              : JSON.stringify({ channel: "AgentUpdatesChannel" });
          socket.send(JSON.stringify({ command: "subscribe", identifier }));
        });

        socket.on("message", (raw: RawData) => {
          queue = queue.then(() => handleFrame(raw)).catch((err) => {
            logger.error(`Salt socket client: error handling frame: ${(err as Error).message}`);
          });
        });

        socket.on("close", () => finish());
        socket.on("error", (err: Error) => {
          logger.error(`Salt socket client: websocket error: ${err.message}`);
          // 'close' normally follows in the ws library; finish() runs there.
        });
      })();
    });
  }

  async function loop(): Promise<void> {
    let backoff = minBackoffMs;
    logger.info(`Salt socket client: connecting to ${wsHost}/cable`);
    while (!stopped) {
      let outcome: { subscribed: boolean };
      try {
        outcome = await runConnection();
      } catch (err) {
        logger.error(`Salt socket client: connection failed: ${(err as Error).message}`);
        outcome = { subscribed: false };
      }
      if (stopped) break;
      if (outcome.subscribed) backoff = minBackoffMs; // a clean connection resets the failure backoff
      const waitMs = jitter(backoff);
      logger.error(`Salt socket client: reconnecting in ${waitMs}ms`);
      await sleep(waitMs);
      backoff = Math.min(backoff * 2, maxBackoffMs);
    }
  }

  return {
    start() {
      if (loopPromise) return; // already running
      stopped = false;
      loopPromise = loop().catch((err) => logger.error(`Salt socket client: loop exited unexpectedly: ${(err as Error).message}`));
    },
    async stop() {
      stopped = true;
      if (currentSocket) {
        try {
          currentSocket.terminate();
        } catch {
          // already gone
        }
      }
      await loopPromise;
      loopPromise = null;
    },
  };
}
