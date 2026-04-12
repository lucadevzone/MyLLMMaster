const path = require('path')
const fs = require('fs').promises
const { DATA_DIR } = require('../utils/dataInit')
const { readJSON, writeJSON, fileExists, ensureDir } = require('../utils/fileStore')
const { loadNotesIndex } = require('./moduleNotesAnalyzer')

function tableDir(tableId) {
  return path.join(DATA_DIR, 'tables', tableId)
}

function scenesDir(tableId) {
  return path.join(tableDir(tableId), 'scenes')
}

function charactersDir(tableId) {
  return path.join(tableDir(tableId), 'characters')
}

function npcsDir(tableId) {
  return path.join(tableDir(tableId), 'pngs')
}

function objectsDir(tableId) {
  return path.join(tableDir(tableId), 'oggetti')
}

function cluesDir(tableId) {
  return path.join(tableDir(tableId), 'indizi')
}

function sessionsDir(tableId) {
  return path.join(tableDir(tableId), 'sessions')
}

function sessionDir(tableId, sessionId) {
  return path.join(sessionsDir(tableId), sessionId)
}

function sessionMetaPath(tableId, sessionId) {
  return path.join(sessionDir(tableId, sessionId), 'session.json')
}

function chatHistoryPath(tableId, sessionId) {
  return path.join(sessionDir(tableId, sessionId), 'chat_history.json')
}

function sessionLogPath(tableId, sessionId) {
  return path.join(sessionDir(tableId, sessionId), 'log.jsonl')
}

function sessionPromptsDir(tableId, sessionId) {
  return path.join(sessionDir(tableId, sessionId), 'prompts')
}

function gameClockPath(tableId) {
  return path.join(tableDir(tableId), 'game_clock.json')
}

function groupsPath(tableId) {
  return path.join(tableDir(tableId), 'groups.json')
}

function storyLogPath(tableId) {
  return path.join(tableDir(tableId), 'story_log.json')
}

function partyKnowledgePath(tableId) {
  return path.join(tableDir(tableId), 'party_knowledge.json')
}

function relationsPath(tableId) {
  return path.join(tableDir(tableId), 'grafo_relazioni.json')
}

function defaultGameClock() {
  return {
    currentChapter: 1,
    data_inizio_avventura: '',
    giorno_avventura: 1,
    ora_gioco: ''
  }
}

function defaultGroupsState() {
  return {
    turno_corrente: null,
    gruppi_attivi: []
  }
}

function defaultStoryLog() {
  return {
    entries: []
  }
}

function defaultPartyKnowledge() {
  return {
    entries: []
  }
}

async function ensureTableRuntimeStructure(tableId) {
  const root = tableDir(tableId)
  await ensureDir(root)
  await Promise.all([
    ensureDir(scenesDir(tableId)),
    ensureDir(charactersDir(tableId)),
    ensureDir(npcsDir(tableId)),
    ensureDir(objectsDir(tableId)),
    ensureDir(cluesDir(tableId)),
    ensureDir(sessionsDir(tableId)),
    ensureDir(path.join(root, 'bootstrap'))
  ])
}

async function getTable(tableId) {
  const p = path.join(tableDir(tableId), 'table.json')
  if (!await fileExists(p)) return null
  return readJSON(p)
}

function moduleNotesDir(moduleId) {
  return path.join(DATA_DIR, 'modules', moduleId, 'notes')
}

function candidateModuleNotesDirs(moduleId) {
  const normalized = String(moduleId || '').trim()
  if (!normalized) return []
  const candidates = [moduleNotesDir(normalized)]
  const stripped = normalized.replace(/^mod_/, '')
  if (stripped && stripped !== normalized) candidates.push(moduleNotesDir(stripped))
  return candidates
}

const notesCache = new Map()

function getModuleNotesResources(moduleId) {
  if (!moduleId) return null
  if (notesCache.has(moduleId)) return notesCache.get(moduleId)
  for (const notesDir of candidateModuleNotesDirs(moduleId)) {
    try {
      const index = loadNotesIndex(notesDir)
      const value = { notesDir, index }
      notesCache.set(moduleId, value)
      return value
    } catch {
      // try next
    }
  }
  notesCache.set(moduleId, null)
  return null
}

