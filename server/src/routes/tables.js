const express = require('express')
const router = express.Router()
const { v4: uuidv4 } = require('uuid')
const path = require('path')
const fs = require('fs').promises
const { readJSON, writeJSON, fileExists, ensureDir } = require('../utils/fileStore')
const { DATA_DIR, FILES } = require('../utils/dataInit')
const { authMiddleware, adminOnly, playerOnly } = require('../middleware/auth')

const TABLES_DIR = path.join(DATA_DIR, 'tables')

async function getTablePath(tableId) {
  return path.join(TABLES_DIR, tableId, 'table.json')
}

async function getAllTables() {
  let dirs
  try {
    dirs = await fs.readdir(TABLES_DIR)
  } catch {
    return []
  }
  const tables = []
  for (const d of dirs) {
    const filePath = path.join(TABLES_DIR, d, 'table.json')
    if (await fileExists(filePath)) {
      tables.push(await readJSON(filePath))
    }
  }
  return tables
}

function isSessionDue(table) {
  if (!table.plannedSession) return false
  const { date, time } = table.plannedSession
  return new Date(`${date}T${time}:00`) <= new Date()
}

async function checkAndOpenTable(table) {
  if (table.state === 'ready' && isSessionDue(table)) {
    table.state = 'open'
    table.updatedAt = new Date().toISOString()
    await writeJSON(path.join(TABLES_DIR, table.id, 'table.json'), table)
  }
  return table
}

async function getOllamaModels() {
  try {
    const res = await fetch(`${process.env.OLLAMA_BASE_URL || 'http://localhost:11434'}/api/tags`)
    const data = await res.json()
    return (data.models || []).map(m => m.name)
  } catch {
    return []
  }
}

// GET /api/tables/ollama-models
router.get('/ollama-models', authMiddleware, adminOnly, async (req, res) => {
  const models = await getOllamaModels()
  res.json(models)
})

// GET /api/tables  (admin: tutti, player: solo i suoi)
router.get('/', authMiddleware, async (req, res) => {
  const raw = await getAllTables()
  const tables = await Promise.all(raw.map(checkAndOpenTable))
  if (req.user.role === 'admin') {
    return res.json(tables)
  }
  const myTables = tables.filter(t =>
    t.invitedPlayers.includes(req.user.email) && t.state !== 'archived'
  )
  res.json(myTables)
})

// GET /api/tables/:id
router.get('/:id', authMiddleware, async (req, res) => {
  const filePath = await getTablePath(req.params.id)
  if (!await fileExists(filePath)) return res.status(404).json({ error: 'Tavolo non trovato' })
  const table = await checkAndOpenTable(await readJSON(filePath))
  res.json(table)
})

// POST /api/tables  (solo admin)
router.post('/', authMiddleware, adminOnly, async (req, res) => {
  const { moduleId, invitedPlayers, heavyLlmModel, lightLlmModel } = req.body
  if (!moduleId || !invitedPlayers?.length || !heavyLlmModel) {
    return res.status(400).json({ error: 'Dati tavolo incompleti' })
  }

  const tableId = `tbl_${uuidv4().replace(/-/g, '').slice(0, 8)}`
  const tableDir = path.join(TABLES_DIR, tableId)

  await ensureDir(tableDir)
  await ensureDir(path.join(tableDir, 'characters'))
  await ensureDir(path.join(tableDir, 'sessions'))
  await ensureDir(path.join(tableDir, 'active_scenes'))
  await ensureDir(path.join(tableDir, 'closed_scenes'))
  await ensureDir(path.join(tableDir, 'logs'))

  const table = {
    id: tableId,
    moduleId,
    'heavy-llmModel': heavyLlmModel,
    'light-llmModel': lightLlmModel || null,
    state: 'active',
    invitedPlayers,
    plannedSession: null,
    custodeStarted: false,
    createdAt: new Date().toISOString()
  }

  await writeJSON(path.join(tableDir, 'table.json'), table)

  // Init world state
  const worldState = {
    currentChapter: 1,
    focusScene: null,
    groups: [],
    npcs: [],
    items: []
  }
  await writeJSON(path.join(tableDir, 'world_state.json'), worldState)

  // Init diary
  await fs.writeFile(path.join(tableDir, 'diary.txt'), '')

  res.status(201).json(table)
})

