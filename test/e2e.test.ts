// Drives the real HTTP server, real tmux, a real git brain, fake OpenAI endpoints and a fake `claude`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { app } from '../src/server.ts';
import { Db } from '../src/db.ts';
import type { Config } from '../src/config.ts';
import { ensureBrain } from '../src/tools/memory.ts';
import { machineToken } from '../src/auth.ts';

const tmp = mkdtempSync(join(tmpdir(), 'orch-'));
process.env.TMUX_TMPDIR = tmp; // private tmux server, inherited by every child process
// Inside tmux, $TMUX names the user's own socket and wins over TMUX_TMPDIR: drop it so the tests (and their kill-server) never touch it.
delete process.env.TMUX;
delete process.env.TMUX_PANE;
process.env.BRAIN_DIR = join(tmp, 'brain');
process.env.CONFIG_DIR = join(tmp, 'config'); // project_create writes projects.yaml here
mkdirSync(join(tmp, 'config'));
writeFileSync(join(tmp, 'config', 'projects.yaml'), '# my projects\nprojects: []\n');
process.env.PATH = `${join(tmp, 'bin')}:${process.env.PATH}`;
mkdirSync(join(tmp, 'proj', 'demo'), { recursive: true });
mkdirSync(join(tmp, 'bin'));
// Fake macOS pmset so the "mac" machine reports its power source.
const setPower = (src: 'AC Power' | 'Battery Power') => {
  writeFileSync(join(tmp, 'bin', 'pmset'), `#!/bin/sh\necho "Now drawing from '${src}'"\necho " -InternalBattery-0 80%; charging"\n`);
  chmodSync(join(tmp, 'bin', 'pmset'), 0o755);
};
setPower('AC Power');

// Fake claude: echoes each line as an action; "ask" shows a permission prompt. Like Claude Code, it
// writes a JSONL transcript to $HOME/.claude/projects/<dir>/<--session-id>.jsonl.
process.env.HOME = join(tmp, 'home');
const FAKE = join(tmp, 'bin', 'fake-claude');
writeFileSync(FAKE, `#!/bin/sh
sid=; prev=; for a in "$@"; do [ "$prev" = --session-id ] && sid=$a; prev=$a; done
t="$HOME/.claude/projects/fake/$sid.jsonl"; mkdir -p "$HOME/.claude/projects/fake"
echo "args: $*"
while read l; do
  echo "⏺ Update(src/$l.ts)"
  printf '{"type":"user","message":{"role":"user","content":"%s"}}\\n' "$l" >> "$t"
  printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"src/%s.ts"}}]}}\\n' "$l" >> "$t"
  printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done with %s. All good."}]}}\\n' "$l" >> "$t"
  if [ "$l" = ask ]; then printf "Do you want to proceed?\\n❯ 1. Yes\\n"; else seq 15; fi
done
`);
chmodSync(FAKE, 0o755);

// Fake OpenAI-compatible endpoint that says which model answered.
const fakeLlm = createServer(async (req, res) => {
  if (req.url === '/v1/models') return void res.end('{"data":[]}');
  let body = '';
  for await (const c of req) body += c;
  const { model, messages } = JSON.parse(body);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: `${model} says: ${messages.at(-1).content.toUpperCase()}` } }] }));
});

let cfg: Config;
const db = new Db(join(tmp, 't.db'));
let srv: Server, base = '', client: Client;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
  return { err: !!r.isError, ...JSON.parse(r.content[0].text) };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  await new Promise<void>((r) => fakeLlm.listen(0, '127.0.0.1', r));
  const llmUrl = `http://127.0.0.1:${(fakeLlm.address() as AddressInfo).port}/v1`;
  cfg = {
    machines: [
      { id: 'node2', local: true, os: 'linux', projects_root: join(tmp, 'proj'), claude_cmd: FAKE },
      { id: 'mac', local: true, os: 'macos', projects_root: '~', claude_cmd: 'claude' },
      { id: 'macbook', ssh_host: '192.0.2.1', os: 'macos', projects_root: '~', local: false, claude_cmd: 'claude' },
    ],
    projects: [{ id: 'demo', aliases: ['the demo'], machine: 'node2', shared: [] }],
    endpoints: [
      { id: 'gpu-small', machine: 'node2', url: 'http://127.0.0.1:9/v1', model: 'small', ctx: 4096, requires_ac: false },
      { id: 'mac-large', machine: 'mac', url: llmUrl, model: 'large', ctx: 65536, requires_ac: true },
    ],
    routing: ['gpu-small', 'mac-large'],
    agents: [{ id: 'shout', machine: 'node2', cmd: 'tr a-z A-Z', timeout_s: 10 }],
  };
  await ensureBrain();
  srv = app({ cfg, db }, 'secret', 'mcp-secret');
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: 'Bearer mcp-secret' } } }));
});
after(async () => {
  await client.close();
  srv.close();
  fakeLlm.close();
  execSync('tmux kill-server 2>/dev/null || true');
});

