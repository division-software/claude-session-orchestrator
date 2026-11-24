// One Durable Object per user (id derived only from the signed-in user id). It holds that user's
// agent WebSocket and relays tool calls to it. It runs no user code and stores no secrets: only the
// agent's advertised tool list, so tools/list still answers while the agent is offline.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index.ts';

export interface ToolInfo { name: string; title?: string; description?: string; inputSchema: unknown; annotations?: unknown }
type Result = { content: unknown[]; isError?: boolean; [k: string]: unknown };

const CALL_TIMEOUT_MS = 120_000;
const MAX_TOOLS = 200;

export class UserHub extends DurableObject<Env> {
  private pending = new Map<string, { resolve: (r: Result) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** Called by the Worker after it has verified the agent token for this user. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    for (const old of this.ctx.getWebSockets('agent')) old.close(4000, 'replaced by a newer agent connection');
    this.ctx.acceptWebSocket(server, ['agent']);
    server.serializeAttachment({ since: Date.now(), tokenId: request.headers.get('x-agent-token-id') });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(_ws: WebSocket, raw: string | ArrayBuffer) {
    let msg: { type?: string; id?: string; result?: Result; tools?: ToolInfo[] };
    try { msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return; }
    if (msg.type === 'hello' && Array.isArray(msg.tools)) {
      await this.ctx.storage.put('tools', msg.tools.slice(0, MAX_TOOLS));
    } else if (msg.type === 'result' && typeof msg.id === 'string') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.resolve(msg.result && Array.isArray(msg.result.content) ? msg.result : { content: [{ type: 'text', text: 'Malformed agent result.' }], isError: true });
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    // Only when no live socket is left: in-flight calls on a newer socket are still being answered.
    if (!this.agent()) this.failPending('Your orchestrator agent disconnected during the call; it reconnects within seconds. Try again.');
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed'); } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket) {
    try { ws.close(1011, 'error'); } catch { /* already closed */ }
  }

  async tools(): Promise<ToolInfo[]> { return (await this.ctx.storage.get<ToolInfo[]>('tools')) ?? []; }

  /**
   * The live agent socket: the newest OPEN one. A socket whose peer vanished (close 1006) can stay listed,
   * CLOSING, long after the agent reconnected; [0] was that dead one, so every call failed for hours.
   */
  private agent(): WebSocket | undefined {
    const since = (ws: WebSocket) => (ws.deserializeAttachment() as { since?: number } | null)?.since ?? 0;
    return this.ctx.getWebSockets('agent').filter((ws) => ws.readyState === WebSocket.OPEN).sort((a, b) => since(b) - since(a))[0];
  }

  /** Answer every in-flight call at once instead of letting each wait out CALL_TIMEOUT_MS. */
  private failPending(summary: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.resolve({ content: [{ type: 'text', text: JSON.stringify({ summary }) }], isError: true });
    }
  }

  async status() {
    const ws = this.agent();
    const tools = await this.tools();
    return { online: !!ws, since: ws ? (ws.deserializeAttachment() as { since: number }).since : null, tools: tools.length };
  }

  /** Relay one tools/call to the agent; resolves with the agent's CallToolResult. */
  async call(name: string, args: unknown): Promise<Result | null> {
    const ws = this.agent();
    if (!ws) return null; // offline: the caller explains how to start the agent
    const id = crypto.randomUUID();
    return new Promise<Result>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ content: [{ type: 'text', text: JSON.stringify({ summary: 'Your orchestrator agent did not answer within 2 minutes.' }) }], isError: true });
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      try {
        ws.send(JSON.stringify({ type: 'call', id, name, args }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ content: [{ type: 'text', text: JSON.stringify({ summary: 'Your orchestrator agent just disconnected; it reconnects within seconds. Try again.' }) }], isError: true });
      }
    });
  }

  /** Revocation: drop the live connection that used a revoked token. */
  async disconnect(tokenId: string) {
    for (const ws of this.ctx.getWebSockets('agent')) {
      if ((ws.deserializeAttachment() as { tokenId?: string }).tokenId === tokenId) ws.close(4001, 'agent token revoked');
    }
  }
}
