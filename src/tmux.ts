import { randomBytes } from 'node:crypto';
import type { Machine } from './config.ts';
import { q, qpath, run, runOk, unreachable } from './transport/ssh.ts';

export const SESSION_RE = /^cc-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface TmuxSession { name: string; activity: number; pane: string }

// Exact-match targets: a bare `-t name` falls back to prefix matching, so a stale `cc-foo`
// would silently hit a live `cc-foo-ab12`. Session commands take `=name`, pane commands `=name:`.
const sess = (name: string) => q(`=${name}`);

/**
 * What to point tmux at. A session name (exact match), or a row: adopted sessions carry the
 * pane id (%N) of the pane running Claude Code, which can sit in any tmux session or window.
 */
export type Ref = string | { name: string; target?: string | null };
export const PANE_RE = /^%\d+$/;
const pane = (r: Ref) => q(typeof r === 'string' ? `=${r}:` : r.target && PANE_RE.test(r.target) ? r.target : `=${r.name}:`);

/** Every cc-* session on a machine with its last 30 pane lines, in one round trip. */
export async function snapshot(m: Machine): Promise<TmuxSession[]> {
  // Fresh random marker per call, so text shown in a pane cannot forge another session's record.
  const mark = `@@cc-${randomBytes(12).toString('hex')}@@`;
  const r = await run(m, `{ tmux list-sessions -F '#{session_name} #{session_activity}'; tmux list-windows -a -F '#{session_name} #{window_activity}'; } 2>/dev/null |
    awk '($2 + 0) > (m[$1] + 0) { m[$1] = $2 } END { for (s in m) print s, m[s] }' | sort | grep '^cc-' |
    while read -r s a; do echo "${mark} $s $a"; tmux capture-pane -p -J -t "=$s:" -S -30; done; true`);
  if (r.code === 255) throw unreachable(m);
  const seen = new Set<string>();
  return r.stdout.split(`${mark} `).slice(1).map((chunk) => {
    const nl = chunk.indexOf('\n');
    const [name, act] = chunk.slice(0, nl === -1 ? undefined : nl).trim().split(' ');
    return { name, activity: Number(act) * 1000, pane: nl === -1 ? '' : chunk.slice(nl + 1) };
  }).filter((s) => SESSION_RE.test(s.name) && !seen.has(s.name) && !!seen.add(s.name));
}

/**
 * Uses the machine's own tmux: the default server and socket, same as by hand. A running server just
 * gets the new session. If none runs, tmux starts one that daemonizes inside the cgroup of whoever
 * launched it, so from the orchestrator service it would die with every service restart. Start it in
 * its own transient systemd scope instead (plain tmux where systemd-run is unavailable).
 */
export const newSessionCmd = (name: string, dir: string, cmd: string) => {
  const nw = `tmux new-session -d -s ${q(name)} -c ${qpath(dir)} ${q(cmd)}`;
  return `if tmux list-sessions >/dev/null 2>&1; then ${nw}; else systemd-run --user --scope --quiet ${nw} 2>/dev/null || ${nw}; fi`;
};

/** Rename a tmux session: 'exists' when another session already has that name. */
export async function renameSession(m: Machine, from: string, to: string): Promise<'ok' | 'exists' | 'failed'> {
  const r = await run(m, `tmux rename-session -t ${sess(from)} ${q(to)}`);
  if (r.code === 0) return 'ok';
  return /duplicate session/.test(r.stderr) ? 'exists' : 'failed';
}

export const newSession = (m: Machine, name: string, dir: string, cmd: string) => runOk(m, newSessionCmd(name, dir, cmd));

/** Type literal text, then press Enter (separate call so text is never parsed as key names). */
export async function sendText(m: Machine, ref: Ref, text: string) {
  await runOk(m, `tmux send-keys -t ${pane(ref)} -l ${q(text)} && sleep 0.2 && tmux send-keys -t ${pane(ref)} Enter`);
}

export const sendKeys = (m: Machine, ref: Ref, ...keys: string[]) =>
  runOk(m, `tmux send-keys -t ${pane(ref)} ${keys.map(q).join(' ')}`);

export const capture = (m: Machine, ref: Ref, lines: number) =>
  runOk(m, `tmux capture-pane -p -J -t ${pane(ref)} -S -${Math.max(1, Math.floor(lines))}`);

/** Native sessions: close the tmux session. Adopted ones: close only the pane (the session is the user's). */
export const kill = (m: Machine, ref: Ref) =>
  typeof ref !== 'string' && ref.target && PANE_RE.test(ref.target)
    ? runOk(m, `tmux kill-pane -t ${q(ref.target)}`)
    : runOk(m, `tmux kill-session -t ${sess(typeof ref === 'string' ? ref : ref.name)}`);

