const express = require('express')
const router = express.Router()
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const { readJSON, writeJSON } = require('../utils/fileStore')
const { FILES } = require('../utils/dataInit')
const { authMiddleware } = require('../middleware/auth')

function generateToken(user) {
  return jwt.sign(
    { email: user.email, name: user.name, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
  )
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) {
    return res.status(400).json({ error: 'Email e password obbligatorie' })
  }

  const users = await readJSON(FILES.users)
  const user = users.find(u => u.email === email)

  if (!user) {
    return res.status(401).json({ error: 'Credenziali non valide' })
  }

  if (user.accountState === 'eliminato' || user.accountState === 'disabilitato') {
    return res.status(403).json({ error: 'Account non accessibile' })
  }

  // Invited users: password is the invite code
  const match = await bcrypt.compare(password, user.password)
  if (!match) {
    return res.status(401).json({ error: 'Credenziali non valide' })
  }

  const token = generateToken(user)
  res.json({
    token,
    user: { email: user.email, name: user.name, role: user.role, accountState: user.accountState }
  })
})

// POST /api/auth/change-password
router.post('/change-password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Dati mancanti' })
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'La nuova password deve essere di almeno 6 caratteri' })
  }

  const users = await readJSON(FILES.users)
  const idx = users.findIndex(u => u.email === req.user.email)
  if (idx === -1) return res.status(404).json({ error: 'Utente non trovato' })

  const match = await bcrypt.compare(currentPassword, users[idx].password)
  if (!match) return res.status(401).json({ error: 'Password attuale non corretta' })

  users[idx].password = await bcrypt.hash(newPassword, 10)
  // If account was 'invited', set to 'attivo' after first password change
  if (users[idx].accountState === 'invited') {
    users[idx].accountState = 'attivo'
  }
  await writeJSON(FILES.users, users)

  const token = generateToken(users[idx])
  res.json({ message: 'Password aggiornata', token, accountState: users[idx].accountState })
})

module.exports = router
