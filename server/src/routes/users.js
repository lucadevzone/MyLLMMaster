const express = require('express')
const router = express.Router()
const bcrypt = require('bcrypt')
const path = require('path')
const fs = require('fs').promises
const { readJSON, writeJSON } = require('../utils/fileStore')
const { FILES, DATA_DIR } = require('../utils/dataInit')
const { authMiddleware, adminOnly, playerOnly } = require('../middleware/auth')

const TABLES_DIR = path.join(DATA_DIR, 'tables')

async function disableTablesForPlayer(email) {
  let tableDirs = []
  try {
    tableDirs = await fs.readdir(TABLES_DIR)
  } catch {
    return 0
  }

  let updatedCount = 0
  for (const dir of tableDirs) {
    const tablePath = path.join(TABLES_DIR, dir, 'table.json')
    try {
      const table = await readJSON(tablePath)
      if (!table.invitedPlayers?.includes(email)) continue
      if (table.state === 'archived' || table.state === 'disabled') continue

      table.state = 'disabled'
      table.updatedAt = new Date().toISOString()
      await writeJSON(tablePath, table)
      updatedCount++
    } catch {
      // Ignora tavoli malformati o incompleti senza bloccare l'operazione utente
    }
  }

  return updatedCount
}

// GET /api/users/names  (tutti gli autenticati - mappa email→nome per UI)
router.get('/names', authMiddleware, async (req, res) => {
  const users = await readJSON(FILES.users)
  const names = users
    .filter(u => u.role === 'player')
    .map(u => ({ email: u.email, name: u.name, accountState: u.accountState }))
  res.json(names)
})

// GET /api/users/me
router.get('/me', authMiddleware, async (req, res) => {
  const users = await readJSON(FILES.users)
  const user = users.find(u => u.email === req.user.email)
  if (!user) return res.status(404).json({ error: 'Utente non trovato' })
  const { password, ...safeUser } = user
  res.json(safeUser)
})

// PATCH /api/users/me/name
router.patch('/me/name', authMiddleware, async (req, res) => {
  const { name } = req.body
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nome obbligatorio' })

  const users = await readJSON(FILES.users)
  const idx = users.findIndex(u => u.email === req.user.email)
  if (idx === -1) return res.status(404).json({ error: 'Utente non trovato' })

  users[idx].name = name.trim()
  await writeJSON(FILES.users, users)
  res.json({ message: 'Nome aggiornato', name: users[idx].name })
})

// DELETE /api/users/me  (solo player)
router.delete('/me', authMiddleware, playerOnly, async (req, res) => {
  const users = await readJSON(FILES.users)
  const idx = users.findIndex(u => u.email === req.user.email)
  if (idx === -1) return res.status(404).json({ error: 'Utente non trovato' })

  users[idx].accountState = 'disabilitato'
  await writeJSON(FILES.users, users)
  const disabledTables = await disableTablesForPlayer(req.user.email)
  res.json({
    message: 'Account eliminato',
    disabledTables
  })
})

// --- ADMIN ROUTES ---

// GET /api/users  (solo admin)
router.get('/', authMiddleware, adminOnly, async (req, res) => {
  const users = await readJSON(FILES.users)
  const players = users
    .filter(u => u.role === 'player')
    .map(({ password, ...u }) => u)
  res.json(players)
})

// POST /api/users/invite  (solo admin)
router.post('/invite', authMiddleware, adminOnly, async (req, res) => {
  const { email, inviteCode } = req.body
  if (!email || !inviteCode) return res.status(400).json({ error: 'Email e codice invito obbligatori' })

  const users = await readJSON(FILES.users)
  if (users.find(u => u.email === email)) {
    return res.status(409).json({ error: 'Email già registrata' })
  }

  const hashedCode = await bcrypt.hash(inviteCode, 10)
  const newUser = {
    email,
    name: email.split('@')[0],
    password: hashedCode,
    role: 'player',
    accountState: 'invited',
    registrationDate: new Date().toISOString()
  }
  users.push(newUser)
  await writeJSON(FILES.users, users)

  res.status(201).json({ message: 'Giocatore invitato', email })
})

// DELETE /api/users/:email  (solo admin)
router.delete('/:email', authMiddleware, adminOnly, async (req, res) => {
  const { email } = req.params
  if (email === req.user.email) {
    return res.status(403).json({ error: 'Non puoi eliminare il tuo account admin' })
  }

  const users = await readJSON(FILES.users)
  const idx = users.findIndex(u => u.email === email)
  if (idx === -1) return res.status(404).json({ error: 'Utente non trovato' })
  if (users[idx].role === 'admin') {
    return res.status(403).json({ error: 'Non puoi eliminare un account admin' })
  }

  users[idx].accountState = 'eliminato'
  await writeJSON(FILES.users, users)
  const disabledTables = await disableTablesForPlayer(email)
  res.json({
    message: 'Utente eliminato',
    disabledTables
  })
})

module.exports = router