test('lists all tools', async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['agent_run', 'agent_status', 'events_pending', 'llm_list', 'llm_run', 'machine_list', 'machine_status',
    'memory_append', 'memory_delete', 'memory_link', 'memory_read', 'memory_search', 'memory_write', 'overview', 'project_context',
    'project_sessions', 'session_approve', 'session_delete', 'session_interrupt', 'session_list', 'session_read', 'session_send', 'session_start', 'session_stop', 'session_wait']);
});

test('unreachable Mac fails fast with a speakable error', async () => {
  const t = Date.now();
  const r = await call('session_start', { project: 'demo', machine: 'macbook' });
  assert.ok(Date.now() - t < 6000);
  assert.ok(r.err);
  assert.match(r.summary, /macbook is unreachable.*asleep or on battery/);
  const list = await call('machine_list');
  assert.match(list.summary, /Unreachable: macbook/);
  assert.equal(list.machines.find((m: { id: string }) => m.id === 'mac').power.source, 'ac');
});

test('memory tools, and shared knowledge reaches a new session', async () => {
  assert.ok((await call('memory_read', { path: '../etc/passwd' })).err);
  assert.ok((await call('memory_write', { path: '.git/config', content: 'x' })).err);

  assert.ok(!(await call('memory_write', { path: 'shared/deployment/expo.md', content: '# Expo\nUse EAS build profile "prod".\n' })).err);
  await call('memory_append', { path: 'projects/demo/notes.md', text: 'Decision: ship weekly.' });
  assert.match((await call('memory_link', { project: 'the demo', shared_path: 'shared/deployment' })).summary, /Linked demo/);
  assert.match((await call('memory_link', { project: 'demo', shared_path: 'shared/deployment' })).summary, /already linked/);
  assert.ok((await call('memory_link', { project: 'demo', shared_path: 'shared/nope' })).err);

  const hits = await call('memory_search', { query: 'eas build' });
  assert.equal(hits.hits[0].path, 'shared/deployment/expo.md');

  const pc = await call('project_context', { project: 'demo' });
  assert.match(pc.summary, /1 notes, 1 shared files/);

  const start = await call('session_start', { project: 'demo', name: 'ctx test' });
  assert.equal(start.session, 'cc-ctx-test');
  const context = readFileSync(join(tmp, 'brain', 'projects', 'demo', 'context.md'), 'utf8');
  assert.match(context, /EAS build profile "prod"/);
  assert.match(context, /ship weekly/);
  const claudeMd = readFileSync(join(tmp, 'proj', 'demo', 'CLAUDE.md'), 'utf8');
  assert.equal(claudeMd.match(/@.*projects\/demo\/context\.md/g)?.length, 1);

  await call('session_stop', { session: 'cc-ctx-test', mode: 'kill', confirm: true });
  await call('session_start', { project: 'demo', name: 'ctx test' }); // second start: import line not duplicated
  assert.equal(readFileSync(join(tmp, 'proj', 'demo', 'CLAUDE.md'), 'utf8').match(/context\.md/g)?.length, 1);
  await call('session_stop', { session: 'cc-ctx-test', mode: 'kill', confirm: true });
  assert.match(readFileSync(join(tmp, 'brain', 'projects', 'demo', 'log.md'), 'utf8'), /cc-ctx-test/);

  assert.match((await call('memory_delete', { path: 'projects/demo/notes.md' })).summary, /confirm=true/);
  assert.ok(!(await call('memory_delete', { path: 'projects/demo/notes.md', confirm: true })).err);
  assert.ok(!existsSync(join(tmp, 'brain', 'projects', 'demo', 'notes.md')));
  const log = execSync(`git -C ${join(tmp, 'brain')} log --oneline`).toString();
  assert.match(log, /memory_write: shared\/deployment\/expo\.md/);
  assert.match(log, /memory_delete/);
  assert.doesNotMatch(execSync(`git -C ${join(tmp, 'brain')} ls-files`).toString(), /context\.md/);
});

