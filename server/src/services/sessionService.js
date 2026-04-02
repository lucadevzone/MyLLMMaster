const { v4: uuidv4 } = require('uuid')
const path = require('path')
const fs = require('fs').promises
const { readJSON, writeJSON, fileExists, ensureDir } = require('../utils/fileStore')
const { DATA_DIR } = require('../utils/dataInit')

// In-memory active sessions: tableId → { session, messages, timers }
const activeSessions = new Map()

// Lock per getOrCreateSession: evita che join concorrenti creino ctx duplicati
const sessionLocks = new Map()

function tableDir(tableId) {
  return path.join(DATA_DIR, 'tables', tableId)
}

function sessionPath(tableId, sessionId) {
  return path.join(tableDir(tableId), 'sessions', `session_${sessionId}.json`)
}

function chatPath(tableId, sessionId) {
  return path.join(tableDir(tableId), 'sessions', `chat_${sessionId}.json`)
}

function logPath(tableId, sessionId) {
  return path.join(tableDir(tableId), 'logs', `log_${sessionId}.json`)
}

// ── Persistenza ──────────────────────────────────────────────────────────────

async function saveSession(tableId, session) {
  await writeJSON(sessionPath(tableId, session.sessionId), session)
}

async function saveChat(tableId, sessionId, messages) {
  await writeJSON(chatPath(tableId, sessionId), messages)
}

async function appendLog(tableId, sessionId, entry) {
  try {
    const p = logPath(tableId, sessionId)
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'
    await fs.appendFile(p, line)
  } catch {
    // Il log non deve mai crashare il server
  }
}

// ── Gestione sessione ─────────────────────────────────────────────────────────

async function getOrCreateSession(tableId, invitedPlayers) {
  if (activeSessions.has(tableId)) return activeSessions.get(tableId)

  // Serializza chiamate concorrenti per lo stesso tavolo
  if (sessionLocks.has(tableId)) return sessionLocks.get(tableId)

  let resolveLock
  const lock = new Promise(r => { resolveLock = r })
  sessionLocks.set(tableId, lock)

  const tDir = tableDir(tableId)
  const sessDir = path.join(tDir, 'sessions')
  await ensureDir(sessDir)
  await ensureDir(path.join(tDir, 'logs'))

  // Cerca sessione esistente non terminata
  let session = null
  let messages = []
  try {
    const files = await fs.readdir(sessDir)
    const sessionFiles = files.filter(f => f.startsWith('session_') && f.endsWith('.json'))
    for (const f of sessionFiles) {
      const s = await readJSON(path.join(sessDir, f))
      if (s.state !== 'terminata') { session = s; break }
    }
    if (session) {
      const cp = chatPath(tableId, session.sessionId)
      if (await fileExists(cp)) messages = await readJSON(cp)
    }
  } catch {}

  if (!session) {
    // Conta sessioni passate per numero progressivo
    let sessionNumber = 1
    try {
      const files = await fs.readdir(sessDir)
      sessionNumber = files.filter(f => f.startsWith('session_')).length + 1
    } catch {}

    session = {
      sessionId: uuidv4(),
      sessionNumber,
      state: 'custode-pronto',
      custodePhase: null,
      focusGroupId: null,
      startedAt: null,
      endedAt: null,
      registroPresenti: [],
      players: invitedPlayers.map(email => ({
        email,
        playerState: 'turno-custode',
        connected: false,
        voteTardi: false,
        lastSeen: null,
        missedSince: null
      })),
      pianoAzione: null,
      lastMessageId: null,
      engagement: {}
    }
    await saveSession(tableId, session)
    await appendLog(tableId, session.sessionId, { event: 'session-created', sessionNumber })
  }

  const ctx = { session, messages, timers: {} }
  activeSessions.set(tableId, ctx)
  sessionLocks.delete(tableId)
  resolveLock(ctx)
  return ctx
}

function getSession(tableId) {
  return activeSessions.get(tableId) || null
}

// ── Giocatori ─────────────────────────────────────────────────────────────────

function getPlayer(ctx, email) {
  return ctx.session.players.find(p => p.email === email)
}

async function playerConnected(tableId, email) {
  const ctx = getSession(tableId)
  if (!ctx) return null
  const { session } = ctx

  const player = getPlayer(ctx, email)
  if (!player) return null

  const wasConnected = player.connected
  const missedSince = player.missedSince
  player.connected = true
  player.missedSince = null
  player.lastSeen = new Date().toISOString()

  if (!session.registroPresenti.includes(email)) {
    session.registroPresenti.push(email)
  }

  // Messaggi persi
  const missed = missedSince
    ? ctx.messages.filter(m => m.timestamp > missed)
    : []

  await saveSession(tableId, session)
  await appendLog(tableId, session.sessionId, { event: 'player-connected', email })

  return { wasConnected, missed }
}