// ---- Discovery of Claude Code panes the orchestrator did not start ----

export interface ClaudePane {
  id: string;               // tmux pane id, e.g. %12
  session: string;          // tmux session name
  cwd: string;
  activity: number;         // ms, newest of the tmux session's activity and the pane's window activity
  pane: string;             // last 30 lines
  claude_pid: number;       // the Claude Code process; changes when it restarts in the same pane
  claude_id: string | null; // from --session-id / --resume in the process args, if given
  remote_control: number;   // 1 on, 0 off, -1 unknown: see resolveRemoteControl
  real_cwd?: string;        // realpath of cwd on the machine, when it could be resolved
}
/** `remoteControlAtStartup` as read on the machine; undefined = not set (or not a boolean) there. */
export interface RcSettings { user?: boolean; project?: boolean; managed?: boolean }

export interface Discovery {
  home: string;
  panes: ClaudePane[];
  dirs: Map<string, string>; // configured project folder (as written) -> its realpath on the machine
}

const INTERPRETERS = new Set(['node', 'bun', 'sh', 'bash', 'zsh', 'env']);
const base = (t?: string) => t?.split('/').pop() ?? '';
const REMOTE_CONTROL = /(?:^|\s)--(?:remote-control|rc)(?:[\s=]|$)/;

/**
 * Is Remote Control on for a Claude Code process? Claude Code 2.1.330: `remoteControlAtStartup` (boolean)
 * starts it every session; repo-scoped settings (project, local) cannot enable it, only turn it off;
 * managed policy can lock it; --remote-control / --rc turns it on and no flag turns it off.
 * Precedence: managed > flag > project (off only) > user. -1 when nothing says (an org default we
 * cannot read may still apply).
 */
export function resolveRemoteControl(args: string, set: RcSettings = {}): number {
  if (set.managed !== undefined) return set.managed ? 1 : 0;
  if (REMOTE_CONTROL.test(args)) return 1;
  if (set.project === false) return 0;
  if (set.user !== undefined) return set.user ? 1 : 0;
  return -1;
}
const CLAUDE_ID = /--(?:session-id|resume)[ =]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

/** Executable names that mean "Claude Code" on a machine: `claude` plus whatever its claude_cmd runs. */
export const claudeNames = (m: Machine) => ['claude', base(m.claude_cmd.trim().split(/\s+/)[0])];

/** Does this process command line look like an interactive Claude Code? (`claude -p` one-shots do not count.) */
export function isClaudeArgs(args: string, names: string[]): boolean {
  if (/(^|\s)(-p|--print)(\s|$)/.test(args)) return false;
  const [a, b] = args.trim().split(/\s+/);
  if (names.includes(base(a))) return true;
  if (INTERPRETERS.has(base(a)) && names.includes(base(b))) return true;
  return /@anthropic-ai\/claude-code\/(cli|bin\/)/.test(args);
}

