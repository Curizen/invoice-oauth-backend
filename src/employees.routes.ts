import { Router, type Request, type Response } from 'express';
import { pool } from './db.js';
import { logger } from './logger.js';
import { computeEmployeeAlerts, daysUntil, CONTRACT_EXPIRY_WINDOW_DAYS } from './employeeAlerts.js';
import { pdfToText, extractContractFields } from './pipeline/contractExtract.js';
import {
  newRowId,
  fieldAad,
  encryptNumber,
  decryptNumber,
  encryptBuffer,
  decryptBuffer,
  encryptJson,
} from './fieldCrypto.js';

// Employees section: list + detail, contract PDF upload with AI extraction
// (via the n8n Claude webhook), vacation/sick/bonus tracking and salary
// history. All rows are scoped to the authenticated app user.
//
// Salaries, bonus/history amounts, contract PDFs and extracted contract JSON
// are encrypted at rest (see fieldCrypto.ts): the routes encrypt on write and
// decrypt on read, so API responses keep their original plaintext shape. Row
// ids are generated app-side wherever an encrypted value is inserted, because
// the AAD includes the row id and must be known before the INSERT.

export const employeeRoutes = Router();

const EMPLOYEE_COLS = `id, name, role, salary_enc, salary_currency, contract_start, contract_end, contract_type,
       probation_end, notice_period, vacation_days_allowed, sick_days_allowed, status, created_at`;

/** Decrypt salary_enc into the `salary` field API consumers expect. */
function withSalary<T extends { id: string; salary_enc?: Buffer | null }>(row: T) {
  const { salary_enc, ...rest } = row;
  return {
    ...rest,
    salary: salary_enc ? decryptNumber(salary_enc, fieldAad('employees', 'salary', row.id)) : '0',
  };
}

/** Resolve an employee row only if it belongs to this user. */
async function ownedEmployee(userId: string, employeeId: string) {
  const { rows } = await pool.query(
    `SELECT ${EMPLOYEE_COLS} FROM employees WHERE id = $1 AND user_id = $2`,
    [employeeId, userId],
  );
  return rows[0] ? withSalary(rows[0]) : null;
}

