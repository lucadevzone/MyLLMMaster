const express = require('express')
const router = express.Router()
const { v4: uuidv4 } = require('uuid')
const path = require('path')
const fs = require('fs').promises
const { readJSON, writeJSON, fileExists, ensureDir } = require('../utils/fileStore')
const { DATA_DIR, FILES } = require('../utils/dataInit')
const { authMiddleware, adminOnly, playerOnly } = require('../middleware/auth')
const sessionService = require('../services/sessionService')
const custodeEngine = require('../services/custodeEngine')
const { getIO } = require('../socket/runtime')
const { validateInvitedPlayersForModule, reconcileTableState } = require('../services/tableRules')
const {
  tableDir,
  scenesDir,
  charactersDir,
  npcsDir,
  objectsDir,
  cluesDir,
  sessionsDir,
  gameClockPath,
  groupsPath,
  storyLogPath,
  ensureTableRuntimeStructure,
  listScenes,
  getWorldState,
  saveWorldState,
  saveStoryLog,
  getStoryLog,
  renderStoryLogText,
  migrateLegacyTableRuntime,
  seedTableRuntimeFromModuleNotes,
  relationsPath,
  buildInitialRuntimeSet,
  sanitizeFileStem,
  partyKnowledgePath
} = require('../services/tableRuntimeStore')

const TABLES_DIR = path.join(DATA_DIR, 'tables')

async function getTablePath(tableId) {
  return path.join(TABLES_DIR, tableId, 'table.json')
}

async function getAllTables() {
  let dirs
  try {
    dirs = await fs.readdir(TABLES_DIR)
  } catch {
    return []
  }
  const tables = []
  for (const d of dirs) {
    const filePath = path.join(TABLES_DIR, d, 'table.json')
    if (await fileExists(filePath)) {
      tables.push(await readJSON(filePath))
    }
  }
  return tables
}

async function getCurrentSessionMeta(tableId) {
  const active = sessionService.getSession(tableId)?.session
  if (active && active.state !== 'terminata') {
    return {
      sessionState: active.state,
      custodePhase: active.custodePhase,
      phase: active.phase || 'inizio_sessione',
      sessionNumber: active.sessionNumber
    }
  }

  const sessionsDir = path.join(TABLES_DIR, tableId, 'sessions')
  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true })
    for (const entry of entries.filter(item => item.isDirectory())) {
      const session = await readJSON(path.join(sessionsDir, entry.name, 'session.json'))
      if (session.state !== 'terminata') {
        return {
          sessionState: session.state,
          custodePhase: session.custodePhase,
          phase: session.phase || 'inizio_sessione',
          sessionNumber: session.sessionNumber
        }
      }
    }
  } catch {
    // nessuna sessione
  }

  return { sessionState: null, custodePhase: null, phase: null, sessionNumber: null }
}

async function attachSessionMeta(table) {
  return { ...table, ...(await getCurrentSessionMeta(table.id)) }
}

async function listActiveScenes(tableId) {
  const scenes = await listScenes(tableId)
  return scenes.filter(scene => scene?.runtime?.stato !== 'completata' && scene?.runtime?.stato !== 'abbandonata')
}

async function readWorldStateOrDefault(tableId) {
  return getWorldState(tableId)
}

function tableBootstrapDir(tableId) {
  return path.join(TABLES_DIR, tableId, 'bootstrap')
}

async function loadTableBootstrapFiles(tableId) {
  const dir = tableBootstrapDir(tableId)
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const definitions = []
  for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, 'it'))) {
    const filePath = path.join(dir, entry.name, 'bootstrap.json')
    if (!await fileExists(filePath)) continue
    definitions.push(await readJSON(filePath))
  }
  return definitions
}