async function getTableNotesResources(tableId) {
  const table = await getTable(tableId)
  if (!table?.moduleId) return null
  return getModuleNotesResources(table.moduleId)
}

async function readNotesEntityByRef(notesDir, entityRef) {
  if (!notesDir || !entityRef?.file) return null
  const payload = await readJSON(path.join(notesDir, entityRef.file))
  if (entityRef.type === 'scene' || entityRef.type === 'npc') return payload
  if (entityRef.type === 'object') {
    return (payload.oggetti || []).find(item => item.id_oggetto === entityRef.id) || null
  }
  if (entityRef.type === 'clue') {
    return (payload.indizi || []).find(item => item.id_indizio === entityRef.id) || null
  }
  return payload
}

function defaultNpcRuntimeSlice(id_png) {
  return {
    id_png,
    runtime: {
      stato: 'vivo',
      posizione: null,
      atteggiamento_verso_pg: 'neutrale',
      informazioni_rivelate: [],
      note_npc_master: null
    }
  }
}

function defaultSceneRuntimeSlice(id_scena) {
  return {
    id_scena,
    runtime: {
      stato: 'non_iniziata',
      tempo_inizio: null,
      tempo_corrente: null,
      eventi_accaduti: [],
      trigger_attivati: [],
      indizi_trovati: [],
      note_scene_master: null
    }
  }
}

function extractNpcRuntimeSlice(noteNpc, existing = null) {
  const base = defaultNpcRuntimeSlice(noteNpc.id_png)
  return {
    id_png: noteNpc.id_png,
    runtime: {
      ...base.runtime,
      ...(noteNpc.runtime || {}),
      ...(existing?.runtime || {})
    }
  }
}

function extractSceneRuntimeSlice(noteScene, existing = null) {
  const base = defaultSceneRuntimeSlice(noteScene.id_scena)
  return {
    id_scena: noteScene.id_scena,
    runtime: {
      ...base.runtime,
      ...(noteScene.runtime || {}),
      ...(existing?.runtime || {})
    }
  }
}

function extractObjectRuntimeSlice(noteObject, existing = null) {
  return {
    id_oggetto: noteObject.id_oggetto,
    posizione: existing?.posizione ?? noteObject.posizione ?? null
  }
}

function extractClueRuntimeSlice(noteClue, existing = null) {
  return {
    id_indizio: noteClue.id_indizio,
    stato: existing?.stato ?? noteClue.stato ?? 'non_trovato',
    trovato_da: existing?.trovato_da ?? noteClue.trovato_da ?? null,
    timestamp_scoperta: existing?.timestamp_scoperta ?? noteClue.timestamp_scoperta ?? null,
    in_possesso_di: existing?.in_possesso_di ?? noteClue.in_possesso_di ?? null,
    effetto_meccanico: existing?.effetto_meccanico ?? noteClue.effetto_meccanico ?? null
  }
}

async function listJsonEntities(dirPath) {
  const files = await fs.readdir(dirPath).catch(() => [])
  const values = await Promise.all(
    files.filter(file => file.endsWith('.json')).map(file => readJSON(path.join(dirPath, file)))
  )
  return values
}

async function getGameClock(tableId) {
  const p = gameClockPath(tableId)
  if (!await fileExists(p)) {
    const clock = defaultGameClock()
    await writeJSON(p, clock)
    return clock
  }
  return { ...defaultGameClock(), ...(await readJSON(p)) }
}

async function saveGameClock(tableId, clock) {
  await writeJSON(gameClockPath(tableId), { ...defaultGameClock(), ...(clock || {}) })
}

async function getGroupsState(tableId) {
  const p = groupsPath(tableId)
  if (!await fileExists(p)) {
    const groups = defaultGroupsState()
    await writeJSON(p, groups)
    return groups
  }
  return { ...defaultGroupsState(), ...(await readJSON(p)) }
}

async function saveGroupsState(tableId, groupsState) {
  await writeJSON(groupsPath(tableId), { ...defaultGroupsState(), ...(groupsState || {}) })
}

