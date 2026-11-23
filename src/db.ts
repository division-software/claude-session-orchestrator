// SQLite via Node's built-in node:sqlite (no native build step, unlike better-sqlite3).
import { DatabaseSync } from 'node:sqlite';
import type { Status } from './summarize.ts';

export interface SessionRow {
  name: string;
  machine: string;
  project: string;
  status: Status;
  remote_control: number;
  status_since: number;
  last_message: string | null;
  claude_id: string | null;   // Claude Code session id (we pass --session-id, or a hook reports it)
  transcript: string | null;  // transcript path reported by a hook
  created: number | null;     // when the session started (null for rows from before this column)
  keep: number;               // 1 = never auto-stopped by the idle cleanup
}

export class Db {
  db: DatabaseSync;
  constructor(path = process.env.DB_PATH ?? 'orchestrator.db') {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        name TEXT PRIMARY KEY, machine TEXT NOT NULL, project TEXT NOT NULL,
        status TEXT NOT NULL, remote_control INTEGER NOT NULL DEFAULT 1,
        status_since INTEGER NOT NULL, last_message TEXT);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, session TEXT NOT NULL, hook TEXT NOT NULL,
        status TEXT NOT NULL, message TEXT, ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, agent TEXT NOT NULL, task TEXT NOT NULL, status TEXT NOT NULL,
        result TEXT, started INTEGER NOT NULL, finished INTEGER);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, tool TEXT NOT NULL,
        args TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT);
    `);
    // Columns added after the first release; ALTER fails harmlessly when they already exist.
    for (const col of ['claude_id TEXT', 'transcript TEXT', 'created INTEGER', 'keep INTEGER NOT NULL DEFAULT 0']) {
      try { this.db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`); } catch { /* already there */ }
    }
  }

  /** Forget a session completely: its row and its events. */
  deleteSession(name: string) {
    this.db.prepare(`DELETE FROM events WHERE session = ?`).run(name);
    this.db.prepare(`DELETE FROM sessions WHERE name = ?`).run(name);
  }

  setTranscript(name: string, claudeId: string | null, transcript: string | null) {
    this.db.prepare(`UPDATE sessions SET claude_id = COALESCE(?, claude_id), transcript = COALESCE(?, transcript) WHERE name = ?`)
      .run(claudeId, transcript, name);
  }

  upsertSession(s: Omit<SessionRow, 'status_since' | 'last_message' | 'claude_id' | 'transcript' | 'created' | 'keep'>) {
    const now = Date.now();
    this.db.prepare(`INSERT INTO sessions (name, machine, project, status, remote_control, status_since, created)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET machine = excluded.machine, project = excluded.project,
        status = excluded.status, remote_control = excluded.remote_control, status_since = excluded.status_since,
        created = excluded.created, claude_id = NULL, transcript = NULL`)
      .run(s.name, s.machine, s.project, s.status, s.remote_control, now, now);
  }

  /** Every session ever tracked for a project, newest first. */
  projectSessions(project: string) {
    return this.db.prepare(`SELECT * FROM sessions WHERE project = ? ORDER BY COALESCE(created, status_since) DESC`)
      .all(project) as unknown as SessionRow[];
  }

  setKeep(name: string, keep: boolean) {
    this.db.prepare(`UPDATE sessions SET keep = ? WHERE name = ?`).run(keep ? 1 : 0, name);
  }

  setStatus(name: string, status: Status, message: string | null = null) {
    this.db.prepare(`UPDATE sessions SET status = ?, status_since = ?, last_message = ? WHERE name = ?`)
      .run(status, Date.now(), message, name);
  }

  session(name: string) {
    return this.db.prepare(`SELECT * FROM sessions WHERE name = ?`).get(name) as SessionRow | undefined;
  }

  sessions() {
    return this.db.prepare(`SELECT * FROM sessions`).all() as unknown as SessionRow[];
  }

  pending() {
    return this.db.prepare(`SELECT * FROM sessions WHERE status IN ('waiting_input', 'waiting_approval')
      ORDER BY status_since ASC`).all() as unknown as SessionRow[];
  }

  addEvent(session: string, hook: string, status: Status, message: string | null) {
    this.db.prepare(`INSERT INTO events (session, hook, status, message, ts) VALUES (?, ?, ?, ?, ?)`)
      .run(session, hook, status, message, Date.now());
  }

  /** Hook events newer than `after` (an event id), oldest first: the cursor for events_wait. */
  eventsAfter(after: number) {
    return this.db.prepare(`SELECT * FROM events WHERE id > ? ORDER BY id LIMIT 50`).all(after) as unknown as
      { id: number; session: string; hook: string; status: Status; message: string | null; ts: number }[];
  }

  lastEventId() {
    return (this.db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM events`).get() as { n: number }).n;
  }

  addJob(id: string, agent: string, task: string) {
    this.db.prepare(`INSERT INTO jobs (id, agent, task, status, started) VALUES (?, ?, ?, 'running', ?)`)
      .run(id, agent, task, Date.now());
  }

  finishJob(id: string, status: 'done' | 'failed', result: string) {
    this.db.prepare(`UPDATE jobs SET status = ?, result = ?, finished = ? WHERE id = ?`)
      .run(status, result, Date.now(), id);
  }

  job(id: string) {
    return this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as
      { id: string; agent: string; task: string; status: string; result: string | null; started: number; finished: number | null } | undefined;
  }

  /** Jobs still 'running' after a restart lost their worker. */
  failOrphanJobs() {
    this.db.prepare(`UPDATE jobs SET status = 'failed', result = 'orchestrator restarted' WHERE status = 'running'`).run();
  }

  audit(tool: string, args: unknown, error?: string) {
    this.db.prepare(`INSERT INTO audit (ts, tool, args, ok, error) VALUES (?, ?, ?, ?, ?)`)
      .run(Date.now(), tool, JSON.stringify(args ?? {}), error ? 0 : 1, error ?? null);
  }
}