async function hydrateBootstrapDefinition(tableId, bootstrap) {
  const activeScenes = await listActiveScenes(tableId)
  const worldState = await readWorldStateOrDefault(tableId)
  const fallbackFocusScene = worldState.focusScene || activeScenes[0]?.id_scena || null
  const resolvedFocusSceneId = bootstrap.focusSceneId || fallbackFocusScene
  const resolvedFocusSceneLabel = bootstrap.focusSceneLabel
    || activeScenes.find(scene => scene.id_scena === resolvedFocusSceneId)?.contesto_dove
    || null

  return {
    supported: false,
    initialSessionState: 'sessione-iniziata',
    initialCustodePhase: null,
    initialPlayerState: 'gioco-libero',
    ...bootstrap,
    focusSceneId: resolvedFocusSceneId,
    focusSceneLabel: resolvedFocusSceneLabel
  }
}

async function getSessionBootstrapDefinitions(tableId) {
  const bootstraps = await loadTableBootstrapFiles(tableId)
  return Promise.all(bootstraps.map(bootstrap => hydrateBootstrapDefinition(tableId, bootstrap)))
}

async function getSessionBootstrapDefinition(tableId, bootstrapId) {
  const definitions = await getSessionBootstrapDefinitions(tableId)
  return definitions.find(item => item.id === bootstrapId) || null
}

function bootstrapSnapshotDir(tableId, bootstrapId) {
  return path.join(tableBootstrapDir(tableId), bootstrapId)
}

async function clearDirectoryContents(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    await fs.rm(path.join(dirPath, entry.name), { recursive: true, force: true })
  }
}

async function copyDirectoryContents(sourceDir, targetDir) {
  await ensureDir(targetDir)
  const entries = await fs.readdir(sourceDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)
    if (entry.isDirectory()) {
      await copyDirectoryContents(sourcePath, targetPath)
    } else {
      await ensureDir(path.dirname(targetPath))
      await fs.copyFile(sourcePath, targetPath)
    }
  }
}

