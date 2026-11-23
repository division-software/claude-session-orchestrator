import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { q, qpath } from '../src/transport/ssh.ts';
import { clean, detectStatus, menuKeys, summarize, tail } from '../src/summarize.ts';
import { statusFor } from '../src/tools/events.ts';
import { parseKv } from '../src/tools/machines.ts';
import { findProject, loadConfig, type Config, type Machine } from '../src/config.ts';
import { lastActivity } from '../src/tools/sessions.ts';
import { adoptedName, adoptPanes, matchProject, projectDirs, type AdoptIo } from '../src/adopt.ts';
import { Db } from '../src/db.ts';
import { DatabaseSync } from 'node:sqlite';
import { isClaudeArgs, newSessionCmd, parseDiscovery, RCVAL_SH, resolveRemoteControl } from '../src/tmux.ts';

test('q() survives quotes and shell metacharacters', () => {
  const nasty = `it's "x" $(rm -rf /) \`id\` ; | &`;
  assert.equal(execFileSync('sh', ['-c', `printf %s ${q(nasty)}`]).toString(), nasty);
  assert.equal(execFileSync('sh', ['-c', `printf %s ${qpath("~/a b'c")}`]).toString(), `${process.env.HOME}/a b'c`);
});

const PANE = `\x1b[32m⏺ Update(src/app.ts)\x1b[0m
  12 + const a = 1;
⏺ Write(src/new.ts)
⏺ Bash(npm test)
  Error: 2 tests failed
╭──────────────╮
│ Bash command  │
Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again
  3. No`;

test('summarize/detectStatus read a permission prompt', () => {
  assert.equal(detectStatus(PANE), 'waiting_approval');
  assert.equal(detectStatus('✻ Thinking… (esc to interrupt)'), 'working');
  assert.equal(detectStatus('> '), undefined);
  const s = summarize(PANE);
  assert.equal(s.changed_files_count, 2);
  assert.equal(s.last_action, 'Bash(npm test)');
  assert.match(s.last_error!, /2 tests failed/);
  assert.match(s.waiting_for!, /Do you want to proceed/);
  assert.ok(!clean(PANE).some((l) => l.includes('\x1b')));
});

// Captured from Claude Code 2.1.319 on the first start with a brain import.
const IMPORT_DIALOG = `  Allow external CLAUDE.md file imports?
  This project's CLAUDE.md or .claude/rules imports files outside the current
  working directory. Never allow this for third-party repositories.
  External imports:
    /home/user/brain/projects/orchestrator/context.md
  Important: Only use Claude Code with files you trust. Accessing untrusted
  files may pose security risks https://code.claude.com/docs/en/security
  ❯ No, disable external imports
    Yes, allow external imports
  Enter to confirm · Esc to cancel`;

test('menuKeys picks the right option in numbered and unnumbered menus', () => {
  assert.equal(detectStatus(IMPORT_DIALOG), 'waiting_approval');
  assert.deepEqual(menuKeys(IMPORT_DIALOG, 'yes'), ['Down', 'Enter']);
  assert.deepEqual(menuKeys(IMPORT_DIALOG, 'always'), ['Down', 'Enter']);
  assert.deepEqual(menuKeys(IMPORT_DIALOG, 'no'), ['Enter']);
  assert.deepEqual(menuKeys(PANE, 'yes'), ['1']);
  assert.deepEqual(menuKeys(PANE, 'always'), ['2']);
  assert.deepEqual(menuKeys(PANE, 'no'), ['3']);
  assert.equal(menuKeys('plain output', 'yes'), null);
});

// Only the "Yes, I trust this folder" label is confirmed against Claude Code 2.1.330; the rest is a plausible layout.
const TRUST_DIALOG = `  Quick safety check: is this a project you created or one you trust?
  ❯ 1. Yes, I trust this folder
    2. No, exit
  Enter to confirm · Esc to cancel`;

test('trust-folder dialog is an approval prompt that session_approve can answer', () => {
  assert.equal(detectStatus(TRUST_DIALOG), 'waiting_approval');
  assert.equal(detectStatus(TRUST_DIALOG.replace('❯', ' ')), 'waiting_approval'); // cursor glyph not needed to detect it
  assert.deepEqual(menuKeys(TRUST_DIALOG, 'yes'), ['1']);
  assert.deepEqual(menuKeys(TRUST_DIALOG, 'no'), ['2']);
});

