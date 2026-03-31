const express = require('express')
const router = express.Router()
const { v4: uuidv4 } = require('uuid')
const path = require('path')
const { readJSON, writeJSON, fileExists, ensureDir } = require('../utils/fileStore')
const { DATA_DIR } = require('../utils/dataInit')
const { authMiddleware, adminOnly } = require('../middleware/auth')

const MODULES_DIR = path.join(DATA_DIR, 'modules')

async function getAllModules() {
  const fs = require('fs').promises
  let files
  try {
    files = await fs.readdir(MODULES_DIR)
  } catch {
    return []
  }
  const modules = []
  for (const f of files.filter(f => f.endsWith('.json'))) {
    const mod = await readJSON(path.join(MODULES_DIR, f))
    modules.push(mod)
  }
  return modules.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
}

// GET /api/modules
router.get('/', authMiddleware, async (req, res) => {
  const modules = await getAllModules()
  res.json(modules)
})

// GET /api/modules/:id
router.get('/:id', authMiddleware, async (req, res) => {
  const filePath = path.join(MODULES_DIR, `${req.params.id}.json`)
  if (!await fileExists(filePath)) return res.status(404).json({ error: 'Modulo non trovato' })
  res.json(await readJSON(filePath))
})

// POST /api/modules  (solo admin)
router.post('/', authMiddleware, adminOnly, async (req, res) => {
  const { title, minPlayers, maxPlayers, chapters } = req.body
  if (!title || !minPlayers || !maxPlayers || !chapters?.length) {
    return res.status(400).json({ error: 'Dati modulo incompleti' })
  }

  const mod = {
    id: `mod_${uuidv4().replace(/-/g, '').slice(0, 12)}`,
    title,
    minPlayers: Number(minPlayers),
    maxPlayers: Number(maxPlayers),
    chapters,
    createdAt: new Date().toISOString()
  }

  await ensureDir(MODULES_DIR)
  await writeJSON(path.join(MODULES_DIR, `${mod.id}.json`), mod)
  res.status(201).json(mod)
})

// PUT /api/modules/:id  (solo admin)
router.put('/:id', authMiddleware, adminOnly, async (req, res) => {
  const filePath = path.join(MODULES_DIR, `${req.params.id}.json`)
  if (!await fileExists(filePath)) return res.status(404).json({ error: 'Modulo non trovato' })

  const existing = await readJSON(filePath)
  const { title, minPlayers, maxPlayers, chapters } = req.body

  const updated = {
    ...existing,
    title: title ?? existing.title,
    minPlayers: minPlayers != null ? Number(minPlayers) : existing.minPlayers,
    maxPlayers: maxPlayers != null ? Number(maxPlayers) : existing.maxPlayers,
    chapters: chapters ?? existing.chapters,
    updatedAt: new Date().toISOString()
  }
  await writeJSON(filePath, updated)
  res.json(updated)
})

// DELETE /api/modules/:id  (solo admin)
router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  const filePath = path.join(MODULES_DIR, `${req.params.id}.json`)
  if (!await fileExists(filePath)) return res.status(404).json({ error: 'Modulo non trovato' })
  const fs = require('fs').promises
  await fs.unlink(filePath)
  res.json({ message: 'Modulo eliminato' })
})

module.exports = router