async function getStoryLog(tableId) {
  const legacyDiary = path.join(tableDir(tableId), 'diary.txt')
  const p = storyLogPath(tableId)
  if (!await fileExists(p) && await fileExists(legacyDiary)) {
    await migrateLegacyTableRuntime(tableId)
  }
  if (!await fileExists(p)) {
    const storyLog = defaultStoryLog()
    await writeJSON(p, storyLog)
    return storyLog
  }
  const raw = await readJSON(p)
  const storyLog = { ...defaultStoryLog(), ...(raw || {}) }
  if (!Array.isArray(storyLog.entries)) storyLog.entries = []
  return storyLog
}

async function saveStoryLog(tableId, storyLog) {
  const normalized = { ...defaultStoryLog(), ...(storyLog || {}) }
  if (!Array.isArray(normalized.entries)) normalized.entries = []
  await writeJSON(storyLogPath(tableId), normalized)
}

async function getPartyKnowledge(tableId) {
  const p = partyKnowledgePath(tableId)
  if (!await fileExists(p)) {
    const payload = defaultPartyKnowledge()
    await writeJSON(p, payload)
    return payload
  }
  const raw = await readJSON(p)
  const normalized = { ...defaultPartyKnowledge(), ...(raw || {}) }
  if (!Array.isArray(normalized.entries)) normalized.entries = []
  return normalized
}

async function savePartyKnowledge(tableId, partyKnowledge) {
  const normalized = { ...defaultPartyKnowledge(), ...(partyKnowledge || {}) }
  if (!Array.isArray(normalized.entries)) normalized.entries = []
  await writeJSON(partyKnowledgePath(tableId), normalized)
}

function renderStoryLogText(storyLog) {
  return (storyLog?.entries || [])
    .map(entry => entry?.text || '')
    .filter(Boolean)
    .join('\n\n')
}

function renderPartyKnowledgeText(partyKnowledge) {
  return (partyKnowledge?.entries || [])
    .map(entry => entry?.text || '')
    .filter(Boolean)
    .join('\n')
}

async function appendStoryLogEntry(tableId, entry) {
  const storyLog = await getStoryLog(tableId)
  const nextId = storyLog.entries.length
    ? Math.max(...storyLog.entries.map(item => Number(item.id) || 0)) + 1
    : 1
  storyLog.entries.push({
    id: entry.id || nextId,
    timestamp: entry.timestamp || new Date().toISOString(),
    sessione: entry.sessione ?? null,
    scena: entry.scena ?? null,
    type: entry.type || 'narrative',
    text: entry.text || ''
  })
  await saveStoryLog(tableId, storyLog)
}

async function appendPartyKnowledgeEntry(tableId, entry) {
  const partyKnowledge = await getPartyKnowledge(tableId)
  const nextId = partyKnowledge.entries.length
    ? Math.max(...partyKnowledge.entries.map(item => Number(item.id) || 0)) + 1
    : 1
  partyKnowledge.entries.push({
    id: entry.id || nextId,
    scena: entry.scena ?? null,
    timestamp: entry.timestamp || new Date().toISOString(),
    text: entry.text || ''
  })
  await savePartyKnowledge(tableId, partyKnowledge)
}

async function listScenes(tableId) {
  const dirPath = scenesDir(tableId)
  const hasScenesDir = await fileExists(dirPath)
  const hasLegacyScenes = await fileExists(path.join(tableDir(tableId), 'active_scenes'))
    || await fileExists(path.join(tableDir(tableId), 'closed_scenes'))
  if ((!hasScenesDir || !(await fs.readdir(dirPath).catch(() => [])).length) && hasLegacyScenes) {
    await migrateLegacyTableRuntime(tableId)
  }
  const runtimeScenes = await listJsonEntities(scenesDir(tableId))
  const resources = await getTableNotesResources(tableId)
  if (!resources?.index) return runtimeScenes
  const merged = await Promise.all(runtimeScenes.map(async runtimeScene => {
    const ref = resources.index.byId?.[runtimeScene.id_scena]
    const noteScene = ref ? await readNotesEntityByRef(resources.notesDir, ref) : null
    if (!noteScene) return runtimeScene
    return {
      ...noteScene,
      id_scena: runtimeScene.id_scena || noteScene.id_scena,
      runtime: {
        ...(noteScene.runtime || {}),
        ...(runtimeScene.runtime || {})
      }
    }
  }))
  return merged
}

