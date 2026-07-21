import { Router, type Request, type Response } from 'express';
import { pool, getInvoiceStore } from './db.js';
import { logger } from './logger.js';
import { saveUploadedInvoice } from './pipeline/uploadInvoice.js';

// Manual invoice upload: the UI base64-encodes a PDF/image and posts it here.
// We file it in the user's chosen OneDrive and extract + save to invoices.

export const uploadRoutes = Router();

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
