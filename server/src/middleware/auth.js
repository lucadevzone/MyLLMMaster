const jwt = require('jsonwebtoken')

function authMiddleware(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token mancante' })
  }
  const token = header.slice(7)
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET)
    next()
  } catch {
    return res.status(401).json({ error: 'Token non valido o scaduto' })
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Accesso riservato agli admin' })
  }
  next()
}

function playerOnly(req, res, next) {
  if (req.user?.role !== 'player') {
    return res.status(403).json({ error: 'Accesso riservato ai player' })
  }
  next()
}

module.exports = { authMiddleware, adminOnly, playerOnly }
