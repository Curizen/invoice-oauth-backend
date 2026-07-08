/**
 * Port of the n8n "Extract Invoice Fields" (GPT-4o agent) node and the
 * "Code in JavaScript" cleanup node. Same prompt, same fallback logic.
 */

export interface EmailMeta {
  subject: string;
  fromAddress: string;
  fromName: string;
  bodyPreview: string;
  receivedDateTime: string;
  messageId: string;
}

export interface ExtractedInvoice {
  vendor: string;
  invoice_number: string | null;
  amount: number;
  currency: string;
  invoice_date: string | null;
  due_date: string | null;
  category: string;
  description: string;
  tax_amount: number;
}

const PROMPT = (email: EmailMeta, attachmentName: string, pdfText: string) => `Extract all invoice fields from this email and its attached PDF invoice.

EMAIL SUBJECT: ${email.subject}
FROM EMAIL: ${email.fromAddress || 'unknown'}
SENDER NAME: ${email.fromName || 'unknown'}
EMAIL BODY: ${email.bodyPreview}
ATTACHMENT NAME: ${attachmentName}
RECEIVED DATE: ${email.receivedDateTime}

PDF CONTENT (text):
${pdfText.slice(0, 15000)}

INSTRUCTIONS:
- Read the PDF content above to extract the invoice fields
- The PDF contains the actual invoice — prioritize data from it over the email body
- If a field is not found in the PDF, try extracting it from the email subject or body
- The vendor is usually the company that sent the invoice
- Return ONLY a raw JSON object, no markdown, no code blocks, no explanation
- Start with { and end with }

Return JSON with exactly these fields:
- vendor (company name issuing the invoice)
- invoice_number (the invoice ID or reference number)
- amount (total amount as a number only, no currency symbol)
- currency (3-letter code e.g. USD, EUR, GBP, SAR)
- invoice_date (YYYY-MM-DD format)
- due_date (YYYY-MM-DD format or null if not found)
- category (one of: software/office_supplies/travel/equipment/utilities/services/other)
- description (short description of what the invoice is for)
- tax_amount (tax amount as a number, 0 if not found)`;

async function callOpenAI(prompt: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return data.choices[0]?.message?.content ?? '';
}

/** Port of the "Code in JavaScript" node: strip fences, find {...}, fallbacks. */
export async function extractInvoiceFields(
  email: EmailMeta,
  attachmentName: string,
  pdfText: string,
): Promise<ExtractedInvoice> {
  const raw = await callOpenAI(PROMPT(email, attachmentName, pdfText));
  const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');

  let parsed: Partial<ExtractedInvoice> = {};
  if (start !== -1 && end !== -1) {
    try {
      parsed = JSON.parse(cleaned.substring(start, end + 1));
    } catch {
      parsed = {};
    }
  }

  return {
    vendor: parsed.vendor ?? email.fromName ?? 'Unknown Vendor',
    invoice_number: parsed.invoice_number ?? null,
    amount: Number(parsed.amount ?? 0) || 0,
    currency: parsed.currency ?? 'USD',
    invoice_date: parsed.invoice_date ?? null,
    due_date: parsed.due_date ?? null,
    category: parsed.category ?? 'other',
    description: parsed.description ?? '',
    tax_amount: Number(parsed.tax_amount ?? 0) || 0,
  };
}