employeeRoutes.get('/employees', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.*, (c.id IS NOT NULL) AS has_contract
       FROM (SELECT ${EMPLOYEE_COLS} FROM employees WHERE user_id = $1) e
       LEFT JOIN LATERAL (
         SELECT id FROM employee_contracts WHERE employee_id = e.id
         ORDER BY uploaded_at DESC LIMIT 1
       ) c ON true
       ORDER BY e.status = 'active' DESC, e.name`,
      [req.userId!],
    );
    const today = new Date();
    res.json(
      rows.map((e) => ({
        ...withSalary(e),
        contract_expiring:
          e.contract_end != null && daysUntil(e.contract_end, today) <= CONTRACT_EXPIRY_WINDOW_DAYS,
        contract_days_left: e.contract_end != null ? daysUntil(e.contract_end, today) : null,
      })),
    );
  } catch (err) {
    logger.error({ err }, 'list employees failed');
    res.status(500).json({ error: 'Failed to load employees' });
  }
});

employeeRoutes.post('/employees', async (req: Request, res: Response) => {
  const b = req.body as {
    name?: string; role?: string; salary?: number | string; salary_currency?: string;
    contract_start?: string; contract_end?: string; contract_type?: string;
  };
  if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'name is required' });
  const salary = Number(b.salary ?? 0);
  if (!Number.isFinite(salary) || salary < 0) {
    return res.status(400).json({ error: 'salary must be a non-negative number' });
  }
  if (b.contract_type != null && b.contract_type !== 'fixed' && b.contract_type !== 'indefinite') {
    return res.status(400).json({ error: 'contract_type must be fixed or indefinite' });
  }
  // An indefinite-term contract has no end date by definition.
  const contractType = b.contract_type ?? 'fixed';
  const contractEnd = contractType === 'indefinite' ? null : b.contract_end || null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const employeeId = newRowId();
    const { rows } = await client.query(
      `INSERT INTO employees (id, user_id, name, role, salary_enc, salary_currency, contract_start, contract_end, contract_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${EMPLOYEE_COLS}`,
      [
        employeeId, req.userId!, b.name.trim(), b.role?.trim() || null,
        encryptNumber(salary, fieldAad('employees', 'salary', employeeId)),
        (b.salary_currency || 'USD').toUpperCase(), b.contract_start || null, contractEnd, contractType,
      ],
    );
    if (salary > 0) {
      const historyId = newRowId();
      await client.query(
        `INSERT INTO employee_salary_history (id, employee_id, user_id, old_amount_enc, new_amount_enc, currency)
         VALUES ($1, $2, $3, NULL, $4, $5)`,
        [
          historyId, employeeId, req.userId!,
          encryptNumber(salary, fieldAad('employee_salary_history', 'new_amount', historyId)),
          rows[0].salary_currency,
        ],
      );
    }
    await client.query('COMMIT');
    res.status(201).json(withSalary(rows[0]));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err }, 'create employee failed');
    res.status(500).json({ error: 'Failed to add employee' });
  } finally {
    client.release();
  }
});

// One-shot flow: upload a contract PDF, AI-extract the fields, and create the
// employee from them in a single request. The PDF lands in employee_contracts
// exactly like a normal per-employee upload. Nothing is created when
// extraction fails or finds no employee name — junk rows are worse than a
// retry, and the manual add form is right there.
employeeRoutes.post('/employees/from-contract', async (req: Request, res: Response) => {
  const b = req.body as { filename?: string; contentType?: string; dataBase64?: string };
  if (!b.dataBase64 || !b.filename) {
    return res.status(400).json({ error: 'filename and dataBase64 required' });
  }
  const contentType = b.contentType || 'application/pdf';
  if (!/pdf/i.test(contentType)) {
    return res.status(400).json({ error: 'Only PDF contracts are supported' });
  }
  const buffer = Buffer.from(b.dataBase64, 'base64');
  if (buffer.length > 20 * 1024 * 1024) {
    return res.status(413).json({ error: 'File too large (max 20 MB).' });
  }

  let extracted;
  try {
    const pdfText = await pdfToText(buffer);
    extracted = await extractContractFields(b.filename, pdfText, buffer.toString('base64'));
  } catch (err) {
    logger.error({ err }, 'contract extraction failed for employee creation');
    return res.status(502).json({ error: 'AI extraction failed — try again, or add the employee manually and upload the contract on their page.' });
  }
  if (!extracted) {
    return res.status(503).json({ error: 'AI extraction is not configured (N8N_CONTRACT_WEBHOOK_URL) — add the employee manually.' });
  }
  if (!extracted.employee_name) {
    return res.status(422).json({
      error: 'Could not find an employee name in this contract — add the employee manually, then upload the contract on their page.',
      extracted,
    });
  }

  // The model promises YYYY-MM-DD but a malformed date would abort the insert.
  const date = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const salary = extracted.salary_amount != null && extracted.salary_amount >= 0 ? extracted.salary_amount : 0;
  // No end date in the contract = indefinite-term.
  const contractEnd = date(extracted.end_date);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const employeeId = newRowId();
    const { rows } = await client.query(
      `INSERT INTO employees (id, user_id, name, role, salary_enc, salary_currency, contract_start, contract_end, contract_type,
                              probation_end, notice_period, vacation_days_allowed, sick_days_allowed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING ${EMPLOYEE_COLS}`,
      [
        employeeId, req.userId!, extracted.employee_name, extracted.role,
        encryptNumber(salary, fieldAad('employees', 'salary', employeeId)),
        (extracted.salary_currency || 'USD').toUpperCase(),
        date(extracted.start_date), contractEnd, contractEnd ? 'fixed' : 'indefinite',
        date(extracted.probation_end),
        extracted.notice_period,
        Math.max(0, Math.round(extracted.vacation_days ?? 0)),
        Math.max(0, Math.round(extracted.sick_days ?? 0)),
      ],
    );
    const employee = withSalary(rows[0]);
    if (salary > 0) {
      const historyId = newRowId();
      await client.query(
        `INSERT INTO employee_salary_history (id, employee_id, user_id, old_amount_enc, new_amount_enc, currency)
         VALUES ($1, $2, $3, NULL, $4, $5)`,
        [
          historyId, employeeId, req.userId!,
          encryptNumber(salary, fieldAad('employee_salary_history', 'new_amount', historyId)),
          employee.salary_currency,
        ],
      );
    }
    const contractId = newRowId();
    await client.query(
      `INSERT INTO employee_contracts (id, employee_id, user_id, filename, content_type, file_data_enc, extracted_enc)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        contractId, employeeId, req.userId!, b.filename, contentType,
        encryptBuffer(buffer, fieldAad('employee_contracts', 'file_data', contractId)),
        encryptJson(extracted, fieldAad('employee_contracts', 'extracted', contractId)),
      ],
    );
    await client.query('COMMIT');
    res.status(201).json({ employee, contractId, extracted });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err }, 'create employee from contract failed');
    res.status(500).json({ error: 'Failed to create the employee from the contract' });
  } finally {
    client.release();
  }
});