async function applyBootstrapSnapshot(tableId, bootstrap, session) {
  const rootDir = bootstrapSnapshotDir(tableId, bootstrap.id)
  const worldStateSnapshot = path.join(rootDir, 'world_state.json')
  const gameClockSnapshot = path.join(rootDir, 'game_clock.json')
  const groupsSnapshot = path.join(rootDir, 'groups.json')
  const storyLogSnapshot = path.join(rootDir, 'story_log.json')
  const partyKnowledgeSnapshot = path.join(rootDir, 'party_knowledge.json')
  const relationsSnapshot = path.join(rootDir, 'grafo_relazioni.json')
  const scenesSnapshot = path.join(rootDir, 'scenes')
  const activeScenesSnapshot = path.join(rootDir, 'active_scenes')
  const charactersSnapshot = path.join(rootDir, 'characters')
  const npcsSnapshot = path.join(rootDir, 'pngs')
  const objectsSnapshot = path.join(rootDir, 'oggetti')
  const cluesSnapshot = path.join(rootDir, 'indizi')
  const diarySnapshot = path.join(rootDir, 'diary.txt')
  const chatSnapshot = path.join(rootDir, 'chat.json')
  const chatHistorySnapshot = path.join(rootDir, 'chat_history.json')

  if (await fileExists(worldStateSnapshot)) {
    const worldState = await readJSON(worldStateSnapshot)
    await saveWorldState(tableId, worldState)
  }

  if (await fileExists(gameClockSnapshot)) {
    await fs.copyFile(gameClockSnapshot, gameClockPath(tableId))
  }
  if (await fileExists(groupsSnapshot)) {
    await fs.copyFile(groupsSnapshot, groupsPath(tableId))
  }
  if (await fileExists(storyLogSnapshot)) {
    await fs.copyFile(storyLogSnapshot, storyLogPath(tableId))
  }
  if (await fileExists(partyKnowledgeSnapshot)) {
    await fs.copyFile(partyKnowledgeSnapshot, partyKnowledgePath(tableId))
  }
  if (await fileExists(relationsSnapshot)) {
    await fs.copyFile(relationsSnapshot, relationsPath(tableId))
  }

  if (await fileExists(scenesSnapshot) || await fileExists(activeScenesSnapshot)) {
    const targetScenesDir = scenesDir(tableId)
    await ensureDir(targetScenesDir)
    await clearDirectoryContents(targetScenesDir)
    if (await fileExists(scenesSnapshot)) {
      await copyDirectoryContents(scenesSnapshot, targetScenesDir)
    } else {
      await copyDirectoryContents(activeScenesSnapshot, targetScenesDir)
    }
  }

  if (await fileExists(charactersSnapshot)) {
    const targetCharactersDir = charactersDir(tableId)
    await ensureDir(targetCharactersDir)
    await clearDirectoryContents(targetCharactersDir)
    await copyDirectoryContents(charactersSnapshot, targetCharactersDir)
  }

  for (const [snapshotDir, targetDir] of [
    [npcsSnapshot, npcsDir(tableId)],
    [objectsSnapshot, objectsDir(tableId)],
    [cluesSnapshot, cluesDir(tableId)]
  ]) {
    if (await fileExists(snapshotDir)) {
      await ensureDir(targetDir)
      await clearDirectoryContents(targetDir)
      await copyDirectoryContents(snapshotDir, targetDir)
    }
  }

  if (await fileExists(diarySnapshot)) {
    const diaryText = await fs.readFile(diarySnapshot, 'utf-8').catch(() => '')
    await saveStoryLog(tableId, {
      ...(await getStoryLog(tableId)),
      entries: diaryText.trim()
        ? [{ id: 'bootstrap_diary', timestamp: new Date().toISOString(), type: 'bootstrap', text: diaryText.trim() }]
        : []
    })
  }

  let chatMessages = []
  if (await fileExists(chatHistorySnapshot)) {
    chatMessages = await readJSON(chatHistorySnapshot)
  } else if (await fileExists(chatSnapshot)) {
    chatMessages = await readJSON(chatSnapshot)
  }
  await sessionService.replaceMessages(tableId, chatMessages)

  const currentCtx = sessionService.getSession(tableId)
  if (currentCtx?.session && session) {
    currentCtx.session.lastMessageId = currentCtx.messages.length
      ? currentCtx.messages[currentCtx.messages.length - 1].id
      : null
  }
}

function isSessionDue(table) {
  if (!table.plannedSession) return false
  const { date, time } = table.plannedSession
  return new Date(`${date}T${time}:00`) <= new Date()
}

async function checkAndOpenTable(table) {
  if (table.state === 'ready' && isSessionDue(table) && await custodeEngine.isSessionBootstrapReady(table.id)) {
    console.log(`[Table] Promozione ready→open: ${table.id}`)
    table.state = 'open'
    table.updatedAt = new Date().toISOString()
    await writeJSON(path.join(TABLES_DIR, table.id, 'table.json'), table)
  }
  return table
}

// GET /api/tables  (admin: tutti, player: solo i suoi)
router.get('/', authMiddleware, async (req, res) => {
  const raw = await getAllTables()
  const tables = await Promise.all(raw.map(checkAndOpenTable))
  if (req.user.role === 'admin') {
    return res.json(await Promise.all(tables.map(attachSessionMeta)))
  }
  const myTables = tables.filter(t =>
    t.invitedPlayers.includes(req.user.email) && t.state !== 'archived'
  )
  res.json(myTables)
})

// GET /api/tables/:id
router.get('/:id', authMiddleware, async (req, res) => {
  const filePath = await getTablePath(req.params.id)
  if (!await fileExists(filePath)) return res.status(404).json({ error: 'Tavolo non trovato' })
  const table = await checkAndOpenTable(await readJSON(filePath))
  if (req.user.role === 'admin') return res.json(await attachSessionMeta(table))
  res.json(table)
})

