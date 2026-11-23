// SQLite via Node's built-in node:sqlite (no native build step, unlike better-sqlite3).
import { DatabaseSync } from 'node:sqlite';
import type { Status } from './summarize.ts';

/** Stored in remote_control when we cannot tell (Remote Control may have been turned on after launch). */
export const REMOTE_CONTROL_UNKNOWN = -1;

export interface SessionRow {
  name: string;
  machine: string;
  project: string;
  status: Status;
  remote_control: number;     // 1 on, 0 off, REMOTE_CONTROL_UNKNOWN (-1) for adopted sessions started without the flag
  status_since: number;
  last_message: string | null;
  claude_id: string | null;   // Claude Code session id (we pass --session-id, or a hook reports it)
  transcript: string | null;  // transcript path reported by a hook
  created: number | null;     // when the session started (null for rows from before this column)
  target: string | null;      // adopted sessions: tmux pane id (%N) running Claude Code; null for native ones
  tmux_session: string | null; // adopted sessions: the user's own tmux session name
  claude_pid: number | null;   // adopted sessions: pid of the Claude Code process in the pane (changes when it restarts)
  tmux_orig: string | null;    // adopted sessions: the tmux session's name before we renamed it to cc-<name>
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
    for (const col of ['claude_id TEXT', 'transcript TEXT', 'created INTEGER', 'target TEXT', 'tmux_session TEXT', 'claude_pid INTEGER', 'tmux_orig TEXT']) {
      try { this.db.exec(`ALTER TABLE sessions ADD COLUMN ${col}`); } catch { /* already there */ }
    }
    // One row per adopted pane: machine + tmux pane id. Duplicates from earlier versions go first
    // (oldest row wins), or the unique index below could not be created.
    const removed = this.dedupeAdopted();
    if (removed) console.log(`db: removed ${removed} duplicate adopted session(s), kept the oldest of each pane`);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS sessions_adopted_pane ON sessions (machine, target) WHERE target IS NOT NULL`);
  }

  /** Delete adopted rows that share machine + pane with an older row. Returns how many were removed. */
  dedupeAdopted(): number {
    const dups = this.db.prepare(`SELECT name FROM sessions WHERE target IS NOT NULL
      AND rowid NOT IN (SELECT MIN(rowid) FROM sessions WHERE target IS NOT NULL GROUP BY machine, target)`).all() as { name: string }[];
    for (const d of dups) this.deleteSession(d.name);
    return dups.length;
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

  /** The row tracking this pane (any status), if any. */
  adoptedRow(machine: string, target: string): SessionRow | undefined {
    return this.db.prepare(`SELECT * FROM sessions WHERE machine = ? AND target = ?`).get(machine, target) as SessionRow | undefined;
  }

  /** Is this Claude Code session id already tracked (by the orchestrator or adopted) and not stopped? */
  hasLiveClaudeId(machine: string, claudeId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM sessions WHERE machine = ? AND claude_id = ? AND status != 'stopped'`).get(machine, claudeId);
  }

  /**
   * Track a Claude Code pane that was started outside the orchestrator. Idempotent: the pane
   * (machine + tmux pane id) is the identity, so a repeat, a concurrent scan, a renamed tmux session
   * or a restarted Claude Code updates the existing row instead of adding another.
   */
  adoptSession(s: { name: string; machine: string; project: string; status: Status; target: string; tmux_session: string; claude_id: string | null; claude_pid: number | null; remote_control: number; tmux_orig?: string | null }) {
    const now = Date.now();
    this.db.prepare(`INSERT INTO sessions (name, machine, project, status, remote_control, status_since, created, claude_id, claude_pid, target, tmux_session, tmux_orig)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (machine, target) WHERE target IS NOT NULL DO UPDATE SET
        tmux_session = excluded.tmux_session,
        tmux_orig = COALESCE(sessions.tmux_orig, excluded.tmux_orig),
        project = CASE WHEN sessions.project = 'unassigned' THEN excluded.project ELSE sessions.project END,
        transcript = CASE WHEN sessions.claude_pid IS excluded.claude_pid AND sessions.claude_id IS excluded.claude_id THEN sessions.transcript ELSE NULL END,
        claude_id = excluded.claude_id, claude_pid = excluded.claude_pid,
        status_since = CASE WHEN sessions.status = 'stopped' THEN excluded.status_since ELSE sessions.status_since END,
        status = CASE WHEN sessions.status = 'stopped' THEN excluded.status ELSE sessions.status END`)
      .run(s.name, s.machine, s.project, s.status, s.remote_control, now, now, s.claude_id, s.claude_pid, s.target, s.tmux_session, s.tmux_orig ?? null);
  }

  /**
   * Give a session row a new name (its events follow). False when another adopted row holds that name.
   * A native row with that name is a leftover of a hook event that arrived before the rename: it is dropped.
   */
  renameSession(from: string, to: string): boolean {
    if (from === to) return true;
    const clash = this.session(to);
    if (clash?.target) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (clash) this.deleteSession(to);
      this.db.prepare(`UPDATE events SET session = ? WHERE session = ?`).run(to, from);
      this.db.prepare(`UPDATE sessions SET name = ? WHERE name = ?`).run(to, from);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return true;
  }

  setRemoteControl(name: string, value: number) {
    this.db.prepare(`UPDATE sessions SET remote_control = ? WHERE name = ?`).run(value, name);
  }

  upsertSession(s: Omit<SessionRow, 'status_since' | 'last_message' | 'claude_id' | 'transcript' | 'created' | 'target' | 'tmux_session' | 'claude_pid' | 'tmux_orig'>) {
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