// Dashboard alerts: expiring/expired contracts, probation endings, missing
// contracts. Must be registered before /employees/:id.
employeeRoutes.get('/employees/alerts', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.id, e.name, e.contract_end, e.probation_end,
              EXISTS (SELECT 1 FROM employee_contracts c WHERE c.employee_id = e.id) AS has_contract
       FROM employees e WHERE e.user_id = $1 AND e.status = 'active'`,
      [req.userId!],
    );
    res.json(computeEmployeeAlerts(rows, new Date()));
  } catch (err) {
    logger.error({ err }, 'employee alerts failed');
    res.status(500).json({ error: 'Failed to load alerts' });
  }
});

employeeRoutes.get('/employees/:id', async (req: Request, res: Response) => {
  try {
    const employee = await ownedEmployee(req.userId!, req.params.id);
    if (!employee) return res.status(404).json({ error: 'not found' });

    const [contract, leaves, bonuses, salaryHistory] = await Promise.all([
      pool.query(
        `SELECT id, filename, content_type, uploaded_at FROM employee_contracts
         WHERE employee_id = $1 ORDER BY uploaded_at DESC LIMIT 1`,
        [employee.id],
      ),
      pool.query(
        `SELECT id, kind, on_date, days, note FROM employee_leaves
         WHERE employee_id = $1 ORDER BY on_date DESC, created_at DESC`,
        [employee.id],
      ),
      pool.query<{ id: string; on_date: string; amount_enc: Buffer | null; note: string | null }>(
        `SELECT id, on_date, amount_enc, note FROM employee_bonuses
         WHERE employee_id = $1 ORDER BY on_date DESC, created_at DESC`,
        [employee.id],
      ),
      pool.query<{ id: string; changed_on: string; old_amount_enc: Buffer | null; new_amount_enc: Buffer | null; currency: string }>(
        `SELECT id, changed_on, old_amount_enc, new_amount_enc, currency FROM employee_salary_history
         WHERE employee_id = $1 ORDER BY changed_on DESC, created_at DESC`,
        [employee.id],
      ),
    ]);

    res.json({
      employee,
      contract: contract.rows[0] ?? null,
      leaves: leaves.rows,
      bonuses: bonuses.rows.map((b) => ({
        id: b.id,
        on_date: b.on_date,
        note: b.note,
        amount: b.amount_enc
          ? decryptNumber(b.amount_enc, fieldAad('employee_bonuses', 'amount', b.id))
          : '0',
      })),
      // old_amount NULL (now old_amount_enc NULL) still marks the initial salary.
      salary_history: salaryHistory.rows.map((h) => ({
        id: h.id,
        changed_on: h.changed_on,
        currency: h.currency,
        old_amount: h.old_amount_enc
          ? decryptNumber(h.old_amount_enc, fieldAad('employee_salary_history', 'old_amount', h.id))
          : null,
        new_amount: h.new_amount_enc
          ? decryptNumber(h.new_amount_enc, fieldAad('employee_salary_history', 'new_amount', h.id))
          : null,
      })),
      contract_days_left: employee.contract_end != null ? daysUntil(employee.contract_end, new Date()) : null,
    });
  } catch (err) {
    logger.error({ err }, 'get employee failed');
    res.status(500).json({ error: 'Failed to load employee' });
  }
});

// Partial update. Also the "Confirm" target for reviewed contract fields.
// A salary change is logged to employee_salary_history in the same transaction.
employeeRoutes.patch('/employees/:id', async (req: Request, res: Response) => {
  const b = req.body as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

  const updates: Record<string, unknown> = {};
  if ('name' in b) {
    if (!text(b.name)) return res.status(400).json({ error: 'name cannot be empty' });
    updates.name = text(b.name);
  }
  if ('role' in b) updates.role = text(b.role);
  if ('notice_period' in b) updates.notice_period = text(b.notice_period);
  if ('contract_start' in b) updates.contract_start = text(b.contract_start);
  if ('contract_end' in b) updates.contract_end = text(b.contract_end);
  if ('contract_type' in b) {
    if (b.contract_type !== 'fixed' && b.contract_type !== 'indefinite') {
      return res.status(400).json({ error: 'contract_type must be fixed or indefinite' });
    }
    updates.contract_type = b.contract_type;
    // Indefinite-term means no end date; drop any stored/passed one.
    if (b.contract_type === 'indefinite') updates.contract_end = null;
  }
  if ('probation_end' in b) updates.probation_end = text(b.probation_end);
  if ('salary_currency' in b) updates.salary_currency = (text(b.salary_currency) ?? 'USD').toUpperCase();
  if ('status' in b) {
    if (b.status !== 'active' && b.status !== 'inactive') {
      return res.status(400).json({ error: 'status must be active or inactive' });
    }
    updates.status = b.status;
  }
  for (const f of ['vacation_days_allowed', 'sick_days_allowed'] as const) {
    if (f in b) {
      const n = Number(b[f] ?? 0);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: `${f} must be a non-negative number` });
      updates[f] = Math.round(n);
    }
  }
  let newSalary: number | null = null;
  if ('salary' in b) {
    newSalary = Number(b.salary);
    if (!Number.isFinite(newSalary) || newSalary < 0) {
      return res.status(400).json({ error: 'salary must be a non-negative number' });
    }
    updates.salary_enc = encryptNumber(newSalary, fieldAad('employees', 'salary', req.params.id));
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no fields to update' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ salary_enc: Buffer | null; salary_currency: string }>(
      `SELECT salary_enc, salary_currency FROM employees WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [req.params.id, req.userId!],
    );
    if (!current.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not found' });
    }

    const cols = Object.keys(updates);
    const setSql = cols.map((c, i) => `${c} = $${i + 3}`).join(', ');
    const { rows } = await client.query(
      `UPDATE employees SET ${setSql} WHERE id = $1 AND user_id = $2 RETURNING ${EMPLOYEE_COLS}`,
      [req.params.id, req.userId!, ...cols.map((c) => updates[c])],
    );

    const oldSalary = current.rows[0].salary_enc
      ? Number(decryptNumber(current.rows[0].salary_enc, fieldAad('employees', 'salary', req.params.id)))
      : 0;
    if (newSalary != null && newSalary !== oldSalary) {
      const historyId = newRowId();
      await client.query(
        `INSERT INTO employee_salary_history (id, employee_id, user_id, old_amount_enc, new_amount_enc, currency)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          historyId, req.params.id, req.userId!,
          encryptNumber(oldSalary, fieldAad('employee_salary_history', 'old_amount', historyId)),
          encryptNumber(newSalary, fieldAad('employee_salary_history', 'new_amount', historyId)),
          rows[0].salary_currency,
        ],
      );
    }
    await client.query('COMMIT');
    res.json(withSalary(rows[0]));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err }, 'update employee failed');
    res.status(500).json({ error: 'Failed to update employee' });
  } finally {
    client.release();
  }
});

employeeRoutes.delete('/employees/:id', async (req: Request, res: Response) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM employees WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId!],
    );
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  } catch (err) {
    logger.error({ err }, 'delete employee failed');
    res.status(500).json({ error: 'Failed to delete employee' });
  }
});

// Contract upload: store the PDF right away (so it is always downloadable),
// then run Claude extraction through n8n. Extracted values are only RETURNED
// for review — the employee row is untouched until the user confirms (PATCH).
employeeRoutes.post('/employees/:id/contract', async (req: Request, res: Response) => {
  const b = req.body as { filename?: string; contentType?: string; dataBase64?: string };
  if (!b.dataBase64 || !b.filename) {
    return res.status(400).json({ error: 'filename and dataBase64 required' });
  }
  const contentType = b.contentType || 'application/pdf';
  if (!/pdf/i.test(contentType)) {
    return res.status(400).json({ error: 'Only PDF contracts are supported' });
  }
  try {
    const employee = await ownedEmployee(req.userId!, req.params.id);
    if (!employee) return res.status(404).json({ error: 'not found' });

    const buffer = Buffer.from(b.dataBase64, 'base64');
    if (buffer.length > 20 * 1024 * 1024) {
      return res.status(413).json({ error: 'File too large (max 20 MB).' });
    }

    const pdfText = await pdfToText(buffer);
    let extracted = null;
    let extractError: string | null = null;
    try {
      extracted = await extractContractFields(b.filename, pdfText, buffer.toString('base64'));
    } catch (err) {
      logger.error({ err }, 'contract extraction failed; storing PDF without fields');
      extractError = 'AI extraction failed — you can fill the fields manually.';
    }
    if (!extracted && !extractError) {
      extractError = 'AI extraction is not configured (N8N_CONTRACT_WEBHOOK_URL) — fill the fields manually.';
    }

    const contractId = newRowId();
    const { rows } = await pool.query<{ uploaded_at: string }>(
      `INSERT INTO employee_contracts (id, employee_id, user_id, filename, content_type, file_data_enc, extracted_enc)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING uploaded_at`,
      [
        contractId, employee.id, req.userId!, b.filename, contentType,
        encryptBuffer(buffer, fieldAad('employee_contracts', 'file_data', contractId)),
        extracted ? encryptJson(extracted, fieldAad('employee_contracts', 'extracted', contractId)) : null,
      ],
    );
    res.status(201).json({
      contractId,
      uploaded_at: rows[0].uploaded_at,
      filename: b.filename,
      extracted,
      extractError,
    });
  } catch (err) {
    logger.error({ err }, 'contract upload failed');
    res.status(500).json({ error: 'Failed to upload the contract' });
  }
});

// Download the latest contract PDF.
employeeRoutes.get('/employees/:id/contract', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query<{ id: string; filename: string; content_type: string; file_data_enc: Buffer | null }>(
      `SELECT c.id, c.filename, c.content_type, c.file_data_enc
       FROM employee_contracts c
       JOIN employees e ON e.id = c.employee_id
       WHERE c.employee_id = $1 AND e.user_id = $2
       ORDER BY c.uploaded_at DESC LIMIT 1`,
      [req.params.id, req.userId!],
    );
    if (!rows[0] || !rows[0].file_data_enc) return res.status(404).json({ error: 'no contract uploaded' });
    const safeName = rows[0].filename.replace(/[^a-zA-Z0-9 ._-]/g, '_');
    res.setHeader('Content-Type', rows[0].content_type);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.send(decryptBuffer(rows[0].file_data_enc, fieldAad('employee_contracts', 'file_data', rows[0].id)));
  } catch (err) {
    logger.error({ err }, 'contract download failed');
    res.status(500).json({ error: 'Failed to download the contract' });
  }
});

// Vacation + sick leave entries (kind distinguishes them).
employeeRoutes.post('/employees/:id/leaves', async (req: Request, res: Response) => {
  const b = req.body as { kind?: string; on_date?: string; days?: number | string; note?: string };
  if (b.kind !== 'vacation' && b.kind !== 'sick') {
    return res.status(400).json({ error: 'kind must be vacation or sick' });
  }
  const days = Number(b.days);
  if (!Number.isFinite(days) || days <= 0) {
    return res.status(400).json({ error: 'days must be a positive number' });
  }
  try {
    const employee = await ownedEmployee(req.userId!, req.params.id);
    if (!employee) return res.status(404).json({ error: 'not found' });
    const { rows } = await pool.query(
      `INSERT INTO employee_leaves (employee_id, user_id, kind, on_date, days, note)
       VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5, $6)
       RETURNING id, kind, on_date, days, note`,
      [employee.id, req.userId!, b.kind, b.on_date || null, days, b.note?.trim() || null],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    logger.error({ err }, 'add leave failed');
    res.status(500).json({ error: 'Failed to add the entry' });
  }
});

employeeRoutes.delete('/employees/:id/leaves/:leaveId', async (req: Request, res: Response) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM employee_leaves WHERE id = $1 AND employee_id = $2 AND user_id = $3`,
      [req.params.leaveId, req.params.id, req.userId!],
    );
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  } catch (err) {
    logger.error({ err }, 'delete leave failed');
    res.status(500).json({ error: 'Failed to delete the entry' });
  }
});