async function getScene(tableId, sceneId) {
  const p = path.join(scenesDir(tableId), `${sceneId}.json`)
  const runtimeScene = await fileExists(p) ? await readJSON(p) : null
  const resources = await getTableNotesResources(tableId)
  const ref = resources?.index?.byId?.[sceneId] || null
  const noteScene = ref ? await readNotesEntityByRef(resources.notesDir, ref) : null
  if (!noteScene) return runtimeScene
  return {
    ...noteScene,
    id_scena: runtimeScene?.id_scena || noteScene.id_scena,
    runtime: {
      ...(noteScene.runtime || {}),
      ...(runtimeScene?.runtime || {})
    }
  }
}

async function getNpc(tableId, npcId) {
  const p = path.join(npcsDir(tableId), `${npcId}.json`)
  const runtimeNpc = await fileExists(p) ? await readJSON(p) : null
  const resources = await getTableNotesResources(tableId)
  const ref = resources?.index?.byId?.[npcId] || null
  const noteNpc = ref ? await readNotesEntityByRef(resources.notesDir, ref) : null
  if (!noteNpc) return runtimeNpc
  return {
    ...noteNpc,
    id_png: runtimeNpc?.id_png || noteNpc.id_png,
    runtime: {
      ...(noteNpc.runtime || {}),
      ...(runtimeNpc?.runtime || {})
    }
  }
}

async function getObject(tableId, objectId) {
  const p = path.join(objectsDir(tableId), `${objectId}.json`)
  const runtimeObject = await fileExists(p) ? await readJSON(p) : null
  const resources = await getTableNotesResources(tableId)
  const ref = resources?.index?.byId?.[objectId] || null
  const noteObject = ref ? await readNotesEntityByRef(resources.notesDir, ref) : null
  if (!noteObject) return runtimeObject
  return {
    ...noteObject,
    id_oggetto: runtimeObject?.id_oggetto || noteObject.id_oggetto,
    posizione: runtimeObject?.posizione ?? noteObject.posizione ?? null
  }
}

async function getClue(tableId, clueId) {
  const p = path.join(cluesDir(tableId), `${clueId}.json`)
  const runtimeClue = await fileExists(p) ? await readJSON(p) : null
  const resources = await getTableNotesResources(tableId)
  const ref = resources?.index?.byId?.[clueId] || null
  const noteClue = ref ? await readNotesEntityByRef(resources.notesDir, ref) : null
  if (!noteClue) return runtimeClue
  return {
    ...noteClue,
    id_indizio: runtimeClue?.id_indizio || noteClue.id_indizio,
    stato: runtimeClue?.stato ?? noteClue.stato ?? 'non_trovato',
    trovato_da: runtimeClue?.trovato_da ?? noteClue.trovato_da ?? null,
    timestamp_scoperta: runtimeClue?.timestamp_scoperta ?? noteClue.timestamp_scoperta ?? null,
    in_possesso_di: runtimeClue?.in_possesso_di ?? noteClue.in_possesso_di ?? null,
    effetto_meccanico: runtimeClue?.effetto_meccanico ?? noteClue.effetto_meccanico ?? null
  }
}

async function getCharacterByName(tableId, name) {
  const normalized = String(name || '').trim().toLowerCase()
  if (!normalized) return null
  const chars = await listJsonEntities(charactersDir(tableId))
  return chars.find(char => String(char.name || '').trim().toLowerCase() === normalized) || null
}

async function getCharacterByPlayerId(tableId, playerId) {
  const normalized = String(playerId || '').trim().toLowerCase()
  if (!normalized) return null
  const chars = await listJsonEntities(charactersDir(tableId))
  return chars.find(char => String(char.playerID || '').trim().toLowerCase() === normalized) || null
}

async function saveScene(tableId, scene) {
  await ensureDir(scenesDir(tableId))
  const current = await readJSON(path.join(scenesDir(tableId), `${scene.id_scena}.json`)).catch(() => null)
  let payload
  if (scene.runtime && typeof scene.runtime === 'object') {
    payload = {
      id_scena: scene.id_scena,
      runtime: {
        ...(current?.runtime || {}),
        ...scene.runtime
      }
    }
  } else {
    payload = {
      id_scena: scene.id_scena,
      runtime: {
        ...(current?.runtime || {}),
        stato: current?.runtime?.stato || 'non_iniziata',
        tempo_inizio: current?.runtime?.tempo_inizio || null,
        tempo_corrente: scene.momento_corrente ?? current?.runtime?.tempo_corrente ?? null,
        eventi_accaduti: current?.runtime?.eventi_accaduti || [],
        trigger_attivati: current?.runtime?.trigger_attivati || [],
        indizi_trovati: current?.runtime?.indizi_trovati || [],
        note_scene_master: scene.progressione ?? current?.runtime?.note_scene_master ?? null
      }
    }
  }
  await writeJSON(path.join(scenesDir(tableId), `${scene.id_scena}.json`), payload)
}

