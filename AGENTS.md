# AGENTS.md

Guidance for coding agents working in this repo.

## What this is

A Vercel Chat SDK (`chat`) platform adapter for Salt (saltapp.ai). It
implements the `Adapter<SaltThreadId, SaltRawMessage>` interface from the
`chat` package. See `README.md` for what it does and doesn't cover;
`HANDOFF.md` for what's left and publish steps.

## File map

- `src/types.ts` -- Salt-specific shapes: `SaltAdapterConfig`,
  `SaltThreadId`, and the exact JSON bodies salt-api's `WebhookJob` posts
  (`SaltRawMessage`, `SaltRawChatMeta`, `SaltCardInteractionWebhookBody`).
  These are hand-derived from salt-api's `Message#formatted_message` and
  `Message#send_webhook` (in the sibling `salt-api` repo) -- if that
  serialization ever changes, this file is the one to update, and the
  webhook tests in `tests/webhook.test.ts` are what will catch a drift.
- `src/thread-id.ts` -- `salt:<chatId>` / `salt:<chatId>:lane:<laneId>`
  encode/decode. Pure functions, no I/O.
- `src/signature.ts` -- HMAC verification matching salt-agent-sdk's own
  (unexported) `webhook.ts` algorithm byte for byte. See its header comment
  for why this exists instead of importing something from salt-agent-sdk.
- `src/action-id.ts` -- packs a chat-sdk button's `(id, value)` into Salt's
  40-char `action_id` charset. `encodeSaltActionId`/`decodeSaltActionId`
  must stay inverses of each other; `tests/action-id.test.ts` pins the
  round trip and the overflow-throws behavior.
- `src/cards.ts` -- `CardElement` -> Salt's block vocabulary
  (`SALT_CARD_LIMITS` mirrors salt-api's `app/models/card.rb` constants;
  keep them in sync if that model's limits ever change).
- `src/salt-rest.ts` -- the two-ish endpoints salt-agent-sdk's `SaltClient`
  doesn't cover (reactions, delete-for-everyone, and a `getChat` that
  returns the full chat payload `getChatMembers`/`getChatMessages` each
  only return half of). Delete this file's methods one by one as
  salt-agent-sdk grows real equivalents -- see HANDOFF.md.
- `src/socket.ts` -- version/capability gate for `mode: "socket"`. Always
  throws today (no sibling lane has shipped a socket client yet); see its
  header comment before "fixing" it to guess at an API that doesn't exist.
- `src/adapter.ts` -- the `Adapter` implementation itself. Read the class's
  top comment and `parseMessage`'s doc comment before touching decryption:
  Salt content is PGP ciphertext, which can only be decrypted
  asynchronously, but `Adapter.parseMessage` is a synchronous contract
  method. The resolution is `ChatInstance.processMessage`'s own
  "message: Message | (() => Promise<Message>)" escape hatch -- real
  decryption happens in the async factory `dispatchMessage` hands it, never
  in `parseMessage` itself.

## Working here

- `chat` and `@chat-adapter/shared` are ESM-only (`"type": "module"`, no
  `require` condition in their `exports` map). This package is therefore
  ESM too (`"type": "module"` in `package.json`) and built with `tsup`
  (`format: ["esm"]`), not plain `tsc`, which is what emits raw CommonJS
  `require()` calls that would fail against `chat` at runtime. Don't switch
  the build back to `tsc -p tsconfig.json` without re-checking this --
  `tsconfig.json`'s `noEmit: true` is deliberate; `tsc` here is
  type-checking only (`npm run typecheck`).
- `salt-agent-sdk` is a **sibling repo**, not published to the real npm
  registry. `package.json` must read `"salt-agent-sdk": "^0.7.1"` (or
  whatever range is current) when committed. For local dev/testing, point
  it at the sibling checkout instead: `npm install ../salt-agent-sdk`
  (which rewrites the dependency to `file:../salt-agent-sdk` in
  `package.json`) -- and **restore the semver range before committing**,
  same as every other lane touching this package per the workspace's
  `LANES.md`. If `salt-agent-sdk` changed since your last install here,
  rebuild it first (`cd ../salt-agent-sdk && npm run build`) -- this
  package imports its compiled `dist/`, not its TypeScript source.
- Tests mock the REST layer at the `fetch` level (`tests/helpers.ts`'s
  `FakeSaltApi`), not by hand-stubbing `SaltClient`'s ~30 methods. Real
  `openpgp`-backed encryption/decryption runs in tests via
  `salt-agent-sdk`'s `generateKeypair`/`encryptFor`/`decrypt` -- crypto is
  never mocked away, only the network.
- `chat`'s published package exports `CardText`, not `Text`, as the runtime
  value (the bare name collides with `mdast`'s `Text` node type at the
  package's own build step and gets dropped from the compiled bundle --
  see the doc comment on `CardText` in `chat`'s source). Importing `Text`
  as a value from `"chat"` will be `undefined` and throw "Text is not a
  function" the moment you call it. Use `CardText`.
- No TODO placeholders, no skipped tests, no stubs presented as done. If
  something is genuinely blocked (like socket mode), say so loudly in code
  comments and in `HANDOFF.md`, and make the failure mode a clear thrown
  error rather than a silent no-op.

## Commands

```bash
npm install              # or: npm install ../salt-agent-sdk for local dev, see above
npm test                  # vitest run
npm run typecheck          # tsc --noEmit, catches the things vitest's esbuild transform won't
npm run build               # tsup -> dist/ (ESM + .d.ts)
```

`examples/echo-bot/` has its own `package.json` (also ESM, run with `tsx`,
not `ts-node` -- same `chat`-is-ESM-only reason as above) and its own
`npm install`/`npm run typecheck`.
