// WhatsApp through the orchestrator: proxies a few tools of the local WhatsApp MCP (whatsapp-mcp on
// 127.0.0.1:8742), so claude.ai can use WhatsApp via this connector while that MCP stays private.
// Config: WHATSAPP_ENV_FILE = the bridge's .env (its MCP_TOKEN is read at call time, never copied),
// WHATSAPP_MCP_URL (default http://127.0.0.1:8742/mcp). Without WHATSAPP_ENV_FILE these tools are not offered.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { UserError } from '../config.ts';
import { tool, type Ctx } from './common.ts';

function token(file: string): string {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { throw new UserError('WhatsApp is not reachable: its token file cannot be read.'); }
  const m = text.match(/^\s*MCP_TOKEN\s*=\s*["']?([^"'\s]+)/m);
  if (!m) throw new UserError('WhatsApp is not reachable: MCP_TOKEN is missing from its token file.');
  return m[1];
}

/** Call one tool on the WhatsApp MCP; returns each text block, JSON-parsed where possible. */
async function wa(name: string, args: Record<string, unknown>): Promise<unknown[]> {
  const url = process.env.WHATSAPP_MCP_URL ?? 'http://127.0.0.1:8742/mcp';
  const client = new Client({ name: 'session-orchestrator', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token(process.env.WHATSAPP_ENV_FILE!)}` } },
  });
  try {
    await client.connect(transport);
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 }) as { isError?: boolean; content: { type: string; text?: string }[] };
    const out = r.content.filter((c) => c.type === 'text').map((c) => { try { return JSON.parse(c.text!); } catch { return c.text; } });
    if (r.isError) throw new UserError(`WhatsApp ${name} failed: ${String(out[0] ?? '').slice(0, 200)}`);
    return out;
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError(`WhatsApp is not reachable (${(e as Error).message.slice(0, 120)}). Is whatsapp-mcp running on node2?`);
  } finally {
    await client.close().catch(() => {});
  }
}

const flat = (xs: unknown[]) => xs.flatMap((x) => (Array.isArray(x) ? x : [x]));

export interface WaLine { at: string; chat: string | null; from: string; text: string }

/** Parse whatsapp-mcp's message listing: "[YYYY-MM-DD HH:MM:SS] Chat: <name> From: <who>: <text>", text may span lines. */
export function parseMessages(text: string): WaLine[] {
  const out: WaLine[] = [];
  for (const l of text.split('\n')) {
    const m = l.match(/^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\] (?:Chat: (.*?) )?From: (.*?): (.*)$/);
    if (m) out.push({ at: m[1], chat: m[2] ?? null, from: m[3], text: m[4] });
    else if (out.length && l) out.at(-1)!.text += `\n${l}`;
  }
  return out;
}

const messagesText = (r: unknown[]) => r.filter((x): x is string => typeof x === 'string').join('\n');
// Phone number with country code (digits only) or a WhatsApp JID; never a name, so a send cannot go to a guessed contact.
const RECIPIENT = /^(?:\d{8,15}|\d{8,15}(?:-\d+)?@(?:s\.whatsapp\.net|g\.us)|\d{10,25}@g\.us)$/;

export function register(server: McpServer, ctx: Ctx) {
  if (!process.env.WHATSAPP_ENV_FILE) return;

  tool(server, ctx, 'whatsapp_search', 'Search WhatsApp: chats and contacts whose name or number matches, and messages containing the text. Use it to find the phone number or chat JID before whatsapp_send.',
    {
      query: z.string().min(1),
      chat_jid: z.string().optional().describe('Only messages in this chat (JID from a previous result)'),
      after: z.string().optional().describe('ISO date: only messages after it'),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async ({ query, chat_jid, after, limit }) => {
      const [chats, contacts, msgs] = await Promise.all([
        wa('list_chats', { query, limit: 10, include_last_message: false }),
        wa('search_contacts', { query }),
        wa('list_messages', { query, chat_jid, after, limit, include_context: false }),
      ]);
      const messages = parseMessages(messagesText(msgs));
      const c = flat(chats), p = flat(contacts);
      return {
        summary: `${messages.length} message${messages.length === 1 ? '' : 's'} mention "${query}"; ${c.length} chat${c.length === 1 ? '' : 's'} and ${p.length} contact${p.length === 1 ? '' : 's'} match.`,
        chats: c, contacts: p, messages,
      };
    });

  tool(server, ctx, 'whatsapp_summary', 'Recent WhatsApp activity: message counts per chat for the last hours (most active first) and the messages themselves, to summarize or answer "what did I miss?".',
    {
      hours: z.number().min(1).max(24 * 14).default(24),
      chat_jid: z.string().optional().describe('Only this chat'),
      limit: z.number().int().min(1).max(500).default(200),
    },
    async ({ hours, chat_jid, limit }) => {
      const after = new Date(Date.now() - hours * 3600_000).toISOString();
      const messages = parseMessages(messagesText(await wa('list_messages', { after, chat_jid, limit, include_context: false })));
      const by = new Map<string, { chat: string; messages: number; from_others: number; last: string }>();
      for (const m of messages) {
        const k = m.chat ?? 'unknown chat';
        const e = by.get(k) ?? { chat: k, messages: 0, from_others: 0, last: m.at };
        e.messages++;
        if (m.from !== 'Me') e.from_others++;
        if (m.at > e.last) e.last = m.at;
        by.set(k, e);
      }
      const chats = [...by.values()].sort((a, b) => b.messages - a.messages);
      const top = chats.slice(0, 3).map((c) => `${c.chat} (${c.messages})`).join(', ');
      return {
        summary: messages.length
          ? `${messages.length} message${messages.length === 1 ? '' : 's'} in the last ${hours} h across ${chats.length} chat${chats.length === 1 ? '' : 's'}. Most active: ${top}.${messages.length >= limit ? ' More exist; raise limit to see them.' : ''}`
          : `No WhatsApp messages in the last ${hours} h.`,
        chats, messages,
      };
    });

  tool(server, ctx, 'whatsapp_send', 'Send a WhatsApp text message. Needs an explicit recipient (phone number with country code, digits only, or a chat JID from whatsapp_search; never a name) and the exact text, and confirm=true after the user approved both.',
    {
      recipient: z.string().describe('Phone number with country code, digits only (e.g. 31612345678), or a JID like 31612345678@s.whatsapp.net or 1203...@g.us'),
      text: z.string().min(1).max(4000).describe('The exact message text'),
      confirm: z.boolean().optional().describe('true only after the user approved this recipient and text'),
    },
    async ({ recipient, text, confirm }) => {
      const to = recipient.trim().replace(/^\+/, '');
      if (!RECIPIENT.test(to)) throw new UserError(`"${recipient}" is not a phone number or chat JID. Look it up with whatsapp_search first.`);
      if (!text.trim()) throw new UserError('The message text is empty.');
      if (confirm !== true) throw new UserError(`Sending "${text.slice(0, 80)}" to ${to} needs confirm=true. Read the recipient and text back to the user and ask first.`);
      const [r] = await wa('send_message', { recipient: to, message: text });
      const res = (r ?? {}) as { success?: boolean; message?: string };
      if (!res.success) throw new UserError(`WhatsApp did not send it: ${res.message ?? 'unknown error'}.`);
      return { summary: `Sent to ${to}.`, recipient: to };
    });
}