async function closeScene(tableId, sceneId, suggerimentoProssimaScena = '') {
  const scene = await getScene(tableId, sceneId)
  if (!scene) return
  if (!scene.runtime || typeof scene.runtime !== 'object') scene.runtime = {}
  scene.runtime.stato = 'completata'
  scene.suggerimento_prossima_scena = suggerimentoProssimaScena || scene.suggerimento_prossima_scena || ''
  await saveScene(tableId, scene)
}

async function nextSceneId(tableId) {
  const scenes = await listScenes(tableId)
  return `scene_${String(scenes.length).padStart(3, '0')}`
}

async function getWorldState(tableId) {
  const hasLegacyWorldState = await fileExists(path.join(tableDir(tableId), 'world_state.json'))
  const hasStructuredRuntime = await fileExists(gameClockPath(tableId))
    || await fileExists(groupsPath(tableId))
    || await fileExists(storyLogPath(tableId))
  if (hasLegacyWorldState && !hasStructuredRuntime) {
    await migrateLegacyTableRuntime(tableId)
  }

  const [clock, groupsState, storyLog, partyKnowledge, npcSlices, objectSlices, scenes, resources, chars] = await Promise.all([
    getGameClock(tableId),
    getGroupsState(tableId),
    getStoryLog(tableId),
    getPartyKnowledge(tableId),
    listJsonEntities(npcsDir(tableId)),
    listJsonEntities(objectsDir(tableId)),
    listScenes(tableId),
    getTableNotesResources(tableId),
    listJsonEntities(charactersDir(tableId))
  ])

  const charNameToEmail = Object.fromEntries((chars || []).map(char => [String(char.name || '').toLowerCase(), char.playerID]))
  const activeGroups = Array.isArray(groupsState.gruppi_attivi) ? groupsState.gruppi_attivi : []
  const focusSceneCandidate = activeGroups[0]?.sceneId || null
  const focusSceneExists = focusSceneCandidate && scenes.some(scene => scene?.id_scena === focusSceneCandidate)
  const fallbackFocusScene = !focusSceneExists && scenes.length === 1 ? scenes[0].id_scena : focusSceneCandidate
  const normalizedGroups = activeGroups.map(group => {
    if (!group || typeof group !== 'object') return group
    const sceneIdExists = group.sceneId && scenes.some(scene => scene?.id_scena === group.sceneId)
    const participantEmails = (group.participants || []).map(name => charNameToEmail[String(name || '').toLowerCase()] || name)
    if (!sceneIdExists && scenes.length === 1) {
      return { ...group, sceneId: scenes[0].id_scena, participants: participantEmails }
    }
    return { ...group, participants: participantEmails }
  })

  const npcRuntimeList = await Promise.all((Array.isArray(npcSlices) ? npcSlices : []).map(async slice => {
    const ref = resources?.index?.byId?.[slice.id_png] || null
    const noteNpc = ref ? await readNotesEntityByRef(resources.notesDir, ref) : null
    return {
      id_png: slice.id_png,
      name: noteNpc?.nome || slice.nome || slice.name || slice.id_png,
      scena_id: slice.runtime?.posizione?.tipo === 'scena' ? slice.runtime.posizione.id : null,
      posizione: slice.runtime?.posizione ?? null,
      stato: slice.runtime?.stato || noteNpc?.runtime?.stato || 'vivo',
      atteggiamento_verso_pg: slice.runtime?.atteggiamento_verso_pg ?? null,
      informazioni_rivelate: slice.runtime?.informazioni_rivelate || [],
      note_npc_master: slice.runtime?.note_npc_master ?? null
    }
  }))

  const itemRuntimeList = await Promise.all((Array.isArray(objectSlices) ? objectSlices : []).map(async slice => {
    const ref = resources?.index?.byId?.[slice.id_oggetto] || null
    const noteObject = ref ? await readNotesEntityByRef(resources.notesDir, ref) : null
    return {
      id_oggetto: slice.id_oggetto,
      name: noteObject?.nome || slice.id_oggetto,
      posizione: slice.posizione ?? noteObject?.posizione ?? null
    }
  }))

  return {
    currentChapter: clock.currentChapter || 1,
    focusScene: fallbackFocusScene || null,
    groups: normalizedGroups,
    stato_pgs: Object.fromEntries((chars || []).map(char => [char.name, { stato: char.stato_corrente || '' }])),
    conoscenze_party: renderPartyKnowledgeText(partyKnowledge),
    data_inizio_avventura: typeof clock.data_inizio_avventura === 'string' ? clock.data_inizio_avventura : '',
    npcs: npcRuntimeList,
    items: itemRuntimeList
  }
}

