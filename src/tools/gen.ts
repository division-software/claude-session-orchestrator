// Image + video generation through the orchestrator: proxies genapi on nurhak-gpu (REST at GEN_API_URL, e.g.
// http://gen.lan) so claude.ai can make images and videos while genapi stays on the LAN/tailnet.
// Images: Z-Image Turbo (~10-20 s). Videos: MiniMax H3 via VideoTurko (minutes). One GPU job at a time.
// Without GEN_API_URL these tools are not offered.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { UserError } from '../config.ts';
import { tool, type Ctx } from './common.ts';

export interface Job {
  id: string; kind: string; state: string; url?: string; error?: string; warning?: string; queue_position?: number;
  params?: Record<string, unknown>; created?: number; started?: number; finished?: number;
}

async function gen<T = Job>(path: string, body?: object): Promise<T> {
  const url = process.env.GEN_API_URL!.replace(/\/$/, '') + path;
  let r: Response;
  try {
    r = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new UserError(`Image/video generation is not reachable (${(e as Error).message.slice(0, 120)}). Is genapi running on nurhak-gpu?`);
  }
  const j = await r.json().catch(() => ({})) as T & { error?: string };
  if (!r.ok) throw new UserError(`Generation refused: ${j.error ?? `HTTP ${r.status}`}.`);
  return j;
}

/** One speakable sentence for a job. */
export function describe(j: Job): string {
  const what = j.kind === 'image' ? 'Image' : 'Video';
  if (j.state === 'done') return `${what} ${j.id} is ready: ${j.url}${j.warning ? ` (${j.warning})` : ''}`;
  if (j.state === 'failed') return `${what} job ${j.id} failed: ${j.error}`;
  if (j.state === 'queued') return `${what} job ${j.id} is queued${j.queue_position ? ` at position ${j.queue_position}` : ''}; check it with gen_status.`;
  return `${what} job ${j.id} is running; check it with gen_status.`;
}

const pending = (j: Job) => j.state === 'queued' || j.state === 'running';

export function register(server: McpServer, ctx: Ctx) {
  if (!process.env.GEN_API_URL) return;
  const waitMs = Number(process.env.GEN_WAIT_MS ?? 90_000);

  tool(server, ctx, 'gen_image', 'Make an image on the home GPU (Z-Image Turbo). Plain descriptive English works best: subject, setting, light, style; no negative prompt. Usually ready in 10-20 s; if the GPU is busy (e.g. a video) you get a job id to check with gen_status. The result is a URL on the home network (gen.lan), reachable over LAN/Tailscale only.',
    {
      prompt: z.string().min(1).max(2000),
      width: z.number().int().min(256).max(2048).default(1024).describe('Multiple of 64. 1344x768 = 16:9, 768x1344 = 9:16'),
      height: z.number().int().min(256).max(2048).default(1024).describe('Multiple of 64'),
      steps: z.number().int().min(1).max(30).default(8).describe('8 is best; 6 is faster with slightly less detail'),
      seed: z.number().int().optional().describe('Fixed seed to reproduce an image; random when omitted'),
    },
    async ({ prompt, width, height, steps, seed }) => {
      let job = await gen('/api/image', { prompt, width, height, steps, seed, wait: false });
      const end = Date.now() + waitMs;
      while (pending(job) && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 2000));
        job = await gen(`/api/jobs/${encodeURIComponent(job.id)}`);
      }
      return { summary: describe(job), ...job };
    });

  tool(server, ctx, 'gen_video', 'Start a short video with sound on the home GPU (MiniMax H3, 640x384, 24 fps) and return a job id at once; check it with gen_status (56 frames take ~1.5 min). Prompt: one English paragraph describing one continuous shot, optionally an "audio:" sentence. To animate an image, pass the id of a finished gen_image job as init_image_job. Note: the MiniMax H3 licence excludes use in the EU, UK, US and South Korea.',
    {
      prompt: z.string().min(1).max(4000),
      frames: z.number().int().min(22).max(209).default(56).describe('On the 17k+5 grid: 56 (2.3 s), 73, 90, 107, 124, 141 (5.9 s) ... 209 (8.7 s)'),
      seed: z.number().int().default(42),
      width: z.number().int().default(640).describe('Multiple of 32, area at least 640x384'),
      height: z.number().int().default(384).describe('Multiple of 32'),
      init_image_job: z.string().optional().describe('Id of a finished gen_image job to use as the first frame (max 192 frames)'),
    },
    async (args) => {
      const job = await gen('/api/video', args);
      return { summary: describe(job), ...job };
    });

  tool(server, ctx, 'gen_status', 'State of an image/video job (queued, running, done with its URL, or failed). Without job_id: the most recent jobs.',
    { job_id: z.string().optional(), limit: z.number().int().min(1).max(50).default(10) },
    async ({ job_id, limit }) => {
      if (job_id) {
        const job = await gen(`/api/jobs/${encodeURIComponent(job_id)}`);
        if (!job.id) throw new UserError(`No generation job ${job_id}.`);
        return { summary: describe(job), ...job };
      }
      const jobs = await gen<Job[]>(`/api/jobs?limit=${limit}`);
      const busy = jobs.filter(pending).length;
      return {
        summary: jobs.length ? `${jobs.length} recent job${jobs.length === 1 ? '' : 's'}, ${busy} still queued or running. Latest: ${describe(jobs[0])}` : 'No generation jobs yet.',
        jobs,
      };
    });
}
