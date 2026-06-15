import { Router } from 'express'
import pool from '../services/db.js'

const router = Router()

// GET /api/editor/state?project=Signal+OS
router.get('/state', async (req, res) => {
  try {
    const projectId = (req.query.project as string) || 'default'
    const result = await pool.query(
      'SELECT files, active_file_name FROM editor_state WHERE project_id = $1',
      [projectId]
    )
    if (result.rows.length === 0) {
      return res.json({ files: null, activeFileName: null })
    }
    const row = result.rows[0]
    res.json({ files: row.files, activeFileName: row.active_file_name })
  } catch (err) {
    console.error('editor/state GET error:', err)
    res.status(500).json({ error: 'Error loading editor state' })
  }
})

// POST /api/editor/state
router.post('/state', async (req, res) => {
  try {
    const { projectId = 'default', files, activeFileName } = req.body
    await pool.query(
      `INSERT INTO editor_state (project_id, files, active_file_name, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (project_id) DO UPDATE
       SET files = $2, active_file_name = $3, updated_at = NOW()`,
      [projectId, JSON.stringify(files), activeFileName]
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('editor/state POST error:', err)
    res.status(500).json({ error: 'Error saving editor state' })
  }
})

export default router
