import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { getChat, listChats, messagesFor, openDatabase } from "./db.ts";
import { respond } from "./agent.ts";

const port = Number(process.env.PORT ?? 3000);
const page = readFileSync(new URL("../public/index.html", import.meta.url));

const missing = ["OPENROUTER_API_KEY", "EXA_API_KEY", "FIRECRAWL_API_KEY"].filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing ${missing.join(", ")} in .env`);
  process.exit(1);
}

try {
  new Intl.DateTimeFormat("en-US", { timeZone: process.env.TIMEZONE || "Asia/Kolkata" });
} catch {
  console.error("TIMEZONE is not a valid IANA time zone.");
  process.exit(1);
}

openDatabase();

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(page);
    return;
  }
  if (request.method === "GET" && url.pathname === "/chats") {
    sendJson(response, 200, listChats());
    return;
  }
  if (request.method === "GET" && url.pathname === "/messages") {
    const chatId = Number(url.searchParams.get("chat"));
    if (!Number.isInteger(chatId) || chatId <= 0 || !getChat(chatId)) {
      sendJson(response, 404, { error: "That chat was not found." });
      return;
    }
    sendJson(response, 200, messagesFor(chatId));
    return;
  }
  if (request.method === "POST" && url.pathname === "/chat") {
    void handleChat(request, response);
    return;
  }
  response.writeHead(404);
  response.end();
});

let nextPort = port;
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE" && nextPort < port + 10) {
    nextPort += 1;
    server.listen(nextPort);
    return;
  }
  console.error(error.message);
  process.exit(1);
});
server.on("listening", () => {
  const address = server.address();
  const bound = typeof address === "object" && address ? address.port : nextPort;
  console.log(`Chat is at http://localhost:${bound}`);
});
server.listen(nextPort);

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function handleChat(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let message = "";
  let chatId: number | null = null;
  try {
    const body = await readMessage(request);
    message = body.message;
    chatId = body.chatId;
  } catch (error) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Bad request." }));
    return;
  }
  if (chatId !== null && !getChat(chatId)) {
    sendJson(response, 404, { error: "That chat was not found." });
    return;
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const controller = new AbortController();
  response.on("close", () => {
    if (!response.writableFinished) controller.abort();
  });
  const send = (event: string, data: unknown) => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await respond({
      message,
      chatId,
      signal: controller.signal,
      onChat: (chat) => send("chat", chat),
      onStatus: (tool) => send("status", { tool }),
      onDelta: (text) => send("delta", { text }),
    });
    send("done", {});
  } catch (error) {
    const message = error instanceof Error ? error.message : "The reply failed.";
    console.error(`chat failed: ${message}`);
    if (!controller.signal.aborted) send("error", { message });
  } finally {
    response.end();
  }
}

function readMessage(request: IncomingMessage): Promise<{ message: string; chatId: number | null }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32_000) {
        reject(new Error("Message is too long."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { message?: unknown; chatId?: unknown };
        if (typeof body.message !== "string" || !body.message.trim()) {
          reject(new Error("Message is empty."));
          return;
        }
        if (body.chatId !== undefined && body.chatId !== null) {
          if (typeof body.chatId !== "number" || !Number.isInteger(body.chatId) || body.chatId <= 0) {
            reject(new Error("Chat is invalid."));
            return;
          }
          resolve({ message: body.message.trim(), chatId: body.chatId });
          return;
        }
        resolve({ message: body.message.trim(), chatId: null });
      } catch (error) {
        reject(error instanceof Error && (error.message === "Message is empty." || error.message === "Chat is invalid.") ? error : new Error("Message must be JSON."));
      }
    });
    request.on("error", reject);
  });
}
