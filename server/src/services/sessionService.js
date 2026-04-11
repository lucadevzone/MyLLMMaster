const { v4: uuidv4 } = require('uuid')
const path = require('path')
const fs = require('fs').promises
const { readJSON, writeJSON, fileExists, ensureDir } = require('../utils/fileStore')
const {
  tableDir,
  sessionsDir,
  sessionDir,
  sessionMetaPath,
  chatHistoryPath,
  sessionLogPath,
  ensureTableRuntimeStructure
} = require('./tableRuntimeStore')

// In-memory active sessions: tableId → { session, messages, timers, typingPlayers }
const activeSessions = new Map()

// Lock per getOrCreateSession: evita che join concorrenti creino ctx duplicati
const sessionLocks = new Map()

function sessionPath(tableId, sessionId) {
  return sessionMetaPath(tableId, sessionId)
}

function chatPath(tableId, sessionId) {
  return chatHistoryPath(tableId, sessionId)
}

function logPath(tableId, sessionId) {
  return sessionLogPath(tableId, sessionId)
}

async function migrateLegacySessionFiles(tableId, sessionId) {
  const legacySession = path.join(tableDir(tableId), 'sessions', `session_${sessionId}.json`)
  const legacyChat = path.join(tableDir(tableId), 'sessions', `chat_${sessionId}.json`)
  const legacyLog = path.join(tableDir(tableId), 'logs', `log_${sessionId}.json`)
  const targetDir = sessionDir(tableId, sessionId)
  await ensureDir(targetDir)

  if (await fileExists(legacySession) && !await fileExists(sessionPath(tableId, sessionId))) {
    await fs.copyFile(legacySession, sessionPath(tableId, sessionId))
  }
  if (await fileExists(legacyChat) && !await fileExists(chatPath(tableId, sessionId))) {
    await fs.copyFile(legacyChat, chatPath(tableId, sessionId))
  }
  if (await fileExists(legacyLog) && !await fileExists(logPath(tableId, sessionId))) {
    await fs.copyFile(legacyLog, logPath(tableId, sessionId))
  }
}

// ── Persistenza ──────────────────────────────────────────────────────────────

async function saveSession(tableId, session) {
  await ensureDir(sessionDir(tableId, session.sessionId))
  await writeJSON(sessionPath(tableId, session.sessionId), session)
}

async function saveChat(tableId, sessionId, messages) {
  await ensureDir(sessionDir(tableId, sessionId))
  await writeJSON(chatPath(tableId, sessionId), messages)
}