test('session lifecycle over MCP + hooks', async () => {
  const start = await call('session_start', { project: 'the demo', prompt: "first 'task'", wait: 0 });
  assert.ok(!start.err, start.summary);
  const name: string = start.session;
  assert.equal(name, 'cc-demo'); // named after the project
  await wait(300);

  // The tmux server must not live in our own cgroup, or restarting the orchestrator service would kill it.
  let scoped = true;
  try { execSync('systemd-run --user --scope --quiet true', { stdio: 'ignore' }); } catch { scoped = false; }
  if (scoped) {
    const cg = (pid: string | number) => readFileSync(`/proc/${pid}/cgroup`, 'utf8');
    assert.notEqual(cg(execSync("tmux display -p '#{pid}'").toString().trim()), cg(process.pid));
  }

  let read = await call('session_read', { session: 'demo', mode: 'tail' });
  assert.match(read.text, new RegExp(`args: --name demo --remote-control demo --session-id [0-9a-f-]{36} first 'task'`));

  await call('session_send', { session: name, message: 'ask', wait: 0 });
  await wait(500);
  read = await call('session_read', { session: name, mode: 'summary' });
  assert.equal(read.changed_files_count, 1);
  assert.match(read.waiting_for, /Do you want to proceed/);

  // Hook arrives.
  const post = (body: unknown, token = machineToken('secret', 'node2')) => fetch(`${base}/events?session=${name}&machine=node2`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await post({ hook_event_name: 'Notification', message: 'x' }, 'wrong')).status, 401);
  assert.equal((await post({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' })).status, 204);
  const pending = await call('events_pending');
  assert.equal(pending.pending[0].session, name);
  assert.equal(pending.pending[0].status, 'waiting_approval');

  const ov = await call('overview');
  assert.match(ov.summary, /1 sessions: 1 waiting for approval/);

  const ap = await call('session_approve', { session: name, choice: 'yes', wait: 0 });
  assert.ok(!ap.err, ap.summary);
  await call('session_send', { session: name, message: 'go', wait: 0 }); // fake gets "1go", scrolls the prompt away
  await wait(400);
  assert.equal((await call('events_pending')).pending.length, 0);
  assert.match((await call('session_approve', { session: name, choice: 'yes', wait: 0 })).summary, /not waiting for approval/);

  assert.equal((await post({ hook_event_name: 'Stop' })).status, 204);
  const list = await call('session_list');
  assert.equal(list.sessions[0].status, 'idle');
  assert.equal(list.sessions[0].remote_control, true);

  // Ended from the Claude app: SessionEnd hook marks it stopped and writes the brain log.
  const logBefore = readFileSync(join(tmp, 'brain', 'projects', 'demo', 'log.md'), 'utf8');
  assert.equal((await post({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' })).status, 204);
  await wait(500);
  assert.equal((await call('session_list')).sessions[0].status, 'stopped'); // fake pane lingers; real claude exits
  assert.equal((await call('events_pending')).pending.length, 0);
  const logAfter = readFileSync(join(tmp, 'brain', 'projects', 'demo', 'log.md'), 'utf8');
  assert.match(logAfter.slice(logBefore.length), new RegExp(`${name}[\\s\\S]*Ended: prompt_input_exit`));
  execSync(`tmux kill-session -t ${name}`);

  const audit = db.db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number };
  assert.ok(audit.n >= 10);
});

test('llm_run auto routing: GPU down → Mac on AC, never Mac on battery', async () => {
  const list = await call('llm_list');
  assert.match(list.summary, /1 of 2 endpoints up: mac-large/);

  const r = await call('llm_run', { task: 'hello' });
  assert.ok(!r.err, r.summary);
  assert.equal(r.endpoint, 'mac-large');
  assert.equal(r.text, 'large says: HELLO');
  assert.ok(r.skipped.some((s: string) => s.startsWith('gpu-small')));

  setPower('Battery Power');
  const off = await call('llm_run', { task: 'hello' });
  assert.ok(off.err);
  assert.match(off.summary, /mac-large: mac on battery/);
  setPower('AC Power');

  assert.match((await call('llm_run', { task: 'x', endpoint: 'nope' })).summary, /Unknown endpoint/);
});

test('agent_run / agent_status', async () => {
  const j = await call('agent_run', { agent: 'shout', task: 'build it' });
  assert.ok(!j.err, j.summary);
  let s;
  for (let i = 0; i < 20; i++) {
    s = await call('agent_status', { job_id: j.job_id });
    if (s.status !== 'running') break;
    await wait(100);
  }
  assert.equal(s.status, 'done');
  assert.equal(s.result, 'BUILD IT');
});

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
const MCP_H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const mcpPost = (headers: Record<string, string> = {}) => fetch(`${base}/mcp`, { method: 'POST', headers: { ...MCP_H, ...headers }, body: JSON.stringify(INIT) });

test('security: /mcp trusts no network address (loopback and DNS-rebinding requests need a credential)', async () => {
  assert.equal((await mcpPost()).status, 401);
  assert.equal((await mcpPost({ host: 'attacker.example', origin: 'http://attacker.example' })).status, 401);
  assert.equal((await mcpPost({ authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await mcpPost({ authorization: 'Bearer mcp-secret' })).status, 200);
});

test('security: Cloudflare Access JWT is verified (signature, audience, issuer, expiry)', async () => {
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const { resetAccessKeys } = await import('../src/auth.ts');
  const good = generateKeyPairSync('rsa', { modulusLength: 2048 }), evil = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...good.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const certs = createServer((_q, r) => r.end(JSON.stringify({ keys: [jwk] })));
  await new Promise<void>((r) => certs.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud-123',
    CF_ACCESS_CERTS_URL: `http://127.0.0.1:${(certs.address() as AddressInfo).port}/certs`,
  });
  resetAccessKeys();
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = (claims: object, key = good.privateKey, kid = 'k1') => {
    const head = `${b64({ alg: 'RS256', kid })}.${b64(claims)}`;
    return `${head}.${sign('sha256', Buffer.from(head), key).toString('base64url')}`;
  };
  const now = Math.floor(Date.now() / 1000);
  const ok = { aud: ['aud-123'], iss: 'https://team.cloudflareaccess.com', exp: now + 300, email: 'me@example.com' };
  try {
    assert.equal((await mcpPost({ 'cf-access-jwt-assertion': jwt(ok) })).status, 200);
    assert.equal((await mcpPost({ 'cf-access-jwt-assertion': jwt(ok, evil.privateKey) })).status, 401);
    assert.equal((await mcpPost({ 'cf-access-jwt-assertion': jwt({ ...ok, aud: ['other'] }) })).status, 401);
    assert.equal((await mcpPost({ 'cf-access-jwt-assertion': jwt({ ...ok, iss: 'https://evil.example' }) })).status, 401);
    assert.equal((await mcpPost({ 'cf-access-jwt-assertion': jwt({ ...ok, exp: now - 10 }) })).status, 401);
    assert.equal((await mcpPost({ 'cf-access-jwt-assertion': jwt(ok, good.privateKey, 'unknown-kid') })).status, 401);
    assert.equal((await mcpPost({ 'cf-access-jwt-assertion': 'not.a.jwt' })).status, 401);
  } finally {
    for (const k of ['CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD', 'CF_ACCESS_CERTS_URL']) delete process.env[k];
    resetAccessKeys();
    certs.close();
  }
});

test('security: a hook sender is bound to its own machine', async () => {
  db.upsertSession({ name: 'cc-app-ab12', machine: 'mac', project: 'app', status: 'working', remote_control: 0 });
  const ev = (machine: string, token: string, session = 'cc-app-ab12') => fetch(`${base}/events?session=${session}&machine=${machine}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' }),
  });
  assert.equal((await ev('node2', 'secret')).status, 401); // the shared master secret is not a machine token
  assert.equal((await ev('mac', machineToken('secret', 'node2'))).status, 401); // node2's token cannot claim mac
  assert.equal((await ev('node2', machineToken('secret', 'node2'))).status, 403); // nor touch mac's session
  assert.equal(db.session('cc-app-ab12')!.status, 'working');
  assert.equal((await ev('mac', machineToken('secret', 'mac'))).status, 204);
  assert.equal(db.session('cc-app-ab12')!.status, 'waiting_approval');
  db.setStatus('cc-app-ab12', 'stopped');
});

test('security: notify.sh never puts the hook token on the command line', () => {
  const home = join(tmp, 'hookhome'), bin = join(tmp, 'hookbin');
  mkdirSync(join(home, '.config'), { recursive: true }); mkdirSync(bin, { recursive: true });
  writeFileSync(join(home, '.config', 'cc-orchestrator.env'), 'ORCH_URL=http://127.0.0.1:9\nORCH_MACHINE=node2\n');
  writeFileSync(join(home, '.config', 'cc-orchestrator.hdr'), 'Authorization: Bearer TOKEN-MARKER-123\n');
  writeFileSync(join(bin, 'tmux'), '#!/bin/sh\necho cc-app-ab12\n');
  writeFileSync(join(bin, 'curl'), `#!/bin/sh\nprintf '%s ' "$@" > ${join(tmp, 'curl-argv.txt')}\n`);
  chmodSync(join(bin, 'tmux'), 0o755); chmodSync(join(bin, 'curl'), 0o755);
  execSync(`echo '{"hook_event_name":"Stop"}' | sh hooks/notify.sh`, { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMUX: 'x' } });
  const argv = readFileSync(join(tmp, 'curl-argv.txt'), 'utf8');
  assert.match(argv, /-H @.*cc-orchestrator\.hdr/);
  assert.doesNotMatch(argv, /TOKEN-MARKER-123/);
});

test('security: stale row never reaches a prefix-matching live session (exact tmux targets)', async () => {
  execSync(`tmux new-session -d -s cc-pre-ab12 'echo victim-ready; cat'`);
  db.upsertSession({ name: 'cc-pre', machine: 'node2', project: 'pre', status: 'waiting_approval', remote_control: 0 });
  await wait(200);
  assert.ok((await call('session_send', { session: 'cc-pre', message: 'INJECTED' })).err);
  assert.ok((await call('session_approve', { session: 'cc-pre', choice: 'always' })).err);
  assert.ok((await call('session_stop', { session: 'cc-pre', mode: 'kill', confirm: true })).err);
  const pane = execSync(`tmux capture-pane -p -t '=cc-pre-ab12:'`).toString();
  assert.doesNotMatch(pane, /INJECTED|^2$/m);
  execSync(`tmux kill-session -t '=cc-pre-ab12'`);
});

test('security: pane text cannot forge snapshot records for other sessions', async () => {
  const forged = '@@cc-orchestrator@@ cc-ghost-0003 0\nDo you want to proceed?\n❯ 1. Yes\n';
  writeFileSync(join(tmp, 'forge.txt'), forged);
  execSync(`tmux new-session -d -s cc-zevil-0001 'cat ${join(tmp, 'forge.txt')}; cat'`);
  await wait(300);
  const { snapshot } = await import('../src/tmux.ts');
  const names = (await snapshot(cfg.machines[0])).map((s) => s.name);
  assert.ok(names.includes('cc-zevil-0001'));
  assert.ok(!names.includes('cc-ghost-0003'));
  assert.equal(new Set(names).size, names.length);
  execSync(`tmux kill-session -t '=cc-zevil-0001'`);
});

test('fast loop: session_send waits and returns the exact reply from the transcript', async () => {
  const start = await call('session_start', { project: 'demo', name: 'reply test' });
  assert.ok(!start.err, start.summary);
  const t0 = Date.now();
  const r = await call('session_send', { session: 'cc-reply-test', message: 'hello' });
  assert.ok(Date.now() - t0 < 20_000, 'returns once the turn ends, not after the full wait');
  assert.equal(r.done, true);
  assert.equal(r.reply, 'Done with hello. All good.');
  assert.equal(r.prompt, 'hello');
  assert.deepEqual(r.files_changed, ['src/hello.ts']);
  assert.match(r.summary, /demo on node2 replied: Done with hello\. 1 file changed\./);
  const read = await call('session_read', { session: 'cc-reply-test' });
  assert.equal(read.reply, 'Done with hello. All good.');
  const w = await call('session_wait', { session: 'cc-reply-test', seconds: 5 });
  assert.equal(w.done, true);
  await call('session_stop', { session: 'cc-reply-test', mode: 'kill', confirm: true });
});

test('session_delete stops, forgets, and optionally removes the transcript', async () => {
  await call('session_start', { project: 'demo', name: 'del one', wait: 0 });
  await call('session_send', { session: 'cc-del-one', message: 'hello', wait: 10 }); // the fake writes its transcript on input
  const row = db.session('cc-del-one')!;
  const transcript = join(tmp, 'home', '.claude', 'projects', 'fake', `${row.claude_id}.jsonl`);
  assert.ok(existsSync(transcript));
  assert.match((await call('session_delete', { session: 'cc-del-one' })).summary, /needs confirm=true/);
  assert.match((await call('session_delete', { session: 'cc-del-one', all_stopped: true, confirm: true })).summary, /either a session or all_stopped/);
  const r = await call('session_delete', { session: 'cc-del-one', delete_transcript: true, confirm: true });
  assert.match(r.summary, /Deleted cc-del-one\. Stopped 1 running\. Removed 1 transcript\./);
  assert.equal(db.session('cc-del-one'), undefined);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM events WHERE session = 'cc-del-one'").get()!.n, 0);
  assert.ok(!existsSync(transcript));
  assert.throws(() => execSync(`tmux has-session -t '=cc-del-one'`, { stdio: 'ignore' }));

  // Bulk: stopped records go, running sessions stay.
  await call('session_start', { project: 'demo', name: 'keep me', wait: 0 });
  db.upsertSession({ name: 'cc-old-0001', machine: 'node2', project: 'demo', status: 'stopped', remote_control: 0 });
  const bulk = await call('session_delete', { all_stopped: true, confirm: true });
  assert.ok(bulk.deleted.includes('cc-old-0001'));
  assert.ok(!bulk.deleted.includes('cc-keep-me'));
  assert.ok(db.session('cc-keep-me'));
  await call('session_stop', { session: 'cc-keep-me', mode: 'kill', confirm: true });
});

test('new project: own folder and git repo, project-named sessions, shared history', async () => {
  mkdirSync(join(tmp, 'home'), { recursive: true });
  writeFileSync(join(tmp, 'home', '.claude.json'), JSON.stringify({ oauthAccount: { id: 'keep' }, projects: { '/other': { hasTrustDialogAccepted: false } } }));
  assert.match((await call('session_start', { project: 'Side Quest' })).summary, /Unknown project/);
  const r = await call('session_start', { project: 'Side Quest', create: true, wait: 0 });
  assert.ok(!r.err, r.summary);
  assert.match(r.summary, /Created .*side-quest with a new git repo\. Trusted it in Claude Code\. Started side-quest on node2 as cc-side-quest/);
  const dir = join(tmp, 'proj', 'side-quest');
  assert.ok(existsSync(join(dir, '.git')));
  assert.match(readFileSync(join(tmp, 'config', 'projects.yaml'), 'utf8'), /^# my projects\nprojects:\n  - id: side-quest\n[\s\S]*Side Quest/);
  assert.ok(cfg.projects.some((p) => p.id === 'side-quest'));
  // The new folder is pre-trusted in Claude Code (trust dialog + external CLAUDE.md import).
  const claudeJson = JSON.parse(readFileSync(join(tmp, 'home', '.claude.json'), 'utf8'));
  assert.deepEqual(claudeJson.projects[realpathSync(dir)], { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true });
  assert.match(r.summary, /Trusted it in Claude Code/);
  assert.deepEqual(claudeJson.oauthAccount, { id: 'keep' }); // the rest of the file is untouched
  assert.deepEqual(claudeJson.projects['/other'], { hasTrustDialogAccepted: false });
  assert.equal(statSync(join(tmp, 'home', '.claude.json')).mode & 0o077, 0); // stays private

  // A second concurrent session gets the next project-named slot; the spoken alias resolves too.
  const r2 = await call('session_start', { project: 'side quest', wait: 0 });
  assert.equal(r2.session, 'cc-side-quest-2');
  await call('session_send', { session: 'cc-side-quest-2', message: 'refactor', wait: 10 });
  await call('session_stop', { session: 'cc-side-quest-2', mode: 'kill', confirm: true });
  // The ended session's exact reply lands in the log, and the next session's context carries it.
  const log = readFileSync(join(tmp, 'brain', 'projects', 'side-quest', 'log.md'), 'utf8');
  assert.match(log, /cc-side-quest-2[\s\S]*Claude session: [0-9a-f-]{36}[\s\S]*Done with refactor/);
  const r3 = await call('session_start', { project: 'side-quest', wait: 0 });
  assert.equal(r3.session, 'cc-side-quest-3'); // -2 is still tracked, so its history is not overwritten
  assert.match(readFileSync(join(tmp, 'brain', 'projects', 'side-quest', 'context.md'), 'utf8'), /## Recent sessions[\s\S]*Done with refactor/);

  assert.equal(JSON.parse(readFileSync(join(tmp, 'home', '.claude.json'), 'utf8')).projects[realpathSync(join(tmp, 'proj', 'demo'))], undefined);

  const hist = await call('project_sessions', { project: 'side quest' });
  assert.match(hist.summary, /side-quest has had 3 sessions, 2 running/);
  assert.deepEqual(hist.sessions.map((s: { name: string }) => s.name).sort(), ['cc-side-quest', 'cc-side-quest-2', 'cc-side-quest-3']);
  assert.ok(hist.sessions.every((s: { claude_session_id: string }) => /^[0-9a-f-]{36}$/.test(s.claude_session_id)));

  // create=true on a folder nested in another repo still gives the project its own repo.
  execSync(`git init -q ${join(tmp, 'proj')}`);
  mkdirSync(join(tmp, 'proj', 'nested'));
  const n = await call('session_start', { project: 'nested', create: true, wait: 0 });
  assert.match(n.summary, /new git repo/);
  assert.ok(existsSync(join(tmp, 'proj', 'nested', '.git')));

  // A known repo is cloned when the folder is missing.
  const src = join(tmp, 'src-repo');
  execSync(`git init -q ${src} && git -C ${src} -c user.name=t -c user.email=t@t commit -q --allow-empty -m init`);
  const c = await call('session_start', { project: 'cloned', create: true, repo: src, wait: 0 });
  assert.match(c.summary, /Cloned /);
  assert.ok(existsSync(join(tmp, 'proj', 'cloned', '.git')));
  assert.ok((await call('session_start', { project: 'evil', create: true, repo: '--upload-pack=touch /tmp/x', wait: 0 })).err);
  assert.ok(!cfg.projects.some((p) => p.id === 'evil')); // failed setup registers nothing

  for (const s of ['cc-side-quest', 'cc-side-quest-3', 'cc-nested', 'cc-cloned']) await call('session_stop', { session: s, mode: 'kill', confirm: true });
});

test('adopts Claude Code panes started outside the orchestrator (tmux, any session name)', async () => {
  // node2 and mac are both local here and would see the same tmux server; scan only node2.
  const all = cfg.machines;
  cfg.machines = all.filter((m) => m.id === 'node2');
  const sid = randomUUID();
  const proj = join(tmp, 'proj', 'demo');
  mkdirSync(join(tmp, 'elsewhere'), { recursive: true });
  execSync(`tmux new-session -d -s mywork -c ${proj}/ '${FAKE} --session-id ${sid}'`);
  execSync(`tmux new-session -d -s scratch -c ${join(tmp, 'elsewhere')} '${FAKE}'`);
  execSync(`tmux new-session -d -s plain -c ${proj} 'cat'`); // not Claude Code: ignored
  try {
    await wait(300);
    assert.equal(db.sessions().filter((r) => r.target).length, 0, 'no background scan');

    const list = await call('session_list');
    const adopted = list.sessions.filter((s: { adopted: boolean }) => s.adopted);
    assert.equal(adopted.length, 2);
    // Their tmux sessions were renamed to cc-<name> (so the hooks report for them); the row name follows.
    const a = adopted.find((s: { tmux_session: string }) => s.tmux_session === 'cc-mywork');
    const u = adopted.find((s: { tmux_session: string }) => s.tmux_session === 'cc-scratch');
    assert.equal(a.project, 'demo');
    assert.equal(a.name, 'cc-mywork'); // the project is not part of an adopted name
    assert.equal(u.name, 'cc-scratch');
    assert.equal(u.project, 'unassigned');
    assert.match(list.summary, /unassigned \(tmux cc-scratch\) on node2/);
    execSync(`tmux has-session -t '=cc-mywork'`);
    assert.throws(() => execSync(`tmux has-session -t '=mywork'`, { stdio: 'ignore' }));
    assert.equal(db.session('cc-mywork')!.tmux_orig, 'mywork');

    // The renamed session shows up as a cc-* tmux session on the next scan: still one row, never a native duplicate.
    for (let i = 0; i < 2; i++) {
      const again = await call('session_list');
      assert.equal(again.sessions.filter((s: { adopted: boolean }) => s.adopted).length, 2, 'adopting twice does not duplicate');
      assert.equal(again.sessions.filter((s: { name: string }) => s.name === 'cc-mywork').length, 1);
    }
    assert.equal(db.sessions().filter((r) => r.name === 'cc-mywork' && !r.target).length, 0, 'no native row under the renamed name');

    // notify.sh reports session=<tmux name>: that is the adopted row now.
    const hook = (session: string, body: unknown) => fetch(`${base}/events?session=${session}&machine=node2`, {
      method: 'POST', headers: { authorization: `Bearer ${machineToken('secret', 'node2')}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await hook('cc-mywork', { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' })).status, 204);
    assert.equal(db.session('cc-mywork')!.status, 'waiting_approval');
    assert.ok(db.session('cc-mywork')!.target, 'still the adopted row');
    const tHook = Date.now();
    assert.equal((await hook('cc-mywork', { hook_event_name: 'Stop' })).status, 204);
    assert.equal(db.session('cc-mywork')!.status, 'idle');
    // A hook event bumps last_activity even though tmux saw no client input.
    const la = (await call('session_list')).sessions.find((x: { name: string }) => x.name === 'cc-mywork').last_activity;
    assert.ok(Date.parse(la) >= tHook - 1000, `last_activity ${la} is current`);
    assert.equal(db.sessions().filter((r) => r.name === 'cc-mywork').length, 1);

    // Works like a native session: send (exact reply from transcript via --session-id), read, approve, stop.
    const r = await call('session_send', { session: a.name, message: 'hello' });
    assert.ok(!r.err, r.summary);
    assert.equal(r.reply, 'Done with hello. All good.');
    assert.equal(r.done, true);
    assert.equal(db.session(a.name)!.status, 'idle', 'no hooks: idle inferred from the pane');
    assert.match((await call('session_read', { session: a.name, mode: 'tail' })).text, /Update\(src\/hello\.ts\)/);

    await call('session_send', { session: u.name, message: 'ask', wait: 0 });
    await wait(500);
    const ap = await call('session_approve', { session: u.name, choice: 'yes', wait: 0 });
    assert.ok(!ap.err, ap.summary);

    assert.match((await call('session_stop', { session: u.name, mode: 'kill' })).summary, /needs confirm=true/);
    assert.ok(!(await call('session_stop', { session: u.name, mode: 'kill', confirm: true })).err);
    assert.equal(db.session(u.name)!.status, 'stopped');
    assert.throws(() => execSync(`tmux has-session -t '=cc-scratch'`, { stdio: 'ignore' })); // its only pane closed

    // Claude exits to a shell: the session is stopped and nothing is typed into the shell.
    execSync(`tmux respawn-pane -k -t '=cc-mywork:' 'cat'`);
    await wait(300);
    const gone = await call('session_send', { session: a.name, message: 'INJECTED', wait: 0 });
    assert.ok(gone.err);
    assert.doesNotMatch(execSync(`tmux capture-pane -p -t '=cc-mywork:'`).toString(), /INJECTED/);
    assert.equal(db.session(a.name)!.status, 'stopped');
    assert.ok(!(await call('session_delete', { session: a.name, confirm: true })).err);
    execSync(`tmux has-session -t '=cc-mywork'`); // deleting a stopped adopted session leaves the user's pane alone

    // An unknown name triggers a scan, and the tmux session name works as a name.
    execSync(`tmux respawn-pane -k -t '=cc-mywork:' '${FAKE}'`);
    await wait(300);
    const t = await call('session_read', { session: 'mywork', mode: 'tail' });
    assert.ok(!t.err, t.summary);
    // Its row was deleted and its tmux session is cc-* now, so it is tracked by name like any cc-* session: one live row.
    assert.equal(db.sessions().filter((r) => r.name === 'cc-mywork' && r.status !== 'stopped').length, 1);
    assert.ok((await call('session_read', { session: 'no-such-thing' })).err);
  } finally {
    cfg.machines = all;
    for (const s of ['mywork', 'cc-mywork', 'scratch', 'cc-scratch', 'plain']) execSync(`tmux kill-session -t '=${s}' 2>/dev/null || true`);
  }
});
