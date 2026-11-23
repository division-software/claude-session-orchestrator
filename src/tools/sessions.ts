import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { adoptPanes, projectDirs } from '../adopt.ts';
import { findMachine, findProject, projectDir, saveProject, UserError, type Machine, type Project } from '../config.ts';
import { injectContext, logSession } from './memory.ts';
import type { SessionRow } from '../db.ts';
import { detectStatus, menuKeys, summarize, tail, type Status } from '../summarize.ts';
import * as tmux from '../tmux.ts';
import { deleteTranscript, lastTurn, readTranscript } from '../transcript.ts';
import { q, qpath, runOk } from '../transport/ssh.ts';
import { ago, tool, type Ctx } from './common.ts';

const SPOKEN: Record<Status, string> = {
  working: 'working', waiting_input: 'waiting for input', waiting_approval: 'waiting for approval',
  idle: 'idle', stopped: 'stopped',
};

/** Project of a session started outside the orchestrator: the longest known project id in its name. */
export function projectOf(ctx: Ctx, name: string): string {
  const rest = name.slice(3);
  const known = ctx.cfg.projects.map((p) => p.id).filter((id) => rest === id || rest.startsWith(`${id}-`));
  return known.sort((a, b) => b.length - a.length)[0] ?? rest.replace(/-[^-]+$/, '');
}

