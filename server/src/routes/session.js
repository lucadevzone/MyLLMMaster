const express = require('express')
const router = express.Router()
const path = require('path')
const fs = require('fs').promises
const { authMiddleware } = require('../middleware/auth')
const { DATA_DIR } = require('../utils/dataInit')
const { fileExists } = require('../utils/fileStore')
const { getStoryLog, renderStoryLogText } = require('../services/tableRuntimeStore')

// GET /api/session/:tableId/diary
router.get('/:tableId/diary', authMiddleware, async (req, res) => {
  try {
    const storyLog = await getStoryLog(req.params.tableId)
    res.json({ content: renderStoryLogText(storyLog) })
  } catch {
    res.json({ content: '' })
  }
})

// PATCH /api/session/:tableId/character/notes  (player salva note personali)
router.patch('/:tableId/character/notes', authMiddleware, async (req, res) => {
  const { notes } = req.body
  const charsDir = path.join(DATA_DIR, 'tables', req.params.tableId, 'characters')
  try {
    const files = await fs.readdir(charsDir)
    for (const f of files.filter(f => f.endsWith('.json'))) {
      const { readJSON, writeJSON } = require('../utils/fileStore')
      const charPath = path.join(charsDir, f)
      const char = await readJSON(charPath)
      if (char.playerID === req.user.email) {
        char.notes = notes
        await writeJSON(charPath, char)
        return res.json({ ok: true })
      }
    }
    res.status(404).json({ error: 'Personaggio non trovato' })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