// GET /api/tables/:id/session-bootstraps
router.get('/:id/session-bootstraps', authMiddleware, async (req, res) => {
  const filePath = await getTablePath(req.params.id)
  if (!await fileExists(filePath)) return res.status(404).json({ error: 'Tavolo non trovato' })
  const table = await readJSON(filePath)
  if (req.user.role !== 'admin' && !table.invitedPlayers.includes(req.user.email)) {
    return res.status(403).json({ error: 'Accesso negato' })
  }
  res.json(await getSessionBootstrapDefinitions(req.params.id))
})

// POST /api/tables  (solo admin)
router.post('/', authMiddleware, adminOnly, async (req, res) => {
  const { moduleId, invitedPlayers } = req.body
  if (!moduleId || !invitedPlayers?.length) {
    return res.status(400).json({ error: 'Dati tavolo incompleti' })
  }

  try {
    await validateInvitedPlayersForModule(moduleId, invitedPlayers)
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }

  const tableId = `tbl_${uuidv4().replace(/-/g, '').slice(0, 8)}`
  const rootDir = tableDir(tableId)

  await ensureTableRuntimeStructure(tableId)

  const table = {
    id: tableId,
    moduleId,
    state: 'active',
    invitedPlayers,
    plannedSession: null,
    custodeStarted: false,
    createdAt: new Date().toISOString()
  }

  await writeJSON(path.join(rootDir, 'table.json'), table)

  await saveWorldState(tableId, {
    currentChapter: 1,
    focusScene: null,
    groups: [],
    npcs: [],
    items: [],
    stato_pgs: {},
    conoscenze_party: '',
    data_inizio_avventura: ''
  })
  await saveStoryLog(tableId, { entries: [] })
  await writeJSON(partyKnowledgePath(tableId), { entries: [] })
  await buildInitialRuntimeSet(tableId, moduleId)

  custodeEngine.prepareSessionBootstrapInBackground(tableId, { force: true })

  res.status(201).json(table)
})

// PATCH /api/tables/:id  (solo admin)
router.patch('/:id', authMiddleware, adminOnly, async (req, res) => {
  const filePath = await getTablePath(req.params.id)
  if (!await fileExists(filePath)) return res.status(404).json({ error: 'Tavolo non trovato' })

  const table = await readJSON(filePath)
  if (req.body.invitedPlayers !== undefined) {
    try {
      await validateInvitedPlayersForModule(table.moduleId, req.body.invitedPlayers)
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message })
    }
  }

  const allowed = ['invitedPlayers', 'plannedSession', 'state']
  for (const key of allowed) {
    if (req.body[key] !== undefined) table[key] = req.body[key]
  }
  const shouldRefreshBootstrap = req.body.moduleId !== undefined
  if (shouldRefreshBootstrap) {
    table.custodeStarted = false
  }
  if (req.body.invitedPlayers !== undefined) {
    table.state = await reconcileTableState(table)
  }
  table.updatedAt = new Date().toISOString()
  await writeJSON(filePath, table)
  if (shouldRefreshBootstrap) {
    custodeEngine.prepareSessionBootstrapInBackground(table.id, { force: true })
  }
  res.json(table)
})

// DELETE /api/tables/:id  (solo admin - archivia)
router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  const filePath = await getTablePath(req.params.id)
  if (!await fileExists(filePath)) return res.status(404).json({ error: 'Tavolo non trovato' })

  const table = await readJSON(filePath)
  table.state = 'archived'
  table.updatedAt = new Date().toISOString()
  await writeJSON(filePath, table)
  res.json({ message: 'Tavolo archiviato' })
})

// DELETE /api/tables  (solo admin - clear all, per playtest)
router.delete('/', authMiddleware, adminOnly, async (req, res) => {
  try {
    const dirs = await fs.readdir(TABLES_DIR)
    for (const d of dirs) {
      await fs.rm(path.join(TABLES_DIR, d), { recursive: true, force: true })
    }
    res.json({ message: 'Tutti i tavoli eliminati' })
  } catch {
    res.status(500).json({ error: 'Errore nella cancellazione dei tavoli' })
  }
})

