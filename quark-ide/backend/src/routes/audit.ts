import { Router, Request, Response } from 'express';
import pool from '../services/db.js';

const router = Router();

router.post('/save', async (req: Request, res: Response) => {
  const { repo, recommendations, verdict } = req.body as {
    repo?: string;
    recommendations?: string[];
    verdict?: string;
  };

  if (!repo || !Array.isArray(recommendations) || recommendations.length === 0) {
    res.status(400).json({ error: 'repo and recommendations[] are required' });
    return;
  }

  try {
    const { rows } = await pool.query<{ audit_id: string; review_date: string }>(
      `INSERT INTO audit_history (repo_name, recommendations, status, review_date, verdict)
       VALUES ($1, $2, 'pending', NOW() + INTERVAL '4 months', $3)
       RETURNING audit_id, review_date`,
      [repo, recommendations, verdict ?? null],
    );
    res.status(201).json({ audit_id: rows[0].audit_id, review_date: rows[0].review_date });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'DB error';
    console.error('[AUDIT] save error:', msg);
    res.status(500).json({ error: msg });
  }
});

router.get('/history', async (req: Request, res: Response) => {
  const repo = req.query.repo as string | undefined;

  if (!repo) {
    res.status(400).json({ error: 'repo query param is required' });
    return;
  }

  try {
    const { rows } = await pool.query(
      `SELECT audit_id, repo_name, audit_date, recommendations, status,
              review_date, verdict, results, created_at
       FROM audit_history
       WHERE repo_name = $1
       ORDER BY audit_date DESC`,
      [repo],
    );
    res.json(rows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'DB error';
    console.error('[AUDIT] history error:', msg);
    res.status(500).json({ error: msg });
  }
});

router.patch('/:id/status', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status, results } = req.body as {
    status?: 'implemented' | 'evaluating' | 'completed' | 'failed';
    results?: string;
  };

  const validStatuses = ['implemented', 'evaluating', 'completed', 'failed'] as const;
  if (!status || !validStatuses.includes(status)) {
    res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
    return;
  }

  try {
    const { rowCount } = await pool.query(
      `UPDATE audit_history
       SET status = $1::varchar,
           results = $2,
           review_date = CASE WHEN $1::varchar = 'completed' THEN NOW() ELSE review_date END
       WHERE audit_id = $3::uuid`,
      [status, results ?? null, id],
    );

    if (rowCount === 0) {
      res.status(404).json({ error: 'Audit not found' });
      return;
    }

    res.json({ ok: true, audit_id: id, status });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'DB error';
    console.error('[AUDIT] status update error:', msg);
    res.status(500).json({ error: msg });
  }
});

export default router;
