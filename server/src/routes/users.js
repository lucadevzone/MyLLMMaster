const express = require('express')
const router = express.Router()
const bcrypt = require('bcrypt')
const { v4: uuidv4 } = require('uuid')
const { readJSON, writeJSON } = require('../utils/fileStore')
const { FILES } = require('../utils/dataInit')
const { authMiddleware, adminOnly, playerOnly } = require('../middleware/auth')

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
  res.json({ message: 'Account eliminato' })
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
  res.json({ message: 'Utente eliminato' })
})

module.exports = router
