# AGENTS.md

Guidance for coding agents working in this repo.

## What this is

Salt (saltapp.ai) is an end-to-end encrypted chat where humans and AI
agents are equal contacts. This package is a Vercel Chat SDK (`chat`)
platform adapter for it: it implements the `Adapter<SaltThreadId,
SaltRawMessage>` interface from the `chat` package. See `README.md` for
what it does and doesn't cover; `HANDOFF.md` for what's left and publish
steps.

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
- `salt-agent-sdk` is on the npm registry (0.28.0 published 2026-10-19);
  `package.json` reads `"salt-agent-sdk": "^0.29.0"`. For local dev against
  an unreleased sibling checkout you can `npm install ../salt-agent-sdk`
  (rewrites the dependency to `file:../salt-agent-sdk`) -- **restore the
  semver range before committing**. If `salt-agent-sdk` changed since your
  last install here, rebuild it first (`cd ../salt-agent-sdk && npm run build`).
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

## Rules that bite

Cross-repo facts worth knowing before touching webhook, card, or
REST-fetch code here -- the same mistakes have already shipped in
sibling adapters:

- **Never poll `GET /api/v1/agent/updates` while waiting on a specific
  card's answer.** That outbox has exactly ONE forward-only cursor per
  agent -- `socket.ts`'s poller and `salt-rest.ts`'s `fetchAgentUpdates`
  both advance it, and any `after=` you pass permanently moves the ack,
  silently cutting off whatever else is reading that agent's backlog. A
  tool waiting on a human's card answer polls/waits on its OWN card
  instead, via `GET /api/v1/cards/:id` (`salt-agent-sdk`'s
  `client.getCard` -- its own doc comment states this exact rule; not
  currently re-exposed through this package's `salt-rest.ts`, so add it
  there before building a card-wait flow on top of this adapter).
- **`POST /api/v1/cards` responds referencing the chat MESSAGE it
  created** (`message_id`/`resource_id`), never a top-level `id`.
  `adapter.ts`'s `toRawMessage` already reads `p.message_id ?? p.id` for
  exactly this reason -- keep that order if it's ever touched, and never
  trust a bare `.id` on a posted-card response.
- **The same field name nests differently depending on which endpoint you
  read.** A webhook body's `chat` (`SaltRawChatMeta.encrypted`) and a
  message row (`SaltRawMessage.encrypted`) both carry `encrypted`
  top-level, confirmed against salt-api's real `WebhookJob` payload. But
  `GET /api/v1/chats/:id` (`extra.getChat`, used by `fetchThread`) returns
  a chat whose `encrypted` lives under `session.encrypted` --
  `salt-agent-sdk`'s `SaltChat` type has no top-level `encrypted` field at
  all. `fetchThread` read the wrong one until 0.1.1
  (`(chat as { encrypted?: boolean }).encrypted !== false`, always `true`
  because that top-level field does not exist on `getChat`'s response) and
  it now reads `chat.session?.encrypted`. The consequence was not a dead
  branch: it could overwrite a correct cache entry with the wrong value,
  after which `postMessage` took the PGP branch and salt-api refused the
  send. `chat.name` had the identical bug in the same function. The `as
  {...}` cast is what hid both from the type checker, so widen
  salt-agent-sdk's `SaltChat.session` locally rather than casting the
  chat's top level -- its own type still declares only `users` and
  `encrypted`, not `name`. `tests/helpers.ts`'s `FakeChat.session` is the
  ONE place to add a new session-nested field for tests; never add one to
  `FakeChat` itself, which is how this shipped green.
- **Since salt-api 0.98.1, an encrypted chat refuses a non-PGP-armored
  message body** (`messages_controller.rb`'s `pgp_armored?` check on
  `#create`). This adapter always PGP-encrypts before posting into a chat
  it believes is encrypted (`encryptForChat` -> `client.postMessage`), so
  it satisfies this by construction -- as long as whatever fed the
  encrypted/open decision was correct, which is exactly what the
  `fetchThread` bug above puts at risk.
- **Test fakes must model salt-api's actual controller response shape,
  not whatever the calling code assumes it returns.** This exact bug --
  a fake written to match the new code instead of the real endpoint --
  has shipped identically in five downstream adapters across this
  workspace. It's the file map's `types.ts` note above from a different
  angle: `tests/helpers.ts`'s `FakeSaltApi` and `tests/webhook.test.ts`
  exist so a real drift in salt-api's serialization is caught here, not
  at runtime against a live agent -- pin any new fake to a real response,
  never to the shape the new code happens to read off it.

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

## Where the truth is

- `https://saltapp.ai/api/openapi.json` -- the live OpenAPI spec for every
  REST endpoint salt-api serves; source of truth over any hand-derived
  type in `src/types.ts` if the two ever disagree.
- `https://saltapp.ai/agents.md` -- Salt's own agent-facing docs.
- `https://mcp.saltapp.ai/mcp` -- the hosted Salt MCP server (Streamable
  HTTP), useful for comparing this adapter's REST-based approach against
  the tool-call shape the same operations take over MCP.
- `salt-mcp`'s `docs/CLIENTS.md` (sibling repo,
  `/Users/z1ggy/projects/salt/salt-mcp/docs/CLIENTS.md`) -- the
  client-by-client integration matrix.

## Publishing

Not published to npm yet. The unscoped name `saltapp-chat-adapter` is
reserved for when it is -- see `README.md`'s "Listing this on
chat-sdk.dev" section and `HANDOFF.md` for the exact publish/listing
steps and who does them.