// GET /api/tables/:id/characters
// POST /api/tables/:id/reset — riporta il tavolo allo stato dopo creazione PG
router.post('/:id/reset', authMiddleware, adminOnly, async (req, res) => {
  const tableId = req.params.id
  const tablePath = path.join(TABLES_DIR, tableId, 'table.json')
  if (!await fileExists(tablePath)) return res.status(404).json({ error: 'Tavolo non trovato' })

  // Ferma engine e sessione in-memory
  custodeEngine.destroy(tableId)
  sessionService.destroySession(tableId)

  const rootDir = tableDir(tableId)

  // Cancella directory runtime e residui legacy del tavolo
  for (const dir of ['sessions', 'scenes', 'pngs', 'oggetti', 'indizi', 'rag', 'active_scenes', 'closed_scenes', 'logs']) {
    const p = path.join(rootDir, dir)
    try { await fs.rm(p, { recursive: true, force: true }) } catch { /* già assente */ }
  }

  // Cancella file runtime e residui legacy
  for (const file of ['world_state.json', 'diary.txt', 'game_clock.json', 'groups.json', 'story_log.json', 'party_knowledge.json', 'grafo_relazioni.json']) {
    try { await fs.unlink(path.join(rootDir, file)) } catch { /* già assente */ }
  }

  // Cancella materiale pre-elaborato del Custode
  for (const file of ['ambientazione.txt', 'avviare_la_sessione.txt']) {
    try { await fs.unlink(path.join(tableDir, file)) } catch { /* già assente */ }
  }

  // Cancella i log LLM del tavolo
  try {
    const promptLogsDir = path.join(rootDir, 'logs', 'prompts')
    const logFiles = await fs.readdir(promptLogsDir)
    for (const file of logFiles) {
      await fs.unlink(path.join(promptLogsDir, file))
    }
  } catch {
    // nessuna cartella log o nessun file da rimuovere
  }

  // Riporta il tavolo a 'ready': tornera' a 'open' solo quando il bootstrap sara' pronto
  const table = await readJSON(tablePath)
  table.state = 'ready'
  table.custodeStarted = false
  table.updatedAt = new Date().toISOString()
  await writeJSON(tablePath, table)
  await ensureTableRuntimeStructure(tableId)
  await saveWorldState(tableId, {
    currentChapter: 1,
    focusScene: null,
    groups: [],
    npcs: [],
    items: [],
    stato_pgs: {},
    conoscenze_party: '',
    data_inizio_avventura: ''
  })
  await saveStoryLog(tableId, { entries: [] })
  await writeJSON(partyKnowledgePath(tableId), { entries: [] })
  await buildInitialRuntimeSet(tableId, table.moduleId)

  res.json({ message: 'Tavolo resettato', table })
})

// POST /api/tables/:id/resume-custode  (solo admin)
router.post('/:id/resume-custode', authMiddleware, adminOnly, async (req, res) => {
  const tableId = req.params.id
  const tablePath = path.join(TABLES_DIR, tableId, 'table.json')
  if (!await fileExists(tablePath)) return res.status(404).json({ error: 'Tavolo non trovato' })

  const ctx = sessionService.getSession(tableId)
  if (!ctx) {
    return res.status(409).json({ error: 'Nessuna sessione attiva in memoria per questo tavolo' })
  }
  if (ctx.session.state !== 'technical-pause') {
    return res.status(409).json({ error: 'Il Custode può essere ripreso solo da una pausa tecnica' })
  }

  sessionService.resumeAllTimers(tableId)
  await sessionService.updateSessionState(tableId, 'sessione-iniziata')

  const io = getIO()
  if (io) {
    io.to(`table:${tableId}`).emit('session:status-update', { state: 'sessione-iniziata' })
    io.to(`table:${tableId}`).emit('session:toast', { type: 'connect', text: 'Custode ripreso' })
  }

  const engine = custodeEngine.getOrCreate(tableId, io)
  engine.resume().catch(console.error)

  const table = await attachSessionMeta(await readJSON(tablePath))
  res.json({ message: 'Custode ripreso', table })
})