async function appendLog(tableId, sessionId, entry) {
  try {
    await ensureDir(sessionDir(tableId, sessionId))
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

  const sessDir = sessionsDir(tableId)
  await ensureTableRuntimeStructure(tableId)

  // Cerca sessione esistente non terminata
  let session = null
  let messages = []
  try {
    const entries = await fs.readdir(sessDir, { withFileTypes: true })
    const legacySessionFiles = entries
      .filter(entry => entry.isFile() && entry.name.startsWith('session_') && entry.name.endsWith('.json'))
      .map(entry => entry.name)
    for (const f of legacySessionFiles) {
      const sessionId = f.replace(/^session_/, '').replace(/\.json$/, '')
      await migrateLegacySessionFiles(tableId, sessionId)
    }

    const sessionEntries = await fs.readdir(sessDir, { withFileTypes: true })
    for (const entry of sessionEntries.filter(item => item.isDirectory())) {
      const sessionMeta = sessionPath(tableId, entry.name)
      if (!await fileExists(sessionMeta)) continue
      const s = await readJSON(sessionMeta)
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
      const entries = await fs.readdir(sessDir, { withFileTypes: true })
      sessionNumber = entries.filter(entry => entry.isDirectory()).length + 1
    } catch {}

    session = {
      sessionId: uuidv4(),
      sessionNumber,
      ragSequenceNumber: 0,
      state: 'custode-pronto',
      custodePhase: null,
      phase: 'inizio_sessione',
      pendingRoll: null,
      pendingClarification: null,
      conversationTargets: {},
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
  } else if (!session.phase) {
    session.phase = 'inizio_sessione'
    await saveSession(tableId, session)
  } else if (!('pendingRoll' in session)) {
    session.pendingRoll = null
    if (!('pendingClarification' in session)) session.pendingClarification = null
    if (!('conversationTargets' in session)) session.conversationTargets = {}
    await saveSession(tableId, session)
  } else if (!('pendingClarification' in session)) {
    session.pendingClarification = null
    if (!('conversationTargets' in session)) session.conversationTargets = {}
    await saveSession(tableId, session)
  } else if (!('conversationTargets' in session)) {
    session.conversationTargets = {}
    await saveSession(tableId, session)
  }

  const ctx = { session, messages, timers: {}, typingPlayers: {} }
  activeSessions.set(tableId, ctx)
  sessionLocks.delete(tableId)
  resolveLock(ctx)
  return ctx
}

function getSession(tableId) {
  return activeSessions.get(tableId) || null
}

async function nextRagSequenceNumber(tableId) {
  const ctx = getSession(tableId)
  if (!ctx) return 0
  ctx.session.ragSequenceNumber = (ctx.session.ragSequenceNumber || 0) + 1
  await saveSession(tableId, ctx.session)
  await appendLog(tableId, ctx.session.sessionId, {
    event: 'rag-sequence',
    sessionNumber: ctx.session.sessionNumber,
    sequenceNumber: ctx.session.ragSequenceNumber
  })
  return ctx.session.ragSequenceNumber
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
    ? ctx.messages.filter(m => m.timestamp > missedSince)
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
  if (ctx.typingPlayers) delete ctx.typingPlayers[email]

  await saveSession(tableId, session)
  await appendLog(tableId, session.sessionId, { event: 'player-disconnected', email })
}

async function setPlayerTyping(tableId, email) {
  const ctx = getSession(tableId)
  if (!ctx) return
  ctx.typingPlayers[email] = Date.now()
  await appendLog(tableId, ctx.session.sessionId, { event: 'player-typing-start', email })
}

async function clearPlayerTyping(tableId, email) {
  const ctx = getSession(tableId)
  if (!ctx) return
  if (ctx.typingPlayers[email]) {
    delete ctx.typingPlayers[email]
    await appendLog(tableId, ctx.session.sessionId, { event: 'player-typing-stop', email })
  }
}

function getTypingPlayers(tableId) {
  const ctx = getSession(tableId)
  return ctx?.typingPlayers || {}
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

async function replaceMessages(tableId, messages = []) {
  const ctx = getSession(tableId)
  if (!ctx) return
  ctx.messages = Array.isArray(messages) ? messages.map(message => ({
    id: message.id || uuidv4(),
    timestamp: message.timestamp || new Date().toISOString(),
    ...message
  })) : []
  ctx.session.lastMessageId = ctx.messages.length ? ctx.messages[ctx.messages.length - 1].id : null
  await saveChat(tableId, ctx.session.sessionId, ctx.messages)
  await saveSession(tableId, ctx.session)
  await appendLog(tableId, ctx.session.sessionId, { event: 'chat-replaced', count: ctx.messages.length })
}

async function updateMessage(tableId, messageId, patch = {}) {
  const ctx = getSession(tableId)
  if (!ctx || !messageId || !patch || typeof patch !== 'object') return null
  const index = ctx.messages.findIndex(message => message?.id === messageId)
  if (index < 0) return null
  ctx.messages[index] = { ...ctx.messages[index], ...patch }
  await saveChat(tableId, ctx.session.sessionId, ctx.messages)
  await appendLog(tableId, ctx.session.sessionId, {
    event: 'message-updated',
    messageId,
    fields: Object.keys(patch)
  })
  return ctx.messages[index]
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

async function updateSessionPhase(tableId, phase) {
  const ctx = getSession(tableId)
  if (!ctx) return
  ctx.session.phase = phase || 'inizio_sessione'
  await saveSession(tableId, ctx.session)
  await appendLog(tableId, ctx.session.sessionId, { event: 'phase-change', phase: ctx.session.phase })
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
  await appendLog(tableId, ctx.session.sessionId, { event: 'all-player-state', playerState })
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
  const timer = {
    callback,
    remainingMs: ms,
    startedAt: Date.now(),
    paused: false,
    handle: null
  }
  timer.handle = setTimeout(() => {
    delete ctx.timers[name]
    callback()
  }, ms)
  ctx.timers[name] = timer
}

function clearTimer(tableId, name) {
  const ctx = getSession(tableId)
  if (!ctx) return
  const timer = ctx.timers[name]
  if (timer) {
    if (timer.handle) clearTimeout(timer.handle)
    delete ctx.timers[name]
  }
}

function clearAllTimers(tableId) {
  const ctx = getSession(tableId)
  if (!ctx) return
  Object.values(ctx.timers).forEach(timer => {
    if (timer.handle) clearTimeout(timer.handle)
  })
  ctx.timers = {}
}

function pauseAllTimers(tableId) {
  const ctx = getSession(tableId)
  if (!ctx) return
  Object.values(ctx.timers).forEach(timer => {
    if (timer.paused || !timer.handle) return
    const elapsed = Date.now() - timer.startedAt
    timer.remainingMs = Math.max(0, timer.remainingMs - elapsed)
    clearTimeout(timer.handle)
    timer.handle = null
    timer.paused = true
  })
}

function resumeAllTimers(tableId) {
  const ctx = getSession(tableId)
  if (!ctx) return
  for (const [name, timer] of Object.entries(ctx.timers)) {
    if (!timer.paused) continue
    const delay = Math.max(0, timer.remainingMs)
    timer.startedAt = Date.now()
    timer.paused = false
    timer.handle = setTimeout(() => {
      delete ctx.timers[name]
      timer.callback()
    }, delay)
  }
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
  setPlayerTyping,
  clearPlayerTyping,
  getTypingPlayers,
  addMessage,
  replaceMessages,
  updateMessage,
  getMessagesSince,
  updateSessionState,
  updateSessionPhase,
  updatePlayerState,
  setAllPlayersState,
  voteTardi,
  setTimer,
  clearTimer,
  clearAllTimers,
  pauseAllTimers,
  resumeAllTimers,
  destroySession,
  saveSession,
  nextRagSequenceNumber,
  sessionPath,
  chatPath,
  logPath
}
