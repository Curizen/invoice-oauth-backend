import { pool } from '../db.js';
import { logger } from '../logger.js';
import { saveVoiceInvoice, type SavedVoiceInvoice, type VoiceInvoiceFields } from './manualInvoice.js';

// In-repo replacement for the old n8n "Voice Invoice via Webhook" workflow.
// One conversational agent (OpenAI, tool-calling) that can both take
// dictation for a new invoice AND answer questions about invoices already
// in the database — instead of only ever asking for missing invoice fields.

const log = logger.child({ component: 'voice-assistant' });
const BASE_CURRENCY = process.env.BASE_CURRENCY ?? 'USD';
const MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o';
const CATEGORIES = ['software', 'office_supplies', 'travel', 'equipment', 'utilities', 'services', 'other'];

type Role = 'system' | 'user' | 'assistant' | 'tool';

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

// ── Per-session conversation memory ─────────────────────────────────────────
// In-process only (fine for a single instance); bounded so it can't grow
// without limit across a long-running process.
const MAX_SESSIONS = 500;
const MAX_TURNS = 24; // user+assistant messages retained per session

const sessions = new Map<string, ChatMessage[]>();

function getHistory(sessionKey: string): ChatMessage[] {
  let hist = sessions.get(sessionKey);
  if (hist) {
    // Refresh LRU position.
    sessions.delete(sessionKey);
    sessions.set(sessionKey, hist);
    return hist;
  }
  hist = [];
  sessions.set(sessionKey, hist);
  if (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest !== undefined) sessions.delete(oldest);
  }
  return hist;
}

function pushHistory(sessionKey: string, ...msgs: ChatMessage[]) {
  const hist = getHistory(sessionKey);
  hist.push(...msgs);
  if (hist.length > MAX_TURNS) hist.splice(0, hist.length - MAX_TURNS);
}

// ── Whisper transcription (replaces n8n's Whisper node) ─────────────────────
export async function transcribeAudio(audioBase64: string, audioMime: string): Promise<string> {
  const buf = Buffer.from(audioBase64, 'base64');
  const ext = /mp4/.test(audioMime) ? 'mp4' : /mpeg|mp3/.test(audioMime) ? 'mp3' : /ogg/.test(audioMime) ? 'ogg' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([buf], { type: audioMime || 'audio/webm' }), `audio.${ext}`);
  form.append('model', 'whisper-1');
  // Pin the language: auto-detect misreads short/accented English clips as
  // other languages (e.g. Arabic), which then makes the assistant reply in them.
  form.append('language', 'en');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Whisper ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { text?: string };
  return data.text?.trim() ?? '';
}

// ── Tool: query_invoices — read-only lookup against the user's own invoices ─
interface QueryFilters {
  vendor?: string;
  category?: string;
  start_date?: string;
  end_date?: string;
  min_amount?: number;
  max_amount?: number;
  limit?: number;
  order_by?: 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc';
}

const ORDER_SQL: Record<string, string> = {
  date_desc: 'invoice_date DESC NULLS LAST',
  date_asc: 'invoice_date ASC NULLS LAST',
  amount_desc: 'normalized_amount DESC NULLS LAST',
  amount_asc: 'normalized_amount ASC NULLS LAST',
};

async function queryInvoices(userId: string, f: QueryFilters) {
  const limit = Math.min(Math.max(Math.trunc(f.limit ?? 10), 1), 25);
  const order = ORDER_SQL[f.order_by ?? 'date_desc'] ?? ORDER_SQL.date_desc;

  const where: string[] = ['user_id = $1'];
  const params: unknown[] = [userId];
  if (f.vendor) { params.push(`%${f.vendor}%`); where.push(`vendor ILIKE $${params.length}`); }
  if (f.category) { params.push(f.category); where.push(`category = $${params.length}`); }
  if (f.start_date) { params.push(f.start_date); where.push(`invoice_date >= $${params.length}`); }
  if (f.end_date) { params.push(f.end_date); where.push(`invoice_date <= $${params.length}`); }
  if (f.min_amount != null) { params.push(f.min_amount); where.push(`normalized_amount >= $${params.length}`); }
  if (f.max_amount != null) { params.push(f.max_amount); where.push(`normalized_amount <= $${params.length}`); }
  const whereSql = where.join(' AND ');

  const [rowsRes, aggRes] = await Promise.all([
    pool.query(
      `SELECT vendor, invoice_number, original_amount, original_currency,
              normalized_amount, base_currency, invoice_date, due_date,
              category, description, tax_amount, source
       FROM invoices WHERE ${whereSql} ORDER BY ${order} LIMIT ${limit}`,
      params,
    ),
    pool.query<{ count: string; total: string | null }>(
      `SELECT COUNT(*) AS count, SUM(normalized_amount) AS total FROM invoices WHERE ${whereSql}`,
      params,
    ),
  ]);

  return {
    matching_count: Number(aggRes.rows[0]?.count ?? 0),
    total_normalized_amount: Number(aggRes.rows[0]?.total ?? 0),
    base_currency: BASE_CURRENCY,
    invoices: rowsRes.rows,
  };
}

