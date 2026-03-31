const jwt = require('jsonwebtoken')

module.exports = function setupSocket(io) {
  // Auth middleware for socket
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token
    if (!token) return next(new Error('Token mancante'))
    try {
      socket.user = jwt.verify(token, process.env.JWT_SECRET)
      next()
    } catch {
      next(new Error('Token non valido'))
    }
  })

  io.on('connection', (socket) => {
    console.log(`[Socket] Connesso: ${socket.user.email}`)

    socket.on('join-table', (tableId) => {
      socket.join(`table:${tableId}`)
      console.log(`[Socket] ${socket.user.email} entrato nel tavolo ${tableId}`)
    })

    socket.on('leave-table', (tableId) => {
      socket.leave(`table:${tableId}`)
    })

    socket.on('disconnect', () => {
      console.log(`[Socket] Disconnesso: ${socket.user.email}`)
    })
  })
}