async function saveWorldState(tableId, worldState) {
  await ensureTableRuntimeStructure(tableId)

  const currentClock = await getGameClock(tableId)
  const nextClock = {
    ...currentClock,
    currentChapter: worldState.currentChapter ?? currentClock.currentChapter,
    data_inizio_avventura: worldState.data_inizio_avventura ?? currentClock.data_inizio_avventura
  }
  await saveGameClock(tableId, nextClock)

  await saveGroupsState(tableId, {
    turno_corrente: null,
    gruppi_attivi: await mapLegacyGroupsToRuntimeGroups(tableId, Array.isArray(worldState.groups) ? worldState.groups : [], worldState.focusScene ?? null)
  })

  await syncNpcRuntimeCollection(tableId, worldState.npcs || [])
  await syncObjectRuntimeCollection(tableId, worldState.items || [])
  await syncCharacterStates(tableId, worldState.stato_pgs || {})
}

async function mapLegacyGroupsToRuntimeGroups(tableId, groups, focusScene = null) {
  const chars = await listJsonEntities(charactersDir(tableId))
  const emailToName = Object.fromEntries((chars || []).map(char => [char.playerID, char.name]))
  const mapped = (groups || []).map((group, index) => ({
    groupId: group.groupId || `group${String(index + 1).padStart(2, '0')}`,
    sceneId: group.sceneId || focusScene || null,
    participants: (group.participants || []).map(value => emailToName[value] || value)
  }))
  if (!mapped.length && chars.length) {
    return [{
      groupId: 'group01',
      sceneId: focusScene || null,
      participants: chars.map(char => char.name)
    }]
  }
  return mapped
}

async function syncCharacterStates(tableId, statoPgs) {
  const chars = await listJsonEntities(charactersDir(tableId))
  for (const char of chars) {
    const next = statoPgs?.[char.name]?.stato
    if (next == null) continue
    char.stato_corrente = next
    await writeJSON(path.join(charactersDir(tableId), `${sanitizeFileStem(char.name)}.json`), char)
  }
}

async function syncNpcRuntimeCollection(tableId, npcs) {
  const resources = await getTableNotesResources(tableId)
  await ensureDir(npcsDir(tableId))
  if (!resources?.index) {
    await syncLegacyEntityCollection(npcsDir(tableId), npcs, 'name')
    return
  }
  const updates = []
  for (const npc of npcs) {
    if (!npc || typeof npc !== 'object') continue
    const ref = npc.id_png
      ? resources.index.byId?.[npc.id_png]
      : (resources.index.entities?.npc || []).find(entity => entity.name === npc.name)
    if (!ref) continue
    const existing = await readJSON(path.join(npcsDir(tableId), `${ref.id}.json`)).catch(() => null)
    const payload = extractNpcRuntimeSlice({ id_png: ref.id, runtime: existing?.runtime || {} }, existing)
    payload.runtime.stato = npc.stato ?? payload.runtime.stato
    if (npc.posizione) payload.runtime.posizione = npc.posizione
    else if (npc.scena_id) payload.runtime.posizione = { tipo: 'scena', id: npc.scena_id }
    if (npc.atteggiamento_verso_pg != null) payload.runtime.atteggiamento_verso_pg = npc.atteggiamento_verso_pg
    if (Array.isArray(npc.informazioni_rivelate)) payload.runtime.informazioni_rivelate = npc.informazioni_rivelate
    if (npc.note_npc_master != null) payload.runtime.note_npc_master = npc.note_npc_master
    updates.push([ref.id, payload])
  }
  for (const [id, payload] of updates) {
    await writeJSON(path.join(npcsDir(tableId), `${id}.json`), payload)
  }
}

