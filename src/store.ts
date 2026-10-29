import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type UserState = {
  openId: string;
  chatId: string;
  activeThreadId: string | null;
  activeProjectId: string | null;
  updatedAt: number;
};

export type GuestThread = {
  threadId: string;
  openId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

export class StateStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_state (
        open_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        active_thread_id TEXT,
        active_project_id TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS processed_events (
        event_id TEXT PRIMARY KEY,
        processed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS turn_routes (
        thread_id TEXT PRIMARY KEY,
        turn_id TEXT,
        open_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'owner',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS guest_threads (
        thread_id TEXT PRIMARY KEY,
        open_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS guest_threads_open_id_updated_at
        ON guest_threads(open_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS guest_user_threads (
        open_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL UNIQUE
      );
    `);
    this.db.exec(`
      INSERT OR IGNORE INTO guest_user_threads (open_id, thread_id)
      SELECT current.open_id, current.thread_id
      FROM guest_threads AS current
      WHERE NOT EXISTS (
        SELECT 1
        FROM guest_threads AS newer
        WHERE newer.open_id = current.open_id
          AND (
            newer.updated_at > current.updated_at
            OR (newer.updated_at = current.updated_at AND newer.thread_id > current.thread_id)
          )
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(user_state)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "active_project_id")) {
      this.db.exec("ALTER TABLE user_state ADD COLUMN active_project_id TEXT");
    }
    const routeColumns = this.db.prepare("PRAGMA table_info(turn_routes)").all() as Array<{ name: string }>;
    if (!routeColumns.some((column) => column.name === "role")) {
      this.db.exec("ALTER TABLE turn_routes ADD COLUMN role TEXT NOT NULL DEFAULT 'owner'");
    }
  }

  close(): void {
    this.db.close();
  }

  rememberUser(openId: string, chatId: string): void {
    this.db
      .prepare(`
        INSERT INTO user_state (open_id, chat_id, active_thread_id, active_project_id, updated_at)
        VALUES (?, ?, NULL, NULL, ?)
        ON CONFLICT(open_id) DO UPDATE SET
          chat_id = excluded.chat_id,
          updated_at = excluded.updated_at
      `)
      .run(openId, chatId, Date.now());
  }

  setActiveThread(openId: string, chatId: string, threadId: string, projectId?: string | null): void {
    this.db
      .prepare(`
        INSERT INTO user_state (open_id, chat_id, active_thread_id, active_project_id, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(open_id) DO UPDATE SET
          chat_id = excluded.chat_id,
          active_thread_id = excluded.active_thread_id,
          active_project_id = COALESCE(excluded.active_project_id, user_state.active_project_id),
          updated_at = excluded.updated_at
      `)
      .run(openId, chatId, threadId, projectId ?? null, Date.now());
  }

  setActiveProject(openId: string, chatId: string, projectId: string): void {
    this.db
      .prepare(`
        INSERT INTO user_state (open_id, chat_id, active_thread_id, active_project_id, updated_at)
        VALUES (?, ?, NULL, ?, ?)
        ON CONFLICT(open_id) DO UPDATE SET
          chat_id = excluded.chat_id,
          active_project_id = excluded.active_project_id,
          updated_at = excluded.updated_at
      `)
      .run(openId, chatId, projectId, Date.now());
  }

  prepareNewThread(openId: string, chatId: string, projectId: string): void {
    this.db
      .prepare(`
        INSERT INTO user_state (open_id, chat_id, active_thread_id, active_project_id, updated_at)
        VALUES (?, ?, NULL, ?, ?)
        ON CONFLICT(open_id) DO UPDATE SET
          chat_id = excluded.chat_id,
          active_thread_id = NULL,
          active_project_id = excluded.active_project_id,
          updated_at = excluded.updated_at
      `)
      .run(openId, chatId, projectId, Date.now());
  }

  prepareNewGuestThread(openId: string, chatId: string): void {
    this.db
      .prepare(`
        INSERT INTO user_state (open_id, chat_id, active_thread_id, active_project_id, updated_at)
        VALUES (?, ?, NULL, NULL, ?)
        ON CONFLICT(open_id) DO UPDATE SET
          chat_id = excluded.chat_id,
          active_thread_id = NULL,
          active_project_id = NULL,
          updated_at = excluded.updated_at
      `)
      .run(openId, chatId, Date.now());
  }

  addGuestThread(openId: string, threadId: string, title: string): GuestThread {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getGuestThreadForUser(openId);
      if (existing) {
        this.db.exec("COMMIT");
        return existing;
      }
      this.db
        .prepare(`
          INSERT INTO guest_threads (thread_id, open_id, title, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(threadId, openId, title, now, now);
      this.db
        .prepare("INSERT INTO guest_user_threads (open_id, thread_id) VALUES (?, ?)")
        .run(openId, threadId);
      this.db.exec("COMMIT");
      return { threadId, openId, title, createdAt: now, updatedAt: now };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getGuestThreadForUser(openId: string): GuestThread | null {
    const row = this.db
      .prepare(`
        SELECT thread.thread_id, thread.open_id, thread.title, thread.created_at, thread.updated_at
        FROM guest_user_threads AS binding
        JOIN guest_threads AS thread ON thread.thread_id = binding.thread_id
        WHERE binding.open_id = ?
      `)
      .get(openId) as
      | { thread_id: string; open_id: string; title: string; created_at: number; updated_at: number }
      | undefined;
    return row
      ? { threadId: row.thread_id, openId: row.open_id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at }
      : null;
  }

  updateGuestThreadTitle(threadId: string, title: string): void {
    this.db.prepare("UPDATE guest_threads SET title = ?, updated_at = ? WHERE thread_id = ?").run(title, Date.now(), threadId);
  }

  touchGuestThread(threadId: string): void {
    this.db.prepare("UPDATE guest_threads SET updated_at = ? WHERE thread_id = ?").run(Date.now(), threadId);
  }

  getGuestThread(threadId: string): GuestThread | null {
    const row = this.db
      .prepare("SELECT thread_id, open_id, title, created_at, updated_at FROM guest_threads WHERE thread_id = ?")
      .get(threadId) as
      | { thread_id: string; open_id: string; title: string; created_at: number; updated_at: number }
      | undefined;
    return row
      ? { threadId: row.thread_id, openId: row.open_id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at }
      : null;
  }

  listGuestThreads(openId: string, limit = 30): GuestThread[] {
    const rows = this.db
      .prepare(`
        SELECT thread_id, open_id, title, created_at, updated_at
        FROM guest_threads
        WHERE open_id = ?
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(openId, limit) as Array<{
        thread_id: string;
        open_id: string;
        title: string;
        created_at: number;
        updated_at: number;
      }>;
    return rows.map((row) => ({
      threadId: row.thread_id,
      openId: row.open_id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getUser(openId: string): UserState | null {
    const row = this.db
      .prepare(
        "SELECT open_id, chat_id, active_thread_id, active_project_id, updated_at FROM user_state WHERE open_id = ?",
      )
      .get(openId) as
      | {
          open_id: string;
          chat_id: string;
          active_thread_id: string | null;
          active_project_id: string | null;
          updated_at: number;
        }
      | undefined;

    if (!row) return null;
    return {
      openId: row.open_id,
      chatId: row.chat_id,
      activeThreadId: row.active_thread_id,
      activeProjectId: row.active_project_id,
      updatedAt: row.updated_at,
    };
  }

  markEventProcessed(eventId: string): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO processed_events (event_id, processed_at) VALUES (?, ?)")
      .run(eventId, Date.now());
    return result.changes === 1;
  }

  setTurnRoute(threadId: string, turnId: string | null, openId: string, chatId: string, role: "owner" | "guest" = "owner"): void {
    this.db
      .prepare(`
        INSERT INTO turn_routes (thread_id, turn_id, open_id, chat_id, role, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          turn_id = excluded.turn_id,
          open_id = excluded.open_id,
          chat_id = excluded.chat_id,
          role = excluded.role,
          updated_at = excluded.updated_at
      `)
      .run(threadId, turnId, openId, chatId, role, Date.now());
  }

  getTurnRoute(threadId: string): { turnId: string | null; openId: string; chatId: string; role: "owner" | "guest" } | null {
    const row = this.db
      .prepare("SELECT turn_id, open_id, chat_id, role FROM turn_routes WHERE thread_id = ?")
      .get(threadId) as { turn_id: string | null; open_id: string; chat_id: string; role: "owner" | "guest" } | undefined;
    if (!row) return null;
    return { turnId: row.turn_id, openId: row.open_id, chatId: row.chat_id, role: row.role };
  }
}
