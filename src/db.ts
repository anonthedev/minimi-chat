import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const WORKING_WINDOW = 16;
export const RECALL_LIMIT = 20;

export type StoredChat = {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
};

export type StoredMessage = {
  id: number;
  chat_id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

let database: DatabaseSync | undefined;

export function openDatabase(path = "data/chat.sqlite"): DatabaseSync {
  if (database) return database;
  mkdirSync("data", { recursive: true });
  database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  ensureChatColumn(database);
  database.exec("CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, id)");
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='id'
    )
  `);
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END
  `);
  return database;
}

export function listChats(): StoredChat[] {
  const rows = openDatabase()
    .prepare(
      `SELECT id, title, created_at, updated_at
       FROM chats
       ORDER BY updated_at DESC, id DESC`,
    )
    .all();
  return rows.map(readChat);
}

export function getChat(id: number): StoredChat | null {
  const row = openDatabase()
    .prepare("SELECT id, title, created_at, updated_at FROM chats WHERE id = ?")
    .get(id);
  return row ? readChat(row as Record<string, unknown>) : null;
}

export function createChat(title: string, createdAt = new Date()): StoredChat {
  const iso = createdAt.toISOString();
  const result = openDatabase()
    .prepare("INSERT INTO chats (title, created_at, updated_at) VALUES (?, ?, ?)")
    .run(title, iso, iso);
  return { id: Number(result.lastInsertRowid), title, created_at: iso, updated_at: iso };
}

export function deleteChat(id: number): void {
  openDatabase().prepare("DELETE FROM chats WHERE id = ?").run(id);
}

export function messageCount(chatId: number): number {
  const row = openDatabase().prepare("SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?").get(chatId) as
    | { count: number }
    | undefined;
  return Number(row?.count ?? 0);
}

export function messagesFor(chatId: number): StoredMessage[] {
  const rows = openDatabase()
    .prepare(
      `SELECT id, chat_id, role, content, created_at
       FROM messages
       WHERE chat_id = ?
       ORDER BY id ASC`,
    )
    .all(chatId);
  return rows.map(readMessage);
}

export function recentMessages(chatId: number, limit = WORKING_WINDOW): StoredMessage[] {
  const rows = openDatabase()
    .prepare(
      `SELECT id, chat_id, role, content, created_at
       FROM messages
       WHERE chat_id = ?
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(chatId, limit);
  return rows.map(readMessage).reverse();
}

export function insertMessage(chatId: number, role: "user" | "assistant", content: string, createdAt = new Date()): number {
  const iso = createdAt.toISOString();
  const result = openDatabase()
    .prepare("INSERT INTO messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)")
    .run(chatId, role, content, iso);
  openDatabase().prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(iso, chatId);
  return Number(result.lastInsertRowid);
}

export function titleFrom(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  if (line.length <= 48) return line || "New chat";
  return `${line.slice(0, 48).trimEnd()}…`;
}

export type RecalledMessage = StoredMessage & { chat_title: string };

export type RecallQuery = {
  skipChatId: number | null;
  start: Date | null;
  end: Date | null;
  query: string | null;
  beforeId: number | null;
};

export function recallMessages(input: RecallQuery): RecalledMessage[] {
  const match = input.query ? ftsMatch(input.query) : null;
  const rows = openDatabase()
    .prepare(
      `SELECT messages.id, messages.chat_id, messages.role, messages.content, messages.created_at, chats.title AS chat_title
       FROM messages
       JOIN chats ON chats.id = messages.chat_id
       WHERE (? IS NULL OR messages.created_at >= ?)
         AND (? IS NULL OR messages.created_at < ?)
         AND (? IS NULL OR messages.id < ?)
         AND (? IS NULL OR messages.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?))
         AND (? IS NULL OR messages.id NOT IN (
           SELECT id FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?
         ))
       ORDER BY messages.id DESC
       LIMIT ?`,
    )
    .all(
      input.start ? input.start.toISOString() : null,
      input.start ? input.start.toISOString() : null,
      input.end ? input.end.toISOString() : null,
      input.end ? input.end.toISOString() : null,
      input.beforeId,
      input.beforeId,
      match,
      match,
      input.skipChatId,
      input.skipChatId,
      WORKING_WINDOW,
      RECALL_LIMIT,
    );
  return rows.map(readRecalled).reverse();
}

function ftsMatch(query: string): string | null {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((token) => token.length >= 2) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replaceAll('"', "")}"`).join(" OR ");
}

function ensureChatColumn(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(messages)").all() as Array<{ name?: string }>;
  if (!columns.some((column) => column.name === "chat_id")) {
    database.exec("ALTER TABLE messages ADD COLUMN chat_id INTEGER");
  }
  const pending = database.prepare("SELECT COUNT(*) AS count FROM messages WHERE chat_id IS NULL").get() as
    | { count: number }
    | undefined;
  if (!pending || Number(pending.count) === 0) return;
  const first = database
    .prepare("SELECT content FROM messages WHERE role = 'user' AND chat_id IS NULL ORDER BY id ASC LIMIT 1")
    .get() as { content?: string } | undefined;
  const span = database
    .prepare("SELECT MIN(created_at) AS created_at, MAX(created_at) AS updated_at FROM messages WHERE chat_id IS NULL")
    .get() as { created_at: string; updated_at: string };
  const title = first?.content ? titleFrom(String(first.content)) : "Earlier chat";
  const result = database
    .prepare("INSERT INTO chats (title, created_at, updated_at) VALUES (?, ?, ?)")
    .run(title, span.created_at, span.updated_at);
  database.prepare("UPDATE messages SET chat_id = ? WHERE chat_id IS NULL").run(Number(result.lastInsertRowid));
}

function readChat(row: Record<string, unknown>): StoredChat {
  return {
    id: Number(row.id),
    title: String(row.title),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function readRecalled(row: Record<string, unknown>): RecalledMessage {
  return { ...readMessage(row), chat_title: String(row.chat_title ?? "") };
}

function readMessage(row: Record<string, unknown>): StoredMessage {
  const role = row.role === "assistant" ? "assistant" : "user";
  return {
    id: Number(row.id),
    chat_id: Number(row.chat_id),
    role,
    content: String(row.content),
    created_at: String(row.created_at),
  };
}