async function syncObjectRuntimeCollection(tableId, items) {
  const resources = await getTableNotesResources(tableId)
  await ensureDir(objectsDir(tableId))
  if (!resources?.index) {
    await syncLegacyEntityCollection(objectsDir(tableId), items, 'name')
    return
  }
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const ref = item.id_oggetto
      ? resources.index.byId?.[item.id_oggetto]
      : (resources.index.entities?.object || []).find(entity => entity.name === item.name)
    if (!ref) continue
    const existing = await readJSON(path.join(objectsDir(tableId), `${ref.id}.json`)).catch(() => null)
    const payload = {
      id_oggetto: ref.id,
      posizione: item.posizione ?? existing?.posizione ?? null
    }
    await writeJSON(path.join(objectsDir(tableId), `${ref.id}.json`), payload)
  }
}

async function syncLegacyEntityCollection(dirPath, items, keyField) {
  const existingFiles = await fs.readdir(dirPath).catch(() => [])
  const nextNames = new Set()
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const fileName = item.id_png || item.id_oggetto || item.id_indizio || sanitizeFileStem(item[keyField] || 'item')
    nextNames.add(`${fileName}.json`)
    await writeJSON(path.join(dirPath, `${fileName}.json`), item)
  }
  for (const file of existingFiles.filter(name => name.endsWith('.json'))) {
    if (!nextNames.has(file)) await fs.rm(path.join(dirPath, file), { force: true })
  }
}

function sanitizeFileStem(value) {
  return String(value || 'item')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'item'
}

async function migrateLegacyTableRuntime(tableId) {
  await ensureTableRuntimeStructure(tableId)
  const table = await getTable(tableId)
  if (table?.moduleId) {
    await seedTableRuntimeFromModuleNotes(tableId, table.moduleId, { overwrite: false })
  }

  const legacyWorldStatePath = path.join(tableDir(tableId), 'world_state.json')
  if (await fileExists(legacyWorldStatePath)) {
    const legacy = await readJSON(legacyWorldStatePath)
    await saveWorldState(tableId, legacy)
  }

  const activeDir = path.join(tableDir(tableId), 'active_scenes')
  const closedDir = path.join(tableDir(tableId), 'closed_scenes')
  for (const [dirPath, status] of [[activeDir, null], [closedDir, 'completata']]) {
    const files = await fs.readdir(dirPath).catch(() => [])
    for (const file of files.filter(name => name.endsWith('.json'))) {
      const scene = await readJSON(path.join(dirPath, file))
      if (status) {
        if (!scene.runtime || typeof scene.runtime !== 'object') scene.runtime = {}
        scene.runtime.stato = scene.runtime.stato || status
      }
      await saveScene(tableId, scene)
    }
  }

  const legacyDiaryPath = path.join(tableDir(tableId), 'diary.txt')
  if (await fileExists(legacyDiaryPath)) {
    const diaryText = await fs.readFile(legacyDiaryPath, 'utf-8').catch(() => '')
    const trimmed = String(diaryText || '').trim()
    if (trimmed) {
      const storyLog = await getStoryLog(tableId)
      if (!storyLog.entries.length) {
        storyLog.entries.push({
          id: 'legacy_diary_import',
          timestamp: new Date().toISOString(),
          type: 'legacy-import',
          text: trimmed
        })
        await saveStoryLog(tableId, storyLog)
      }
    }
  }
}