/** Pure part of discover(): the panes whose process tree contains Claude Code. */
export function parseDiscovery(out: string, mark: string, names: string[]): Discovery {
  let home = '', ps = '', panes = '';
  const caps = new Map<string, string>(), realCwd = new Map<string, string>(), dirs = new Map<string, string>();
  const rcSet = new Map<string, RcSettings>();
  const tri = (v?: string) => (v === 'true' ? true : v === 'false' ? false : undefined);
  const pairs = (body: string, into: Map<string, string>) => {
    for (const l of body.split('\n')) { const [k, v] = l.split('\t'); if (k && v) into.set(k, v); }
  };
  for (const chunk of out.split(`${mark} `).slice(1)) {
    const nl = chunk.indexOf('\n');
    const head = (nl === -1 ? chunk : chunk.slice(0, nl)).trim();
    const body = nl === -1 ? '' : chunk.slice(nl + 1);
    if (head.startsWith('home ')) home = head.slice(5);
    else if (head === 'ps') ps = body;
    else if (head === 'panes') panes = body;
    else if (head.startsWith('cap ')) caps.set(head.slice(4), body);
    else if (head === 'real') pairs(body, realCwd);
    else if (head === 'dirs') pairs(body, dirs);
    else if (head === 'rc') {
      for (const l of body.split('\n')) {
        const [id, user, project, managed] = l.split('\t');
        if (id) rcSet.set(id, { user: tri(user), project: tri(project), managed: tri(managed) });
      }
    }
  }
  const kids = new Map<number, number[]>(), args = new Map<number, string>();
  for (const l of ps.split('\n')) {
    const m = l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    args.set(Number(m[1]), m[3]);
    kids.set(Number(m[2]), [...(kids.get(Number(m[2])) ?? []), Number(m[1])]);
  }
  const claudeIn = (root: number): { pid: number; args: string } | null => {
    const seen = new Set<number>(), stack = [root];
    while (stack.length) {
      const p = stack.pop()!;
      if (seen.has(p)) continue;
      seen.add(p);
      const a = args.get(p);
      if (a && isClaudeArgs(a, names)) return { pid: p, args: a };
      stack.push(...(kids.get(p) ?? []));
    }
    return null;
  };
  const found: ClaudePane[] = [];
  const seenIds = new Set<string>();
  for (const l of panes.split('\n')) {
    const [id, pid, act, wact, session, ...cwd] = l.split('\t');
    if (!PANE_RE.test(id ?? '') || seenIds.has(id) || !session) continue;
    seenIds.add(id);
    const hit = claudeIn(Number(pid));
    if (hit === null) continue;
    const a = hit.args;
    found.push({
      id, session, cwd: cwd.join('\t'), activity: Math.max(Number(act) || 0, Number(wact) || 0) * 1000, pane: caps.get(id) ?? '',
      claude_pid: hit.pid, claude_id: a.match(CLAUDE_ID)?.[1] ?? null, remote_control: resolveRemoteControl(a, rcSet.get(id)),
      ...(realCwd.has(id) && { real_cwd: realCwd.get(id) }),
    });
  }
  return { home, panes: found, dirs };
}

/** Shell function: prints the value of remoteControlAtStartup in a settings file (never anything else from it). */
export const RCVAL_SH = `rcval() { [ -r "$1" ] && grep -o '"remoteControlAtStartup"[[:space:]]*:[[:space:]]*[a-z]*' "$1" 2>/dev/null | head -1 | sed 's/.*:[[:space:]]*//'; }`;

/**
 * Every pane on a machine that runs Claude Code, in one round trip (panes, process table, pane text).
 * `dirs` are configured project folders (may start with ~); the machine resolves them with realpath.
 */
export async function discover(m: Machine, dirs: string[] = []): Promise<Discovery> {
  const mark = `@@cc-${randomBytes(12).toString('hex')}@@`; // random per call: pane text cannot forge records
  // $HOME can be unset in a service environment; fall back to the account's home directory.
  const dirLines = dirs.map((d) => `d=${q(d)}; case "$d" in "~") d=$H;; "~/"*) d="$H/\${d#"$t"}";; esac; printf '%s\\t%s\\n' ${q(d)} "$(realpath -e -- "$d" 2>/dev/null)"`).join('\n');
  const r = await run(m, `${RCVAL_SH}
    t='~/'; H=\${HOME:-$(cd ~ 2>/dev/null && pwd -P)}
    echo "${mark} home $H"; echo "${mark} ps"; ps -A -ww -o pid=,ppid=,args= 2>/dev/null
    echo "${mark} panes"
    tmux list-panes -a -F '#{pane_id}\t#{pane_pid}\t#{session_activity}\t#{window_activity}\t#{session_name}\t#{pane_current_path}' 2>/dev/null
    echo "${mark} real"
    tmux list-panes -a -F '#{pane_id}\t#{pane_current_path}' 2>/dev/null | while IFS="$(printf '\\t')" read -r p c; do printf '%s\\t%s\\n' "$p" "$(realpath -e -- "$c" 2>/dev/null)"; done
    echo "${mark} dirs"
    ${dirLines}
    echo "${mark} rc"
    tmux list-panes -a -F '#{pane_id}\t#{pane_current_path}' 2>/dev/null | while IFS="$(printf '\\t')" read -r p c; do
      pj=; for f in "$c/.claude/settings.local.json" "$c/.claude/settings.json"; do v=$(rcval "$f"); [ "$v" = false ] && pj=false; [ -z "$pj" ] && pj=$v; done
      printf '%s\\t%s\\t%s\\t%s\\n' "$p" "$(rcval "$H/.claude/settings.json")" "$pj" "$(rcval /etc/claude-code/managed-settings.json)"
    done
    tmux list-panes -a -F '#{pane_id}' 2>/dev/null | while read -r p; do echo "${mark} cap $p"; tmux capture-pane -p -J -t "$p" -S -30; done; true`, 8000);
  if (r.code === 255) throw unreachable(m);
  return parseDiscovery(r.stdout, mark, claudeNames(m));
}
