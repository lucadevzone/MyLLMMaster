const jwt = require('jsonwebtoken')
const path = require('path')
const { readJSON, fileExists } = require('../utils/fileStore')
const { DATA_DIR } = require('../utils/dataInit')
const svc = require('../services/sessionService')
const custodeEngine = require('../services/custodeEngine')

const TIMER_AVVIO_MS = 5 * 60 * 1000  // 5 minuti

module.exports = function setupSocket(io) {

  // ── Auth middleware ───────────────────────────────────────────────────────
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

  // ── Helper: leggi tabella ──────────────────────────────────────────────────
  async function getTable(tableId) {
    const p = path.join(DATA_DIR, 'tables', tableId, 'table.json')
    if (!await fileExists(p)) return null
    return readJSON(p)
  }

  async function getPlayerName(email) {
    const usersPath = path.join(DATA_DIR, 'users.json')
    const users = await readJSON(usersPath)
    return users.find(u => u.email === email)?.name || email
  }

  async function getDiary(tableId) {
    const p = path.join(DATA_DIR, 'tables', tableId, 'diary.txt')
    try { return await require('fs').promises.readFile(p, 'utf-8') } catch { return '' }
  }

  // ── Connessione ───────────────────────────────────────────────────────────
  io.on('connection', async (socket) => {
    const { email } = socket.user
    // Leggo sempre il nome aggiornato dal DB (non dalla JWT che può essere vecchia)
    const name = await getPlayerName(email)
    console.log(`[Socket] Connesso: ${email} (${name})`)

    // ── session:join ─────────────────────────────────────────────────────────
    socket.on('session:join', async (tableId) => {
      const table = await getTable(tableId)
      if (!table) return socket.emit('session:error', 'Tavolo non trovato')
      if (!table.invitedPlayers.includes(email)) {
        return socket.emit('session:error', 'Non sei invitato a questo tavolo')
      }

      // Carica / crea sessione
      const ctx = await svc.getOrCreateSession(tableId, table.invitedPlayers)
      const { session } = ctx

      socket.tableId = tableId
      socket.join(`table:${tableId}`)

      const { wasConnected, missed } = await svc.playerConnected(tableId, email)

      // Invia stato completo al giocatore
      socket.emit('session:state', {
        session: ctx.session,
        messages: wasConnected ? missed.map(m => ({ ...m, toRecover: true })) : ctx.messages
      })

      // Invia diario
      socket.emit('session:diary', await getDiary(tableId))

      // Notifica agli altri (toast)
      socket.to(`table:${tableId}`).emit('session:toast', {
        type: 'connect',
        text: `${name} si è collegato`
      })

      // Aggiorna stato player per tutti
      io.to(`table:${tableId}`).emit('session:player-update', {
        email,
        connected: true,
        playerState: svc.getPlayer(ctx, email)?.playerState
      })

      // ── Macchina a stati sessione ──────────────────────────────────────────
      const connessi = session.players.filter(p => p.connected)

      if (session.state === 'custode-pronto') {
        // Primo giocatore → avvia timer 5 min
        await svc.updateSessionState(tableId, 'primo-giocatore')
        io.to(`table:${tableId}`).emit('session:status-update', {
          state: 'primo-giocatore',
          timerMs: TIMER_AVVIO_MS
        })

        svc.setTimer(tableId, 'avvio', TIMER_AVVIO_MS, async () => {
          await avviaSessione(tableId)
        })

      } else if (session.state === 'primo-giocatore') {
        // Tutti connessi → annulla timer e avvia subito
        const tutti = table.invitedPlayers.every(e =>
          session.players.find(p => p.email === e)?.connected
        )
        if (tutti) {
          svc.clearTimer(tableId, 'avvio')
          await avviaSessione(tableId)
        }

      } else if (session.state === 'in-pausa') {
        // Riconnessione dopo pausa
        const anyConnected = session.players.some(p => p.connected)
        if (anyConnected) {
          await svc.updateSessionState(tableId, 'sessione-iniziata')
          io.to(`table:${tableId}`).emit('session:status-update', { state: 'sessione-iniziata' })
        }
      }
    })

    // ── session:message ───────────────────────────────────────────────────────
    socket.on('session:message', async ({ text, type = 'normal', to = null }) => {
      const tableId = socket.tableId
      if (!tableId) return

      const playerName = await getPlayerName(email)
      const msg = await svc.addMessage(tableId, { type, from: email, fromName: playerName, to, text })

      if (type === 'whisper' && to) {
        // Consegna solo al mittente e al destinatario
        socket.emit('session:message', msg)
        const targetSocket = [...io.sockets.sockets.values()]
          .find(s => s.user?.email === to && s.tableId === tableId)
        if (targetSocket) targetSocket.emit('session:message', msg)
      } else {
        io.to(`table:${tableId}`).emit('session:message', msg)
      }

      // Notifica il motore del Custode
      const ctx = svc.getSession(tableId)
      if (ctx?.session?.state === 'sessione-iniziata') {
        const engine = custodeEngine.getOrCreate(tableId, io)
        if (engine.running) engine.onPlayerMessage(msg).catch(console.error)
      }
    })

    // ── session:dice-roll ─────────────────────────────────────────────────────
    socket.on('session:dice-roll', async ({ caratteristica, soglia }) => {
      const tableId = socket.tableId
      if (!tableId) return

      const valore = Math.floor(Math.random() * 100) + 1
      const esito = valore <= soglia ? 'successo' : 'fallimento'

      const result = { roller: email, rollerName: name, caratteristica, soglia, valore, esito }

      // Aggiorna piano azione in sessione (per custode)
      const ctx = svc.getSession(tableId)
      if (ctx) {
        const player = svc.getPlayer(ctx, email)
        if (player) player.playerState = 'turno-custode'
        await svc.saveSession(tableId, ctx.session)
      }

      // Toast per tutti
      io.to(`table:${tableId}`).emit('session:dice-result', result)
      // Aggiorna stato player
      io.to(`table:${tableId}`).emit('session:player-update', {
        email, connected: true, playerState: 'turno-custode'
      })

      // Notifica il motore del Custode
      const diceCtx = svc.getSession(tableId)
      if (diceCtx?.session?.state === 'sessione-iniziata') {
        const engine = custodeEngine.getOrCreate(tableId, io)
        if (engine.running) engine.onDiceRoll(email, valore, soglia, caratteristica).catch(console.error)
      }
    })

    // ── session:set-color ─────────────────────────────────────────────────────
    socket.on('session:set-color', async (color) => {
      const tableId = socket.tableId
      if (!tableId) return
      const ctx = svc.getSession(tableId)
      if (!ctx) return
      const player = svc.getPlayer(ctx, email)
      if (player) player.bubbleColor = color
      await svc.saveSession(tableId, ctx.session)
      io.to(`table:${tableId}`).emit('session:player-update', { email, bubbleColor: color })
    })

    // ── session:vote-tardi ────────────────────────────────────────────────────
    socket.on('session:vote-tardi', async () => {
      const tableId = socket.tableId
      if (!tableId) return

      const triggerChiusura = await svc.voteTardi(tableId, email)
      const ctx = svc.getSession(tableId)
      if (!ctx) return

      io.to(`table:${tableId}`).emit('session:player-update', {
        email, voteTardi: true
      })

      if (triggerChiusura) {
        io.to(`table:${tableId}`).emit('session:status-update', { state: 'in-chiusura' })
      }
    })

    // ── session:avvia-custode ─────────────────────────────────────────────────
    socket.on('session:avvia-custode', async () => {
      const tableId = socket.tableId
      if (!tableId) return
      if (socket.user.role !== 'admin') {
        return socket.emit('session:error', 'Solo l\'admin può avviare il Custode')
      }
      const engine = custodeEngine.getOrCreate(tableId, io)
      engine.start().catch(console.error)
      io.to(`table:${tableId}`).emit('session:toast', { type: 'connect', text: 'Custode avviato' })
    })

    // ── session:riprendi-custode ──────────────────────────────────────────────
    socket.on('session:riprendi-custode', async () => {
      const tableId = socket.tableId
      if (!tableId) return
      if (socket.user.role !== 'admin') {
        return socket.emit('session:error', 'Solo l\'admin può riprendere il Custode')
      }
      const engine = custodeEngine.getOrCreate(tableId, io)
      engine.resume().catch(console.error)
      io.to(`table:${tableId}`).emit('session:toast', { type: 'connect', text: 'Custode ripreso' })
    })

    // ── session:leave ─────────────────────────────────────────────────────────
    socket.on('session:leave', async () => {
      await handleDisconnect(socket)
    })

    // ── disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      console.log(`[Socket] Disconnesso: ${email}`)
      await handleDisconnect(socket)
    })

    async function handleDisconnect(socket) {
      const tableId = socket.tableId
      if (!tableId) return

      await svc.playerDisconnected(tableId, email)
      const ctx = svc.getSession(tableId)
      if (!ctx) return

      io.to(`table:${tableId}`).emit('session:player-update', {
        email, connected: false
      })
      io.to(`table:${tableId}`).emit('session:toast', {
        type: 'disconnect',
        text: `${name} si è disconnesso`
      })

      // Se tutti disconnessi → metti in pausa
      const anyConnected = ctx.session.players.some(p => p.connected)
      if (!anyConnected && ctx.session.state === 'sessione-iniziata') {
        svc.clearAllTimers(tableId)
        await svc.updateSessionState(tableId, 'in-pausa')
        io.to(`table:${tableId}`).emit('session:status-update', { state: 'in-pausa' })
      }
    }
  })

  // ── Avvia sessione (condiviso tra timer e trigger "tutti presenti") ─────────
  async function avviaSessione(tableId) {
    await svc.updateSessionState(tableId, 'sessione-iniziata')
    await svc.setAllPlayersState(tableId, 'gioco-libero')
    io.to(`table:${tableId}`).emit('session:status-update', { state: 'sessione-iniziata' })
    // Aggiorna stato di tutti i player
    const ctx = svc.getSession(tableId)
    if (ctx) {
      ctx.session.players.forEach(p => {
        io.to(`table:${tableId}`).emit('session:player-update', {
          email: p.email,
          connected: p.connected,
          playerState: 'gioco-libero'
        })
      })
    }
  }
}