async function playerDisconnected(tableId, email) {
  const ctx = getSession(tableId)
  if (!ctx) return
  const { session } = ctx

  const player = getPlayer(ctx, email)
  if (!player) return

  player.connected = false
  player.missedSince = new Date().toISOString()
  player.lastSeen = new Date().toISOString()

  await saveSession(tableId, session)
  await appendLog(tableId, session.sessionId, { event: 'player-disconnected', email })
}

// ── Messaggi ─────────────────────────────────────────────────────────────────

async function addMessage(tableId, msg) {
  const ctx = getSession(tableId)
  if (!ctx) return null
  const message = { id: uuidv4(), timestamp: new Date().toISOString(), ...msg }
  ctx.messages.push(message)
  ctx.session.lastMessageId = message.id
  await saveChat(tableId, ctx.session.sessionId, ctx.messages)
  await appendLog(tableId, ctx.session.sessionId, { event: 'message', ...message })
  return message
}

function getMessagesSince(tableId, since) {
  const ctx = getSession(tableId)
  if (!ctx) return []
  if (!since) return ctx.messages
  return ctx.messages.filter(m => m.timestamp > since)
}

// ── Stato sessione ─────────────────────────────────────────────────────────────

async function updateSessionState(tableId, newState, extra = {}) {
  const ctx = getSession(tableId)
  if (!ctx) return
  ctx.session.state = newState
  Object.assign(ctx.session, extra)
  if (newState === 'sessione-iniziata' && !ctx.session.startedAt) {
    ctx.session.startedAt = new Date().toISOString()
  }
  if (newState === 'terminata') {
    ctx.session.endedAt = new Date().toISOString()
  }
  await saveSession(tableId, ctx.session)
  await appendLog(tableId, ctx.session.sessionId, { event: 'state-change', state: newState, ...extra })
}

async function updatePlayerState(tableId, email, playerState) {
  const ctx = getSession(tableId)
  if (!ctx) return
  const player = getPlayer(ctx, email)
  if (player) player.playerState = playerState
  await saveSession(tableId, ctx.session)
  await appendLog(tableId, ctx.session.sessionId, { event: 'player-state', email, playerState })
}

async function setAllPlayersState(tableId, playerState) {
  const ctx = getSession(tableId)
  if (!ctx) return
  ctx.session.players.forEach(p => { p.playerState = playerState })
  await saveSession(tableId, ctx.session)
}

async function voteTardi(tableId, email) {
  const ctx = getSession(tableId)
  if (!ctx) return false
  const { session } = ctx
  const player = getPlayer(ctx, email)
  if (player) player.voteTardi = true

  const presenti = session.registroPresenti.length
  const disconnessi = session.players.filter(p => !p.connected).length
  const votiTardi = session.players.filter(p => p.voteTardi).length
  const soglia = Math.ceil(presenti / 2)

  if (disconnessi + votiTardi >= soglia) {
    await updateSessionState(tableId, 'in-chiusura')
    await saveSession(tableId, session)
    return true  // trigger in-chiusura
  }
  await saveSession(tableId, session)
  return false
}

// ── Timer ─────────────────────────────────────────────────────────────────────

function setTimer(tableId, name, ms, callback) {
  const ctx = getSession(tableId)
  if (!ctx) return
  clearTimer(tableId, name)
  ctx.timers[name] = setTimeout(() => {
    delete ctx.timers[name]
    callback()
  }, ms)
}

function clearTimer(tableId, name) {
  const ctx = getSession(tableId)
  if (!ctx) return
  if (ctx.timers[name]) {
    clearTimeout(ctx.timers[name])
    delete ctx.timers[name]
  }
}

function clearAllTimers(tableId) {
  const ctx = getSession(tableId)
  if (!ctx) return
  Object.values(ctx.timers).forEach(t => clearTimeout(t))
  ctx.timers = {}
}

function destroySession(tableId) {
  clearAllTimers(tableId)
  activeSessions.delete(tableId)
}

module.exports = {
  getOrCreateSession,
  getSession,
  getPlayer,
  playerConnected,
  playerDisconnected,
  addMessage,
  getMessagesSince,
  updateSessionState,
  updatePlayerState,
  setAllPlayersState,
  voteTardi,
  setTimer,
  clearTimer,
  clearAllTimers,
  destroySession,
  saveSession
}