/** cc-<project>, or cc-<project>-2, -3… : never reuses a name the DB still tracks, so history stays per session. */
function freeName(ctx: Ctx, live: string[], pid: string): string {
  const taken = new Set([...live, ...ctx.db.sessions().map((r) => r.name)]);
  for (let i = 1; ; i++) {
    const n = i === 1 ? `cc-${pid}` : `cc-${pid}-${i}`;
    if (!taken.has(n)) return n;
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Make sure the project has its own folder on the machine: clone `repo` if it is missing,
 * or with `create` make it and `git init` it. Returns what was done, for the summary.
 */
async function ensureProjectDir(m: Machine, p: Project, create: boolean): Promise<string | undefined> {
  const dir = qpath(projectDir(m, p));
  const exists = await runOk(m, `test -d ${dir}`).then(() => true, () => false);
  if (!exists && p.repo) {
    // `--` so a repo value starting with "-" cannot be read as a git option.
    await runOk(m, `mkdir -p "$(dirname ${dir})" && git clone -q -- ${q(p.repo)} ${dir}`, 300_000)
      .catch((e) => { throw new UserError(`Could not clone ${p.repo} on ${m.id}: ${(e as Error).message.slice(0, 200)}`); });
    return `Cloned ${p.repo}.`;
  }
  if (!exists && !create) throw new UserError(`Project folder ${projectDir(m, p)} does not exist on ${m.id}. Use create=true to make it.`);
  if (!create) return undefined;
  // A folder inside some other repo still gets its own: a project must never share a repo by accident.
  const top = await runOk(m, `cd ${dir} && test "$(git rev-parse --show-toplevel 2>/dev/null)" = "$(pwd -P)"`).then(() => true, () => false);
  if (exists && top) return undefined;
  await runOk(m, `mkdir -p ${dir} && git -C ${dir} init -q${p.repo ? ` && git -C ${dir} remote add origin -- ${q(p.repo)}` : ''}`);
  return `Created ${projectDir(m, p)} with a new git repo.`;
}

/**
 * Pre-accept Claude Code's first-run prompts for a folder this orchestrator just made: "trust this folder"
 * and "allow external CLAUDE.md imports" (the brain context). Keys are per folder in ~/.claude.json.
 * shortcut: read-modify-write races a Claude Code process writing the file at the same instant; the window is
 * one jq run, and losing it only means the prompt shows once.
 */
async function trustFolder(m: Machine, dir: string): Promise<string | undefined> {
  const keys = '{hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true}';
  return runOk(m, `command -v jq >/dev/null || exit 3; umask 077; d=$(cd ${qpath(dir)} && pwd -P) && f="$HOME/.claude.json" &&
    { [ -s "$f" ] || echo '{}' > "$f"; } && jq --arg d "$d" '.projects[$d] = ((.projects[$d] // {}) + ${keys})' "$f" > "$f.cso-tmp" && mv "$f.cso-tmp" "$f"`)
    .then(() => undefined, () => `Could not pre-trust the folder (needs jq on ${m.id}); answer the first prompt with session_approve.`);
}

/** Last activity: the newest of what tmux saw and the row's last status change (hook events and scans). */
export const lastActivity = (tmuxMs: number, statusSince: number | null | undefined) => Math.max(tmuxMs || 0, statusSince ?? 0);

export interface LiveSession extends SessionRow { reachable: boolean; last_activity: number | null }

/**
 * Reconcile tmux reality with the DB: new cc-* sessions get adopted, vanished ones become stopped.
 * Claude Code panes started outside the orchestrator (any tmux session name) are only adopted when
 * `adopt` is set; panes already adopted are always checked, so they can be marked stopped.
 */
export async function refresh(ctx: Ctx, machine?: string, adopt = false): Promise<LiveSession[]> {
  const ms = machine ? [findMachine(ctx.cfg, machine)] : ctx.cfg.machines;
  const snaps = await Promise.all(ms.map(async (m) => {
    const hasAdopted = ctx.db.sessions().some((r) => r.machine === m.id && r.target && r.status !== 'stopped');
    try {
      const [live, found] = await Promise.all([tmux.snapshot(m), adopt || hasAdopted ? tmux.discover(m, projectDirs(ctx.cfg, m)) : null]);
      return { m, live, found };
    } catch { return { m, live: null, found: null }; }
  }));
  const out: LiveSession[] = [];
  for (const { m, live, found } of snaps) {
    if (live && found && adopt) {
      await adoptPanes(ctx.cfg, ctx.db, m, found, { rename: (from, to) => tmux.renameSession(m, from, to), taken: new Set(live.map((s) => s.name)) });
    }
    const mine = ctx.db.sessions().filter((r) => r.machine === m.id);
    const rows = new Map(mine.filter((r) => !r.target).map((r) => [r.name, r]));
    const adoptedNames = new Set(mine.filter((r) => r.target).map((r) => r.name));
    if (live) {
      for (const s of live) {
        if (adoptedNames.has(s.name)) continue; // an adopted session renamed to cc-<name>: tracked by its pane below, never a second row
        const owner = ctx.db.session(s.name)?.machine;
        if (owner && owner !== m.id) continue; // same name already tracked on another machine
        if (!rows.has(s.name)) {
          // Started outside the orchestrator: project is the middle of cc-<project>-<id>.
          ctx.db.upsertSession({ name: s.name, machine: m.id, project: projectOf(ctx, s.name), status: 'idle', remote_control: 0 });
        }
        const row = ctx.db.session(s.name)!;
        const seen = detectStatus(s.pane);
        // Pane regex is the fallback for missed hooks; it only overrides when it sees something definite.
        if (seen && seen !== row.status) ctx.db.setStatus(s.name, seen, row.last_message);
        { const r = ctx.db.session(s.name)!; out.push({ ...r, reachable: true, last_activity: lastActivity(s.activity, r.status_since) }); }
        rows.delete(s.name);
      }
      for (const r of rows.values()) {
        if (r.status !== 'stopped') ctx.db.setStatus(r.name, 'stopped');
      }
      // Adopted panes: alive while Claude Code still runs in the pane.
      for (const r of mine.filter((x) => x.target && x.status !== 'stopped')) {
        const p = found?.panes.find((x) => x.id === r.target);
        if (!p) { ctx.db.setStatus(r.name, 'stopped'); continue; }
        // Re-evaluated every scan from the process args and the settings on the machine.
        if (p.remote_control !== r.remote_control) ctx.db.setRemoteControl(r.name, p.remote_control);
        const seen = detectStatus(p.pane);
        if (seen && seen !== r.status) ctx.db.setStatus(r.name, seen, r.last_message);
        // No hooks reach adopted sessions: a turn that no longer shows "esc to interrupt" has ended.
        else if (!seen && (r.status === 'working' || r.status === 'waiting_approval') && Date.now() - r.status_since > 5000) ctx.db.setStatus(r.name, 'idle');
        { const cur = ctx.db.session(r.name)!; out.push({ ...cur, reachable: true, last_activity: lastActivity(p.activity, cur.status_since) }); }
      }
    } else {
      for (const r of mine) if (r.status !== 'stopped') out.push({ ...r, reachable: false, last_activity: null });
    }
  }
  return out;
}

/** A session by full name, tmux session name (adopted ones), or project id/alias with exactly one live session. */
function lookup(ctx: Ctx, name: string): SessionRow | undefined {
  const n = name.trim().toLowerCase();
  const row = ctx.db.session(n) ?? ctx.db.session(`cc-${n}`);
  if (row) return row;
  const live = ctx.db.sessions().filter((r) => r.status !== 'stopped');
  let cands = live.filter((r) => r.tmux_session?.toLowerCase() === n);
  if (!cands.length) {
    let pid: string | undefined;
    try { pid = findProject(ctx.cfg, n).id; } catch { /* not a project name */ }
    cands = live.filter((r) => r.project === pid || r.project === n);
  }
  if (cands.length > 1) throw new UserError(`"${name}" matches ${cands.length} sessions: ${cands.map((c) => c.name).join(', ')}. Say which one.`);
  return cands[0];
}

/**
 * Accept a full session name, a tmux session name or a project id/alias that has exactly one live session.
 * A name we do not know triggers a scan for Claude Code sessions started outside the orchestrator.
 */
export async function resolve(ctx: Ctx, name: string): Promise<SessionRow & { m: ReturnType<typeof findMachine> }> {
  let row = lookup(ctx, name);
  if (!row) {
    await refresh(ctx, undefined, true);
    row = lookup(ctx, name);
  } else if (row.target && row.status !== 'stopped') {
    // Adopted pane: Claude Code may have exited to a shell since the last look. Never type into that.
    await refresh(ctx, row.machine);
    row = ctx.db.session(row.name)!;
  }
  if (!row || row.status === 'stopped') throw new UserError(`No running session called "${name}".`);
  return { ...row, m: findMachine(ctx.cfg, row.machine) };
}

/** Like resolve(), but also finds stopped sessions (for deletion). */
function findAny(ctx: Ctx, name: string): SessionRow {
  const n = name.trim().toLowerCase();
  const row = ctx.db.session(n) ?? ctx.db.session(`cc-${n}`);
  if (row) return row;
  let pid: string | undefined;
  try { pid = findProject(ctx.cfg, n).id; } catch { /* not a project name */ }
  const cands = ctx.db.sessions().filter((r) => r.project === pid || r.project === n);
  if (cands.length > 1) throw new UserError(`"${name}" matches ${cands.length} sessions: ${cands.map((c) => c.name).join(', ')}. Say which one.`);
  if (!cands.length) throw new UserError(`No session called "${name}".`);
  return cands[0];
}

/** Best effort "what happened in this session" entry in the brain's projects/<p>/log.md. */
export async function writeLog(ctx: Ctx, s: SessionRow, m: Machine, note?: string) {
  try {
    let text = note ?? '';
    const tr = await readTranscript(m, s.transcript, s.claude_id).catch(() => null);
    const raw = tr ? null : await tmux.capture(m, s, 400).catch(() => null);
    if (tr) {
      const t = lastTurn(tr);
      const reply = t.reply.length > 600 ? `${t.reply.slice(0, 600)}…` : t.reply;
      text = [note, t.prompt && `Last ask: ${t.prompt.slice(0, 200)}`, reply && `Last reply: ${reply}`,
        t.files.length && `Files changed: ${t.files.join(', ')}`].filter(Boolean).join('\n');
    } else if (raw) {
      const sum = summarize(raw);
      text = [note, sum.last_action && `Last action: ${sum.last_action}`, `${sum.changed_files_count} files changed`,
        sum.last_error && `Last error: ${sum.last_error}`].filter(Boolean).join('. ') + '.';
    }
    await logSession(ctx, s.project, s.name, `Machine: ${m.id}.${s.claude_id ? ` Claude session: ${s.claude_id}.` : ''}\n${text || 'Session ended.'}`);
  } catch (e) {
    console.error(`session log for ${s.name} failed:`, (e as Error).message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DONE: Status[] = ['idle', 'waiting_input', 'waiting_approval', 'stopped'];
const WAIT = (dflt: number) => z.number().int().min(0).max(100).default(dflt)
  .describe('Seconds to wait for the session to finish its turn and return its reply (0 = return at once; max 100)');

/**
 * Wait until the session's turn ends: a hook reports idle/waiting after `since`, or (without hooks)
 * the pane shows a permission prompt, or stops showing "esc to interrupt" for two polls in a row.
 */
async function waitTurn(ctx: Ctx, name: string, m: Machine, since: number, seconds: number): Promise<boolean> {
  const end = Date.now() + seconds * 1000;
  let quiet = 0;
  while (Date.now() < end) {
    await sleep(2000);
    const row = ctx.db.session(name);
    if (row && DONE.includes(row.status) && row.status_since > since) return true;
    const pane = await tmux.capture(m, row ?? name, 30).catch(() => null);
    if (pane === null) return true; // session is gone
    const seen = detectStatus(pane);
    if (seen === 'waiting_approval') { ctx.db.setStatus(name, 'waiting_approval'); return true; }
    quiet = seen === 'working' ? 0 : quiet + 1;
    if (quiet >= 2 && Date.now() - since > 4000) {
      if (row?.target && row.status === 'working') ctx.db.setStatus(name, 'idle'); // adopted: no Stop hook
      return true;
    }
  }
  return false;
}

/** The session's latest turn: exact reply from the transcript, else a pane summary. */
async function report(ctx: Ctx, name: string, m: Machine, done = true) {
  const row = ctx.db.session(name)!;
  const label = `${row.project} on ${m.id}`;
  const status = SPOKEN[row.status];
  const raw = await readTranscript(m, row.transcript, row.claude_id).catch(() => null);
  if (raw) {
    const t = lastTurn(raw);
    const first = t.reply.split(/(?<=[.!?])\s/)[0]?.slice(0, 220) ?? '';
    const changed = t.files.length ? ` ${t.files.length} file${t.files.length === 1 ? '' : 's'} changed.` : '';
    const head = !done ? `${label} is still working.` : row.status === 'waiting_approval' ? `${label} is waiting for your approval.` : `${label} replied:`;
    return {
      summary: `${head}${first ? ` ${first}` : ''}${changed}${!done ? ' Call session_wait to keep waiting.' : ''}`,
      status: row.status, done, reply: t.reply || null, prompt: t.prompt, actions: t.actions, files_changed: t.files,
      ...(row.status === 'waiting_approval' && { waiting_for: summarize(await tmux.capture(m, row, 30).catch(() => '')).waiting_for }),
    };
  }
  const sum = summarize(await tmux.capture(m, row, 200).catch(() => ''));
  const parts = [sum.waiting_for && `Waiting: ${sum.waiting_for}`, sum.last_action && `Last: ${sum.last_action}`,
    sum.last_error && `Error: ${sum.last_error}`].filter(Boolean);
  return { summary: `${label} is ${status}.${parts.length ? ` ${parts.join('. ')}.` : ''}${!done ? ' Call session_wait to keep waiting.' : ''}`, status: row.status, done, ...sum };
}

async function sendAndWait(ctx: Ctx, s: SessionRow & { m: Machine }, wait: number, sent: number) {
  if (!wait) return null;
  const done = await waitTurn(ctx, s.name, s.m, sent, wait);
  return report(ctx, s.name, s.m, done);
}

export function line(s: LiveSession) {
  const where = s.reachable ? '' : ' (machine unreachable, last known)';
  const label = s.project === 'unassigned' && s.tmux_session ? `unassigned (tmux ${s.tmux_session})` : s.project;
  return `${label} on ${s.machine}: ${SPOKEN[s.status]} since ${ago(s.status_since)}${where}.`;
}

export function register(server: McpServer, ctx: Ctx) {
  tool(server, ctx, 'session_list', 'List Claude Code sessions with project, machine, status, last activity and Remote Control flag. Also adopts Claude Code sessions running in tmux that were started outside the orchestrator (project "unassigned" if no project folder matches).',
    { machine: z.string().optional() },
    async ({ machine }) => {
      const ss = await refresh(ctx, machine, true);
      return {
        summary: ss.length ? `${ss.length} sessions. ${ss.map(line).join(' ')}` : 'No sessions running.',
        sessions: ss.map((s) => ({
          name: s.name, project: s.project, machine: s.machine, status: s.status,
          last_activity: s.last_activity && new Date(s.last_activity).toISOString(),
          remote_control: s.remote_control < 0 ? null : !!s.remote_control, machine_reachable: s.reachable,
          adopted: !!s.target, ...(s.tmux_session && { tmux_session: s.tmux_session }),
        })),
      };
    });

  tool(server, ctx, 'session_start', 'Start a new Claude Code session in tmux for a project, always in the project\'s own folder (Remote Control on by default so it shows in the Claude app). The session is named after the project. Machine defaults to the project\'s machine. For a new project pass create=true: it gets its own folder and git repo (or a clone of repo), is registered, and the folder is pre-trusted in Claude Code so no trust prompt blocks the session.',
    {
      project: z.string().describe('Project id or spoken alias; with create=true, the new project\'s name'),
      create: z.boolean().default(false).describe('New project: create its folder and git repo and register it'),
      repo: z.string().optional().describe('With create=true: git URL to clone (or to set as origin)'),
      machine: z.string().optional(),
      prompt: z.string().optional().describe('First message for the session'),
      remote_control: z.boolean().default(true),
      name: z.string().optional().describe('Custom short name; becomes cc-<name>'),
      wait: WAIT(45),
    },
    async ({ project, create, repo, machine, prompt, remote_control, name, wait }) => {
      let p: Project | undefined;
      try { p = findProject(ctx.cfg, project); } catch (e) { if (!create) throw e; }
      if (p && repo && p.repo !== repo) throw new UserError(`${p.id} already exists${p.repo ? ` with repo ${p.repo}` : ''}; edit projects.yaml to change it.`);
      const mid = machine ?? p?.machine ?? (ctx.cfg.machines.find((x) => x.local) ?? ctx.cfg.machines[0])?.id;
      if (!mid) throw new UserError('No machines configured.');
      const m = findMachine(ctx.cfg, mid);
      const live = (await tmux.snapshot(m)).map((s) => s.name); // also fails fast when the machine is unreachable
      const isNew = !p;
      if (!p) {
        const id = slug(project);
        if (!id) throw new UserError(`"${project}" is not a usable project name.`);
        // Saved only after the folder exists: a failed setup must not leave a registered project behind.
        p = { id, aliases: id === project.toLowerCase() ? [] : [project], machine: m.id, shared: [], ...(repo && { repo }) };
      }
      const setup = await ensureProjectDir(m, p, create);
      // Only folders made here are trusted automatically; an existing folder keeps Claude Code's own prompt.
      const trustWarning = setup ? await trustFolder(m, projectDir(m, p)) : undefined;
      if (isNew) p = saveProject(ctx.cfg, p);
      const sname = name ? `cc-${slug(name)}` : freeName(ctx, live, p.id);
      if (!tmux.SESSION_RE.test(sname)) throw new UserError(`"${name}" is not a usable session name.`);
      if (live.includes(sname)) throw new UserError(`${sname} already exists on ${m.id}.`);
      const dir = projectDir(m, p);
      // Spec §5: refresh context.md and the CLAUDE.md import first. A brain problem must not block the session.
      let warning: string | undefined;
      await injectContext(ctx, m, p.id).catch((e) => { warning = `Shared context not updated: ${(e as Error).message}`; });
      // --remote-control takes an optional name, so always pass one or the prompt would be eaten as the name.
      // Our own session id makes the transcript findable: ~/.claude/projects/*/<id>.jsonl.
      const claudeId = randomUUID();
      // The project name (cc- dropped) labels it in the Claude app and in /resume.
      const label = q(sname.slice(3));
      const cmd = `${m.claude_cmd} --name ${label}${remote_control ? ` --remote-control ${label}` : ''} --session-id ${claudeId}${prompt ? ` ${q(prompt)}` : ''}`;
      const started = Date.now();
      await tmux.newSession(m, sname, dir, cmd);
      ctx.db.upsertSession({ name: sname, machine: m.id, project: p.id, status: prompt ? 'working' : 'waiting_input', remote_control: remote_control ? 1 : 0 });
      ctx.db.setTranscript(sname, claudeId, null);
      const base = `${setup ? `${setup}${trustWarning ? ` ${trustWarning}` : ' Trusted it in Claude Code.'} ` : ''}Started ${p.id} on ${m.id} as ${sname}${remote_control ? '; it shows in the Claude app' : ''}.${warning ? ` ${warning}` : ''}`;
      const turn = prompt ? await sendAndWait(ctx, { ...ctx.db.session(sname)!, m }, wait, started) : null;
      return turn ? { ...turn, summary: `${base} ${turn.summary}`, session: sname } : { summary: base, session: sname };
    });

  tool(server, ctx, 'session_read', 'Read a session. reply (default): its latest reply text, the tools it used and files it changed, from Claude Code\'s transcript. summary: a short status from the terminal. tail: the cleaned terminal text.',
    {
      session: z.string(),
      mode: z.enum(['reply', 'summary', 'tail']).default('reply'),
      lines: z.number().int().min(1).max(500).default(60),
    },
    async ({ session, mode, lines }) => {
      const s = await resolve(ctx, session);
      if (mode === 'reply') return report(ctx, s.name, s.m, ctx.db.session(s.name)!.status !== 'working');
      const raw = await tmux.capture(s.m, s, Math.max(lines, 200));
      if (mode === 'tail') return { summary: `Last ${lines} lines of ${s.name}.`, text: tail(raw, lines) };
      const sum = summarize(raw);
      const parts = [
        sum.waiting_for && `Waiting: ${sum.waiting_for}`,
        sum.last_action && `Last action: ${sum.last_action}`,
        sum.last_error && `Last error: ${sum.last_error}`,
        `${sum.changed_files_count} files changed`,
      ].filter(Boolean);
      return { summary: `${s.project} on ${s.machine}: ${parts.join('. ')}.`, status: s.status, ...sum };
    });

  tool(server, ctx, 'session_send', 'Send a message to a session (typed, then Enter) and, by default, wait for its reply.',
    { session: z.string(), message: z.string().min(1), wait: WAIT(45) },
    async ({ session, message, wait }) => {
      const s = await resolve(ctx, session);
      const sent = Date.now();
      await tmux.sendText(s.m, s, message);
      ctx.db.setStatus(s.name, 'working');
      return (await sendAndWait(ctx, s, wait, sent)) ?? { summary: `Sent to ${s.project}.` };
    });

  tool(server, ctx, 'session_wait', 'Wait for a working session to finish its turn (or ask for something), then return its reply.',
    { session: z.string(), seconds: WAIT(60) },
    async ({ session, seconds }) => {
      const s = await resolve(ctx, session);
      const done = s.status !== 'working' || await waitTurn(ctx, s.name, s.m, s.status_since, seconds);
      return report(ctx, s.name, s.m, done);
    });

  tool(server, ctx, 'session_approve', 'Answer a pending permission prompt: yes, always (don\'t ask again), or no.',
    { session: z.string(), choice: z.enum(['yes', 'no', 'always']), wait: WAIT(30) },
    async ({ session, choice, wait }) => {
      const s = await resolve(ctx, session);
      const pane = await tmux.capture(s.m, s, 30);
      if (s.status !== 'waiting_approval' && detectStatus(pane) !== 'waiting_approval') {
        throw new UserError(`${s.project} is not waiting for approval; it is ${SPOKEN[s.status]}.`);
      }
      // Read the menu on screen; if none is visible, fall back to the tool-permission layout.
      const keys = menuKeys(pane, choice) ?? [{ yes: '1', always: '2', no: 'Escape' }[choice]];
      const sent = Date.now();
      await tmux.sendKeys(s.m, s, ...keys);
      ctx.db.setStatus(s.name, choice === 'no' ? 'waiting_input' : 'working');
      const turn = choice === 'no' ? null : await sendAndWait(ctx, s, wait, sent);
      return turn ? { ...turn, summary: `Answered ${choice}. ${turn.summary}` } : { summary: `Answered ${choice} for ${s.project}.` };
    });

  tool(server, ctx, 'session_interrupt', 'Press Esc in a session: stops the current work, keeps the session open.',
    { session: z.string() },
    async ({ session }) => {
      const s = await resolve(ctx, session);
      await tmux.sendKeys(s.m, s, 'Escape');
      ctx.db.setStatus(s.name, 'waiting_input');
      return { summary: `Interrupted ${s.project}.` };
    });

  tool(server, ctx, 'session_stop', 'Stop a session. graceful sends /exit; kill closes the tmux session and needs confirm=true.',
    { session: z.string(), mode: z.enum(['graceful', 'kill']).default('graceful'), confirm: z.boolean().optional() },
    async ({ session, mode, confirm }) => {
      const s = await resolve(ctx, session);
      if (mode === 'kill' && confirm !== true) throw new UserError(`Killing ${s.name} needs confirm=true. Ask the user first.`);
      await writeLog(ctx, s, s.m); // while the pane still exists
      // Mark stopped first so the SessionEnd hook that /exit triggers does not log a second time.
      ctx.db.setStatus(s.name, 'stopped');
      if (mode === 'kill') await tmux.kill(s.m, s);
      else await tmux.sendText(s.m, s, '/exit');
      return { summary: `${mode === 'kill' ? 'Killed' : 'Stopped'} ${s.project} on ${s.machine}.` };
    });

  tool(server, ctx, 'session_delete', 'Delete a session for cleanup: stop it if running, then remove it from the orchestrator. delete_transcript also deletes its Claude Code conversation history (cannot be undone). all_stopped clears every stopped session record. Needs confirm=true.',
    {
      session: z.string().optional().describe('Session name, or a project with exactly one session'),
      all_stopped: z.boolean().optional().describe('Delete every stopped session record instead of one session'),
      delete_transcript: z.boolean().default(false),
      confirm: z.boolean().optional(),
    },
    async ({ session, all_stopped, delete_transcript, confirm }) => {
      if (!session === !all_stopped) throw new UserError('Give either a session or all_stopped=true.');
      const rows = all_stopped
        ? ctx.db.sessions().filter((r) => r.status === 'stopped')
        : [findAny(ctx, session!)];
      if (!rows.length) return { summary: 'No stopped sessions to delete.' };
      if (confirm !== true) {
        throw new UserError(`Deleting ${rows.length === 1 ? rows[0].name : `${rows.length} sessions`}${delete_transcript ? ' and their conversation history' : ''} needs confirm=true. Ask the user first.`);
      }
      let killed = 0, transcripts = 0;
      for (const r of rows) {
        const m = ctx.cfg.machines.find((x) => x.id === r.machine);
        if (m) {
          // An adopted session that already stopped leaves the user's shell in that pane: never close it.
          const live = !(r.target && r.status === 'stopped') && await tmux.capture(m, r, 1).then(() => true, () => false);
          if (live) {
            await writeLog(ctx, r, m);
            ctx.db.setStatus(r.name, 'stopped'); // so the SessionEnd hook does not log twice
            await tmux.kill(m, r);
            killed++;
          }
          if (delete_transcript && await deleteTranscript(m, r.transcript, r.claude_id).catch(() => false)) transcripts++;
        }
        ctx.db.deleteSession(r.name);
      }
      const what = rows.length === 1 ? rows[0].name : `${rows.length} sessions`;
      return {
        summary: `Deleted ${what}.${killed ? ` Stopped ${killed} running.` : ''}${delete_transcript ? ` Removed ${transcripts} transcript${transcripts === 1 ? '' : 's'}.` : ''}`,
        deleted: rows.map((r) => r.name),
      };
    });

  tool(server, ctx, 'project_sessions', 'Every session a project has had (running and ended), newest first, with machine, start time and Claude Code session id. Ended sessions\' notes are in the brain at projects/<project>/log.md and reach new sessions through their context.',
    { project: z.string() },
    async ({ project }) => {
      const p = findProject(ctx.cfg, project);
      await refresh(ctx).catch(() => {});
      const rows = ctx.db.projectSessions(p.id);
      const running = rows.filter((r) => r.status !== 'stopped').length;
      return {
        summary: rows.length ? `${p.id} has had ${rows.length} session${rows.length === 1 ? '' : 's'}, ${running} running. Latest: ${rows[0].name} on ${rows[0].machine}, ${SPOKEN[rows[0].status]}.` : `${p.id} has no sessions yet.`,
        sessions: rows.map((r) => ({
          name: r.name, machine: r.machine, status: r.status, claude_session_id: r.claude_id,
          started: r.created && new Date(r.created).toISOString(), last_message: r.last_message,
        })),
      };
    });

  tool(server, ctx, 'overview', 'One-call status of every project: one line per session plus what is waiting on the user, and every configured project with its machine and number of running sessions. Use for "how are my projects doing?".', {},
    async () => {
      const ss = await refresh(ctx);
      const waiting = ss.filter((s) => s.status === 'waiting_approval' || s.status === 'waiting_input');
      const counts = Object.entries(Object.groupBy(ss, (s) => s.status)).map(([k, v]) => `${v!.length} ${SPOKEN[k as Status]}`);
      const running = (id: string) => ss.filter((s) => s.project === id && s.status !== 'stopped').length;
      return {
        summary: `${ctx.cfg.projects.length} projects configured. ` + (ss.length ? `${ss.length} sessions: ${counts.join(', ')}.` : 'No sessions running.'),
        lines: ss.map(line),
        pending: waiting.map((s) => ({ session: s.name, project: s.project, status: s.status, since: ago(s.status_since), message: s.last_message })),
        projects: ctx.cfg.projects.map((p) => ({ id: p.id, aliases: p.aliases, machine: p.machine, running_sessions: running(p.id) })),
      };
    });
}