test('newSessionCmd: default tmux socket, own systemd scope only when no server runs', () => {
  const c = newSessionCmd('cc-x-1', '~/p', "it's");
  assert.match(c, /^if tmux list-sessions >\/dev\/null 2>&1; then tmux new-session -d -s 'cc-x-1' -c "\$HOME"'\/p' 'it'\\''s'; else systemd-run --user --scope --quiet tmux new-session /);
  assert.match(c, /\|\| tmux new-session -d -s 'cc-x-1'[^;]*; fi$/);
  assert.doesNotMatch(c, /\s-[LS]\s/); // no custom socket
});

test('tail collapses long diffs', () => {
  const diff = Array.from({ length: 20 }, (_, i) => `  ${i} + line`).join('\n');
  const t = tail(diff, 100);
  assert.equal(t.split('\n').length, 6);
  assert.match(t, /diff truncated/);
});

test('hook payload → status', () => {
  assert.equal(statusFor({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' }), 'waiting_approval');
  assert.equal(statusFor({ hook_event_name: 'Notification', message: 'Claude is waiting for your input' }), 'waiting_input');
  assert.equal(statusFor({ hook_event_name: 'Stop' }), 'idle');
  assert.equal(statusFor({ hook_event_name: 'PreToolUse' }), undefined);
});

test('parseKv reads machine_status output', () => {
  const o = parseKv('cpus=8\nload=0.52\ndisk_pct=41%\ngpu=RTX 3070, 12, 2048, 8192\nlink=ethernet');
  assert.deepEqual(o, { cpus: 8, load: 0.52, disk_pct: '41%', link: 'ethernet', gpus: [{ name: 'RTX 3070', util_pct: 12, vram_used_mb: 2048, vram_total_mb: 8192 }] });
});

test('config validates machines and resolves aliases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  writeFileSync(join(dir, 'machines.yaml'), 'machines:\n  - {id: node2, local: true}\n');
  writeFileSync(join(dir, 'projects.yaml'), 'projects:\n  - {id: myapp, aliases: [My App], machine: node2}\n');
  const cfg = loadConfig(dir);
  assert.equal(findProject(cfg, 'my app').id, 'myapp');
  writeFileSync(join(dir, 'projects.yaml'), 'projects:\n  - {id: x, machine: nope}\n');
  assert.throws(() => loadConfig(dir), /unknown machine/);
  writeFileSync(join(dir, 'machines.yaml'), 'machines:\n  - {id: gpu}\n');
  assert.throws(() => loadConfig(dir), /ssh_host/);
});

test('real Claude Code 2.1.319 idle pane: statusline is not an action', async () => {
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(new URL('./fixtures/idle-2.1.319.txt', import.meta.url), 'utf8');
  assert.equal(summarize(raw).last_action, 'OK');
  assert.equal(detectStatus(raw), undefined);
});

test('security: brainPath confines the real path, so symlinks cannot escape the brain', async () => {
  const { symlinkSync, mkdirSync: mk } = await import('node:fs');
  const { brainPath } = await import('../src/tools/memory.ts');
  const root = mkdtempSync(join(tmpdir(), 'brainsec-'));
  const brain = join(root, 'brain'), outside = join(root, 'outside');
  mk(join(brain, 'shared'), { recursive: true }); mk(outside);
  writeFileSync(join(outside, 'secret.env'), 'DUMMY_SECRET=1');
  symlinkSync(join(outside, 'secret.env'), join(brain, 'shared', 'notes.md'));
  symlinkSync(outside, join(brain, 'shared', 'sub'));
  symlinkSync(join(outside, 'nope'), join(brain, 'dangling.md'));
  assert.equal(brainPath('shared/new/deep.md', brain), join(brain, 'shared/new/deep.md'));
  assert.throws(() => brainPath('../outside/secret.env', brain), /outside the brain/);
  assert.throws(() => brainPath('shared/notes.md', brain), /points outside/);
  assert.throws(() => brainPath('shared/sub/x.txt', brain), /points outside/);
  assert.throws(() => brainPath('dangling.md', brain), /broken link/);
  assert.throws(() => brainPath('.GIT/config', brain), /off limits/);
});

test('lastTurn reads the latest turn from a Claude Code transcript', async () => {
  const { lastTurn } = await import('../src/transcript.ts');
  const L = (o: object) => JSON.stringify(o);
  const jsonl = [
    '{"partial line from tail',
    L({ type: 'user', message: { content: 'old prompt' } }),
    L({ type: 'assistant', message: { content: [{ type: 'text', text: 'old reply' }] } }),
    L({ type: 'user', message: { content: 'fix the login bug' } }),
    L({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }),
    L({ type: 'user', message: { content: [{ type: 'tool_result', content: '2 failed' }] } }),
    L({ type: 'user', isMeta: true, message: { content: [{ type: 'text', text: 'meta' }] } }),
    L({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'SUBAGENT' }] } }),
    L({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/login.ts' } }] } }),
    L({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed the token check. Tests pass now.' }] } }),
    L({ type: 'system', stopReason: 'end' }),
  ].join('\n');
  const t = lastTurn(jsonl);
  assert.equal(t.prompt, 'fix the login bug');
  assert.equal(t.reply, 'Fixed the token check. Tests pass now.');
  assert.deepEqual(t.actions, ['Bash: npm test', 'Edit: src/login.ts']);
  assert.deepEqual(t.files, ['src/login.ts']);
});

test('both plugins ship the same skill', () => {
  const skill = (dir: string) => readFileSync(join(dir, 'skills', 'manage-sessions', 'SKILL.md'), 'utf8');
  assert.equal(skill('plugin-local'), skill('plugin'), 'copy plugin/skills/manage-sessions to plugin-local/skills/');
});

test('cli: init writes a loadable config with private tokens, install print gives a stdio command', () => {
  const home = mkdtempSync(join(tmpdir(), 'cli-'));
  const cli = (...args: string[]) => execFileSync(process.execPath, ['src/cli.ts', ...args], { env: { ...process.env, ORCH_HOME: home } }).toString();
  assert.match(cli('init', '--machine', 'hub', '--projects-root', '~/code'), /created .*\.env/);
  assert.match(cli('init'), /kept .*machines\.yaml/); // never overwrites
  const cfg = loadConfig(home);
  assert.equal(cfg.machines[0].id, 'hub');
  assert.equal(cfg.machines[0].projects_root, '~/code');
  assert.equal(statSync(join(home, '.env')).mode & 0o077, 0);
  assert.match(readFileSync(join(home, '.env'), 'utf8'), /^EVENTS_TOKEN=[0-9a-f]{64}\nMCP_TOKEN=[0-9a-f]{64}\n$/);
  const out = JSON.parse(cli('install', 'print'));
  assert.deepEqual(out.mcpServers['session-orchestrator'].args.slice(-2), [join(process.cwd(), 'src', 'cli.ts'), 'stdio']);
});

const MARK = '@@cc-test@@';
const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const DISCOVERY = [
  `${MARK} home /home/u`, `${MARK} ps`,
  '  100     1 -bash', '  101   100 claude --resume ' + ID, '  102   101 node mcp-server.js',
  '  200     1 -bash', '  201   200 vim notes.txt',
  '  300     1 -bash', '  301   300 claude -p one-shot',
  `${MARK} panes`,
  '%1\t100\t1700000000\t1700000500\twork\t/home/u/projects/app/src', // window output is newer than the session's last client input
  '%2\t200\t1700000000\t1700000000\twork\t/home/u',
  '%3\t300\t1700000000\t1700000000\tbatch\t/tmp',
  `${MARK} cap %1`, '✻ Thinking… (esc to interrupt)',
  `${MARK} cap %2`, '$ ',
].join('\n') + '\n';

test('parseDiscovery keeps only panes with Claude Code in their process tree', () => {
  const d = parseDiscovery(DISCOVERY, MARK, ['claude']);
  assert.equal(d.home, '/home/u');
  assert.equal(d.panes.length, 1);
  assert.deepEqual({ ...d.panes[0], pane: undefined }, {
    id: '%1', session: 'work', cwd: '/home/u/projects/app/src', activity: 1700000500_000, pane: undefined, claude_pid: 101, claude_id: ID, remote_control: -1,
  });
  assert.match(d.panes[0].pane, /esc to interrupt/);
  assert.deepEqual(parseDiscovery(DISCOVERY.replaceAll(MARK, '@@other@@'), MARK, ['claude']).panes, []); // wrong marker: nothing forged
});

test('parseDiscovery: activity is the newer of session_activity and window_activity (Remote Control never touches the session)', () => {
  const out = (sess: number, win: string) => [`${MARK} home /h`, `${MARK} ps`, '  100     1 -bash', '  101   100 claude', `${MARK} panes`, `%1\t100\t${sess}\t${win}\ts\t/x`].join('\n') + '\n';
  assert.equal(parseDiscovery(out(100, '300'), MARK, ['claude']).panes[0].activity, 300_000);
  assert.equal(parseDiscovery(out(500, '300'), MARK, ['claude']).panes[0].activity, 500_000);
  assert.equal(parseDiscovery(out(500, ''), MARK, ['claude']).panes[0].activity, 500_000); // field missing
});

test('lastActivity: the newest of tmux activity and the last status change (hook events)', () => {
  assert.equal(lastActivity(1000, 5000), 5000);
  assert.equal(lastActivity(9000, 5000), 9000);
  assert.equal(lastActivity(0, null), 0);
  assert.equal(lastActivity(NaN, 7), 7);
});

test('matchProject: longest folder wins, subfolders match, otherwise null', () => {
  const m = { id: 'gpu', projects_root: '~/projects' } as Machine;
  const cfg = { projects: [
    { id: 'app', aliases: [], machine: 'gpu', shared: [] },
    { id: 'app-api', aliases: [], machine: 'gpu', path: 'app/api', shared: [] },
    { id: 'abs', aliases: [], machine: 'gpu', path: '/srv/abs', shared: [] },
  ] } as unknown as Config;
  assert.equal(matchProject(cfg, m, '/home/u', '/home/u/projects/app'), 'app');
  assert.equal(matchProject(cfg, m, '/home/u', '/home/u/projects/app/src/'), 'app');
  assert.equal(matchProject(cfg, m, '/home/u', '/home/u/projects/app/api/v1'), 'app-api');
  assert.equal(matchProject(cfg, m, '/home/u', '/home/u/projects/application'), null);
  assert.equal(matchProject(cfg, m, '/home/u', '/srv/abs'), 'abs');
  assert.equal(matchProject(cfg, m, '', '/home/u/projects/app'), null); // unknown $HOME: cannot resolve ~
});

const cfgOf = (...projects: object[]) => ({ projects: projects.map((p) => ({ aliases: [], shared: [], ...p })) }) as unknown as Config;

test('matchProject: unknown $HOME falls back to the machine-resolved folder, else no match', () => {
  const m = { id: 'hub', projects_root: '~' } as Machine;
  const cfg = cfgOf({ id: 'webapp', machine: 'hub', path: 'webapp' });
  const dirs = new Map([['~/webapp', '/home/u/webapp']]);
  assert.equal(matchProject(cfg, m, '', '/home/u/webapp/src', { dirs }), 'webapp');
  assert.equal(matchProject(cfg, m, '', '/home/u/webapp'), null); // nothing to resolve ~ with
});

test('matchProject: realpath on both sides (symlinked pane cwd or project folder)', () => {
  const m = { id: 'hub', projects_root: '~' } as Machine;
  const cfg = cfgOf({ id: 'webapp', machine: 'hub', path: 'webapp' });
  assert.equal(matchProject(cfg, m, '/home/u', '/work/link', { cwd: '/home/u/webapp/api' }), 'webapp'); // pane cwd is a symlink
  assert.equal(matchProject(cfg, m, '/home/u', '/data/webapp/x', { dirs: new Map([['~/webapp', '/data/webapp']]) }), 'webapp'); // folder is a symlink
});

test('matchProject: only projects of the scanned machine can match (same relative path on another machine)', () => {
  const hub = { id: 'hub', projects_root: '~' } as Machine;
  const cfg = cfgOf({ id: 'other-app', machine: 'gpu', path: 'app' }, { id: 'app', machine: 'hub', path: 'app/api' });
  assert.equal(matchProject(cfg, hub, '/home/u', '/home/u/app/api/src'), 'app'); // not 'other-app', which is on gpu
  assert.equal(matchProject(cfgOf({ id: 'other-app', machine: 'gpu', path: 'app' }), hub, '/home/u', '/home/u/app'), null);
  const gpu = { id: 'gpu', projects_root: '~/projects' } as Machine;
  assert.equal(matchProject(cfgOf({ id: 'other-app', machine: 'gpu', path: 'app' }), gpu, '/home/u', '/home/u/projects/app'), 'other-app');
});

test('projectDirs: lists only the scanned machine\'s project folders', () => {
  const cfg = cfgOf({ id: 'a', machine: 'hub', path: 'a' }, { id: 'b', machine: 'gpu', path: 'b' });
  assert.deepEqual(projectDirs(cfg, { id: 'hub', projects_root: '~' } as Machine), ['~/a']);
  assert.deepEqual(projectDirs(cfg, { id: 'gpu', projects_root: '~/p' } as Machine), ['~/p/b']);
});

test('parseDiscovery: --remote-control / --rc, realpaths and resolved folders', () => {
  const out = [
    `${MARK} home /home/u`, `${MARK} ps`,
    '  100     1 -bash', '  101   100 claude --rc', '  200     1 -bash', '  201   200 claude --remote-control my-name', '  300     1 -bash', '  301   300 claude',
    `${MARK} panes`, '%1\t100\t1\t1\ta\t/x', '%2\t200\t1\t1\tb\t/y', '%3\t300\t1\t1\tc\t/z',
    `${MARK} real`, '%1\t/real/x', `${MARK} dirs`, '~/webapp\t/home/u/webapp',
  ].join('\n') + '\n';
  const d = parseDiscovery(out, MARK, ['claude']);
  assert.deepEqual(d.panes.map((p) => p.remote_control), [1, 1, -1]);
  assert.deepEqual(d.panes.map((p) => p.real_cwd), ['/real/x', undefined, undefined]);
  assert.equal(d.dirs.get('~/webapp'), '/home/u/webapp');
});

/** A fake tmux server: renames update it, an existing name answers 'exists', and rescans see the new session names. */
function fakeTmux(...existing: string[]) {
  const set = new Set(existing), calls: string[] = [], renamed = new Map<string, string>();
  const io: AdoptIo = { rename: async (from, to) => {
    calls.push(`${from} -> ${to}`);
    if (set.has(to)) return 'exists';
    set.delete(from); set.add(to); renamed.set(from, to);
    return 'ok';
  } };
  return { set, calls, renamed, io };
}

test('adoptPanes: records the flag (unknown, not false) and re-matches unassigned rows (same row)', async () => {
  const m = { id: 'hub', projects_root: '~' } as Machine;
  const db = new Db(':memory:');
  const t = fakeTmux();
  const pane = { id: '%1', session: 'mine', cwd: '/home/u/webapp', activity: 0, pane: '', claude_pid: 7, claude_id: null, remote_control: -1 };
  const found = { home: '', panes: [pane], dirs: new Map<string, string>() };
  assert.equal((await adoptPanes(cfgOf(), db, m, found, t.io)).length, 1);
  let row = db.sessions()[0];
  assert.equal(row.project, 'unassigned');
  assert.equal(row.remote_control, -1);
  const cfg = cfgOf({ id: 'webapp', machine: 'hub', path: 'webapp' });
  const again = { ...found, panes: [{ ...pane, session: 'cc-mine' }] }; // tmux session was renamed by the first scan
  assert.equal((await adoptPanes(cfg, db, m, again, t.io)).length, 0); // still no home and no resolved folder
  assert.equal(db.sessions()[0].project, 'unassigned');
  again.dirs.set('~/webapp', '/home/u/webapp'); // machine resolved the folder
  assert.equal((await adoptPanes(cfg, db, m, again, t.io)).length, 0, 'no duplicate');
  row = db.sessions()[0];
  assert.equal(row.project, 'webapp');
  await adoptPanes(cfg, db, m, { ...again, panes: [{ ...pane, id: '%2', session: 'other', remote_control: 1 }] }, t.io);
  assert.equal(db.sessions().find((r) => r.target === '%2')!.remote_control, 1);
});

// ---- one row per session, however often or however concurrently we scan ----
const hubM = { id: 'hub', projects_root: '~' } as Machine;
const paneOf = (o: object = {}) => ({ id: '%1', session: 'mine', cwd: '/x', activity: 0, pane: '', claude_pid: 7, claude_id: null, remote_control: -1, ...o });
type Tmux = ReturnType<typeof fakeTmux>;
// Panes are given with the tmux name they were first seen under; a rescan sees the name after any rename.
const scan = (db: Db, t: Tmux, ...panes: object[]) => adoptPanes(cfgOf(), db, hubM, {
  home: '/h', dirs: new Map(), panes: panes.map((o) => { const p = paneOf(o); return { ...p, session: t.renamed.get(p.session) ?? p.session }; }),
}, t.io);
const tmpDb = () => join(mkdtempSync(join(tmpdir(), 'orch-db-')), 'o.db');

test('adopt: scanning twice yields one row', async () => {
  const db = new Db(':memory:'), t = fakeTmux('mine');
  assert.equal((await scan(db, t, {})).length, 1);
  assert.equal((await scan(db, t, {})).length, 0);
  assert.equal((await scan(db, t, {})).length, 0);
  assert.equal(db.sessions().length, 1);
  assert.equal(t.calls.length, 1, 'renamed once');
});

test('adopt: a non-cc tmux session is renamed to cc-<name> and the row takes that name', async () => {
  const db = new Db(':memory:'), t = fakeTmux('webapp-monitoring');
  assert.deepEqual(await scan(db, t, { session: 'webapp-monitoring', id: '%4' }), ['cc-webapp-monitoring']);
  assert.deepEqual(t.calls, ['webapp-monitoring -> cc-webapp-monitoring']);
  const r = db.sessions()[0];
  assert.equal(r.name, 'cc-webapp-monitoring');
  assert.equal(r.tmux_session, 'cc-webapp-monitoring');
  assert.equal(r.tmux_orig, 'webapp-monitoring');
  assert.equal(r.target, '%4'); // identity is still machine + pane
  assert.equal(adoptedName('My Work_2'), 'cc-my-work-2');
  assert.equal(adoptedName('!!'), 'cc-session');
});

test('adopt: a name clash gets a numeric suffix (tmux session, or an existing row)', async () => {
  const db = new Db(':memory:'), t = fakeTmux('work', 'cc-work'); // tmux already has cc-work, which we were not told about
  assert.deepEqual(await scan(db, t, { session: 'work' }), ['cc-work-2']);
  assert.deepEqual(t.calls, ['work -> cc-work', 'work -> cc-work-2']);
  assert.equal(db.sessions()[0].tmux_session, 'cc-work-2');
  // A row (orchestrator session, stopped or not) that already has the name is skipped without asking tmux.
  db.upsertSession({ name: 'cc-docs', machine: 'hub', project: 'docs', status: 'stopped', remote_control: 1 });
  const t2 = fakeTmux('docs');
  assert.deepEqual(await scan(db, t2, { session: 'docs', id: '%9' }), ['cc-docs-2']);
  assert.deepEqual(t2.calls, ['docs -> cc-docs-2']);
});

test('adopt: sessions the orchestrator started are never adopted', async () => {
  const db = new Db(':memory:'), t = fakeTmux('renamed-by-user');
  db.upsertSession({ name: 'cc-app-ab12', machine: 'hub', project: 'app', status: 'working', remote_control: 1 });
  db.setTranscript('cc-app-ab12', ID, null);
  assert.equal((await scan(db, t, { id: '%5', session: 'cc-app-ab12' })).length, 0); // its own tmux session
  assert.equal((await scan(db, t, { id: '%6', session: 'renamed-by-user', claude_id: ID })).length, 0); // renamed, same Claude session id
  assert.equal(db.sessions().length, 1);
  assert.deepEqual(t.calls, [], 'their tmux sessions are left alone');
});

test('adopt: two concurrent scans (separate connections, stale snapshots) yield one row', async () => {
  const path = tmpDb();
  const a = new Db(path), b = new Db(path);
  assert.equal((await scan(a, fakeTmux('mine'), {})).length, 1);
  assert.equal((await scan(b, fakeTmux('mine'), {})).length, 0); // b sees a's row
  // Both inserted before either saw the other: the unique index + upsert still leave one row.
  const raw = (db: Db) => db.adoptSession({ name: `cc-unassigned-${Math.random().toString(16).slice(2, 6)}`, machine: 'hub', project: 'unassigned', status: 'idle', target: '%1', tmux_session: 'mine', claude_id: null, claude_pid: 7, remote_control: -1 });
  raw(a); raw(b);
  assert.equal(a.sessions().length, 1);
  assert.equal(b.sessions().length, 1);
});

test('adopt: renamed tmux session, restarted claude and stopped-then-running keep one row', async () => {
  const db = new Db(':memory:'), t = fakeTmux('mine', 'renamed');
  await scan(db, t, {});
  const name = db.sessions()[0].name;
  assert.equal(name, 'cc-mine');
  db.setTranscript(name, null, '/t/old.jsonl');
  await scan(db, t, { session: 'cc-renamed' }); // the user renamed the tmux session again
  assert.equal(db.sessions().length, 1);
  assert.equal(db.sessions()[0].tmux_session, 'cc-renamed');
  assert.equal(db.sessions()[0].name, 'cc-renamed', 'row name follows the tmux name');
  assert.equal(db.sessions()[0].transcript, '/t/old.jsonl'); // same process: transcript kept
  await scan(db, t, { session: 'cc-renamed', claude_pid: 99 }); // claude restarted in the same pane
  assert.equal(db.sessions().length, 1);
  assert.equal(db.sessions()[0].claude_pid, 99);
  assert.equal(db.sessions()[0].transcript, null); // new process: stale transcript dropped
  db.setStatus('cc-renamed', 'stopped');
  assert.equal((await scan(db, t, { session: 'cc-renamed', claude_pid: 99 })).length, 0);
  assert.equal(db.sessions().length, 1);
  assert.equal(db.sessions()[0].name, 'cc-renamed');
  assert.notEqual(db.sessions()[0].status, 'stopped'); // revived, not duplicated
});

test('adopt: an already adopted row is migrated to the cc-<name> naming on the next scan', async () => {
  const db = new Db(':memory:'), t = fakeTmux('webapp-monitoring');
  db.adoptSession({ name: 'cc-unassigned-0a1b', machine: 'hub', project: 'webapp', status: 'idle', target: '%1', tmux_session: 'webapp-monitoring', claude_id: null, claude_pid: 7, remote_control: 1 });
  db.addEvent('cc-unassigned-0a1b', 'Stop', 'idle', null);
  assert.deepEqual(await scan(db, t, { session: 'webapp-monitoring' }), [], 'not a new session');
  const rows = db.sessions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'cc-webapp-monitoring');
  assert.equal(rows[0].project, 'webapp', 'project is not part of the name and is kept');
  assert.equal(rows[0].tmux_orig, 'webapp-monitoring');
  assert.equal(rows[0].remote_control, 1);
  assert.equal((db.db.prepare(`SELECT COUNT(*) n FROM events WHERE session = 'cc-webapp-monitoring'`).get() as { n: number }).n, 1, 'history follows the rename');
  await scan(db, t, { session: 'webapp-monitoring' });
  assert.equal(db.sessions().length, 1, 'rescan after the rename: still one row');
  assert.equal(t.calls.length, 1);
});

test('adopt: several Claude panes in one tmux session: renamed once, first pane has the session name', async () => {
  const db = new Db(':memory:'), t = fakeTmux('dev');
  assert.deepEqual(await scan(db, t, { id: '%12', session: 'dev' }, { id: '%3', session: 'dev', claude_pid: 8 }), ['cc-dev', 'cc-dev-p12']);
  assert.deepEqual(t.calls, ['dev -> cc-dev'], 'one rename');
  const by = (id: string) => db.adoptedRow('hub', id)!;
  assert.equal(by('%3').name, 'cc-dev');
  assert.equal(by('%12').name, 'cc-dev-p12');
  assert.equal(by('%12').tmux_session, 'cc-dev'); // both rows point at the same tmux session
  await scan(db, t, { id: '%12', session: 'dev' }, { id: '%3', session: 'dev', claude_pid: 8 });
  assert.equal(db.sessions().length, 2);
  assert.equal(t.calls.length, 1);
  // The first pane closes: the other keeps its name and the stopped row's name is not reused.
  db.setStatus('cc-dev', 'stopped');
  await scan(db, t, { id: '%12', session: 'dev' });
  assert.deepEqual(db.sessions().map((r) => r.name).sort(), ['cc-dev', 'cc-dev-p12']);
});

test('adopt: a failed tmux rename keeps working and is retried on the next scan', async () => {
  const db = new Db(':memory:');
  let fail = true; const calls: string[] = [];
  const io: AdoptIo = { rename: async (_f, to) => { calls.push(to); return fail ? 'failed' : 'ok'; } };
  const run = (session: string) => adoptPanes(cfgOf(), db, hubM, { home: '/h', dirs: new Map(), panes: [paneOf({ session })] }, io);
  assert.equal((await run('mine')).length, 1);
  assert.equal(db.sessions().length, 1);
  fail = false;
  assert.equal((await run('mine')).length, 0);
  assert.deepEqual(calls, ['cc-mine', 'cc-mine']);
  assert.equal(db.sessions().length, 1);
  assert.equal(db.sessions()[0].tmux_orig, 'mine');
});

test('a hook event naming the renamed session (cc-<name>) lands on the adopted row, never a second one', async () => {
  const { ingest } = await import('../src/tools/events.ts');
  const db = new Db(':memory:'), t = fakeTmux('webapp-monitoring');
  await scan(db, t, { session: 'webapp-monitoring' });
  db.setStatus('cc-webapp-monitoring', 'working');
  const ctx = { db, cfg: { machines: [hubM], projects: [] } } as never;
  assert.equal(ingest(ctx, 'cc-webapp-monitoring', 'hub', { hook_event_name: 'Stop' }), 204);
  assert.equal(db.sessions().length, 1);
  assert.equal(db.session('cc-webapp-monitoring')!.status, 'idle');
  assert.equal(db.session('cc-webapp-monitoring')!.target, '%1', 'still the adopted row');
  // A hook that beat the rename (native row under the new name) is folded into the adopted row.
  const db2 = new Db(':memory:');
  db2.adoptSession({ name: 'cc-unassigned-1', machine: 'hub', project: 'webapp', status: 'idle', target: '%1', tmux_session: 'webapp', claude_id: null, claude_pid: 7, remote_control: 1 });
  ingest({ db: db2, cfg: { machines: [hubM], projects: [] } } as never, 'cc-webapp', 'hub', { hook_event_name: 'Stop' });
  assert.equal(db2.sessions().length, 2);
  await scan(db2, fakeTmux('cc-webapp'), { session: 'cc-webapp' });
  assert.deepEqual(db2.sessions().map((r) => [r.name, !!r.target]), [['cc-webapp', true]]);
});

test('Db startup removes duplicate adopted rows from earlier versions, keeping the oldest', () => {
  const path = tmpDb();
  new Db(path).db.close();
  const raw = new DatabaseSync(path);
  raw.exec('DROP INDEX sessions_adopted_pane'); // the state older versions left behind
  const ins = raw.prepare(`INSERT INTO sessions (name, machine, project, status, remote_control, status_since, target, tmux_session) VALUES (?, 'hub', 'p', 'idle', 0, 1, ?, 't')`);
  ins.run('cc-p-0001', '%1'); ins.run('cc-p-0002', '%1'); ins.run('cc-p-0003', '%1'); ins.run('cc-p-0004', '%2');
  raw.close();
  const db = new Db(path);
  assert.deepEqual(db.sessions().map((r) => r.name).sort(), ['cc-p-0001', 'cc-p-0004']);
  assert.throws(() => new DatabaseSync(path).exec(`INSERT INTO sessions (name, machine, project, status, remote_control, status_since, target) VALUES ('x', 'hub', 'p', 'idle', 0, 1, '%1')`));
});

// ---- Remote Control: remoteControlAtStartup (user settings), repo-scoped can only turn it off, flags ----
test('resolveRemoteControl: managed > flag > project(off only) > user, else unknown', () => {
  assert.equal(resolveRemoteControl('claude', { user: true }), 1); // auto Remote Control, plain claude
  assert.equal(resolveRemoteControl('claude', { user: false }), 0);
  assert.equal(resolveRemoteControl('claude', { user: true, project: false }), 0); // project turns it off
  assert.equal(resolveRemoteControl('claude', { user: false, project: true }), 0); // repo scope cannot enable it
  assert.equal(resolveRemoteControl('claude --rc', { user: false }), 1); // flag beats user
  assert.equal(resolveRemoteControl('claude --remote-control n', { user: true, project: false }), 1); // flag beats project
  assert.equal(resolveRemoteControl('claude', { user: true, managed: false }), 0); // managed policy locks it
  assert.equal(resolveRemoteControl('claude --rc', { managed: false }), 0);
  assert.equal(resolveRemoteControl('claude', {}), -1);
  assert.equal(resolveRemoteControl('claude'), -1);
});

test('parseDiscovery: per-pane settings feed remote_control', () => {
  const out = [
    `${MARK} home /home/u`, `${MARK} ps`, '  100     1 -bash', '  101   100 claude', '  200     1 -bash', '  201   200 claude', '  300     1 -bash', '  301   300 claude',
    `${MARK} panes`, '%1\t100\t1\t1\ta\t/x', '%2\t200\t1\t1\tb\t/y', '%3\t300\t1\t1\tc\t/z',
    `${MARK} rc`, '%1\ttrue\t\t', '%2\ttrue\tfalse\t', '%3\t\t\t',
  ].join('\n') + '\n';
  assert.deepEqual(parseDiscovery(out, MARK, ['claude']).panes.map((p) => p.remote_control), [1, 0, -1]);
});

test('rcval shell function reads only remoteControlAtStartup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-rc-'));
  const f = (name: string, body: string) => { writeFileSync(join(dir, name), body); return join(dir, name); };
  const rc = (file: string) => execFileSync('sh', ['-c', `${RCVAL_SH}; rcval ${q(file)}; true`]).toString().trim();
  assert.equal(rc(f('a.json', '{\n  "remoteControlAtStartup": true,\n  "x": 1\n}')), 'true');
  assert.equal(rc(f('b.json', '{"remoteControlAtStartup":false}')), 'false');
  assert.equal(rc(f('c.json', '{"other": true}')), '');
  assert.equal(rc(join(dir, 'missing.json')), '');
});
