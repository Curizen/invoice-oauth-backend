import { Router, type Request, type Response } from 'express';
import { pool } from './db.js';
import { logger } from './logger.js';
import { runAssistantTurn } from './pipeline/voiceAssistant.js';

// Browser-facing endpoint for the invoice chat assistant. The UI records a
// voice note (or types) and POSTs it here; we inject the AUTHENTICATED user's
// id + name server-side so the browser can never dictate whose books an
// invoice lands in. The assistant (see pipeline/voiceAssistant.ts) transcribes
// audio, holds a conversation, and can both dictate-and-save new invoices AND
// answer questions about invoices already in the database.

export const voiceRoutes = Router();

interface VoiceTurnBody {
  sessionId?: string;
  text?: string;
  audioBase64?: string;
  audioMime?: string;
}

voiceRoutes.post('/voice-invoice', async (req: Request, res: Response) => {
  const body = req.body as VoiceTurnBody;
  if (!body.sessionId) return res.status(400).json({ error: 'sessionId required' });
  if (!body.text && !body.audioBase64) {
    return res.status(400).json({ error: 'text or audioBase64 required' });
  }

  try {
    const { rows } = await pool.query<{ email: string }>(
      `SELECT email FROM app_users WHERE id = $1`,
      [req.userId!],
    );
    const actorName = rows[0]?.email ?? 'Voice User';

    // Namespace the memory key by user so two people can't share a conversation.
    const result = await runAssistantTurn({
      userId: req.userId!,
      sessionKey: `${req.userId}:${body.sessionId}`,
      actorName,
      text: body.text ?? null,
      audioBase64: body.audioBase64 ?? null,
      audioMime: body.audioMime ?? null,
    });

    res.json({
      reply: result.reply,
      intent: result.intent,
      transcript: result.transcript,
      invoice: result.saved,
    });
  } catch (err) {
    logger.error({ err }, 'voice-invoice request failed');
    res.status(500).json({ error: 'Voice assistant request failed' });
  }
});
