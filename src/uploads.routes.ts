import { Router, type Request, type Response } from 'express';
import { pool, getInvoiceStore } from './db.js';
import { logger } from './logger.js';
import { saveUploadedInvoice, extractUploadedInvoice } from './pipeline/uploadInvoice.js';
import type { ExtractedInvoice } from './pipeline/llm.js';

// Manual invoice upload: the UI base64-encodes a PDF/image and posts it here.
// We file it in the user's chosen OneDrive and extract + save to invoices.

export const uploadRoutes = Router();

// Dashboard upload flow (file picker + camera): extract fields for review
// first, without saving anything, so a misread date/amount/vendor can be
// corrected before it's written to OneDrive or Supabase.
uploadRoutes.post('/upload-invoice/extract', async (req: Request, res: Response) => {
  const body = req.body as { filename?: string; contentType?: string; dataBase64?: string };
  if (!body.dataBase64 || !body.filename) {
    return res.status(400).json({ error: 'filename and dataBase64 required' });
  }
  const contentType = body.contentType ?? '';
  if (!/pdf|image/i.test(contentType)) {
    return res.status(400).json({ error: 'Only PDF or image files are supported' });
  }
  const buffer = Buffer.from(body.dataBase64, 'base64');
  if (buffer.length > 20 * 1024 * 1024) {
    return res.status(413).json({ error: 'File too large (max 20 MB).' });
  }

  try {
    const extracted = await extractUploadedInvoice(buffer, contentType, body.filename);
    res.json({ extracted });
  } catch (err) {
    logger.error({ err }, 'upload-invoice/extract failed');
    res.status(500).json({ error: 'Failed to read the file' });
  }
});

// Step 2 of the review flow: the user confirms (optionally edited) fields,
// so we file it in OneDrive and save to invoices using exactly those fields.
uploadRoutes.post('/upload-invoice/confirm', async (req: Request, res: Response) => {
  const body = req.body as {
    filename?: string;
    contentType?: string;
    dataBase64?: string;
    invoice?: ExtractedInvoice;
  };
  if (!body.dataBase64 || !body.filename || !body.invoice) {
    return res.status(400).json({ error: 'filename, dataBase64 and invoice required' });
  }
  const contentType = body.contentType ?? '';
  if (!/pdf|image/i.test(contentType)) {
    return res.status(400).json({ error: 'Only PDF or image files are supported' });
  }
  if (!body.invoice.vendor || !Number.isFinite(Number(body.invoice.amount))) {
    return res.status(400).json({ error: 'Vendor and a numeric amount are required' });
  }

  try {
    const storeConnectionId = await getInvoiceStore(req.userId!);
    if (!storeConnectionId) {
      return res.status(400).json({
        error: 'Choose a OneDrive storage account first (dashboard → Invoice storage).',
      });
    }

    const buffer = Buffer.from(body.dataBase64, 'base64');
    if (buffer.length > 20 * 1024 * 1024) {
      return res.status(413).json({ error: 'File too large (max 20 MB).' });
    }

    const { rows } = await pool.query<{ email: string }>(
      `SELECT email FROM app_users WHERE id = $1`,
      [req.userId!],
    );

    const result = await saveUploadedInvoice({
      userId: req.userId!,
      storeConnectionId,
      actorName: rows[0]?.email ?? 'Upload',
      filename: body.filename,
      contentType,
      buffer,
      invoice: {
        vendor: body.invoice.vendor,
        invoice_number: body.invoice.invoice_number ?? null,
        amount: Number(body.invoice.amount) || 0,
        currency: (body.invoice.currency || 'USD').toUpperCase(),
        invoice_date: body.invoice.invoice_date ?? null,
        due_date: body.invoice.due_date ?? null,
        category: body.invoice.category || 'other',
        description: body.invoice.description ?? '',
        tax_amount: Number(body.invoice.tax_amount) || 0,
      },
    });
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'upload-invoice/confirm failed');
    res.status(500).json({ error: 'Failed to save the invoice' });
  }
});

// Legacy single-shot path (extract + save, no review step) — kept for the
// voice assistant's camera-to-chat flow, which has its own conversational
// confirmation before saving.
uploadRoutes.post('/upload-invoice', async (req: Request, res: Response) => {
  const body = req.body as { filename?: string; contentType?: string; dataBase64?: string };
  if (!body.dataBase64 || !body.filename) {
    return res.status(400).json({ error: 'filename and dataBase64 required' });
  }
  const contentType = body.contentType ?? '';
  if (!/pdf|image/i.test(contentType)) {
    return res.status(400).json({ error: 'Only PDF or image files are supported' });
  }

  try {
    const storeConnectionId = await getInvoiceStore(req.userId!);
    if (!storeConnectionId) {
      return res.status(400).json({
        error: 'Choose a OneDrive storage account first (dashboard → Invoice storage).',
      });
    }

    const buffer = Buffer.from(body.dataBase64, 'base64');
    if (buffer.length > 20 * 1024 * 1024) {
      return res.status(413).json({ error: 'File too large (max 20 MB).' });
    }

    const { rows } = await pool.query<{ email: string }>(
      `SELECT email FROM app_users WHERE id = $1`,
      [req.userId!],
    );

    const result = await saveUploadedInvoice({
      userId: req.userId!,
      storeConnectionId,
      actorName: rows[0]?.email ?? 'Upload',
      filename: body.filename,
      contentType,
      buffer,
    });
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'upload-invoice failed');
    res.status(500).json({ error: 'Failed to process the upload' });
  }
});
