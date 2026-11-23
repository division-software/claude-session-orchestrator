// Adopting Claude Code sessions that run in tmux but were not started by the orchestrator.
import { projectDir, type Config, type Machine } from './config.ts';
import type { Db } from './db.ts';
import { detectStatus } from './summarize.ts';
import { SESSION_RE, type ClaudePane, type Discovery } from './tmux.ts';

export const UNASSIGNED = 'unassigned';

export interface Resolved { cwd?: string; dirs?: Map<string, string> } // realpaths from the machine

/**
 * The project whose folder contains cwd (longest folder wins), or null. A path matches when it
 * matches as written or after realpath, on either side. `~` in config means the machine's $HOME;
 * when $HOME is unknown the machine's own resolution of the folder (real.dirs) is used instead.
 */
export function matchDetail(cfg: Config, m: Machine, home: string, cwd: string, real: Resolved = {}): { id: string; dir: string } | null {
  const norm = (p: string) => p.replace(/\/+$/, '') || '/';
  const cwds = [cwd, real.cwd].filter((x): x is string => !!x).map(norm);
  let best: { id: string; dir: string } | null = null;
  for (const p of cfg.projects) {
    if (p.machine !== m.id) continue; // a project's folder only exists on its own machine
    const written = projectDir(m, p);
    const dirs: string[] = [];
    if (written === '~' || written.startsWith('~/')) { if (home) dirs.push(home + written.slice(1)); }
    else dirs.push(written);
    const r = real.dirs?.get(written);
    if (r) dirs.push(r);
    for (const d of dirs.map(norm)) {
      if (cwds.some((c) => c === d || c.startsWith(`${d}/`)) && (!best || d.length > best.dir.length)) best = { id: p.id, dir: d };
    }
  }
  return best;
}

export const matchProject = (cfg: Config, m: Machine, home: string, cwd: string, real?: Resolved): string | null =>
  matchDetail(cfg, m, home, cwd, real)?.id ?? null;

/** Project folders as configured for this machine, for discover() to resolve with realpath. */
export const projectDirs = (cfg: Config, m: Machine): string[] => cfg.projects.filter((p) => p.machine === m.id).map((p) => projectDir(m, p));

export interface AdoptIo {
  /** Rename a tmux session on the machine. */
  rename(from: string, to: string): Promise<'ok' | 'exists' | 'failed'>;
  /** Names of the tmux sessions we know exist (besides those holding Claude Code panes). */
  taken?: Set<string>;
}

/** `cc-<tmux name>`: lowercase letters, digits and dashes, so Claude Code's hooks (cc-* only) report for it. */
export const adoptedName = (session: string) => `cc-${session.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'session'}`;

/** `base`, else `base-2`, `base-3`, ... : the first name that no row uses. */
function freeName(db: Db, base: string): string {
  for (let n = 1; ; n++) {
    const c = n === 1 ? base : `${base}-${n}`;
    if (!db.session(c)) return c;
  }
}

const paneNo = (id: string) => Number(id.slice(1));

/**
 * Track every Claude Code pane in `found` that we do not know yet, as an adopted session.
 * A tmux session that is not cc-* is renamed once to cc-<its name> (so the hooks, which only report
 * for cc-* tmux sessions, work for it) and its row takes that name. Identity is machine + pane id,
 * checked before the name: a renamed session is never mistaken for a native one. In a tmux session
 * with several Claude panes the lowest pane id gets the session name and the others get
 * `<session name>-p<N>` (hook events name the session, so they land on the first pane's row).
 * Returns the names of the new sessions.
 */
export async function adoptPanes(cfg: Config, db: Db, m: Machine, found: Discovery, io: AdoptIo): Promise<string[]> {
  const added: string[] = [];
  const bySession = new Map<string, ClaudePane[]>();
  for (const p of [...found.panes].sort((a, b) => paneNo(a.id) - paneNo(b.id))) bySession.set(p.session, [...(bySession.get(p.session) ?? []), p]);
  const taken = new Set([...(io.taken ?? []), ...bySession.keys()]);

  for (const [session, all] of bySession) {
    const isCc = SESSION_RE.test(session);
    // A cc-* session belongs to the orchestrator (name-based path in refresh()) unless one of its panes is already adopted.
    if (isCc && !all.some((p) => db.adoptedRow(m.id, p.id))) continue;
    // Started by the orchestrator under another tmux name, or already tracked: never a second row.
    const panes = all.filter((p) => db.adoptedRow(m.id, p.id) || !(p.claude_id && db.hasLiveClaudeId(m.id, p.claude_id)));
    if (!panes.length) continue;

    // Rename the tmux session once; the clash suffix goes on the new name.
    let tmuxName = session, base = session, renamedFrom: string | null = null;
    if (!isCc) {
      const own = (c: string) => panes.some((p) => db.adoptedRow(m.id, p.id)?.name === c);
      const want = adoptedName(session);
      base = want;
      for (let n = 1, tries = 0; tries < 20; n++) {
        const c = n === 1 ? want : `${want}-${n}`;
        if (taken.has(c) || (db.session(c) && !own(c))) continue;
        tries++;
        const r = await io.rename(session, c);
        if (r === 'ok') {
          taken.delete(session); taken.add(c);
          console.log(`adopt: renamed tmux session on ${m.id}: ${session} -> ${c} (panes ${panes.map((p) => p.id).join(', ')})`);
          tmuxName = base = c; renamedFrom = session;
          break;
        }
        if (r === 'failed') { console.log(`adopt: could not rename tmux session ${session} on ${m.id}; will retry on the next scan`); base = c; break; }
        taken.add(c); // 'exists': another tmux session has it; try the next suffix
      }
    } else {
      // A hook event for the new name can arrive before our row is renamed and make a native row: it is a duplicate.
      const dup = db.session(session);
      if (dup && !dup.target && dup.machine === m.id) db.deleteSession(session);
    }

    for (const [i, p] of panes.entries()) {
      const existing = db.adoptedRow(m.id, p.id);
      const wanted = i === 0 ? base : `${base}-p${paneNo(p.id)}`;
      const hit = matchDetail(cfg, m, found.home, p.cwd, { cwd: p.real_cwd, dirs: found.dirs });
      const project = hit?.id ?? UNASSIGNED;
      if (!existing || existing.project === UNASSIGNED) console.log(`adopt: ${existing ? 'rematch ' : ''}${m.id} ${p.id} cwd=${p.cwd} real=${p.real_cwd ?? '-'} home=${found.home || '-'} dir=${hit?.dir ?? '-'} -> ${project}`);
      let name = wanted;
      if (existing) {
        // Follow the tmux name, but never take a name another adopted row (e.g. a stopped pane) holds.
        name = existing.name;
        if (name !== wanted && db.renameSession(name, wanted)) {
          console.log(`adopt: renamed session ${m.id} ${p.id}: ${name} -> ${wanted} (tmux ${tmuxName})`);
          name = wanted;
        }
      } else name = freeName(db, wanted);
      // Insert, or update the row that already tracks this pane (rename, restart, stopped -> running,
      // unassigned -> a project that matches now).
      db.adoptSession({ name, machine: m.id, project, status: detectStatus(p.pane) ?? 'idle', target: p.id, tmux_session: tmuxName, tmux_orig: renamedFrom ?? (existing ? undefined : null), claude_id: p.claude_id, claude_pid: p.claude_pid, remote_control: p.remote_control });
      if (!existing) added.push(name);
    }
  }
  return added;
}
