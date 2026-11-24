// Idle cleanup: every Claude Code session holds a few hundred MB even when idle. On 2026-11-23 ~38 idle
// sessions plus other services filled node2's RAM and swap. Stopping is safe: the conversation is kept,
// and session_send resumes it on demand. Sessions marked keep (session_keep) are never touched.
import { freemem, totalmem } from 'node:os';
import { findMachine } from './config.ts';
import type { Ctx } from './tools/common.ts';
import { refresh, stopSession, type LiveSession } from './tools/sessions.ts';

const H = 3600_000;

export interface ReapOpts {
  idleHours: number;     // stop any session idle this long (0 = never)
  memIdleHours: number;  // when memory is low, also stop local sessions idle this long, longest idle first
  memLow: boolean;       // available memory on this machine is under the threshold
  memMax: number;        // at most this many low-memory stops per pass, so the next pass re-measures
}

/** Which sessions to stop, and why. Pure, so it is testable without tmux. */
export function pickIdle(ss: (LiveSession & { local: boolean })[], now: number, o: ReapOpts) {
  const idle = ss
    .filter((s) => s.reachable && !s.keep && (s.status === 'idle' || s.status === 'waiting_input'))
    .map((s) => ({ s, idleMs: now - Math.max(s.status_since, s.last_activity ?? 0) }))
    .sort((a, b) => b.idleMs - a.idleMs);
  const out: { name: string; reason: string }[] = [];
  let mem = 0;
  for (const { s, idleMs } of idle) {
    const hours = Math.round(idleMs / H);
    if (o.idleHours > 0 && idleMs >= o.idleHours * H) out.push({ name: s.name, reason: `idle ${hours} h` });
    else if (o.memLow && s.local && idleMs >= o.memIdleHours * H && mem < o.memMax) {
      mem++;
      out.push({ name: s.name, reason: `idle ${hours} h while memory was low` });
    }
  }
  return out;
}

export async function reap(ctx: Ctx, env = process.env) {
  const idleHours = Number(env.IDLE_STOP_HOURS ?? 48);
  const minFreePct = Number(env.MEM_MIN_AVAILABLE_PCT ?? 15);
  // shortcut: memory is only measured here (local machines); remote machines get the plain idle rule.
  const memLow = minFreePct > 0 && freemem() / totalmem() * 100 < minFreePct;
  const ss = (await refresh(ctx)).map((s) => ({ ...s, local: !!ctx.cfg.machines.find((m) => m.id === s.machine)?.local }));
  const picks = pickIdle(ss, Date.now(), { idleHours, memIdleHours: Number(env.MEM_STOP_IDLE_HOURS ?? 2), memLow, memMax: 3 });
  for (const p of picks) {
    const row = ctx.db.session(p.name)!;
    const note = `Auto-stopped: ${p.reason}. session_send wakes it with its conversation.`;
    try {
      await stopSession(ctx, row, findMachine(ctx.cfg, row.machine), 'graceful', note);
      ctx.db.addEvent(p.name, 'AutoStop', 'stopped', note); // events_wait reports it
      console.log(`reaper: stopped ${p.name} (${p.reason})`);
    } catch (e) {
      console.error(`reaper: could not stop ${p.name}:`, (e as Error).message);
    }
  }
  return picks;
}

/** Run the cleanup every REAP_MINUTES (default 10; 0 disables). */
export function startReaper(ctx: Ctx) {
  const min = Number(process.env.REAP_MINUTES ?? 10);
  if (!(min > 0)) return;
  const t = setInterval(() => void reap(ctx).catch((e) => console.error('reaper:', (e as Error).message)), min * 60_000);
  t.unref();
}