// POST /api/tables/:id/session-bootstraps/:bootstrapId/start  (solo admin)
router.post('/:id/session-bootstraps/:bootstrapId/start', authMiddleware, adminOnly, async (req, res) => {
  const tableId = req.params.id
  const tablePath = path.join(TABLES_DIR, tableId, 'table.json')
  if (!await fileExists(tablePath)) return res.status(404).json({ error: 'Tavolo non trovato' })

  const table = await readJSON(tablePath)
  const bootstrap = await getSessionBootstrapDefinition(tableId, req.params.bootstrapId)
  if (!bootstrap) {
    return res.status(404).json({ error: 'Bootstrap non trovato' })
  }
  if (!bootstrap.supported) {
    return res.status(409).json({ error: 'Questo bootstrap non è ancora avviabile da API' })
  }

  await sessionService.getOrCreateSession(tableId, table.invitedPlayers)
  const ctx = sessionService.getSession(tableId)
  if (!ctx) {
    return res.status(500).json({ error: 'Impossibile inizializzare la sessione bootstrap' })
  }

  sessionService.clearAllTimers(tableId)
  custodeEngine.destroy(tableId)
  ctx.messages = []
  ctx.session.lastMessageId = null

  const charsDir = path.join(TABLES_DIR, tableId, 'characters')
  const charFiles = await fs.readdir(charsDir).catch(() => [])
  const chars = await Promise.all(
    charFiles.filter(f => f.endsWith('.json')).map(f => readJSON(path.join(charsDir, f)))
  )
  const charByPlayer = new Map(chars.map(char => [char.playerID, char]))

  ctx.session.players.forEach(player => {
    const char = charByPlayer.get(player.email)
    if (char?.name) player.characterName = char.name
    player.playerState = bootstrap.initialPlayerState || 'gioco-libero'
  })
  ctx.session.bootstrapMode = bootstrap.id
  ctx.session.bootstrap = bootstrap
  ctx.session.custodePhase = bootstrap.initialCustodePhase || null
  ctx.session.phase = bootstrap.initialPhase || 'inizio_sessione'
  ctx.session.pianoAzione = null
  ctx.session.focusGroupId = null
  await sessionService.updateSessionState(tableId, bootstrap.initialSessionState || 'sessione-iniziata')
  await sessionService.saveSession(tableId, ctx.session)
  await applyBootstrapSnapshot(tableId, bootstrap, ctx.session)

  const io = getIO()
  const refreshedCtx = sessionService.getSession(tableId) || ctx
  if (io) {
    io.to(`table:${tableId}`).emit('session:state', {
      session: refreshedCtx.session,
      messages: refreshedCtx.messages || [],
      timerMs: null
    })
    io.to(`table:${tableId}`).emit('session:status-update', { state: bootstrap.initialSessionState || 'sessione-iniziata' })
    refreshedCtx.session.players.forEach(p => {
      io.to(`table:${tableId}`).emit('session:player-update', {
        email: p.email,
        connected: p.connected,
        playerState: bootstrap.initialPlayerState || 'gioco-libero'
      })
    })
  }

  const engine = custodeEngine.getOrCreate(tableId, io)
  if (bootstrap.startMode === 'orchestrator-passive') {
    await engine.startPassiveOrchestrator()
    await engine.emitOrchestratorDebug(`Bootstrap "${bootstrap.label}" attivo: gioco libero con routing passivo dell'Orchestrator.`)
  }

  res.json({
    message: 'Bootstrap avviato',
    table: await attachSessionMeta(table),
    bootstrapMode: ctx.session.bootstrapMode,
    bootstrap
  })
})