// PATCH /api/tables/:id  (solo admin)
router.patch('/:id', authMiddleware, adminOnly, async (req, res) => {
  const filePath = await getTablePath(req.params.id)
  if (!await fileExists(filePath)) return res.status(404).json({ error: 'Tavolo non trovato' })

  const table = await readJSON(filePath)
  const allowed = ['invitedPlayers', 'plannedSession', 'state', 'heavy-llmModel', 'light-llmModel']
  for (const key of allowed) {
    if (req.body[key] !== undefined) table[key] = req.body[key]
  }
  table.updatedAt = new Date().toISOString()
  await writeJSON(filePath, table)
  res.json(table)
})

// DELETE /api/tables/:id  (solo admin - archivia)
router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  const filePath = await getTablePath(req.params.id)
  if (!await fileExists(filePath)) return res.status(404).json({ error: 'Tavolo non trovato' })

  const table = await readJSON(filePath)
  table.state = 'archived'
  table.updatedAt = new Date().toISOString()
  await writeJSON(filePath, table)
  res.json({ message: 'Tavolo archiviato' })
})

// DELETE /api/tables  (solo admin - clear all, per playtest)
router.delete('/', authMiddleware, adminOnly, async (req, res) => {
  try {
    const dirs = await fs.readdir(TABLES_DIR)
    for (const d of dirs) {
      await fs.rm(path.join(TABLES_DIR, d), { recursive: true, force: true })
    }
    res.json({ message: 'Tutti i tavoli eliminati' })
  } catch {
    res.status(500).json({ error: 'Errore nella cancellazione dei tavoli' })
  }
})

// GET /api/tables/:id/characters
router.get('/:id/characters', authMiddleware, async (req, res) => {
  const tableDir = path.join(TABLES_DIR, req.params.id)
  const charsDir = path.join(tableDir, 'characters')
  try {
    const files = await fs.readdir(charsDir)
    const chars = []
    for (const f of files.filter(f => f.endsWith('.json'))) {
      chars.push(await readJSON(path.join(charsDir, f)))
    }
    res.json(chars)
  } catch {
    res.json([])
  }
})

// POST /api/tables/:id/characters  (player crea PG)
router.post('/:id/characters', authMiddleware, playerOnly, async (req, res) => {
  const tableDir = path.join(TABLES_DIR, req.params.id)
  const tablePath = path.join(tableDir, 'table.json')
  if (!await fileExists(tablePath)) return res.status(404).json({ error: 'Tavolo non trovato' })

  const table = await readJSON(tablePath)
  if (!table.invitedPlayers.includes(req.user.email)) {
    return res.status(403).json({ error: 'Non sei invitato a questo tavolo' })
  }
  if (table.state !== 'active' && table.state !== 'ready') {
    return res.status(400).json({ error: 'Non puoi creare personaggi in questo stato del tavolo' })
  }

  const character = { ...req.body, playerID: req.user.email, id: uuidv4() }
  const charPath = path.join(tableDir, 'characters', `${character.id}.json`)
  await writeJSON(charPath, character)

  // Check if all players have created their character → set table to 'ready'
  const charsDir = path.join(tableDir, 'characters')
  const charFiles = await fs.readdir(charsDir)
  const chars = []
  for (const f of charFiles.filter(f => f.endsWith('.json'))) {
    chars.push(await readJSON(path.join(charsDir, f)))
  }
  const activePlayers = table.invitedPlayers  // simplified: all invited
  const charOwners = chars.map(c => c.playerID)
  const allCreated = activePlayers.every(email => charOwners.includes(email))
  if (allCreated && table.state === 'active') {
    const now = new Date()
    table.state = 'open'
    table.plannedSession = {
      date: now.toISOString().slice(0, 10),
      time: now.toTimeString().slice(0, 5),
      duration: 180
    }
    table.updatedAt = now.toISOString()
    await writeJSON(tablePath, table)
  }

  res.status(201).json(character)
})

// GET /api/tables/:id/characters/mine  (player vede il suo PG)
router.get('/:id/characters/mine', authMiddleware, playerOnly, async (req, res) => {
  const charsDir = path.join(TABLES_DIR, req.params.id, 'characters')
  try {
    const files = await fs.readdir(charsDir)
    for (const f of files.filter(f => f.endsWith('.json'))) {
      const char = await readJSON(path.join(charsDir, f))
      if (char.playerID === req.user.email) return res.json(char)
    }
    res.status(404).json({ error: 'Personaggio non trovato' })
  } catch {
    res.status(404).json({ error: 'Personaggio non trovato' })
  }
})

module.exports = router
