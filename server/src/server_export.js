/**
 * Esporta app/io/httpServer senza avviarli — usato dai test di integrazione.
 */
const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const cors = require('cors')
const { ensureDataDirs } = require('./utils/dataInit')
const { setIO } = require('./socket/runtime')

const app = express()
const httpServer = http.createServer(app)

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
})
setIO(io)

app.use(cors({ origin: '*' }))
app.use(express.json())

app.use('/api/auth', require('./routes/auth'))
app.use('/api/users', require('./routes/users'))
app.use('/api/modules', require('./routes/modules'))
app.use('/api/tables', require('./routes/tables'))
app.use('/api/professions', require('./routes/professions'))
app.use('/api/session', require('./routes/session'))

require('./socket/index')(io)

// Inizializza le directory dati prima di esportare
const ready = ensureDataDirs()

module.exports = { app, io, httpServer, ready }
