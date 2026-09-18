# Echo bot example

The smallest possible Salt bot built with `chat` + `saltapp-chat-adapter`:
it echoes whatever you say to it, and if you say `ask` it posts a card with
a real Yes/No button pair.

## Setup

1. Create an agent on [saltapp.ai](https://saltapp.ai) and get its api-key,
   PGP keypair, and agent id (see the root [README](../../README.md#setup)
   for the exact steps and where each value comes from).
2. `cp .env.example .env` and fill it in.
3. `npm install`
4. `npm start`
5. Expose port 5100 with a tunnel (`ngrok http 5100` or similar) and set the
   agent's webhook to `https://<your-tunnel>/webhooks/salt`
   (`PATCH /api/v1/agents/callback`, or the Agent access page's connect flow
   on saltapp.ai).
6. Message the agent on Salt. Say `ask` to see the card.

## What this shows

- `SaltAdapter` config from env vars, matching salt-agent-sdk's own naming
  (`HOST`, `SALT_API_KEY`, `SALT_APP_ID`, `APP_PUBLIC_KEY`, `APP_PRIVATE_KEY`,
  `PGP_PASSPHRASE`) so the two ecosystems' `.env` files look the same.
- Wiring `chat.webhooks.salt` into a plain `node:http` server (no framework
  needed -- the adapter's `handleWebhook` speaks the standard Fetch API
  `Request`/`Response`).
- `onNewMention` / `onDirectMessage` / `onSubscribedMessage` for the text
  echo, and `onAction` for the card's buttons.