// ── Tool definitions ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'query_invoices',
      description:
        "Search the user's saved invoices and get accurate totals/counts. Always call this before answering " +
        'any question about past invoices, spending, vendors, categories, or amounts — never guess or estimate.',
      parameters: {
        type: 'object',
        properties: {
          vendor: { type: 'string', description: 'Filter by vendor name (partial match, case-insensitive).' },
          category: { type: 'string', enum: CATEGORIES },
          start_date: { type: 'string', description: 'YYYY-MM-DD, inclusive lower bound on invoice_date.' },
          end_date: { type: 'string', description: 'YYYY-MM-DD, inclusive upper bound on invoice_date.' },
          min_amount: { type: 'number' },
          max_amount: { type: 'number' },
          limit: { type: 'number', description: 'Max rows to return (default 10, max 25).' },
          order_by: { type: 'string', enum: ['date_desc', 'date_asc', 'amount_desc', 'amount_asc'] },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_invoice',
      description:
        'Save a new invoice/expense. Call this as soon as you know at least the vendor and amount — ' +
        'do not wait for extra confirmation from the user.',
      parameters: {
        type: 'object',
        properties: {
          vendor: { type: 'string' },
          amount: { type: 'number' },
          currency: { type: 'string', description: `3-letter currency code, defaults to ${BASE_CURRENCY}` },
          invoice_number: { type: 'string' },
          invoice_date: { type: 'string', description: 'YYYY-MM-DD, defaults to today' },
          due_date: { type: 'string', description: 'YYYY-MM-DD' },
          category: { type: 'string', enum: CATEGORIES },
          description: { type: 'string' },
          tax_amount: { type: 'number' },
        },
        required: ['vendor', 'amount'],
      },
    },
  },
];

const systemPrompt = (actorName: string) => `You are the invoice assistant inside Curizen Portal — a friendly, ` +
  `helpful bookkeeping copilot for ${actorName}. Be conversational and concise (1-3 sentences), like a sharp ` +
  `colleague, not a rigid form.

You can do two things:
1. Record a new invoice/expense the user dictates or types. Once you know at least the vendor and the amount, ` +
  `call save_invoice right away — don't ask for confirmation first, just save it and tell the user what you saved. ` +
  `Ask a short clarifying question only when the vendor or amount is genuinely missing or ambiguous. Default the ` +
  `currency to ${BASE_CURRENCY} and the date to today when not stated.
2. Answer questions about the user's existing invoices — spending totals, vendor history, categories, due dates, ` +
  `biggest/smallest invoices, counts over a period, anything. Always call query_invoices to get real numbers before ` +
  `answering; never invent or estimate figures. Summarize the result naturally, e.g. "You've spent $1,240 across 6 ` +
  `invoices from Acme this year."

Otherwise, just have a normal conversation — greetings, thanks, small talk, or explaining what you can help with.`;

interface OpenAIToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface OpenAIMessage { role: string; content: string | null; tool_calls?: OpenAIToolCall[] }
interface OpenAIChatResponse { choices: { message: OpenAIMessage }[] }

async function callOpenAI(messages: ChatMessage[]): Promise<OpenAIMessage> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.4,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.name ? { name: m.name } : {}),
      })),
      tools: TOOLS,
      tool_choice: 'auto',
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as OpenAIChatResponse;
  return data.choices[0].message;
}

export interface AssistantTurnInput {
  userId: string;
  sessionKey: string;
  actorName: string;
  text?: string | null;
  audioBase64?: string | null;
  audioMime?: string | null;
}

export interface AssistantTurnResult {
  reply: string;
  intent: 'ADD_INVOICE' | 'QUERY_INVOICES' | 'CHAT';
  saved: SavedVoiceInvoice | null;
  transcript?: string;
}

const MAX_TOOL_ROUNDS = 4;

export async function runAssistantTurn(input: AssistantTurnInput): Promise<AssistantTurnResult> {
  let userText = input.text?.trim() || '';
  let transcript: string | undefined;
  if (!userText && input.audioBase64) {
    transcript = await transcribeAudio(input.audioBase64, input.audioMime || 'audio/webm');
    userText = transcript;
  }
  if (!userText) return { reply: "I didn't catch that — could you try again?", intent: 'CHAT', saved: null };

  const history = getHistory(input.sessionKey);
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(input.actorName) },
    ...history,
    { role: 'user', content: userText },
  ];

  let saved: SavedVoiceInvoice | null = null;
  let intent: AssistantTurnResult['intent'] = 'CHAT';
  let finalReply = 'OK.';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const msg = await callOpenAI(messages);
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls });

    if (!msg.tool_calls?.length) {
      finalReply = msg.content?.trim() || 'OK.';
      break;
    }

    for (const call of msg.tool_calls) {
      let result: unknown;
      try {
        const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        if (call.function.name === 'query_invoices') {
          intent = 'QUERY_INVOICES';
          result = await queryInvoices(input.userId, args as QueryFilters);
        } else if (call.function.name === 'save_invoice') {
          intent = 'ADD_INVOICE';
          const fields: VoiceInvoiceFields = {
            vendor: args.vendor,
            amount: Number(args.amount),
            currency: args.currency ?? null,
            invoice_number: args.invoice_number ?? null,
            invoice_date: args.invoice_date ?? null,
            due_date: args.due_date ?? null,
            category: args.category ?? null,
            description: args.description ?? null,
            tax_amount: args.tax_amount ?? null,
          };
          saved = await saveVoiceInvoice(input.userId, input.actorName, fields);
          result = { ok: true, invoice: saved };
        } else {
          result = { error: `unknown tool ${call.function.name}` };
        }
      } catch (err) {
        log.error({ err, tool: call.function.name }, 'tool call failed');
        result = { error: 'That action failed — please try again.' };
      }
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: JSON.stringify(result) });
    }
  }

  pushHistory(input.sessionKey, { role: 'user', content: userText }, { role: 'assistant', content: finalReply });

  return { reply: finalReply, intent, saved, transcript };
}
