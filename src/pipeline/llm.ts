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

const DATE_RULES = `DATE RULES (read carefully — dates are frequently misread):
- Always output dates as YYYY-MM-DD.
- Invoices use different regional formats (DD/MM/YYYY, MM/DD/YYYY, DD.MM.YYYY, etc.). Never assume
  month-first. If the first number is > 12, it must be the day (e.g. 25/03/2026 -> 2026-03-25).
  If both numbers could be a valid month, look for the month spelled out elsewhere on the document,
  or any other date on the page (e.g. due date) that disambiguates the format, before guessing.
- A 2-digit year is 20YY unless the document clearly indicates otherwise.
- If a date is smudged, cropped, at an angle, or you are not reasonably confident in every digit,
  output null for that field rather than guessing — a missing date can be filled in by a human, a
  wrong one silently corrupts the record.`;

const PROMPT = (email: EmailMeta, attachmentName: string, pdfText: string) => `Extract all invoice fields from this email and its attached PDF invoice.

TODAY'S DATE: ${new Date().toISOString().slice(0, 10)}

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
- If the total amount is unclear (multiple totals, tax lines, discounts), prefer the amount
  explicitly labeled "Total" / "Amount Due" / "Grand Total" over a subtotal
- If you are not confident about a field's value, output null (for optional fields) or your best
  single guess only for required fields — never fabricate specifics (invoice numbers, exact cents)
  that aren't legible
- Return ONLY a raw JSON object, no markdown, no code blocks, no explanation
- Start with { and end with }

${DATE_RULES}

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
function parseInvoiceJson(raw: string, fallbackVendor: string): ExtractedInvoice {
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
    vendor: parsed.vendor ?? fallbackVendor ?? 'Unknown Vendor',
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

export async function extractInvoiceFields(
  email: EmailMeta,
  attachmentName: string,
  pdfText: string,
): Promise<ExtractedInvoice> {
  const raw = await callOpenAI(PROMPT(email, attachmentName, pdfText));
  return parseInvoiceJson(raw, email.fromName);
}

const IMAGE_PROMPT = (filename: string) => `You are given a photo of an invoice or receipt (filename: ${filename}). Read the image carefully and extract all invoice fields.

TODAY'S DATE: ${new Date().toISOString().slice(0, 10)}

This is a phone photo, not a scan — expect glare, tilt, shadows, or partially cropped edges.
Zoom into small text (dates, invoice numbers, totals) mentally before answering; do not skim.

- If the total amount is unclear (multiple totals, tax lines, discounts), prefer the amount
  explicitly labeled "Total" / "Amount Due" / "Grand Total" over a subtotal
- If you are not confident about a field's value, output null (for optional fields) or your best
  single guess only for required fields — never fabricate specifics (invoice numbers, exact cents)
  that aren't legible
- Return ONLY a raw JSON object, no markdown, no code blocks, no explanation
- Start with { and end with }

${DATE_RULES}

Return JSON with exactly these fields:
- vendor (company name issuing the invoice)
- invoice_number (the invoice ID or reference number, or null)
- amount (total amount as a number only, no currency symbol)
- currency (3-letter code e.g. USD, EUR, GBP, SAR)
- invoice_date (YYYY-MM-DD format or null)
- due_date (YYYY-MM-DD format or null)
- category (one of: software/office_supplies/travel/equipment/utilities/services/other)
- description (short description of what the invoice is for)
- tax_amount (tax amount as a number, 0 if not found)`;

/** Vision extraction for image invoices (JPEG/PNG/etc.) using GPT-4o. */
export async function extractInvoiceFromImage(
  imageBase64: string,
  contentType: string,
  filename: string,
): Promise<ExtractedInvoice> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? 'gpt-4o',
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: IMAGE_PROMPT(filename) },
            // 'high' detail keeps the model reading a higher-resolution tiled
            // version of the image instead of a single downscaled pass — the
            // default otherwise blurs exactly the small text (dates, invoice
            // numbers) this app depends on getting right.
            { type: 'image_url', image_url: { url: `data:${contentType};base64,${imageBase64}`, detail: 'high' } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI vision ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return parseInvoiceJson(data.choices[0]?.message?.content ?? '', 'Unknown Vendor');
}
