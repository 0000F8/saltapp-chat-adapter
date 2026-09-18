// A minimal Salt bot built with `chat` + saltapp-chat-adapter: it echoes
// whatever you say to it, and answers "ask" with a card that asks a yes/no
// question using real buttons. Run it, expose it with a tunnel (ngrok or
// similar), point a Salt agent's webhook at the tunnel URL, and talk to it.
//
// See ../../README.md for how to create the agent on saltapp.ai and get the
// env vars below.

import "dotenv/config";
import * as http from "node:http";
import { Actions, Button, Card, CardText, Chat } from "chat";
import type { Message, Thread } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { SaltAdapter } from "saltapp-chat-adapter";

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env var ${name}. See .env.example.`);
  }
  return value;
}

const salt = new SaltAdapter({
  host: env("HOST", "https://saltapp.ai"),
  apiKey: env("SALT_API_KEY"),
  agentId: env("SALT_APP_ID"),
  privateKey: env("APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
  publicKey: env("APP_PUBLIC_KEY").replace(/\\n/g, "\n"),
  pgpPassphrase: env("PGP_PASSPHRASE", "salt"),
  username: process.env.SALT_USERNAME,
});

const chat = new Chat({
  adapters: { salt },
  state: createMemoryState(),
  userName: process.env.SALT_USERNAME || "bot",
});

async function echo(thread: Thread, message: Message) {
  if (message.author.isMe) return;

  const text = message.text.trim().toLowerCase();
  if (text === "ask") {
    await thread.post(
      Card({
        title: "A question",
        children: [
          CardText("Do you want to keep going?"),
          Actions([Button({ id: "yes", label: "Yes" }), Button({ id: "no", label: "No" })]),
        ],
      })
    );
    return;
  }

  await thread.post(`Echo: ${message.text}`);
}

// A brand-new 1:1 or a fresh @mention in a group -- subscribe so every
// following message in this chat goes to onSubscribedMessage instead.
chat.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await echo(thread, message);
});
chat.onDirectMessage(echo);
chat.onSubscribedMessage(echo);

chat.onAction(["yes", "no"], async (event) => {
  if (!event.thread) return;
  await event.thread.post(event.actionId === "yes" ? "Great, continuing!" : "Okay, stopping here.");
});

const port = Number(process.env.PORT ?? 5100);

http
  .createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/webhooks/salt") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
    }
    const request = new Request(`http://localhost${req.url}`, {
      method: "POST",
      headers,
      body,
    });

    const response = await chat.webhooks.salt(request);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(await response.text());
  })
  .listen(port, () => {
    console.log(`Salt echo bot listening on :${port} (webhook path: /webhooks/salt)`);
  });
