require('dotenv').config()
const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const cors = require('cors')
const path = require('path')

const { ensureDataDirs } = require('./utils/dataInit')
const { setIO } = require('./socket/runtime')

const app = express()
const httpServer = http.createServer(app)

const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    methods: ['GET', 'POST']
  }
})
setIO(io)

app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173' }))
app.use(express.json())

// Routes
app.use('/api/auth', require('./routes/auth'))
app.use('/api/users', require('./routes/users'))
app.use('/api/modules', require('./routes/modules'))
app.use('/api/tables', require('./routes/tables'))
app.use('/api/professions', require('./routes/professions'))
app.use('/api/session', require('./routes/session'))

// Socket.io
require('./socket/index')(io)

const PORT = process.env.PORT || 3000

async function start() {
  await ensureDataDirs()
  httpServer.listen(PORT, () => {
    console.log(`Server avviato su http://localhost:${PORT}`)
  })
}

start()
