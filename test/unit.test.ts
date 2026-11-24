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
import { findProject, loadConfig } from '../src/config.ts';

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

test('pickIdle: long-idle sessions stop, keep/working never; low memory stops local ones longest idle first', async () => {
  const { pickIdle } = await import('../src/reaper.ts');
  const H = 3600_000, now = 1_000 * H;
  const s = (name: string, idleH: number, extra: Record<string, unknown> = {}) => ({
    name, machine: 'node2', project: 'p', status: 'idle', remote_control: 1, status_since: now - idleH * H, last_message: null,
    claude_id: null, transcript: null, created: 0, keep: 0, reachable: true, last_activity: now - idleH * H, local: true, ...extra,
  }) as never;
  const ss = [
    s('cc-old', 50), s('cc-kept', 99, { keep: 1 }), s('cc-busy', 99, { status: 'working' }), s('cc-asking', 99, { status: 'waiting_approval' }),
    s('cc-typed', 60, { last_activity: now - 1000 }), // pane activity is recent: someone is using it
    s('cc-a', 5), s('cc-b', 3), s('cc-c', 4), s('cc-d', 2.5), s('cc-fresh', 1), s('cc-remote', 10, { local: false }),
  ];
  const opts = { idleHours: 48, memIdleHours: 2, memLow: false, memMax: 3 };
  assert.deepEqual(pickIdle(ss, now, opts).map((p) => p.name), ['cc-old']);
  const low = pickIdle(ss, now, { ...opts, memLow: true });
  assert.deepEqual(low.map((p) => p.name), ['cc-old', 'cc-a', 'cc-c', 'cc-b']); // 3 low-memory stops, longest idle first
  assert.match(low[1].reason, /idle 5 h while memory was low/);
  assert.deepEqual(pickIdle(ss, now, { ...opts, idleHours: 0 }), []); // 0 turns the idle rule off
});

test('parseMessages reads whatsapp-mcp listings, including multi-line messages', async () => {
  const { parseMessages } = await import('../src/tools/whatsapp.ts');
  const m = parseMessages('[2026-11-23 20:01:02] Chat: Family From: Mom: dinner at 7?\nbring bread\n[2026-11-23 20:05:00] Chat: Family From: Me: ok\n[2026-11-23 21:00:00] From: Bob: [image - Message ID: X - Chat JID: 1@s.whatsapp.net] look');
  assert.equal(m.length, 3);
  assert.deepEqual(m[0], { at: '2026-11-23 20:01:02', chat: 'Family', from: 'Mom', text: 'dinner at 7?\nbring bread' });
  assert.equal(m[2].chat, null);
  assert.equal(m[2].from, 'Bob');
});