employeeRoutes.post('/employees/:id/bonuses', async (req: Request, res: Response) => {
  const b = req.body as { on_date?: string; amount?: number | string; note?: string };
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({ error: 'amount must be a non-negative number' });
  }
  try {
    const employee = await ownedEmployee(req.userId!, req.params.id);
    if (!employee) return res.status(404).json({ error: 'not found' });
    const bonusId = newRowId();
    const { rows } = await pool.query<{ id: string; on_date: string; note: string | null }>(
      `INSERT INTO employee_bonuses (id, employee_id, user_id, on_date, amount_enc, note)
       VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5, $6)
       RETURNING id, on_date, note`,
      [
        bonusId, employee.id, req.userId!, b.on_date || null,
        encryptNumber(amount, fieldAad('employee_bonuses', 'amount', bonusId)),
        b.note?.trim() || null,
      ],
    );
    res.status(201).json({ ...rows[0], amount });
  } catch (err) {
    logger.error({ err }, 'add bonus failed');
    res.status(500).json({ error: 'Failed to add the bonus' });
  }
});

employeeRoutes.delete('/employees/:id/bonuses/:bonusId', async (req: Request, res: Response) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM employee_bonuses WHERE id = $1 AND employee_id = $2 AND user_id = $3`,
      [req.params.bonusId, req.params.id, req.userId!],
    );
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  } catch (err) {
    logger.error({ err }, 'delete bonus failed');
    res.status(500).json({ error: 'Failed to delete the bonus' });
  }
});