router.get('/:id/characters', authMiddleware, async (req, res) => {
  const tableDir = path.join(TABLES_DIR, req.params.id)
  const charsDir = path.join(tableDir, 'characters')
  try {
    const files = await fs.readdir(charsDir)
    const chars = []
    for (const f of files.filter(f => f.endsWith('.json'))) {
      chars.push(await readJSON(path.join(charsDir, f)))
    }
    res.json(chars)
  } catch {
    res.json([])
  }
})

// POST /api/tables/:id/characters  (player crea PG)
router.post('/:id/characters', authMiddleware, playerOnly, async (req, res) => {
  const tableDir = path.join(TABLES_DIR, req.params.id)
  const tablePath = path.join(tableDir, 'table.json')
  if (!await fileExists(tablePath)) return res.status(404).json({ error: 'Tavolo non trovato' })

  const table = await readJSON(tablePath)
  if (!table.invitedPlayers.includes(req.user.email)) {
    return res.status(403).json({ error: 'Non sei invitato a questo tavolo' })
  }
  if (table.state !== 'active') {
    return res.status(400).json({ error: 'Non puoi creare personaggi in questo stato del tavolo' })
  }

  const character = { ...req.body, playerID: req.user.email, id: uuidv4() }

  // Validazione: nome PG univoco nel tavolo (case-insensitive)
  const charsDir = path.join(tableDir, 'characters')
  const existingFiles = await fs.readdir(charsDir).catch(() => [])
  for (const f of existingFiles.filter(f => f.endsWith('.json'))) {
    const existing = await readJSON(path.join(charsDir, f))
    if (existing.playerID !== req.user.email &&
        existing.name?.toLowerCase() === character.name?.toLowerCase()) {
      return res.status(400).json({ error: `Il nome "${character.name}" è già usato da un altro PG in questo tavolo` })
    }
  }

  for (const f of existingFiles.filter(f => f.endsWith('.json'))) {
    const existing = await readJSON(path.join(charsDir, f))
    if (existing.playerID === req.user.email && f !== `${sanitizeFileStem(character.name)}.json`) {
      await fs.rm(path.join(charsDir, f), { force: true })
    }
  }

  const charPath = path.join(tableDir, 'characters', `${sanitizeFileStem(character.name)}.json`)
  await writeJSON(charPath, character)
  await buildInitialRuntimeSet(req.params.id, table.moduleId)

  // Check if all players have created their character → set table to 'ready'
  const charFiles = await fs.readdir(charsDir)
  const chars = []
  for (const f of charFiles.filter(f => f.endsWith('.json'))) {
    chars.push(await readJSON(path.join(charsDir, f)))
  }
  const activePlayers = table.invitedPlayers  // simplified: all invited
  const charOwners = chars.map(c => c.playerID)
  const allCreated = activePlayers.every(email => charOwners.includes(email))
  if (allCreated && table.state === 'active') {
    const movedToReady = await custodeEngine.promoteTableToReadyIfPossible(table.id, table)
    if (!movedToReady) {
      custodeEngine.prepareSessionBootstrapInBackground(table.id, { force: true })
    }
  }

  res.status(201).json(character)
})

// GET /api/tables/:id/characters/mine  (player vede il suo PG)
router.get('/:id/characters/mine', authMiddleware, playerOnly, async (req, res) => {
  const charsDir = path.join(TABLES_DIR, req.params.id, 'characters')
  try {
    const files = await fs.readdir(charsDir)
    for (const f of files.filter(f => f.endsWith('.json'))) {
      const char = await readJSON(path.join(charsDir, f))
      if (char.playerID === req.user.email) return res.json(char)
    }
    res.status(404).json({ error: 'Personaggio non trovato' })
  } catch {
    res.status(404).json({ error: 'Personaggio non trovato' })
  }
})

module.exports = router