async function seedTableRuntimeFromModuleNotes(tableId, moduleId, { overwrite = false } = {}) {
  await ensureTableRuntimeStructure(tableId)
  const resources = getModuleNotesResources(moduleId)
  if (!resources?.index) return false

  for (const entity of resources.index.entities?.scene || []) {
    const noteScene = await readNotesEntityByRef(resources.notesDir, entity)
    if (!noteScene) continue
    const target = path.join(scenesDir(tableId), `${entity.id}.json`)
    const existing = await readJSON(target).catch(() => null)
    if (!overwrite && existing) continue
    await writeJSON(target, extractSceneRuntimeSlice(noteScene, existing))
  }

  for (const entity of resources.index.entities?.npc || []) {
    const noteNpc = await readNotesEntityByRef(resources.notesDir, entity)
    if (!noteNpc) continue
    const target = path.join(npcsDir(tableId), `${entity.id}.json`)
    const existing = await readJSON(target).catch(() => null)
    if (!overwrite && existing) continue
    await writeJSON(target, extractNpcRuntimeSlice(noteNpc, existing))
  }

  for (const entity of resources.index.entities?.object || []) {
    const noteObject = await readNotesEntityByRef(resources.notesDir, entity)
    if (!noteObject) continue
    const target = path.join(objectsDir(tableId), `${entity.id}.json`)
    const existing = await readJSON(target).catch(() => null)
    if (!overwrite && existing) continue
    await writeJSON(target, extractObjectRuntimeSlice(noteObject, existing))
  }

  for (const entity of resources.index.entities?.clue || []) {
    const noteClue = await readNotesEntityByRef(resources.notesDir, entity)
    if (!noteClue) continue
    const target = path.join(cluesDir(tableId), `${entity.id}.json`)
    const existing = await readJSON(target).catch(() => null)
    if (!overwrite && existing) continue
    await writeJSON(target, extractClueRuntimeSlice(noteClue, existing))
  }

  const relationsNotePath = path.join(resources.notesDir, 'grafo_relazioni.json')
  if (await fileExists(relationsNotePath) && (overwrite || !await fileExists(relationsPath(tableId)))) {
    const relations = await readJSON(relationsNotePath)
    await writeJSON(relationsPath(tableId), relations)
  }

  return true
}

async function buildInitialRuntimeSet(tableId, moduleId) {
  await ensureTableRuntimeStructure(tableId)
  await seedTableRuntimeFromModuleNotes(tableId, moduleId, { overwrite: true })

  const chars = await listJsonEntities(charactersDir(tableId))
  const table = await getTable(tableId)
  const charsByPlayer = new Map(chars.map(char => [char.playerID, char]))
  const orderedChars = (table?.invitedPlayers || [])
    .map(email => charsByPlayer.get(email))
    .filter(Boolean)
  const participantNames = (orderedChars.length ? orderedChars : chars).map(char => char.name)
  const resources = getModuleNotesResources(moduleId)
  const defaultSceneId = resources?.index?.byId?.scena_asta_grand_palais
    ? 'scena_asta_grand_palais'
    : (resources?.index?.entities?.scene || [])[0]?.id || null

  await saveGroupsState(tableId, {
    turno_corrente: null,
    gruppi_attivi: participantNames.length ? [{
      groupId: 'group01',
      sceneId: defaultSceneId,
      participants: participantNames
    }] : []
  })

  await saveStoryLog(tableId, { entries: [] })
  await savePartyKnowledge(tableId, { entries: [] })
  const clock = await getGameClock(tableId)
  await saveGameClock(tableId, {
    ...clock,
    currentChapter: 1
  })
}

module.exports = {
  tableDir,
  scenesDir,
  charactersDir,
  npcsDir,
  objectsDir,
  cluesDir,
  sessionsDir,
  sessionDir,
  sessionMetaPath,
  chatHistoryPath,
  sessionLogPath,
  sessionPromptsDir,
  gameClockPath,
  groupsPath,
  storyLogPath,
  partyKnowledgePath,
  relationsPath,
  ensureTableRuntimeStructure,
  getGameClock,
  saveGameClock,
  getGroupsState,
  saveGroupsState,
  getStoryLog,
  saveStoryLog,
  getPartyKnowledge,
  savePartyKnowledge,
  renderStoryLogText,
  renderPartyKnowledgeText,
  appendStoryLogEntry,
  appendPartyKnowledgeEntry,
  listScenes,
  getScene,
  getNpc,
  getObject,
  getClue,
  getCharacterByName,
  getCharacterByPlayerId,
  saveScene,
  closeScene,
  nextSceneId,
  getWorldState,
  saveWorldState,
  migrateLegacyTableRuntime,
  seedTableRuntimeFromModuleNotes,
  buildInitialRuntimeSet,
  sanitizeFileStem
}
