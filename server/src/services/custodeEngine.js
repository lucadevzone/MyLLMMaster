/**
 * Custode Engine — macchina a stati procedurale del Game Master LLM
 *
 * Fasi: 1 → 2(opening) → 3(orchestrator) → 4a(scene progress) →
 * 4b(analisi dichiarazioni + sottofasi) → 5(risoluzione stato) → torna a 4a o 2
 */

const path = require('path')
const fs = require('fs').promises
const orchestratorContextBundles = require('../../../config/orchestrator_context_bundles.json')
const orchestratorRoutingPolicy = require('../../../config/orchestrator_routing_policy.json')
const { readJSON, writeJSON, fileExists, ensureDir } = require('../utils/fileStore')
const { DATA_DIR } = require('../utils/dataInit')
const svc = require('./sessionService')
const ollama = require('./ollamaService')
const rag = require('./ragService')
const runtimeStore = require('./tableRuntimeStore')
const { loadNotesIndex, buildQuestionCatalogFromNotesIndex } = require('./moduleNotesAnalyzer')
const {
  renderSceneSummary,
  renderNpcSummary,
  renderObjectSummary,
  renderClueSummary,
  renderLocationSummary,
  renderPgSummary,
  renderRulesExcerpt,
  renderSkillsCatalogSummary,
  loadRulesVocabulary
} = require('./contextObjectRenderers')

const THINKING_MESSAGES_FILE = path.join(__dirname, '../../../config/custode-messages.json')
let thinkingMessagesCache = null

async function loadThinkingMessages() {
  if (thinkingMessagesCache) return thinkingMessagesCache
  try {
    const raw = await fs.readFile(THINKING_MESSAGES_FILE, 'utf-8')
    thinkingMessagesCache = JSON.parse(raw)
  } catch {
    thinkingMessagesCache = {}
  }
  return thinkingMessagesCache
}

function phaseLabel(phaseKey) {
  // "fase-1a" → "[1a]", "sottofase-4b-chiarimenti" → "[sottofase-4b-chiarimenti]"
  return phaseKey.replace('fase-', '[') + ']'
}

const MSG_BUFFER_SIZE = parseInt(process.env.MSG_BUFFER_SIZE || '20')
const SILENCE_TIMER_MS = parseInt(process.env.SILENCE_TIMER_MS || String(30 * 1000))
const PLAYER_TYPING_TTL_MS = parseInt(process.env.PLAYER_TYPING_TTL_MS || '4000')
const PROACTIVITY_TIMER_MS = parseInt(process.env.PROACTIVITY_TIMER_MS || String(5 * 60 * 1000))
const PREP_FILES = {
  ambientazione: 'ambientazione.txt',
  avvio: 'avviare_la_sessione.txt'
}

// ── Helpers filesystem ────────────────────────────────────────────────────────

function tDir(tableId) { return path.join(DATA_DIR, 'tables', tableId) }
function moduleAmbientazionePath(moduleId) {
  return path.join(DATA_DIR, 'modules', `${moduleId}_ambientazione.txt`)
}

function moduleNotesDir(moduleId) {
  return path.join(DATA_DIR, 'modules', moduleId, 'notes')
}

function candidateModuleNotesDirs(moduleId) {
  const normalized = String(moduleId || '').trim()
  if (!normalized) return []
  const candidates = [moduleNotesDir(normalized)]
  const stripped = normalized.replace(/^mod_/, '')
  if (stripped && stripped !== normalized) {
    candidates.push(moduleNotesDir(stripped))
  }
  return candidates
}

const notesQuestionCatalogCache = new Map()
const notesIndexCache = new Map()
const rulesVocabulary = loadRulesVocabulary()

function getModuleQuestionCatalog(moduleId) {
  if (!moduleId) return null
  if (notesQuestionCatalogCache.has(moduleId)) return notesQuestionCatalogCache.get(moduleId)

  for (const notesDir of candidateModuleNotesDirs(moduleId)) {
    try {
      const index = loadNotesIndex(notesDir)
      notesIndexCache.set(moduleId, { index, notesDir })
      const catalog = buildQuestionCatalogFromNotesIndex(index)
      notesQuestionCatalogCache.set(moduleId, catalog)
      return catalog
    } catch {
      // prova il candidato successivo
    }
  }

  notesQuestionCatalogCache.set(moduleId, null)
  return null
}

function getModuleNotesResources(moduleId) {
  if (!moduleId) return null
  if (notesIndexCache.has(moduleId)) return notesIndexCache.get(moduleId)
  for (const notesDir of candidateModuleNotesDirs(moduleId)) {
    try {
      const index = loadNotesIndex(notesDir)
      const value = { index, notesDir }
      notesIndexCache.set(moduleId, value)
      return value
    } catch {
      // prova il candidato successivo
    }
  }
  notesIndexCache.set(moduleId, null)
  return null
}

async function readNotesEntityByRef(notesDir, entityRef) {
  if (!notesDir || !entityRef?.file) return null
  const filePath = path.join(notesDir, entityRef.file)
  const payload = await readJSON(filePath)

  if (entityRef.type === 'scene') return payload
  if (entityRef.type === 'npc') return payload
  if (entityRef.type === 'object') {
    return (payload.oggetti || []).find(item => item.id_oggetto === entityRef.id) || null
  }
  if (entityRef.type === 'clue') {
    return (payload.indizi || []).find(item => item.id_indizio === entityRef.id) || null
  }
  return null
}

function lookupEntityRefByName(index, type, name) {
  const normalized = normalizeChatText(name)
  if (!normalized || !index) return null
  const direct = index.byName?.[type]?.[normalized]
  if (direct) return direct
  if (type === 'scene') {
    const byLocation = (index.entities?.scene || []).find(entity => normalizeChatText(entity.locationName) === normalized)
    if (byLocation) return byLocation
  }
  return (index.entities?.[type] || []).find(entity => normalizeChatText(entity.name) === normalized) || null
}

function recentPlayerMessagesSummary(messages = [], maxItems = 6) {
  const seen = new Set()
  return messages
    .filter(message => message && !['orchestrator-debug', 'custode'].includes(message.type))
    .slice(-maxItems)
    .map(message => `${message.fromName || message.from}: ${normalizeNarrativeText(message.text)}`)
    .filter(line => {
      if (!line || seen.has(line)) return false
      seen.add(line)
      return true
    })
    .filter(Boolean)
    .join('\n')
}

function fullConversationTranscript(messages = [], players = []) {
  const characterNameByEmail = new Map(
    (players || [])
      .filter(player => player?.email)
      .map(player => [player.email, normalizeNarrativeText(player.characterName || player.email)])
  )

  const lines = []
  for (const message of (messages || [])) {
    if (!message || message.type === 'orchestrator-debug') continue
    const text = normalizeNarrativeText(message.text)
    if (!text) continue
    const speaker = characterNameByEmail.get(message.from)
      || normalizeNarrativeText(message.fromName || message.from || 'Sconosciuto')
    const line = `${speaker}: ${text}`
    const previous = lines[lines.length - 1]
    if (previous && normalizeChatText(previous) === normalizeChatText(line)) continue
    lines.push(line)
  }
  return lines.join('\n')
}

function classifyNpcRelationship(value = '') {
  const raw = normalizeNarrativeText(value)
  const normalized = normalizeChatText(raw)
  if (!normalized) return 'neutrale'
  const explicitPrefix = raw.split(':')[0]?.trim() || ''
  const explicitNormalized = normalizeChatText(explicitPrefix)
  if (['amichevole', 'neutrale', 'avverso'].includes(explicitNormalized)) return explicitNormalized
  if (/\b(amichevole|fiducios|collaborativ|disponibil|cordial)\b/i.test(normalized)) return 'amichevole'
  if (/\b(avvers|ostil|nemic|aggressiv|minacci)\b/i.test(normalized)) return 'avverso'
  return 'neutrale'
}

function getNpcConversationPromptFile(npc = null) {
  const relationship = classifyNpcRelationship(npc?.runtime?.atteggiamento_verso_pg || '')
  if (relationship === 'amichevole') return 'npc_master_v0_conversazione_amichevole.md'
  if (relationship === 'avverso') return 'npc_master_v0_conversazione_avversa.md'
  return 'npc_master_v0_conversazione_neutrale.md'
}

function extractSingleNpcConversationTarget(routing = {}) {
  if (routing?.agent === 'NPC Master' && routing?.npcTarget) return routing.npcTarget
  const mentionedNpcs = routing?.metadata?.entities?.npcs || []
  return mentionedNpcs.length === 1 ? mentionedNpcs[0] : null
}

function buildHandlerRoutingMetadata(npcNames = []) {
  const normalized = (npcNames || []).map(name => normalizeNarrativeText(name)).filter(Boolean)
  return {
    entities: {
      npcs: normalized
    },
    primaryEntity: normalized[0] ? { type: 'npc', value: normalized[0] } : null,
    secondaryEntities: normalized.slice(1, 3).map(value => ({ type: 'npc', value }))
  }
}

async function loadCluesHeldByNpc(tableId, npcId, index = null) {
  const normalizedNpcId = normalizeChatText(npcId)
  const clueRefs = Array.isArray(index?.entities?.clue) ? index.entities.clue : []
  if (!normalizedNpcId || !clueRefs.length) return []

  const ownedRefs = clueRefs.filter(ref => normalizeChatText(ref?.references?.owner || ref?.owner) === normalizedNpcId)
  if (!ownedRefs.length) return []

  const clues = []
  for (const ref of ownedRefs) {
    const clue = await runtimeStore.getClue(tableId, ref.id).catch(() => null)
    if (clue) clues.push(clue)
  }
  return clues
}

async function buildPgActiveContextText(tableId, actorPg) {
  if (!actorPg) return ''
  const parts = [renderPgSummary(actorPg)]
  const partyKnowledge = await runtimeStore.getPartyKnowledge(tableId).catch(() => ({ entries: [] }))
  const partyKnowledgeText = runtimeStore.renderPartyKnowledgeText(partyKnowledge)
  if (partyKnowledgeText) {
    parts.push(`Conoscenze gia acquisite dai PG:\n${partyKnowledgeText}`)
  }
  return parts.filter(Boolean).join('\n\n')
}

function normalizeArchivistHandlers(handlers = [], index = null) {
  if (!Array.isArray(handlers)) return []
  const normalized = []
  const seen = new Set()

  for (const handler of handlers) {
    const rawType = normalizeChatText(handler?.type || '')
    const rawName = normalizeNarrativeText(handler?.name || handler?.label || '')
    if (!rawType || !rawName || !['npc', 'object', 'clue'].includes(rawType)) continue

    let ref = index ? lookupEntityRefByName(index, rawType, rawName) : null
    if (!ref && index) {
      for (const fallbackType of ['npc', 'object', 'clue']) {
        ref = lookupEntityRefByName(index, fallbackType, rawName)
        if (ref) break
      }
    }

    const canonical = {
      type: ref?.type || rawType,
      id: ref?.id || null,
      name: ref?.name || rawName
    }
    const key = `${canonical.type}:${normalizeChatText(canonical.id || canonical.name)}`
    if (!canonical.name || seen.has(key)) continue
    seen.add(key)
    normalized.push(canonical)
  }

  return normalized
}

function buildClockDate(clock = {}) {
  const day = normalizeNarrativeText(clock.data_inizio_avventura)
  const time = normalizeNarrativeText(clock.ora_gioco)
  if (!day || !time) return null
  const candidate = new Date(`${day}T${time}:00.000Z`)
  return Number.isNaN(candidate.getTime()) ? null : candidate
}

function mergeUniqueStrings(existing = [], additions = []) {
  const seen = new Set((existing || []).map(value => normalizeChatText(value)).filter(Boolean))
  const merged = [...(existing || []).filter(Boolean)]
  for (const value of (additions || [])) {
    const normalized = normalizeChatText(value)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    merged.push(normalizeNarrativeText(value))
  }
  return merged
}

async function buildNpcMasterSpatialContext(tableId, {
  scene = null,
  actorPg = null,
  actorName = '',
  npc = null,
  npcTargetName = '',
  resolveEntityLabel = (value) => value
} = {}) {
  const groupsState = await runtimeStore.getGroupsState(tableId).catch(() => ({ gruppi_attivi: [] }))
  const activeGroups = Array.isArray(groupsState?.gruppi_attivi) ? groupsState.gruppi_attivi : []
  const actorGroup = activeGroups.find(group =>
    Array.isArray(group?.participants) && group.participants.includes(actorName)
  ) || null

  const actorSceneId = actorGroup?.sceneId || scene?.id_scena || ''
  const actorSceneLabel = actorSceneId ? resolveEntityLabel(actorSceneId) : ''
  const actorGroupLabel = actorGroup?.groupId ? `${actorGroup.groupId}` : ''

  const npcPosition = npc?.runtime?.posizione || null
  const npcPositionId = npcPosition?.id || ''
  const npcPositionLabel = npcPositionId
    ? resolveEntityLabel(npcPositionId)
    : (npcPosition?.label || '')

  const sceneNpcIds = Array.from(new Set([
    ...((scene?.preparazione?.png_presenti || []).filter(Boolean)),
    ...((scene?.preparazione?.png_aggiuntivi || []).filter(Boolean))
  ]))

  const sceneNpcLines = []
  for (const npcId of sceneNpcIds) {
    const sceneNpc = await runtimeStore.getNpc(tableId, npcId).catch(() => null)
    if (!sceneNpc) continue
    const sceneNpcPosition = sceneNpc.runtime?.posizione || null
    const sceneNpcPositionLabel = sceneNpcPosition?.id
      ? resolveEntityLabel(sceneNpcPosition.id)
      : (sceneNpcPosition?.label || actorSceneLabel || 'posizione non specificata')
    sceneNpcLines.push(`${sceneNpc.nome || npcId}: ${sceneNpcPositionLabel}`)
  }

  const lines = [
    actorName
      ? `${actorName} si trova attualmente ${actorSceneLabel ? `nella scena ${actorSceneLabel}` : 'in una scena attiva'}${actorGroupLabel ? `, nel gruppo ${actorGroupLabel}` : ''}`
      : '',
    npcTargetName
      ? `${npcTargetName} si trova attualmente ${npcPositionLabel || 'in una posizione non specificata'}`
      : '',
    sceneNpcLines.length
      ? `PNG presenti nella scena focus: ${sceneNpcLines.join('; ')}`
      : ''
  ].filter(Boolean)

  return lines.join('\n')
}

function getRecentClassifications(messages = [], currentMessageId = null, maxItems = 5) {
  return (messages || [])
    .filter(message => message && message.id !== currentMessageId)
    .filter(message => message.type === 'normal')
    .filter(message => !!message.classificationTag)
    .slice(-maxItems)
    .map(message => ({
      tag: message.classificationTag,
      from: message.from,
      fromName: message.fromName || message.from,
      timestamp: message.timestamp || null
    }))
}

function inferSystemPromptKindFromMessage(message) {
  if (!message || ['normal', 'orchestrator-debug'].includes(message.type)) return null
  if (message.messageKind) return normalizeChatText(message.messageKind)
  const text = normalizeChatText(message.text || '')
  if (!text) return null
  if (/\bcosa fai\b|\bche fai\b|\bcosa fate\b/.test(text)) return 'what_do_you_do'
  if (message.type === 'npc') return 'npc_dialogue'
  if (text.endsWith('?')) return 'question'
  return null
}

function getLastSystemPromptKind(messages = []) {
  for (let index = (messages || []).length - 1; index >= 0; index -= 1) {
    const kind = inferSystemPromptKindFromMessage(messages[index])
    if (kind) return kind
  }
  return null
}

async function ensureModuleAmbientazione(moduleId, primoCapitolo, heavyModel, tableId) {
  const filePath = moduleAmbientazionePath(moduleId)
  try {
    const existing = await fs.readFile(filePath, 'utf-8')
    if (existing.trim()) return existing.trim()
  } catch { /* file non ancora generato */ }

  const text = normalizeNarrativeText(
    await ollama.runTextPhase(heavyModel, 'prepara_ambientazione.md', { primo_capitolo: primoCapitolo }, tableId)
  )
  await fs.writeFile(filePath, text, 'utf-8')
  return text
}

async function getTable(tableId) {
  return readJSON(path.join(tDir(tableId), 'table.json'))
}

async function getTableOrNull(tableId) {
  const p = path.join(tDir(tableId), 'table.json')
  if (!await fileExists(p)) return null
  return readJSON(p)
}

async function getModule(moduleId) {
  return readJSON(path.join(DATA_DIR, 'modules', `${moduleId}.json`))
}

async function getUserNameByEmail(email) {
  const usersPath = path.join(DATA_DIR, 'users.json')
  if (!await fileExists(usersPath)) return email
  const users = await readJSON(usersPath)
  return users.find(u => u.email === email)?.name || email
}

async function getWorldState(tableId) {
  const ws = await runtimeStore.getWorldState(tableId)
  if (!ws.stato_pgs || typeof ws.stato_pgs !== 'object') ws.stato_pgs = {}
  if (typeof ws.conoscenze_party !== 'string') ws.conoscenze_party = ''
  if (typeof ws.data_inizio_avventura !== 'string') ws.data_inizio_avventura = ''
  if (!Array.isArray(ws.npcs)) ws.npcs = []
  if (!Array.isArray(ws.items)) ws.items = []
  return ws
}

async function saveWorldState(tableId, ws) {
  await runtimeStore.saveWorldState(tableId, ws)
}

async function getDiary(tableId) {
  const storyLog = await runtimeStore.getStoryLog(tableId)
  return runtimeStore.renderStoryLogText(storyLog)
}

async function appendDiary(tableId, entry, sessionNumber = 0, moduleTitle = '') {
  const ws = await runtimeStore.getWorldState(tableId)
  await runtimeStore.appendStoryLogEntry(tableId, {
    sessione: sessionNumber || null,
    scena: ws.focusScene || null,
    type: 'narrative',
    text: entry
  })
}

async function readPreparedFile(tableId, filename) {
  const p = path.join(tDir(tableId), filename)
  try { return await fs.readFile(p, 'utf-8') } catch { return '' }
}

async function writePreparedFile(tableId, filename, content) {
  await ensureDir(tDir(tableId))
  await fs.writeFile(path.join(tDir(tableId), filename), content || '')
}

async function getCharacters(tableId) {
  const dir = path.join(tDir(tableId), 'characters')
  try {
    const files = await fs.readdir(dir)
    return Promise.all(
      files.filter(f => f.endsWith('.json')).map(f => readJSON(path.join(dir, f)))
    )
  } catch { return [] }
}

function synthChar(char) {
  // Sintetizza la scheda in una riga per ridurre il contesto
  const c = char.characteristics
  const desc = char.descrizionePersonale ? ` — ${char.descrizionePersonale}` : ''
  return `${char.name} (${char.profession}, ${char.eta}a)${desc}: ` +
    `FOR${c.FOR} COS${c.COS} DES${c.DES} TAG${c.TAG} INT${c.INT} POT${c.POT} APP${c.APP} EDU${c.EDU} ` +
    `PF${char.derivedAttributes?.hp?.current}/${char.derivedAttributes?.hp?.max} ` +
    `SAN${char.derivedAttributes?.sanita?.current}`
}

async function getScene(tableId, sceneId) {
  return runtimeStore.getScene(tableId, sceneId)
}

async function nextSceneId(tableId) {
  return runtimeStore.nextSceneId(tableId)
}

function buildPgLookup(chars) {
  const nameEntries = chars.map(c => [c.name.toLowerCase(), c.name])
  return {
    toName:  Object.fromEntries(chars.map(c => [c.playerID, c.name])),
    toEmail: Object.fromEntries(chars.map(c => [c.name.toLowerCase(), c.playerID])),
    canonicalName: Object.fromEntries(nameEntries)
  }
}

function canonicalPgName(raw, lookup = {}) {
  const value = String(raw || '').trim()
  if (!value) return ''
  return lookup.toName?.[value] || lookup.canonicalName?.[value.toLowerCase()] || value
}

function mergeStatoPgs(target, source, lookup = {}) {
  if (!source || typeof source !== 'object') return false
  let changed = false
  for (const [rawName, statoData] of Object.entries(source)) {
    if (!statoData || typeof statoData.stato !== 'string') continue
    const canonicalName = canonicalPgName(rawName, lookup)
    if (!canonicalName) continue
    const nextValue = { stato: statoData.stato }
    const prevValue = target[canonicalName]
    if (!prevValue || prevValue.stato !== nextValue.stato) {
      target[canonicalName] = nextValue
      changed = true
    }
    if (canonicalName !== rawName && Object.hasOwn(target, rawName)) {
      delete target[rawName]
      changed = true
    }
  }
  return changed
}

function normalizeStatoPgsMap(statoPgs, lookup = {}) {
  if (!statoPgs || typeof statoPgs !== 'object') return { normalized: {}, changed: false }
  const normalized = {}
  mergeStatoPgs(normalized, statoPgs, lookup)
  const currentEntries = Object.entries(statoPgs)
    .filter(([, value]) => value && typeof value.stato === 'string')
    .map(([key, value]) => [key, value.stato])
    .sort(([a], [b]) => a.localeCompare(b))
  const normalizedEntries = Object.entries(normalized)
    .map(([key, value]) => [key, value.stato])
    .sort(([a], [b]) => a.localeCompare(b))
  const changed = JSON.stringify(currentEntries) !== JSON.stringify(normalizedEntries)
  return { normalized, changed }
}

function engagementForLlm(engagement, lookup) {
  return Object.fromEntries(
    Object.entries(engagement).map(([email, count]) => [lookup.toName[email] || email, count])
  )
}

function pianoToEmails(piano, lookup) {
  return (piano || []).map(a => ({
    ...a,
    pg: lookup.toEmail[a.pg?.toLowerCase()] || a.pg
  }))
}

async function buildNarrativeGroups(tableId, worldState, lookup = {}) {
  if (!worldState.groups?.length) return 'Nessun gruppo attivo.'
  const parts = await Promise.all(worldState.groups.map(async (g, i) => {
    const scene = g.sceneId ? await getScene(tableId, g.sceneId) : null
    const location = scene?.contesto_dove || scene?.location || g.sceneId || 'posizione sconosciuta'
    const players = g.participants?.map(e => lookup.toName?.[e] || e).join(', ') || '—'
    const activity = g.activity ? ` (${g.activity})` : ''
    const ordinal = worldState.groups.length === 1 ? 'L\'unico gruppo' : `Il gruppo ${i + 1} (${g.groupId})`
    return `${ordinal} si trova in ${location} [${g.sceneId || 'nessuna scena'}]${activity}. Partecipanti: ${players}.`
  }))
  const intro = worldState.groups.length === 1
    ? 'C\'è 1 gruppo di PG.'
    : `Ci sono ${worldState.groups.length} gruppi di PG.`
  return `${intro} ${parts.join(' ')}`
}

async function saveScene(tableId, scene, closed = false) {
  if (closed && (!scene.runtime || typeof scene.runtime !== 'object')) scene.runtime = {}
  if (closed) scene.runtime.stato = scene.runtime.stato || 'completata'
  await runtimeStore.saveScene(tableId, scene)
}

async function closeScene(tableId, sceneId, suggerimentoProssimaScena = '') {
  await runtimeStore.closeScene(tableId, sceneId, suggerimentoProssimaScena)
}

function hasActiveTypingInFocus(typingPlayers, focusParticipants = []) {
  if (!typingPlayers || !focusParticipants.length) return false
  const now = Date.now()
  return focusParticipants.some(email => {
    const lastTypingAt = typingPlayers[email]
    return lastTypingAt && (now - lastTypingAt) < PLAYER_TYPING_TTL_MS
  })
}

function normalizeNarrativeText(text) {
  if (typeof text === 'string') return text.trim()
  if (text == null) return ''
  return String(text).trim()
}

function stripDiacritics(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function normalizeChatText(text) {
  return stripDiacritics(text)
    .toLowerCase()
    .replace(/[“”«»]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function containsAny(text, patterns) {
  return patterns.some(pattern => pattern.test(text))
}

function buildCanonicalNameVariants(names = [], { allowPersonAliases = false } = {}) {
  const canonicalByVariant = new Map()
  const collisions = new Set()

  const register = (variant, canonical) => {
    const normalizedVariant = normalizeChatText(variant)
    const normalizedCanonical = normalizeChatText(canonical)
    if (!normalizedVariant || !normalizedCanonical) return
    const existing = canonicalByVariant.get(normalizedVariant)
    if (existing && existing !== canonical) {
      collisions.add(normalizedVariant)
      canonicalByVariant.delete(normalizedVariant)
      return
    }
    if (!collisions.has(normalizedVariant)) canonicalByVariant.set(normalizedVariant, canonical)
  }

  for (const originalName of names || []) {
    const canonical = String(originalName || '').trim()
    if (!canonical) continue
    register(canonical, canonical)
    if (!allowPersonAliases) continue

    const stripped = canonical
      .replace(/^(sig\.?|signor|signora|signorina|mr\.?|mrs\.?|miss|monsieur|madame|dott\.?|dottor|dottore)\s+/i, '')
      .trim()
    if (!stripped) continue
    register(stripped, canonical)

    const parts = stripped.split(/\s+/).filter(Boolean)
    if (parts.length >= 2) {
      const first = parts[0]
      const last = parts[parts.length - 1]
      if (first.length >= 4) register(first, canonical)
      if (last.length >= 4) register(last, canonical)
    }
  }

  return canonicalByVariant
}

function findCanonicalNameMatches(text, names = [], options = {}) {
  const normalized = normalizeChatText(text)
  if (!normalized) return []
  const variants = buildCanonicalNameVariants(names, options)
  const boundaryBefore = `(^|[\\s,(['"’])`
  const boundaryAfter = `([,:!?\\s)\\]'"]|$)`
  const matches = []
  const seenCanonical = new Set()

  for (const [variant, canonical] of variants.entries()) {
    const safe = escapeRegExp(variant)
    if (new RegExp(`${boundaryBefore}${safe}${boundaryAfter}`, 'i').test(normalized)) {
      if (!seenCanonical.has(canonical)) {
        seenCanonical.add(canonical)
        matches.push(canonical)
      }
    }
  }

  return matches
}

function getRoutingWeights() {
  const weights = orchestratorRoutingPolicy.weights || {}
  return {
    strong: Number(weights.strongSignal) || 3,
    medium: Number(weights.mediumSignal) || 2,
    weak: Number(weights.weakSignal) || 1,
    moduleBonus: Number(weights.moduleVocabularyBonus) || 2,
    phaseBonus: Number(weights.phasePriorBonus) || 1,
    historyBonus: Number(weights.historyInertiaBonus) || 1
  }
}

function getRoutingDecisionSettings() {
  const decision = orchestratorRoutingPolicy.decision || {}
  return {
    minWinningMargin: Number(decision.minWinningMargin) || 2,
    fallbackCategory: decision.fallbackCategory || 'ambiguo',
    allowStrongSignalOverride: decision.allowStrongSignalOverride !== false
  }
}

function normalizeRoutingPhase(value) {
  return normalizeChatText(value).replace(/\s+/g, '_')
}

function normalizeRoutingCategoryTag(value) {
  const normalized = normalizeChatText(value).replace(/\s+/g, '_')
  if (normalized === 'domanda_al_custode') return 'domanda al custode'
  if (normalized === 'frase_in_character') return 'frase in-character'
  if (normalized === 'fuori_ruolo') return 'fuori ruolo'
  if (normalized === 'discutendo_tra_pg') return 'discutendo tra PG'
  if (normalized === 'dichiarazione') return 'dichiarazione'
  if (normalized === 'ambiguo') return null
  return value
}

function scoreRoutingCategory(scores, category, amount, reason) {
  if (!category || !amount) return
  if (!scores[category]) scores[category] = { score: 0, reasons: [] }
  scores[category].score += amount
  if (reason) scores[category].reasons.push(reason)
}

function historyCategories(options = {}) {
  const recent = Array.isArray(options.recentClassifications)
    ? options.recentClassifications
    : []
  return recent
    .map(entry => typeof entry === 'string' ? entry : entry?.tag)
    .map(normalizeChatText)
    .filter(Boolean)
}

function extractChatFeatures(text, options = {}) {
  const raw = normalizeNarrativeText(text)
  if (!raw) {
    return {
      raw: '',
      normalized: '',
      rawUnquoted: '',
      normalizedUnquoted: '',
      isEmpty: true
    }
  }

  const normalized = normalizeChatText(raw)
  const rawUnquoted = raw.trim().replace(/^[\"']+|[\"']+$/g, '').trim()
  const normalizedUnquoted = normalizeChatText(rawUnquoted)
  if (!normalized) {
    return {
      raw,
      normalized,
      rawUnquoted,
      normalizedUnquoted,
      isEmpty: true
    }
  }

  const otherPgNames = (options.otherPgNames || []).map(name => String(name || '').trim()).filter(Boolean)
  const otherCharacterNames = (options.otherCharacterNames || []).map(name => String(name || '').trim()).filter(Boolean)
  const npcNames = (options.npcNames || []).map(name => String(name || '').trim()).filter(Boolean)
  const otherPlayerNames = (options.otherPlayerNames || []).map(name => String(name || '').trim()).filter(Boolean)
  const locationNames = (options.locationNames || []).map(name => String(name || '').trim()).filter(Boolean)
  const objectNames = (options.objectNames || []).map(name => String(name || '').trim()).filter(Boolean)
  const clueNames = (options.clueNames || []).map(name => String(name || '').trim()).filter(Boolean)
  const skillNames = Array.from(new Set([
      ...((options.skillNames || []).map(name => String(name || '').trim()).filter(Boolean)),
      ...(rulesVocabulary.skillNames || []),
      ...(rulesVocabulary.characteristicNames || [])
    ]))
  const skillActionTerms = Array.from(new Set([
    ...((options.skillActionTerms || []).map(name => String(name || '').trim()).filter(Boolean)),
    ...(rulesVocabulary.skillActionTerms || [])
  ]))
  const addressedNames = [...otherPgNames, ...otherCharacterNames, ...npcNames]
  const honorifics = '(sig\\.?|signor|signora|signorina|mr\\.?|mrs\\.?|miss|monsieur|madame|dott\\.?|dottor|dottore)'

  const matchesName = (names, { startOnly = false, allowHonorific = false, allowPersonAliases = false } = {}) => {
    const variants = buildCanonicalNameVariants(names, { allowPersonAliases })
    return Array.from(variants.keys()).some(name => {
    const safe = escapeRegExp(name)
    const prefix = startOnly ? '^' : '(^|[\\s,])'
    const honorific = allowHonorific ? `(?:${honorifics}\\s+)?` : ''
    return new RegExp(`${prefix}${honorific}${safe}([,:!?\\s]|$)`, 'i').test(normalizedUnquoted)
    })
  }

  const startsWithCustodeVocative = /^(custode|master)([,:!?]|\s)/i.test(normalizedUnquoted)
  const startsWithHonorific = new RegExp(`^${honorifics}\\s+`, 'i').test(normalizedUnquoted)
  const hasCharacterVocative = matchesName(addressedNames, { startOnly: true, allowHonorific: true, allowPersonAliases: true })
  const hasPgVocative = matchesName(otherPgNames, { startOnly: true, allowHonorific: true, allowPersonAliases: true })
  const hasPlayerVocative = matchesName(otherPlayerNames, { startOnly: true })
  const mentionsPlayerName = matchesName(otherPlayerNames)
  const containsNpcName = matchesName(npcNames, { allowPersonAliases: true })
  const containsPgName = matchesName(otherPgNames, { allowPersonAliases: true })
  const containsLocationName = matchesName(locationNames)
  const containsObjectName = matchesName(objectNames)
  const containsClueName = matchesName(clueNames)
  const containsSkillName = matchesName(skillNames)
  const containsSkillActionTerm = matchesName(skillActionTerms)

  const outsideRolePatterns = [
    /\b(afk|brb|lol|ahah|ah ah|scusate|scusa il ritardo|torno subito|devo andare|un secondo|un attimo|lag|connessione|microfono|vado in bagno|arrivo subito|torno tra poco|mi assento due minuti|mi assento un attimo|devo rispondere al telefono|mi chiamano|devo aprire alla porta|aspettate un secondo|sono pronto|siamo pronti|iniziamo|possiamo iniziare)\b/i
  ]
  const nullPatterns = [
    /^(ok|va bene|perfetto|ricevuto|capito|niente|passo|boh|mah|eh)\W*$/i
  ]
  const inCharacterPatterns = [
    /^[\"'].+[\"']$/i,
    /\b(dico|rispondo|sussurro|mormoro|urlo|grido|bisbiglio|replico)\b/i
  ]
  const declarationPatterns = [
    /\b(mi avvicino|mi allontano|mi sposto|entro|esco|vado|vado verso|vado al|vado alla|raggiungo|corro|mi precipito|cerco|osservo|guardo|esamino|controllo|seguo|apro|chiudo|prendo|lascio|aspetto|resto|parlo|parlare con|vorrei parlare con|voglio parlare con|mi rivolgo a|chiedo|domando|provo a|tento di|cerco di|faccio|uso|usare|vorrei usare|voglio usare|voglio persuadere|persuado|persuadere|convinco|convincere|intimorisco|intimidisco|intimidire|minaccio|minacciare|seduco|sedurre|ammalio|ammaliare|non faccio nulla|non faccio niente|rimango fermo)\b/i
  ]
  const discussionPatterns = [
    /\b(ragazzi|noi|tu vai|io vado|facciamo|andiamo|dobbiamo|conviene|secondo me|pensate che|che facciamo)\b/i
  ]
  const custodeQuestionPatterns = [
    /\?$/,
    /\b(custode|master)\b/i,
    /\b(posso|riesco|vedo|sento|mi sembra|cosa noto|cosa vedo|che succede|capisco se|conosco)\b/i
  ]

  const hasQuestionMark = /\?/.test(raw)
  const hasOutsideRoleCue = containsAny(normalized, outsideRolePatterns)
  const hasNullCue = containsAny(normalized, nullPatterns)
  const hasInCharacterCue = containsAny(normalized, inCharacterPatterns)
  const hasDeclarationCue = containsAny(normalized, declarationPatterns)
  const hasDiscussionCue = containsAny(normalized, discussionPatterns) || hasPgVocative
  const hasCustodeCue = containsAny(normalized, custodeQuestionPatterns)
  const hasLeadingVocativeQuestion = /^[^,]{2,40},\s+.+\?$/.test(rawUnquoted)
  const hasQuotedSpeech = /^[\"'].+[\"']$/i.test(raw.trim())
  const hasQuestionWord = /\b(cosa|come|dove|quanto|quale|quali|quando|chi|posso|riesco|e possibile)\b/i.test(normalized)
  const hasMechanicsReference = /\b(tiro|prova|abilita|dado|difficolta|bonus)\b/i.test(normalized)
  const hasPastEventReference = /\b(avevamo|era successo|ricordo che|prima|gia incontrato|gia visto)\b/i.test(normalized)
  const hasSystemDirectAddress = /\b(puoi ripetere|mi dici|puoi dirmi)\b/i.test(normalized)
  const hasActionIntentPattern = /\b(provo a|tento di|mi dirigo verso|uso|uso il mio|uso la mia|uso .* per|prendo|lancio|cerco di|voglio usare|voglio usare .* per|voglio persuadere|voglio convincere|voglio intimidire|voglio sedurre|voglio ammaliare)\b/i.test(normalized)
  const hasConditionalActionIntent = /\b(vorrei|vorrei usare|vorrei usare .* per|potrei provare a|vorrei persuadere|vorrei convincere|vorrei intimidire|vorrei sedurre|vorrei ammaliare)\b/i.test(normalized)
  const hasMyPgPattern = /\b(il mio pg|il mio personaggio)\b/i.test(normalized)
  const hasInvestigationPattern = /\b(cerco|osservo|esamino|controllo|indago|frugo)\b/i.test(normalized)
  const hasMovementPattern = /\b(vado|corro|mi avvicino|mi allontano|entro|esco|salgo|scendo|raggiungo)\b/i.test(normalized)
  const hasSpeechVerbPattern = /\b(dico a|dico|chiedo a|chiedo|rispondo|saluto|replico|sussurro|mormoro)\b/i.test(normalized)
  const hasSocialObjectPattern = /\b(signore|signora|monsieur|madame|signor)\b/i.test(normalized) || containsNpcName
  const hasGroupCoordinationPattern = /\b(tu vai|io vado|facciamo|andiamo|dobbiamo|coprimi|copritemi)\b/i.test(normalized)
  const hasSharedStrategyPattern = /\b(secondo me|conviene|pensate che|che facciamo)\b/i.test(normalized)
  const hasCollectiveDecisionPattern = /\b(noi|ragazzi|tutti|insieme)\b/i.test(normalized)
  const hasRealWorldReference = /\b(lavoro|telefono|porta di casa|bagno|connessione|microfono)\b/i.test(normalized)
  const hasPauseRequest = /\b(facciamo pausa|pausa|aspetta|aspettate)\b/i.test(normalized)
  const hasRuleComplaint = /\b(non ho capito la regola|regola|master e cattivo)\b/i.test(normalized)
  const hasCasualReaction = /\b(lol|ahah|ah ah)\b/i.test(normalized)
  const hasLogisticAbsencePhrase = /\b(vado in bagno|arrivo subito|mi assento|torno tra poco|devo andare|devo rispondere al telefono|devo aprire alla porta)\b/i.test(normalized)
  const hasAfkBrbPhrase = /\b(afk|brb)\b/i.test(normalized)
  const hasQuotedDialogue = hasQuotedSpeech
  const hasDirectAddressToSceneNpc = hasCharacterVocative && containsNpcName
  const hasHonorificVocative = startsWithHonorific && hasCharacterVocative
  const hasQuestionLikeShape = hasQuestionMark || hasQuestionWord
  const moduleMatches = {
    npc: containsNpcName,
    pg: containsPgName,
    player: mentionsPlayerName,
    location: containsLocationName,
    object: containsObjectName,
    clue: containsClueName,
    skill: containsSkillName
  }

  let vocativeType = null
  if (startsWithCustodeVocative) vocativeType = 'custode'
  else if (hasPlayerVocative) vocativeType = 'player'
  else if (hasPgVocative) vocativeType = 'pg'
  else if (hasCharacterVocative) vocativeType = 'character'

  return {
    raw,
    normalized,
    rawUnquoted,
    normalizedUnquoted,
    isEmpty: false,
    startsWithHonorific,
    startsWithCustodeVocative,
    hasCharacterVocative,
    hasPgVocative,
    hasPlayerVocative,
    mentionsPlayerName,
    containsNpcName,
    containsPgName,
    containsLocationName,
    containsObjectName,
    containsClueName,
    containsSkillName,
    containsSkillActionTerm,
    hasQuestionMark,
    hasOutsideRoleCue,
    hasNullCue,
    hasInCharacterCue,
    hasDeclarationCue,
    hasDiscussionCue,
    hasCustodeCue,
    hasLeadingVocativeQuestion,
    hasQuotedSpeech,
    hasQuestionWord,
    hasMechanicsReference,
    hasPastEventReference,
    hasSystemDirectAddress,
    hasActionIntentPattern,
    hasConditionalActionIntent,
    hasMyPgPattern,
    hasInvestigationPattern,
    hasMovementPattern,
    hasSpeechVerbPattern,
    hasSocialObjectPattern,
    hasGroupCoordinationPattern,
    hasSharedStrategyPattern,
    hasCollectiveDecisionPattern,
    hasRealWorldReference,
    hasPauseRequest,
    hasRuleComplaint,
    hasCasualReaction,
    hasLogisticAbsencePhrase,
    hasAfkBrbPhrase,
    hasQuotedDialogue,
    hasDirectAddressToSceneNpc,
    hasHonorificVocative,
    hasQuestionLikeShape,
    moduleMatches,
    vocativeType
  }
}

function resolveChatMessageTag(features, options = {}) {
  if (features.isEmpty) return { tag: null, confidence: 1 }

  if (features.hasOutsideRoleCue) {
    return { tag: 'fuori ruolo', confidence: 0.95 }
  }
  if (features.hasPlayerVocative || features.mentionsPlayerName) {
    return { tag: 'fuori ruolo', confidence: 0.86 }
  }
  if (features.hasNullCue) {
    return { tag: null, confidence: 0.8 }
  }
  if (features.hasQuestionLikeShape && features.vocativeType === 'custode') {
    return { tag: 'domanda al custode', confidence: 0.95 }
  }
  if (!features.hasQuestionMark && features.startsWithHonorific && features.hasCharacterVocative) {
    return { tag: 'frase in-character', confidence: 0.83 }
  }
  if (features.hasQuestionMark && (features.hasCharacterVocative || features.hasLeadingVocativeQuestion) && features.vocativeType !== 'custode') {
    return { tag: 'frase in-character', confidence: 0.84 }
  }
  if (features.hasQuestionMark && features.hasCustodeCue && !features.hasCharacterVocative) {
    return { tag: 'domanda al custode', confidence: 0.9 }
  }
  if (features.hasQuotedSpeech) {
    return { tag: 'frase in-character', confidence: 0.82 }
  }
  const weights = getRoutingWeights()
  const decision = getRoutingDecisionSettings()
  const scores = {}

  const add = (category, amount, reason) => scoreRoutingCategory(scores, category, amount, reason)

  // fuori ruolo
  if (features.hasLogisticAbsencePhrase) add('fuori_ruolo', weights.strong, 'logistic_absence_phrase')
  if (features.hasAfkBrbPhrase) add('fuori_ruolo', weights.strong, 'afk_or_brb_phrase')
  if (features.mentionsPlayerName || features.hasPlayerVocative) add('fuori_ruolo', weights.strong, 'real_player_name_mentioned')
  if (features.hasPauseRequest) add('fuori_ruolo', weights.medium, 'pause_request')
  if (features.hasRealWorldReference) add('fuori_ruolo', weights.medium, 'real_world_reference')
  if (features.hasRuleComplaint) add('fuori_ruolo', weights.medium, 'rule_complaint')
  if (features.hasCasualReaction) add('fuori_ruolo', weights.medium, 'casual_reaction')

  // domanda al custode
  if (features.hasQuestionMark) add('domanda_al_custode', weights.strong, 'question_mark')
  if (features.hasQuestionWord) add('domanda_al_custode', weights.strong, 'world_or_rules_interrogative')
  if (features.hasMechanicsReference) add('domanda_al_custode', weights.strong, 'mechanics_reference')
  if (features.hasPastEventReference) add('domanda_al_custode', weights.medium, 'past_event_reference')
  if (features.hasSystemDirectAddress) add('domanda_al_custode', weights.medium, 'system_direct_address')
  if (features.startsWithCustodeVocative) add('domanda_al_custode', weights.strong, 'master_or_custode_vocative')

  // dichiarazione
  if (features.hasDeclarationCue) add('dichiarazione', weights.strong, 'first_person_action_verb')
  if (features.hasActionIntentPattern) add('dichiarazione', weights.strong, 'action_intent_pattern')
  if (features.hasConditionalActionIntent) add('dichiarazione', weights.strong, 'conditional_action_intent')
  if (features.containsSkillActionTerm) add('dichiarazione', weights.medium, 'skill_derived_action_term')
  if (features.containsSkillName && (features.hasActionIntentPattern || features.hasConditionalActionIntent || features.hasDeclarationCue)) {
    add('dichiarazione', weights.medium, 'skill_name_with_action_intent')
  }
  if (features.hasMyPgPattern) add('dichiarazione', weights.strong, 'my_pg_plus_action')
  if (features.hasInvestigationPattern) add('dichiarazione', weights.medium, 'investigation_pattern')
  if (features.hasMovementPattern) add('dichiarazione', weights.medium, 'movement_pattern')
  if (features.containsLocationName || features.containsObjectName || features.containsClueName) {
    add('dichiarazione', weights.medium, 'interaction_with_scene_element')
  }

  // frase in-character
  if (features.hasQuotedDialogue) add('frase_in_character', weights.strong, 'quoted_dialogue')
  if (features.hasDirectAddressToSceneNpc) add('frase_in_character', weights.strong, 'direct_address_to_scene_npc')
  if (features.hasHonorificVocative) add('frase_in_character', weights.strong, 'honorific_vocative')
  if (features.hasSpeechVerbPattern) add('frase_in_character', weights.medium, 'speech_verb_pattern')
  if (features.hasSocialObjectPattern && !features.hasDiscussionCue) add('frase_in_character', weights.medium, 'social_object_pattern')
  if (features.hasInCharacterCue && !features.hasCustodeCue && !features.hasDeclarationCue) {
    add('frase_in_character', weights.medium, 'dialogue_without_quotes')
  }

  // discutendo tra PG
  if (features.hasPgVocative) add('discutendo_tra_pg', weights.strong, 'pg_name_vocative')
  if (features.hasGroupCoordinationPattern) add('discutendo_tra_pg', weights.strong, 'group_coordination_pattern')
  if (features.hasSharedStrategyPattern) add('discutendo_tra_pg', weights.strong, 'shared_strategy_pattern')
  if (features.hasDiscussionCue) add('discutendo_tra_pg', weights.medium, 'collective_decision_pattern')
  if (features.hasCollectiveDecisionPattern) add('discutendo_tra_pg', weights.medium, 'collective_decision_pattern')

  // module vocabulary bonus
  const modulePolicy = orchestratorRoutingPolicy.categories || {}
  const moduleBuckets = {
    npcNames: features.moduleMatches.npc,
    objectNames: features.moduleMatches.object,
    clueNames: features.moduleMatches.clue,
    locationNames: features.moduleMatches.location,
    skillNames: features.moduleMatches.skill,
    pgNames: features.moduleMatches.pg,
    playerNames: features.moduleMatches.player
  }
  for (const [category, categoryConfig] of Object.entries(modulePolicy)) {
    const allowed = categoryConfig.moduleVocabulary?.allowed || []
    const blocked = categoryConfig.moduleVocabulary?.blocked || []
    const hasAllowed = allowed.some(key => moduleBuckets[key])
    const hasBlocked = blocked.some(key => moduleBuckets[key])
    if (hasAllowed && !hasBlocked) add(category, weights.moduleBonus, 'module_vocabulary_bonus')
  }

  // phase prior
  const phase = normalizeRoutingPhase(options.phase || options.gamePhase || '')
  if (phase) {
    const phaseMap = orchestratorRoutingPolicy.phasePriors?.[phase] || null
    if (phaseMap) {
      for (const [category, amount] of Object.entries(phaseMap)) {
        add(category, Number(amount) || weights.phaseBonus, `phase_prior:${phase}`)
      }
    }
  }

  // history inertia
  const recent = historyCategories(options)
  if (recent.length) {
    const mapped = recent.map(entry => {
      if (entry === 'fuori ruolo') return 'fuori_ruolo'
      if (entry === 'domanda al custode') return 'domanda_al_custode'
      if (entry === 'frase in-character') return 'frase_in_character'
      if (entry === 'discutendo tra pg') return 'discutendo_tra_pg'
      return entry
    })
    const counts = mapped.reduce((acc, key) => {
      acc[key] = (acc[key] || 0) + 1
      return acc
    }, {})
    const modal = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]
    if (modal && counts[modal] >= 2) add(modal, weights.historyBonus, 'history_modal_category')
  }
  const lastSystemPromptKind = normalizeChatText(options.lastSystemPromptKind || '')
  if (lastSystemPromptKind === 'question') {
    if (!features.hasQuestionMark && (features.hasDeclarationCue || features.hasActionIntentPattern || features.hasConditionalActionIntent || features.containsSkillActionTerm)) {
      add('dichiarazione', weights.historyBonus, 'system_last_message_is_question_answered_with_action')
    } else {
      add('domanda_al_custode', weights.historyBonus, 'system_last_message_is_question')
    }
  }
  if (lastSystemPromptKind === 'what_do_you_do') add('dichiarazione', weights.historyBonus, 'system_last_message_asks_what_do_you_do')
  if (lastSystemPromptKind === 'npc_dialogue') {
    add('frase_in_character', weights.historyBonus, 'system_last_message_from_npc')
    if (features.containsNpcName || features.hasSocialObjectPattern || features.hasSpeechVerbPattern) {
      add('frase_in_character', weights.historyBonus, 'system_last_message_from_npc_with_dialogue_cue')
    }
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1].score - a[1].score)
  if (!ranked.length) {
    return { tag: null, confidence: 0.4, scores }
  }

  const [winnerKey, winnerData] = ranked[0]
  const runnerUpScore = ranked[1]?.[1]?.score || 0
  const margin = winnerData.score - runnerUpScore

  if (margin < decision.minWinningMargin) {
    return { tag: null, confidence: 0.45, scores, ambiguous: true }
  }

  const winnerTag = normalizeRoutingCategoryTag(winnerKey)
  const confidence = Math.min(0.93, 0.55 + (winnerData.score * 0.04) + (margin * 0.03))
  return { tag: winnerTag, confidence, scores }
}

function classifyChatMessage(text, options = {}) {
  const features = extractChatFeatures(text, options)
  return resolveChatMessageTag(features, options)
}

function findMentionedName(text, names = []) {
  return findCanonicalNameMatches(text, names, { allowPersonAliases: true })[0] || null
}

function findMentionedNames(text, names = []) {
  return findCanonicalNameMatches(text, names, { allowPersonAliases: true })
}

function extractQuestionMetadata(text, options = {}) {
  const features = extractChatFeatures(text, options)
  const tag = resolveChatMessageTag(features, options).tag
  const raw = features.raw || ''
  const normalized = features.normalized || ''
  const questionNpcNames = options.questionNpcNames || options.npcNames || []
  const rulesTerms = Array.from(new Set([
    ...((options.skillNames || []).map(name => String(name || '').trim()).filter(Boolean)),
    ...(rulesVocabulary.skillNames || []),
    ...(rulesVocabulary.characteristicNames || [])
  ]))

  const entities = {
    npcs: findMentionedNames(raw, questionNpcNames),
    objects: findMentionedNames(raw, options.objectNames || []),
    clues: findMentionedNames(raw, options.clueNames || []),
    locations: findMentionedNames(raw, options.locationNames || []),
    skills: findMentionedNames(raw, rulesTerms),
    pgs: findMentionedNames(raw, options.pgNames || options.otherPgNames || [])
  }

  const allEntities = [
    ...entities.npcs.map(value => ({ type: 'npc', value })),
    ...entities.objects.map(value => ({ type: 'object', value })),
    ...entities.clues.map(value => ({ type: 'clue', value })),
    ...entities.locations.map(value => ({ type: 'location', value })),
    ...entities.skills.map(value => ({ type: 'skill', value })),
    ...entities.pgs.map(value => ({ type: 'pg', value }))
  ]

  let operator = 'ask'
  if (/\b(vedo|guardo|osservo|noto|scorgo|riesco a vedere|cosa vedo|cosa noto)\b/i.test(normalized)) operator = 'perceive'
  else if (/\b(sento|ascolto|odo)\b/i.test(normalized)) operator = 'hear'
  else if (/\b(ricordo|riconosco|conosco)\b/i.test(normalized)) operator = 'remember'
  else if (/\b(abbiamo gia incontrato|ho gia incontrato|abbiamo gia visto|ho gia visto|ci hanno gia parlato di)\b/i.test(normalized)) operator = 'history'
  else if (/\b(capisco|deduco|collego|interpreto)\b/i.test(normalized)) operator = 'infer'
  else if (/\b(sembra|sta facendo|come reagisce|mente)\b/i.test(normalized)) operator = 'evaluate'
  else if (/\b(dov['’]e|dove si trova|dove sta|dovrebbe essere)\b/i.test(normalized)) operator = 'locate'
  else if (/\b(cosa sai dirmi|cos['’]e|spiegami|descrivimi|parlami di|in cosa consiste)\b/i.test(normalized)) operator = 'reference'
  else if (/\b(posso|riesco|che prova|che tiro|uso|fare .*?(psicologia|osservare|furtivita|biblioteca|persuasione))\b/i.test(normalized)) operator = 'mechanical_check'

  let questionType = 'general_question'
  if (tag === 'domanda al custode') {
    const isRulesReferenceOnly = entities.skills.length > 0
      && !entities.npcs.length
      && !entities.objects.length
      && !entities.clues.length
      && !entities.locations.length
      && !entities.pgs.length
      && operator === 'reference'

    if (isRulesReferenceOnly) questionType = 'rules_reference_question'
    else if (entities.skills.length) questionType = 'rule_or_roll_question'
    else if (entities.npcs.length) questionType = 'npc_clarification'
    else if (entities.objects.length) questionType = 'object_question'
    else if (entities.clues.length) questionType = 'clue_or_knowledge_question'
    else if (entities.locations.length || /\b(scena|stanza|sala|podio|porta|corridoio|luogo)\b/i.test(normalized)) questionType = 'scene_clarification'
  }

  const primaryEntity = allEntities[0] || null
  const secondaryEntities = allEntities.slice(1, 3)

  const needs = {
    scene: questionType === 'scene_clarification' || (!!primaryEntity && questionType !== 'rules_reference_question'),
    npc: entities.npcs.length > 0,
    object: entities.objects.length > 0,
    clues: entities.clues.length > 0 || questionType === 'clue_or_knowledge_question',
    rules: questionType === 'rule_or_roll_question' || questionType === 'rules_reference_question' || entities.skills.length > 0,
    pg: entities.pgs.length > 0 || questionType === 'rule_or_roll_question'
  }

  let confidence = 0.45
  if (tag === 'domanda al custode') confidence += 0.2
  if (primaryEntity) confidence += 0.2
  if (questionType !== 'general_question') confidence += 0.1
  if (operator !== 'ask') confidence += 0.05
  confidence = Math.min(0.95, confidence)

  const defaults = orchestratorContextBundles.defaults || {}
  const questionTypeBundle = orchestratorContextBundles.questionTypeBundles?.[questionType] || []
  const primaryEntityBundle = primaryEntity
    ? (orchestratorContextBundles.entityTypeBundles?.[primaryEntity.type] || [])
    : []
  const maxSecondaryEntities = defaults.maxSecondaryEntities || 2
  const secondaryEntityBundles = secondaryEntities
    .slice(0, maxSecondaryEntities)
    .flatMap(entity => orchestratorContextBundles.secondaryEntityBundles?.[entity.type] || [])

  let contextBundle = Array.from(new Set(
    [
      ...(defaults.alwaysInclude || []),
      ...questionTypeBundle,
      ...primaryEntityBundle,
      ...secondaryEntityBundles
    ].filter(Boolean)
  ))
  if (questionType === 'rules_reference_question') {
    contextBundle = ['rulesExcerpt:primarySkill']
  } else if (questionType === 'rule_or_roll_question') {
    contextBundle = contextBundle.filter(entry => entry !== 'partyKnowledgeShort')
  }
  const fallbackBundle = Array.from(new Set((defaults.fallbackBundle || []).filter(Boolean)))

  return {
    tag,
    questionType,
    operator,
    entities,
    primaryEntity,
    secondaryEntities,
    needs,
    contextBundle,
    fallbackBundle,
    confidence
  }
}

function extractDeclarationMetadata(text, options = {}) {
  const raw = normalizeNarrativeText(text)
  const questionNpcNames = options.questionNpcNames || options.npcNames || []
  const entities = {
    npcs: findMentionedNames(raw, questionNpcNames),
    objects: findMentionedNames(raw, options.objectNames || []),
    clues: findMentionedNames(raw, options.clueNames || []),
    locations: findMentionedNames(raw, options.locationNames || []),
    skills: [],
    pgs: findMentionedNames(raw, options.pgNames || options.otherPgNames || [])
  }

  const allEntities = [
    ...entities.npcs.map(value => ({ type: 'npc', value })),
    ...entities.objects.map(value => ({ type: 'object', value })),
    ...entities.clues.map(value => ({ type: 'clue', value })),
    ...entities.locations.map(value => ({ type: 'location', value })),
    ...entities.pgs.map(value => ({ type: 'pg', value }))
  ]

  const primaryEntity = allEntities[0] || null
  const maxSecondaryEntities = orchestratorContextBundles.defaults?.maxSecondaryEntities || 2
  const secondaryEntities = allEntities.slice(1, 1 + maxSecondaryEntities)
  const primaryEntityBundle = primaryEntity
    ? (orchestratorContextBundles.entityTypeBundles?.[primaryEntity.type] || [])
    : []
  const secondaryEntityBundles = secondaryEntities
    .flatMap(entity => orchestratorContextBundles.secondaryEntityBundles?.[entity.type] || [])

  const contextBundle = Array.from(new Set([
    'focusScene',
    'recentChat',
    'pgSummary:actor',
    ...primaryEntityBundle,
    ...secondaryEntityBundles
  ].filter(Boolean)))

  return {
    entities,
    primaryEntity,
    secondaryEntities,
    contextBundle
  }
}

function buildOrchestratorRoutingDecision(messageText, options = {}) {
  const features = extractChatFeatures(messageText, options)
  const classified = resolveChatMessageTag(features, options)
  const tag = classified.tag || '?'
  const mentionedNpcTarget = findMentionedName(messageText, options.npcNames || [])
  const npcTarget = mentionedNpcTarget || options.activeNpcTarget || null
  const implicitNpcHandlerNames = Array.isArray(options.implicitNpcHandlerNames)
    ? options.implicitNpcHandlerNames.map(name => normalizeNarrativeText(name)).filter(Boolean)
    : []
  const questionMetadata = tag === 'domanda al custode'
    ? extractQuestionMetadata(messageText, {
      ...options,
      questionNpcNames: options.questionNpcNames || options.npcNames || []
    })
    : null
  const declarationMetadata = tag === 'dichiarazione'
    ? extractDeclarationMetadata(messageText, {
      ...options,
      questionNpcNames: options.questionNpcNames || options.npcNames || []
    })
    : null
  const fallbackDeclarationMetadata = (!declarationMetadata && tag === '?')
    ? extractDeclarationMetadata(messageText, {
      ...options,
      questionNpcNames: options.questionNpcNames || options.npcNames || []
    })
    : null

  if (tag === 'domanda al custode') {
    const isRulesQuestion = questionMetadata?.questionType === 'rules_reference_question'
      || questionMetadata?.questionType === 'rule_or_roll_question'
    return {
      tag,
      agent: 'Custode',
      reason: isRulesQuestion
        ? 'domanda diretta sulle regole'
        : 'domanda diretta sul mondo',
      npcTarget: null,
      focusSceneId: options.focusSceneId || null,
      focusSceneLabel: options.focusSceneLabel || null,
      contextBundle: questionMetadata?.contextBundle || questionMetadata?.fallbackBundle || [],
      metadata: questionMetadata
    }
  }
  if (tag === 'dichiarazione') {
    return {
      tag,
      agent: 'Scene Master',
      reason: 'azione o dichiarazione che fa avanzare la scena',
      npcTarget: null,
      focusSceneId: options.focusSceneId || null,
      focusSceneLabel: options.focusSceneLabel || null,
      contextBundle: declarationMetadata?.contextBundle || ['focusScene', 'recentChat', 'pgSummary:actor'],
      metadata: declarationMetadata
    }
  }
  if (tag === 'frase in-character' && npcTarget) {
    return {
      tag,
      agent: 'NPC Master',
      reason: options.activeNpcTarget && !findMentionedName(messageText, options.npcNames || [])
        ? 'continuazione della conversazione con il PNG attivo'
        : 'interazione diretta con un PNG',
      npcTarget,
      focusSceneId: options.focusSceneId || null,
      focusSceneLabel: options.focusSceneLabel || null,
      contextBundle: ['focusScene', 'npcSummary:primary', 'recentChat'],
      metadata: null
    }
  }
  if (tag === 'frase in-character' && !npcTarget && implicitNpcHandlerNames.length > 1) {
    return {
      tag,
      agent: 'Scene Master',
      reason: 'battuta ambigua: ci sono piu PNG a portata del PG',
      npcTarget: null,
      focusSceneId: options.focusSceneId || null,
      focusSceneLabel: options.focusSceneLabel || null,
      contextBundle: ['focusScene', 'recentChat', 'pgSummary:actor', 'npcSummary:primary', 'npcSummary:secondary'],
      metadata: buildHandlerRoutingMetadata(implicitNpcHandlerNames)
    }
  }
  if (tag === 'frase in-character') {
    return {
      tag,
      agent: 'NPC Master',
      reason: 'battuta in fiction affidata al NPC Master',
      npcTarget: options.activeNpcTarget || null,
      focusSceneId: options.focusSceneId || null,
      focusSceneLabel: options.focusSceneLabel || null,
      contextBundle: options.activeNpcTarget
        ? ['focusScene', 'npcSummary:primary', 'recentChat']
        : ['focusScene', 'recentChat'],
      metadata: null
    }
  }
  if (tag === 'discutendo tra PG') {
    return {
      tag,
      agent: null,
      reason: 'coordinazione tra PG: nessun intervento necessario',
      npcTarget: null,
      focusSceneId: options.focusSceneId || null,
      focusSceneLabel: options.focusSceneLabel || null,
      contextBundle: [],
      metadata: null
    }
  }
  if (tag === 'fuori ruolo') {
    return {
      tag,
      agent: null,
      reason: 'messaggio fuori ruolo',
      npcTarget: null,
      focusSceneId: options.focusSceneId || null,
      focusSceneLabel: options.focusSceneLabel || null,
      contextBundle: [],
      metadata: null
    }
  }
  const phase = normalizeRoutingPhase(options.phase || options.gamePhase || '')
  if (tag === '?') {
    const fallbackByPhase = phase === 'first_person'
      ? (npcTarget
          ? {
              agent: 'NPC Master',
              reason: 'messaggio ambiguo: fallback alla fase first_person',
              contextBundle: ['focusScene', 'npcSummary:primary', 'recentChat']
            }
          : {
              agent: 'Scene Master',
              reason: 'messaggio ambiguo: fallback alla fase first_person senza PNG bersaglio esplicito',
              contextBundle: fallbackDeclarationMetadata?.contextBundle || ['focusScene', 'recentChat', 'pgSummary:actor'],
              metadata: fallbackDeclarationMetadata
            })
      : phase === 'inizio_sessione'
        ? {
            agent: 'Custode',
            reason: 'messaggio ambiguo: fallback alla fase inizio_sessione',
            contextBundle: questionMetadata?.fallbackBundle || ['focusScene', 'recentChat'],
            metadata: questionMetadata
          }
        : {
            agent: 'Scene Master',
            reason: 'messaggio ambiguo: fallback alla fase scene',
            contextBundle: fallbackDeclarationMetadata?.contextBundle || ['focusScene', 'recentChat', 'pgSummary:actor'],
            metadata: fallbackDeclarationMetadata
          }

    return {
      tag,
      npcTarget: fallbackByPhase.agent === 'NPC Master' ? npcTarget : null,
      focusSceneId: options.focusSceneId || null,
      focusSceneLabel: options.focusSceneLabel || null,
      ...fallbackByPhase
    }
  }
  return {
    tag,
    agent: null,
    reason: 'messaggio ambiguo: nessun routing automatico',
    npcTarget: null,
    focusSceneId: options.focusSceneId || null,
    focusSceneLabel: options.focusSceneLabel || null,
    contextBundle: questionMetadata?.fallbackBundle || [],
    metadata: questionMetadata
  }
}

function inferConversationPhase(currentPhase, routing, options = {}) {
  const current = normalizeRoutingPhase(currentPhase || 'inizio_sessione') || 'inizio_sessione'
  const recent = historyCategories(options)
  const currentTag = normalizeChatText(routing?.tag || '')
  const recentWithCurrent = recent.concat(currentTag).filter(Boolean)
  const recentInCharacterCount = recentWithCurrent
    .slice(-3)
    .filter(tag => tag === 'frase in-character')
    .length

  if (routing?.tag === 'dichiarazione') return 'scene'
  if (routing?.tag === 'frase in-character') return 'first_person'
  if (recentInCharacterCount >= 2) return 'first_person'
  if (current === 'inizio_sessione' && routing?.agent === 'Custode' && routing?.tag === 'domanda al custode') {
    return 'inizio_sessione'
  }
  return current
}

function formatContextBundleEntry(entry, routing = {}) {
  const metadata = routing.metadata || null
  const primaryEntity = metadata?.primaryEntity || null
  const secondaryEntities = metadata?.secondaryEntities || []
  const npcTarget = routing.npcTarget || null
  const focusSceneLabel = routing.focusSceneLabel || routing.focusSceneId || null

  if (entry === 'focusScene') {
    return focusSceneLabel ? `${entry}(${focusSceneLabel})` : entry
  }

  if (entry === 'npcSummary:primary') {
    const label = primaryEntity?.type === 'npc' ? primaryEntity.value : npcTarget
    return label ? `${entry}(${label})` : entry
  }
  if (entry === 'objectSummary:primary') {
    const label = primaryEntity?.type === 'object' ? primaryEntity.value : null
    return label ? `${entry}(${label})` : entry
  }
  if (entry === 'clueSummary:primary') {
    const label = primaryEntity?.type === 'clue' ? primaryEntity.value : null
    return label ? `${entry}(${label})` : entry
  }
  if (entry === 'pgSummary:primary' || entry === 'pgSummary:actor') {
    const label = primaryEntity?.type === 'pg'
      ? primaryEntity.value
      : (metadata?.entities?.pgs || [])[0]
    return label ? `${entry}(${label})` : entry
  }
  if (entry === 'locationCard:primary') {
    const label = primaryEntity?.type === 'location' ? primaryEntity.value : null
    return label ? `${entry}(${label})` : entry
  }
  if (entry === 'rulesExcerpt:primarySkill') {
    const label = primaryEntity?.type === 'skill'
      ? primaryEntity.value
      : (metadata?.entities?.skills || [])[0]
    return label ? `${entry}(${label})` : entry
  }

  const secondaryMatch = entry.match(/^(npcSummary|objectSummary|clueSummary|locationCard|pgSummary):secondary$/)
  if (secondaryMatch) {
    const wantedType = secondaryMatch[1]
      .replace('Summary', '')
      .replace('Card', '')
      .toLowerCase()
    const label = secondaryEntities.find(entity => entity.type === wantedType)?.value
    return label ? `${entry}(${label})` : entry
  }

  return entry
}

function formatContextBundleForDebug(routing = {}) {
  return (routing.contextBundle || []).map(entry => formatContextBundleEntry(entry, routing))
}

function debugString(value) {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function normalizeSceneListOutput(value) {
  if (Array.isArray(value)) {
    return value.map(item => normalizeNarrativeText(item)).filter(Boolean)
  }
  const text = normalizeNarrativeText(value)
  if (!text) return []
  return text
    .split(/[\n,;]+/)
    .map(item => item.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
}

const IT_MONTHS = {
  gennaio: 0,
  febbraio: 1,
  marzo: 2,
  aprile: 3,
  maggio: 4,
  giugno: 5,
  luglio: 6,
  agosto: 7,
  settembre: 8,
  ottobre: 9,
  novembre: 10,
  dicembre: 11
}

// Mappa durata fuzzy (stringa LLM) → minuti da aggiungere all'ISO della scena
const DURATA_FUZZY_MAP = {
  'turno':         1/6,   // ~10 secondi
  'minuti':        5,
  'mezz\'ora':     30,
  'un\'ora':       60,
  'qualche ora':   180,
  'mezza giornata':360,
  'un giorno':     1440
}

function normalizeDurationOutput(value) {
  if (typeof value !== 'string') return 0
  const key = value.trim().toLowerCase()
  return DURATA_FUZZY_MAP[key] ?? 5  // fallback: 5 minuti
}

function parseItalianDate(text) {
  const raw = normalizeNarrativeText(text)
  if (!raw) return null

  const isoCandidate = new Date(raw)
  if (!Number.isNaN(isoCandidate.getTime())) return isoCandidate

  const lower = raw.toLowerCase()
  const dateMatch = lower.match(/(\d{1,2})\s+([a-zà]+)\s+(\d{4})/)
  if (!dateMatch) return null

  const day = Number.parseInt(dateMatch[1], 10)
  const month = IT_MONTHS[dateMatch[2]]
  const year = Number.parseInt(dateMatch[3], 10)
  if (!Number.isFinite(day) || month == null || !Number.isFinite(year)) return null

  let hours = 12
  let minutes = 0
  const timeMatch = lower.match(/ore\s+(\d{1,2})(?::(\d{2}))?/)
  if (timeMatch) {
    hours = Number.parseInt(timeMatch[1], 10)
    minutes = Number.parseInt(timeMatch[2] || '0', 10)
  } else if (lower.includes('notte')) {
    hours = 23
  } else if (lower.includes('sera')) {
    hours = 20
  } else if (lower.includes('pomeriggio')) {
    hours = 16
  } else if (lower.includes('mattina')) {
    hours = 9
  } else if (lower.includes('alba')) {
    hours = 6
  }

  const date = new Date(year, month, day, hours, minutes, 0, 0)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatItalianDate(date, fallbackText = '') {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return normalizeNarrativeText(fallbackText)
  const formatter = new Intl.DateTimeFormat('it-IT', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
  return formatter.format(date)
}

// minutiFloat: valore restituito da normalizeDurationOutput
function advanceDateByMinutes(date, minutiFloat) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null
  if (!minutiFloat) return date
  return new Date(date.getTime() + minutiFloat * 60 * 1000)
}

// Restituisce il momento_corrente della scena come stringa leggibile,
// o stringa vuota se non disponibile.
// Formatta stato_pgs come testo leggibile per i prompt
function formatStatoPgs(statoPgs) {
  if (!statoPgs || !Object.keys(statoPgs).length) return '(nessuno stato PG disponibile)'
  const entries = Object.entries(statoPgs)
    .filter(([, s]) => s?.stato)
    .map(([nome, s]) => `${nome}: ${s.stato}`)
  return entries.length ? entries.join('\n') : '(nessuno stato PG disponibile)'
}

// Formatta gli NPC rilevanti per la scena corrente come testo leggibile per i prompt
function formatStatoNpcs(npcs, scenaId = null) {
  if (!Array.isArray(npcs) || !npcs.length) return '(nessun PNG in scena)'
  const rilevanti = scenaId
    ? npcs.filter(n => !n.scena_id || n.scena_id === scenaId)
    : npcs
  if (!rilevanti.length) return '(nessun PNG in scena)'
  return rilevanti
    .map(n => `${n.name}: ${n.stato || '(stato non definito)'}`)
    .join('\n')
}

function sceneMomentoTesto(scene) {
  if (!scene?.momento_corrente) return ''
  const d = new Date(scene.momento_corrente)
  if (Number.isNaN(d.getTime())) return scene.momento_corrente
  return formatItalianDate(d)
}

// Aggiorna scene.momento_corrente avanzando di minutiFloat
function advanceSceneTime(scene, minutiFloat) {
  if (!minutiFloat || !scene) return
  const current = scene.momento_corrente ? new Date(scene.momento_corrente) : null
  const advanced = advanceDateByMinutes(current, minutiFloat)
  if (advanced) scene.momento_corrente = advanced.toISOString()
}

function compactRagText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function formatRagResults(results) {
  if (!results?.length) return '(nessun contesto disponibile)'
  return results
    .map((r) => {
      const normalizedName = String(r.name || '').trim()
      const displayName = normalizedName.replace(/:+\s*$/, '')
      const normalizedContent = compactRagText(r.content)
        .replace(new RegExp(`^${escapeRegExp(normalizedName)}:?\\s*\\n?`, 'i'), '')
        .replace(new RegExp(`^${escapeRegExp(displayName)}:?\\s*\\n?`, 'i'), '')
        .trim()
      return compactRagText(`[${r.type}] ${displayName}:\n${normalizedContent}`)
    })
    .join('\n\n---\n\n')
}

// ── Tool calling: consulto_il_manuale ─────────────────────────────────────────

const CONSULTO_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'consulto_il_manuale',
    description: "Recupera informazioni dal manuale dell'avventura su un PNG, luogo, oggetto, pericolo o indizio specifico.",
    parameters: {
      type: 'object',
      properties: {
        argomento: {
          description: "Nome o tipo dell'elemento da cercare (es. 'Madame Fouchet', 'sala d\\'aste', 'simbolo sulla fotografia', 'cultista infiltrato')"
        }
      },
      required: ['argomento']
    }
  }
}

function buildConsultoToolHandler(moduleId, tableId) {
  return {
    consulto_il_manuale: async ({ argomento }) => {
      try {
        const results = await rag.cascadeQueryModule(moduleId, argomento, RAG_PROMPT_TOP_K)
        return formatRagResults(results)
      } catch (err) {
        console.warn(`[Custode] consulto_il_manuale("${argomento}") fallito:`, err.message)
        return '(nessun risultato disponibile per questa query)'
      }
    }
  }
}

// Formatta i nomi degli elementi disponibili nella scena per il prompt tool-calling
function formatNomiDisponibili(scene) {
  const lines = []
  if (scene?.PNG) {
    const items = splitIterateItems(String(scene.PNG))
    if (items.length) lines.push(`PNG: ${items.join(', ')}`)
  }
  if (scene?.opportunita) {
    const items = splitIterateItems(String(scene.opportunita))
    if (items.length) lines.push(`Opportunità: ${items.join(', ')}`)
  }
  if (scene?.minacce) {
    const items = splitIterateItems(String(scene.minacce))
    if (items.length) lines.push(`Minacce: ${items.join(', ')}`)
  }
  if (scene?.indizi) {
    const items = splitIterateItems(String(scene.indizi))
    if (items.length) lines.push(`Indizi: ${items.join(', ')}`)
  }
  return lines.length ? lines.join('\n') : '(nessun elemento nel manuale per questa scena)'
}

// ── RAG resolver ──────────────────────────────────────────────────────────────
//
// Risolve i tag {{rag:module:"query"}} e {{rag:table:"query"}} nel template
// prima della normale sostituzione delle variabili.
// La query può contenere riferimenti a variabili runtime: {{rag:module:"{{suggerimento_scena}}"}}

// Sintassi supportate:
// {{rag:module:"query"}}
// {{rag:module:"query":cascade}}
// {{rag:module:locations}}
// {{rag:module:locations|"Capitolo 1"}}
// {{rag:module:location_list}}
// {{rag:module:iterate:"A, B, C"}}
// {{rag:module:iterate:"A, B, C":cascade}}
const RAG_PROMPT_TOP_K = parseInt(process.env.RAG_PROMPT_TOP_K || '3')

function dedupeRagResults(results) {
  const seen = new Set()
  return (results || []).filter(result => {
    const key = [
      result.type || '',
      result.name || '',
      result.chapter || '',
      result.sessionNumber || '',
      result.content || ''
    ].join('::')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function splitIterateItems(query) {
  const raw = String(query || '').trim()
  if (!raw) return []
  if (raw.startsWith('[') && raw.endsWith(']')) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return parsed.map(item => String(item || '').trim()).filter(Boolean)
      }
    } catch { /* fallback sotto */ }
  }
  return raw
    .split(/[\n,;]+/)
    .map(item => item.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
}

function formatRagList(items) {
  if (!items?.length) return '(nessun elemento disponibile)'
  return compactRagText(items.map(item => String(item || '').trim()).filter(Boolean).join(', '))
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseRagDirectiveBody(body) {
  const text = String(body || '').trim()
  if (!text.startsWith('module:') && !text.startsWith('table:')) return null

  const firstColon = text.indexOf(':')
  const source = text.slice(0, firstColon)
  const rest = text.slice(firstColon + 1)

  // legacy/current entity query: module:"query"[:cascade|:iterate]
  if (rest.startsWith('"')) {
    const queryMatch = rest.match(/^"([^"]+)"(?::(cascade|iterate))?$/)
    if (!queryMatch) return null
    return {
      source,
      kind: queryMatch[2] === 'iterate' ? 'iterate' : 'entity',
      queryTemplate: queryMatch[1],
      cascade: queryMatch[2] === 'cascade'
    }
  }

  // iterate:"A, B, C"[:cascade]
  if (rest.startsWith('iterate:')) {
    const iterateMatch = rest.match(/^iterate:"([^"]+)"(?::(cascade))?$/)
    if (!iterateMatch) return null
    return {
      source,
      kind: 'iterate',
      queryTemplate: iterateMatch[1],
      cascade: iterateMatch[2] === 'cascade'
    }
  }

  // category / list mode with optional filter and optional cascade
  const modeMatch = rest.match(/^([a-z_]+)(?:\|"([^"]+)")?(?::(cascade))?$/i)
  if (!modeMatch) return null

  return {
    source,
    kind: 'mode',
    mode: modeMatch[1],
    filterTemplate: modeMatch[2] || '',
    cascade: modeMatch[3] === 'cascade'
  }
}

function findRagDirectives(template) {
  const text = String(template || '')
  const directives = []
  let cursor = 0

  while (cursor < text.length) {
    const start = text.indexOf('{{rag:', cursor)
    if (start === -1) break

    let i = start
    let depth = 0
    let end = -1

    while (i < text.length - 1) {
      const pair = text.slice(i, i + 2)
      if (pair === '{{') {
        depth++
        i += 2
        continue
      }
      if (pair === '}}') {
        depth--
        i += 2
        if (depth === 0) {
          end = i
          break
        }
        continue
      }
      i += 1
    }

    if (end === -1) break

    directives.push({
      start,
      end,
      fullMatch: text.slice(start, end),
      body: text.slice(start + '{{rag:'.length, end - 2)
    })
    cursor = end
  }

  return directives
}

function buildRagResolver(moduleId, tableId) {
  return async (template, vars) => {
    const matches = findRagDirectives(template)
    if (!matches.length) return template

    for (const match of matches.reverse()) {
      const { fullMatch, body, start, end } = match
      const directive = parseRagDirectiveBody(body)
      if (!directive) continue

      const interpolate = (valueTemplate) => {
        let value = String(valueTemplate || '')
        for (const [key, val] of Object.entries(vars)) {
          const replacement = typeof val === 'object' ? JSON.stringify(val) : String(val ?? '')
          value = value.replaceAll(`{{${key}}}`, replacement)
        }
        return value
      }

      let replacement = '(nessun contesto disponibile)'
      try {
        if (directive.kind === 'entity') {
          const query = interpolate(directive.queryTemplate)
          const results = directive.source === 'module'
            ? (directive.cascade
                ? await rag.cascadeQueryModule(moduleId, query, RAG_PROMPT_TOP_K)
                : await rag.queryModule(moduleId, query, RAG_PROMPT_TOP_K))
            : await rag.queryTable(tableId, query, RAG_PROMPT_TOP_K)
          replacement = formatRagResults(results)
        } else if (directive.kind === 'iterate') {
          const query = interpolate(directive.queryTemplate)
          if (directive.source === 'module') {
            const results = await rag.queryModuleIterate(moduleId, query, RAG_PROMPT_TOP_K, { cascade: directive.cascade })
            replacement = formatRagResults(results)
          } else {
            let results = []
            const items = splitIterateItems(query)
            for (const item of items) {
              const partial = await rag.queryTable(tableId, item, RAG_PROMPT_TOP_K)
              results.push(...partial)
            }
            replacement = formatRagResults(dedupeRagResults(results))
          }
        } else {
          const filterText = interpolate(directive.filterTemplate)
          const mode = String(directive.mode || '')
          const isListMode = mode.endsWith('_list')

          if (directive.cascade && isListMode) {
            replacement = '(cascade non supportato per le modalità *_list)'
          } else if (directive.source !== 'module') {
            replacement = '(modalità non supportata per questa sorgente)'
          } else if (isListMode) {
            const items = await rag.listModuleCategory(moduleId, mode, filterText)
            replacement = formatRagList(items)
          } else {
            const results = await rag.queryModuleCategory(moduleId, mode, filterText, RAG_PROMPT_TOP_K)
            replacement = formatRagResults(results)
          }
        }
      } catch (err) {
        console.warn(`[Custode] RAG resolver [${body}] fallita:`, err.message)
      }

      template = `${template.slice(0, start)}${replacement}${template.slice(end)}`
    }

    return template
  }
}

const FASE1A_CACHE_FILE = 'fase1a_cache.json'
function fase1aCachePath(tableId) { return path.join(tDir(tableId), FASE1A_CACHE_FILE) }

async function isSessionBootstrapReady(tableId) {
  return fileExists(fase1aCachePath(tableId))
}

async function promoteTableToReadyIfPossible(tableId, table = null) {
  const currentTable = table || await getTable(tableId)
  if (currentTable.state !== 'active') return false

  const chars = await getCharacters(tableId)
  const charOwners = new Set(chars.map(c => c.playerID))
  const allCreated = currentTable.invitedPlayers.every(email => charOwners.has(email))
  if (!allCreated) return false

  const now = new Date()
  currentTable.state = 'ready'
  currentTable.plannedSession = {
    date: now.toISOString().slice(0, 10),
    time: now.toTimeString().slice(0, 5),
    duration: 180
  }
  currentTable.updatedAt = now.toISOString()
  await writeJSON(path.join(tDir(tableId), 'table.json'), currentTable)
  prepareSessionBootstrapInBackground(tableId)
  return true
}

async function prepareSessionBootstrap(tableId, options = {}) {
  const { force = false } = options
  const table = await getTableOrNull(tableId)
  if (!table) return false

  if (!force && await fileExists(fase1aCachePath(tableId))) return true

  const mod = await getModule(table.moduleId)
  const model = ollama.getDefaultLlmModel()
  if (!model) return false

  const chars = await getCharacters(tableId)
  const charOwners = new Set(chars.map(c => c.playerID))
  const allCreated = table.invitedPlayers.every(email => charOwners.has(email))
  if (!allCreated) return false

  // Verifica che il modulo abbia contenuto (serve per il RAG, non più per l'ambientazione diretta)
  if (!mod.chapters[0]?.content?.trim()) return false

  const schede_PG = chars.map(synthChar).join('\n')
  const ragResolver = buildRagResolver(table.moduleId, tableId)

  let lastError
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await ollama.runPhase(
        model,
        'fase1a_prima_sessione.md',
        { schede_PG },
        { num_ctx: ollama.LLM_NUM_CTX },
        tableId,
        ragResolver
      )
      await writeJSON(fase1aCachePath(tableId), result)
      table.custodeStarted = true
      table.updatedAt = new Date().toISOString()
      await writeJSON(path.join(tDir(tableId), 'table.json'), table)
      if (result.narrativa) {
        rag.indexSessionIntro(tableId, result.narrativa, mod.title).catch(err =>
          console.warn(`[Custode] Indicizzazione Prima Sessione fallita per ${tableId}:`, err.message)
        )
      }
      return true
    } catch (err) {
      lastError = err
      console.error(`[Custode] Cache fase1a tentativo ${attempt}/3 fallito per ${tableId}:`, err.message)
      if (attempt < 3) await sleep(5000 * attempt)
    }
  }
  console.error(`[Custode] Generazione cache fase1a fallita dopo 3 tentativi per ${tableId} — intervento admin richiesto`)
  return false
}

async function ensureSessionBootstrap(tableId) {
  if (await isSessionBootstrapReady(tableId)) return true
  const ready = await prepareSessionBootstrap(tableId).catch(() => false)
  return ready && await isSessionBootstrapReady(tableId)
}

const bootstrapInProgress = new Set()

function prepareSessionBootstrapInBackground(tableId, options = {}) {
  if (bootstrapInProgress.has(tableId)) return
  bootstrapInProgress.add(tableId)
  prepareSessionBootstrap(tableId, options)
    .catch(err => console.error(`[Custode] Errore preparando bootstrap tavolo ${tableId}:`, err.message))
    .finally(() => bootstrapInProgress.delete(tableId))
}

// ── Custode per tavolo ────────────────────────────────────────────────────────

class CustodeEngine {
  constructor(tableId, io) {
    this.tableId = tableId
    this.io = io
    this.buffer = []         // messaggi gioco-libero in attesa
    this.running = false
    this.paused = false
    this.bufferActive = false
    this.flushInProgress = false
    this.passiveOrchestratorMode = false
  }

  get room() { return `table:${this.tableId}` }

  // ── Emit helpers ─────────────────────────────────────────────────────────

  async emitNarrative(text, options = {}) {
    const tableId = this.tableId
    const safeText = normalizeNarrativeText(text)

    if (!safeText) {
      console.warn(`[Custode] Messaggio narrativo vuoto per tavolo ${tableId}`)
      return
    }

    // Typing indicator
    this.io.to(this.room).emit('session:custode-typing', true)
    await sleep(Math.min(safeText.length * 20, 2000))   // simula latenza

    const msg = await svc.addMessage(tableId, {
      type: options.type || 'custode',
      from: options.from || 'custode',
      fromName: options.fromName || 'Custode',
      to: options.to || null,
      text: safeText,
      messageKind: options.messageKind || null
    })

    this.io.to(this.room).emit('session:custode-typing', false)

    if (options.whisper && options.to) {
      // Consegna solo al destinatario
      const target = [...this.io.sockets.sockets.values()]
        .find(s => s.user?.email === options.to && s.tableId === tableId)
      if (target) target.emit('session:message', msg)
      // Anche al custode/altri connessi come log interno? No: è un sussurro privato
    } else {
      this.io.to(this.room).emit('session:message', msg)
    }
  }

  async buildArchivistRuntimeContext(payload = {}) {
    const table = await getTableOrNull(this.tableId)
    const ctx = svc.getSession(this.tableId)
    const notesResources = getModuleNotesResources(table?.moduleId)
    const index = notesResources?.index || null
    const resolveEntityLabel = (value) => {
      const normalized = normalizeChatText(value)
      if (!normalized || !index) return value
      const candidate = Object.values(index.byId || {}).find(entry => normalizeChatText(entry.id) === normalized)
      if (candidate?.name) return candidate.name
      for (const type of ['npc', 'scene', 'object', 'clue']) {
        const ref = lookupEntityRefByName(index, type, value)
        if (ref?.name) return ref.name
      }
      return value
    }

    const scene = payload.focusSceneId
      ? await runtimeStore.getScene(this.tableId, payload.focusSceneId)
      : null
    const actorPg = payload.playerName
      ? await runtimeStore.getCharacterByName(this.tableId, payload.playerName)
      : (payload.playerEmail ? await runtimeStore.getCharacterByPlayerId(this.tableId, payload.playerEmail) : null)
    const npc = payload.npcName
      ? await runtimeStore.getNpc(this.tableId, lookupEntityRefByName(index, 'npc', payload.npcName)?.id || '')
      : null
    const recentChat = recentPlayerMessagesSummary(ctx?.messages || [])

    const sections = []
    if (scene) sections.push(`SCENA FOCUS\n${renderSceneSummary(scene, { resolveEntityLabel })}`)
    if (actorPg) sections.push(`PG ATTIVO\n${await buildPgActiveContextText(this.tableId, actorPg)}`)
    if (npc) sections.push(`PNG ATTIVO\n${renderNpcSummary(npc, { resolveEntityLabel })}`)
    if (recentChat) sections.push(`STORICO CHAT\n${recentChat}`)

    return {
      sourceAgent: payload.sourceAgent || '',
      playerName: payload.playerName || '',
      npcName: payload.npcName || '',
      declarationText: normalizeNarrativeText(payload.declarationText),
      narrativeText: normalizeNarrativeText(payload.narrativeText),
      contextText: sections.join('\n\n') || 'Nessun contesto strutturato disponibile.'
    }
  }

  async getImplicitNpcTargetForPlayer(playerId) {
    const actorPg = playerId
      ? await runtimeStore.getCharacterByPlayerId(this.tableId, playerId)
      : null
    const npcHandlers = Array.isArray(actorPg?.runtime?.handlers)
      ? actorPg.runtime.handlers
        .filter(handler => normalizeChatText(handler?.type || '') === 'npc')
        .map(handler => normalizeNarrativeText(handler?.name || ''))
        .filter(Boolean)
      : []
    return npcHandlers.length === 1 ? npcHandlers[0] : null
  }

  async getImplicitNpcHandlersForPlayer(playerId) {
    const actorPg = playerId
      ? await runtimeStore.getCharacterByPlayerId(this.tableId, playerId)
      : null
    return Array.isArray(actorPg?.runtime?.handlers)
      ? actorPg.runtime.handlers
        .filter(handler => normalizeChatText(handler?.type || '') === 'npc')
        .map(handler => normalizeNarrativeText(handler?.name || ''))
        .filter(Boolean)
      : []
  }

  async applyArchivistRuntimeUpdate(update = {}, payload = {}) {
    const focusSceneId = payload.focusSceneId || null
    const sessionNumber = svc.getSession(this.tableId)?.session?.sessionNumber || null
    const table = await getTableOrNull(this.tableId)
    const notesResources = getModuleNotesResources(table?.moduleId)
    const index = notesResources?.index || null

    for (const entry of (update.storyLog || [])) {
      await runtimeStore.appendStoryLogEntry(this.tableId, {
        sessione: sessionNumber,
        scena: focusSceneId,
        type: 'narrative',
        text: entry
      })
    }

    for (const entry of (update.partyKnowledge || [])) {
      await runtimeStore.appendPartyKnowledgeEntry(this.tableId, {
        scena: focusSceneId,
        text: entry
      })
    }

    if (Array.isArray(update.npcUpdates) && update.npcUpdates.length) {
      const worldState = await getWorldState(this.tableId)
      for (const npcUpdate of update.npcUpdates) {
        const targetName = normalizeNarrativeText(npcUpdate?.npcName || npcUpdate?.name || npcUpdate?.npc || '')
        if (!targetName) continue
        const target = (worldState.npcs || []).find(npc => normalizeChatText(npc.name) === normalizeChatText(targetName))
        if (!target) continue
        if (Array.isArray(npcUpdate.addInformazioniRivelate)) {
          target.informazioni_rivelate = mergeUniqueStrings(target.informazioni_rivelate || [], npcUpdate.addInformazioniRivelate)
        }
        if (npcUpdate.atteggiamento_verso_pg != null) {
          target.atteggiamento_verso_pg = normalizeNarrativeText(npcUpdate.atteggiamento_verso_pg)
        }
        if (npcUpdate.note_npc_master != null) {
          target.note_npc_master = normalizeNarrativeText(npcUpdate.note_npc_master)
        }
      }
      await saveWorldState(this.tableId, worldState)
    }

    if (Array.isArray(update.pgUpdates) && update.pgUpdates.length) {
      for (const pgUpdate of update.pgUpdates) {
        const targetName = normalizeNarrativeText(pgUpdate?.playerName || pgUpdate?.name || pgUpdate?.pg || '')
        if (!targetName) continue
        const target = await runtimeStore.getCharacterByName(this.tableId, targetName)
        if (!target?.name) continue
        const next = { ...target }
        if (!next.runtime || typeof next.runtime !== 'object' || Array.isArray(next.runtime)) next.runtime = {}
        if (pgUpdate.stato != null) next.stato_corrente = normalizeNarrativeText(pgUpdate.stato)
        if (pgUpdate.position != null) next.runtime.position = normalizeNarrativeText(pgUpdate.position)
        if (Array.isArray(pgUpdate.handlers)) {
          next.runtime.handlers = normalizeArchivistHandlers(pgUpdate.handlers, index)
        }
        await writeJSON(
          path.join(runtimeStore.charactersDir(this.tableId), `${runtimeStore.sanitizeFileStem(next.name)}.json`),
          next
        )
      }
    }

    const elapsedMinutes = Math.max(0, Number(update.elapsedMinutes) || 0)
    if (elapsedMinutes > 0 && focusSceneId) {
      const scene = await runtimeStore.getScene(this.tableId, focusSceneId)
      if (scene?.runtime) {
        const base = scene.runtime.tempo_corrente
          ? new Date(scene.runtime.tempo_corrente)
          : buildClockDate(await runtimeStore.getGameClock(this.tableId))
        if (base && !Number.isNaN(base.getTime())) {
          const advanced = new Date(base.getTime() + elapsedMinutes * 60 * 1000)
          scene.runtime.tempo_corrente = advanced.toISOString()
          if (!scene.runtime.tempo_inizio) scene.runtime.tempo_inizio = base.toISOString()
          await runtimeStore.saveScene(this.tableId, scene)
          const clock = await runtimeStore.getGameClock(this.tableId)
          clock.data_inizio_avventura = normalizeNarrativeText(clock.data_inizio_avventura) || advanced.toISOString().slice(0, 10)
          clock.ora_gioco = advanced.toISOString().slice(11, 16)
          const baseDay = Number(clock.giorno_avventura) || 1
          const baseDate = buildClockDate({ data_inizio_avventura: clock.data_inizio_avventura, ora_gioco: '00:00' })
          if (baseDate) {
            const advancedMidnight = new Date(advanced.toISOString().slice(0, 10) + 'T00:00:00.000Z')
            const deltaDays = Math.round((advancedMidnight.getTime() - baseDate.getTime()) / (24 * 60 * 60 * 1000))
            clock.giorno_avventura = Math.max(1, baseDay + Math.max(0, deltaDays))
          }
          await runtimeStore.saveGameClock(this.tableId, clock)
        }
      }
    }
  }

  async runArchivistRuntimeUpdate(payload = {}) {
    try {
      const handoff = await this.buildArchivistRuntimeContext(payload)
      const result = await this.llm('archivist_v0_runtime_update.md', handoff)
      await this.applyArchivistRuntimeUpdate(result, payload)
    } catch (err) {
      console.warn(`[Archivist] Aggiornamento runtime fallito [${this.tableId}]: ${err.message}`)
    }
  }

  queueArchivistRuntimeUpdate(payload = {}) {
    this.runArchivistRuntimeUpdate(payload).catch(err => {
      console.warn(`[Archivist] Aggiornamento runtime asincrono fallito [${this.tableId}]: ${err.message}`)
    })
  }

  async emitPhaseChange(phase) {
    const ctx = svc.getSession(this.tableId)
    if (ctx) {
      ctx.session.custodePhase = phase
      await svc.saveSession(this.tableId, ctx.session)
    }
    console.log(`[Custode] Phase change [${this.tableId}] -> ${phase}`)
    this.io.to(this.room).emit('session:phase-update', { phase })
  }

  async emitError(text) {
    this.io.to(this.room).emit('session:toast', { type: 'error', text })
  }

  async emitOrchestratorDebug(text) {
    const safeText = normalizeNarrativeText(text)
    if (!safeText) return
    const msg = await svc.addMessage(this.tableId, {
      type: 'orchestrator-debug',
      from: 'orchestrator',
      fromName: 'Orchestrator',
      to: null,
      text: safeText,
      messageKind: 'debug'
    })
    if (msg) this.io.to(this.room).emit('session:message', msg)
  }

  emitSessionUpdate() {
    const ctx = svc.getSession(this.tableId)
    if (!ctx) return
    this.io.to(this.room).emit('session:session-update', { session: ctx.session })
  }

  async waitForFocusSilence(reason = 'agent-response', participants = null) {
    const focusParticipants = Array.isArray(participants)
      ? participants
      : await this.getFlushParticipants()
    if (!focusParticipants.length) return

    let attempts = 0
    while (attempts < 20) {
      const typingPlayers = svc.getTypingPlayers(this.tableId)
      if (!hasActiveTypingInFocus(typingPlayers, focusParticipants)) return
      if (attempts === 0) {
        console.log(`[Orchestrator] Waiting for silence [${this.tableId}] reason=${reason} participants=${debugString(focusParticipants)} typing=${debugString(typingPlayers)}`)
      }
      attempts += 1
      await sleep(500)
    }
  }

  async emitThinking(phaseKey) {
    const messages = await loadThinkingMessages()
    const list = messages[phaseKey]
    if (!list?.length) return
    const text = list[Math.floor(Math.random() * list.length)]
    const label = phaseLabel(phaseKey)
    this.io.to(this.room).emit('custode:thinking', { message: `${label} ${text}...` })
  }

  // ── LLM call con gestione errori ──────────────────────────────────────────

  async llmText(promptFile, vars) {
    const table = await getTableOrNull(this.tableId)
    if (!table) {
      const err = Object.assign(new Error(`Tavolo ${this.tableId} non trovato`), { isTableMissing: true })
      throw err
    }

    const model = ollama.getDefaultLlmModel()
    if (!model) {
      const err = Object.assign(
        new Error('Modello LLM non configurato sul tavolo'),
        { isLlmError: true }
      )
      await this.pauseForTechnicalIssue('Modello LLM non configurato – imposta DEFAULT_LLM_MODEL nel file .env')
      throw err
    }

    try {
      const ragResolver = buildRagResolver(table.moduleId, this.tableId)
      return await ollama.runTextPhase(model, promptFile, vars, this.tableId, ragResolver)
    } catch (err) {
      if (err.isLlmError) {
        await this.pauseForTechnicalIssue(`Errore LLM (${model}): ${err.message} – sessione in pausa`)
      }
      throw err
    }
  }

  async llm(promptFile, vars) {
    const table = await getTableOrNull(this.tableId)
    if (!table) {
      const err = Object.assign(new Error(`Tavolo ${this.tableId} non trovato`), { isTableMissing: true })
      throw err
    }
    const model = ollama.getDefaultLlmModel()

    if (!model) {
      const err = Object.assign(
        new Error('Modello LLM non configurato sul tavolo'),
        { isLlmError: true }
      )
      await this.pauseForTechnicalIssue('Modello LLM non configurato – imposta DEFAULT_LLM_MODEL nel file .env')
      throw err
    }

    try {
      const ollamaOptions = { num_ctx: ollama.LLM_NUM_CTX }
      const ragResolver = buildRagResolver(table.moduleId, this.tableId)
      return await ollama.runPhase(model, promptFile, vars, ollamaOptions, this.tableId, ragResolver)
    } catch (err) {
      if (err.isLlmError) {
        await this.pauseForTechnicalIssue(`Errore LLM (${model}): ${err.message} – sessione in pausa`)
      }
      throw err
    }
  }

  // Come llm(), ma usa tool calling con consulto_il_manuale invece del ragResolver
  async llmWithTools(promptFile, vars) {
    const table = await getTableOrNull(this.tableId)
    if (!table) throw Object.assign(new Error(`Tavolo ${this.tableId} non trovato`), { isTableMissing: true })

    const model = ollama.getDefaultLlmModel()
    if (!model) {
      await this.pauseForTechnicalIssue('Modello LLM non configurato – imposta DEFAULT_LLM_MODEL nel file .env')
      throw Object.assign(new Error('Modello LLM non configurato sul tavolo'), { isLlmError: true })
    }

    try {
      const toolHandlers = buildConsultoToolHandler(table.moduleId, this.tableId)
      return await ollama.runPhaseWithTools(
        model, promptFile, vars,
        [CONSULTO_TOOL_DEFINITION], toolHandlers,
        { num_ctx: ollama.LLM_NUM_CTX }, this.tableId
      )
    } catch (err) {
      if (err.isLlmError) {
        await this.pauseForTechnicalIssue(`Errore LLM (${model}): ${err.message} – sessione in pausa`)
      }
      throw err
    }
  }

  async buildCustodeQuestionContext(routing, message) {
    const table = await getTableOrNull(this.tableId)
    const ctx = svc.getSession(this.tableId)
    const worldState = await getWorldState(this.tableId)
    const notesResources = getModuleNotesResources(table?.moduleId)
    const index = notesResources?.index || null
    const notesDir = notesResources?.notesDir || null
    const metadata = routing.metadata || {}
    const primaryEntity = metadata.primaryEntity || null
    const secondaryEntities = metadata.secondaryEntities || []
    const resolveEntityLabel = (value) => {
      const normalized = normalizeChatText(value)
      if (!normalized || !index) return value
      const candidate = Object.values(index.byId || {}).find(entry => normalizeChatText(entry.id) === normalized)
      if (candidate?.name) return candidate.name
      for (const type of ['npc', 'scene', 'object', 'clue']) {
        const ref = lookupEntityRefByName(index, type, value)
        if (ref?.name) return ref.name
      }
      return value
    }

    const sections = []
    const recentMessages = recentPlayerMessagesSummary(ctx?.messages || [])
    const sharedStory = normalizeNarrativeText(worldState?.conoscenze_party || '')
    const contextBundle = Array.isArray(routing.contextBundle) ? routing.contextBundle : []
    const secondaryByType = secondaryEntities.reduce((acc, entity) => {
      if (!acc[entity.type]) acc[entity.type] = []
      acc[entity.type].push(entity.value)
      return acc
    }, {})
    const actorPg = await runtimeStore.getCharacterByPlayerId(this.tableId, message.from)
      || await runtimeStore.getCharacterByName(this.tableId, message.fromName)

    const loadEntityByName = async (type, value) => {
      const ref = lookupEntityRefByName(index, type, value)
      if (!ref) return null
      if (type === 'npc') return runtimeStore.getNpc(this.tableId, ref.id)
      if (type === 'object') return runtimeStore.getObject(this.tableId, ref.id)
      if (type === 'clue') return runtimeStore.getClue(this.tableId, ref.id)
      if (type === 'scene') return runtimeStore.getScene(this.tableId, ref.id)
      return null
    }

    for (const entry of contextBundle) {
      if (entry === 'focusScene') {
        const scene = routing.focusSceneId
          ? await runtimeStore.getScene(this.tableId, routing.focusSceneId)
          : null
        if (scene) sections.push(`SCENA FOCUS\n${renderSceneSummary(scene, { resolveEntityLabel })}`)
        else if (routing.focusSceneLabel) sections.push(`SCENA FOCUS\nLa scena corrente e ${routing.focusSceneLabel}.`)
        continue
      }

      if (entry === 'recentChat') {
        if (recentMessages) sections.push(`STORICO CHAT\n${recentMessages}`)
        continue
      }

      if (entry === 'partyKnowledgeShort') {
        if (sharedStory) sections.push(`COSA SANNO I PG\n${sharedStory}`)
        continue
      }

      if (entry === 'npcSummary:primary' && primaryEntity?.type === 'npc') {
        const npc = await loadEntityByName('npc', primaryEntity.value)
        if (npc) sections.push(`PRIMARY NPC\n${renderNpcSummary(npc, { resolveEntityLabel })}`)
        continue
      }
      if (entry === 'objectSummary:primary' && primaryEntity?.type === 'object') {
        const object = await loadEntityByName('object', primaryEntity.value)
        if (object) sections.push(`PRIMARY OGGETTO\n${renderObjectSummary(object, { resolveEntityLabel })}`)
        continue
      }
      if (entry === 'clueSummary:primary' && primaryEntity?.type === 'clue') {
        const clue = await loadEntityByName('clue', primaryEntity.value)
        if (clue) sections.push(`PRIMARY INDIZIO\n${renderClueSummary(clue, { resolveEntityLabel })}`)
        continue
      }
      if (entry === 'locationCard:primary' && primaryEntity?.type === 'location') {
        const ref = lookupEntityRefByName(index, 'scene', primaryEntity.value) || null
        const scene = ref ? await runtimeStore.getScene(this.tableId, ref.id) : null
        if (scene) sections.push(`PRIMARY LOCATION\n${renderLocationSummary(scene, { resolveEntityLabel })}`)
        continue
      }
      if (entry === 'pgSummary:primary' && primaryEntity?.type === 'pg') {
        const pg = await runtimeStore.getCharacterByName(this.tableId, primaryEntity.value)
        if (pg) sections.push(`PRIMARY PG\n${renderPgSummary(pg)}`)
        continue
      }
      if (entry === 'pgSummary:actor') {
        if (actorPg) sections.push(`PG ATTIVO\n${renderPgSummary(actorPg)}`)
        continue
      }
      if (entry === 'rulesExcerpt:primarySkill') {
        const skill = primaryEntity?.type === 'skill'
          ? primaryEntity.value
          : (metadata?.entities?.skills || [])[0]
        const excerpt = renderRulesExcerpt(skill)
        if (excerpt) sections.push(`ESTRATTO REGOLE\n${excerpt}`)
        continue
      }
      if (entry === 'rulesExcerpt:secondarySkill') {
        const skill = (secondaryByType.skill || [])[0]
        const excerpt = renderRulesExcerpt(skill)
        if (excerpt) sections.push(`ESTRATTO REGOLE SECONDARIO\n${excerpt}`)
        continue
      }

      const secondaryConfigs = [
        { token: 'npcSummary:secondary', type: 'npc', title: 'SECONDARY NPC', renderer: renderNpcSummary },
        { token: 'objectSummary:secondary', type: 'object', title: 'SECONDARY OGGETTO', renderer: renderObjectSummary },
        { token: 'clueSummary:secondary', type: 'clue', title: 'SECONDARY INDIZIO', renderer: renderClueSummary },
        { token: 'pgSummary:secondary', type: 'pg', title: 'SECONDARY PG', renderer: renderPgSummary },
        { token: 'locationCard:secondary', type: 'location', title: 'SECONDARY LOCATION', renderer: renderLocationSummary }
      ]
      const secondaryConfig = secondaryConfigs.find(config => config.token === entry)
      if (!secondaryConfig) continue
      for (const value of (secondaryByType[secondaryConfig.type] || [])) {
        let payload = null
        if (secondaryConfig.type === 'pg') payload = await runtimeStore.getCharacterByName(this.tableId, value)
        else if (secondaryConfig.type === 'location') {
          const ref = lookupEntityRefByName(index, 'scene', value) || null
          payload = ref ? await runtimeStore.getScene(this.tableId, ref.id) : null
        } else {
          payload = await loadEntityByName(secondaryConfig.type, value)
        }
        if (payload) sections.push(`${secondaryConfig.title}\n${secondaryConfig.renderer(payload, { resolveEntityLabel })}`)
      }
    }

    if (!sections.length) sections.push('Nessun contesto strutturato disponibile.')

    return {
      questionType: metadata.questionType || 'general_question',
      operator: metadata.operator || 'ask',
      contextText: sections.join('\n\n') || 'Nessun contesto strutturato disponibile.',
      playerName: message.fromName || message.from,
      playerQuestion: normalizeNarrativeText(message.text),
      focusSceneLabel: routing.focusSceneLabel || routing.focusSceneId || ''
    }
  }

  async buildSceneMasterDeclarationContext(routing, message) {
    const table = await getTableOrNull(this.tableId)
    const ctx = svc.getSession(this.tableId)
    const notesResources = getModuleNotesResources(table?.moduleId)
    const index = notesResources?.index || null
    const resolveEntityLabel = (value) => {
      const normalized = normalizeChatText(value)
      if (!normalized || !index) return value
      const candidate = Object.values(index.byId || {}).find(entry => normalizeChatText(entry.id) === normalized)
      if (candidate?.name) return candidate.name
      for (const type of ['npc', 'scene', 'object', 'clue']) {
        const ref = lookupEntityRefByName(index, type, value)
        if (ref?.name) return ref.name
      }
      return value
    }

    const actorPg = await runtimeStore.getCharacterByPlayerId(this.tableId, message.from)
      || await runtimeStore.getCharacterByName(this.tableId, message.fromName)
    const actorName = actorPg?.name
      || actorPg?.nome
      || ctx?.session?.players?.find(player => player.email === message.from)?.characterName
      || message.fromName
      || message.from

    const recentChat = recentPlayerMessagesSummary(ctx?.messages || [])
    const scene = routing.focusSceneId
      ? await runtimeStore.getScene(this.tableId, routing.focusSceneId)
      : null

    const moduleCatalog = getModuleQuestionCatalog(table?.moduleId) || {}
    const metadataNpcNames = Array.isArray(routing?.metadata?.entities?.npcs)
      ? routing.metadata.entities.npcs.slice(0, 2)
      : []
    const mentionedNpcNames = Array.from(new Set([
      ...findMentionedNames(message.text, moduleCatalog.npcNames || []).slice(0, 2),
      ...metadataNpcNames
    ])).slice(0, 2)
    const mentionedObjectNames = findMentionedNames(message.text, moduleCatalog.objectNames || []).slice(0, 2)
    const mentionedClueNames = findMentionedNames(message.text, moduleCatalog.clueNames || []).slice(0, 2)
    const mentionedLocationNames = findMentionedNames(message.text, moduleCatalog.locationNames || []).slice(0, 1)

    const loadEntityByName = async (type, value) => {
      const ref = lookupEntityRefByName(index, type, value)
      if (!ref) return null
      if (type === 'npc') return runtimeStore.getNpc(this.tableId, ref.id)
      if (type === 'object') return runtimeStore.getObject(this.tableId, ref.id)
      if (type === 'clue') return runtimeStore.getClue(this.tableId, ref.id)
      if (type === 'scene') return runtimeStore.getScene(this.tableId, ref.id)
      return null
    }

    const sections = []
    if (scene) sections.push(`SCENA FOCUS\n${renderSceneSummary(scene, { resolveEntityLabel })}`)
    if (actorPg) sections.push(`PG ATTIVO\n${await buildPgActiveContextText(this.tableId, actorPg)}`)
    if (recentChat) sections.push(`STORICO CHAT\n${recentChat}`)
    const skillsCatalog = renderSkillsCatalogSummary({ dialogueOnly: true })
    if (skillsCatalog) sections.push(`ABILITA DISPONIBILI\n${skillsCatalog}`)

    for (const name of mentionedNpcNames) {
      const npc = await loadEntityByName('npc', name)
      if (!npc) continue
      sections.push(`NPC CITATO\n${renderNpcSummary(npc, { resolveEntityLabel })}`)
      const heldClues = await loadCluesHeldByNpc(this.tableId, npc.id_png, index)
      for (const clue of heldClues) {
        sections.push(`INDIZIO IN POSSESSO DEL PNG\n${renderClueSummary(clue, { resolveEntityLabel })}`)
      }
    }
    for (const name of mentionedObjectNames) {
      const object = await loadEntityByName('object', name)
      if (object) sections.push(`OGGETTO CITATO\n${renderObjectSummary(object, { resolveEntityLabel })}`)
    }
    for (const name of mentionedClueNames) {
      const clue = await loadEntityByName('clue', name)
      if (clue) sections.push(`INDIZIO CITATO\n${renderClueSummary(clue, { resolveEntityLabel })}`)
    }
    for (const name of mentionedLocationNames) {
      const location = await loadEntityByName('scene', name)
      if (location) sections.push(`LUOGO CITATO\n${renderLocationSummary(location, { resolveEntityLabel })}`)
    }

    if (!sections.length) sections.push('Nessun contesto strutturato disponibile.')

    return {
      declarationText: normalizeNarrativeText(message.text),
      playerName: actorName,
      pgName: actorName,
      contextText: sections.join('\n\n') || 'Nessun contesto strutturato disponibile.'
    }
  }

  async answerCustodeQuestion(message, routing) {
    const ctx = svc.getSession(this.tableId)
    if (!ctx) return

    try {
      const handoff = await this.buildCustodeQuestionContext(routing, message)
      const promptFile = handoff.questionType === 'rules_reference_question'
        || handoff.questionType === 'rule_or_roll_question'
        ? 'custode_v1_domanda_regole.md'
        : 'custode_v1_domanda_diretta.md'
      const response = await this.llmText(promptFile, handoff)
      await this.waitForFocusSilence('custode-response')
      await svc.setAllPlayersState(this.tableId, 'turno-custode')
      for (const player of (ctx.session.players || [])) {
        this.io.to(this.room).emit('session:player-update', {
          email: player.email,
          playerState: 'turno-custode',
          connected: player.connected
        })
      }
      await this.emitNarrative(response)
    } finally {
      await svc.setAllPlayersState(this.tableId, 'gioco-libero')
      for (const player of (ctx.session.players || [])) {
        this.io.to(this.room).emit('session:player-update', {
          email: player.email,
          playerState: 'gioco-libero',
          connected: player.connected
        })
      }
    }
  }

  async answerSceneMasterDeclaration(message, routing) {
    const ctx = svc.getSession(this.tableId)
    if (!ctx) return

    try {
      const handoff = await this.buildSceneMasterDeclarationContext(routing, message)
      const result = await this.llm('scene_master_v0_dichiarazione.md', handoff)
      if (result?.response) {
        result.Skill = normalizeNarrativeText(result.Skill)
        result.Difficulty = normalizeNarrativeText(result.Difficulty)
        await this.waitForFocusSilence('scene-master-response')
        await svc.setAllPlayersState(this.tableId, 'turno-custode')
        for (const player of (ctx.session.players || [])) {
          this.io.to(this.room).emit('session:player-update', {
            email: player.email,
            playerState: 'turno-custode',
            connected: player.connected
          })
        }
        const messageKind = result.decision === 'ask_clarification' || result.decision === 'ask_for_roll'
          ? 'question'
          : null
        await this.emitNarrative(result.response, { messageKind })
        const targetPlayer = (ctx.session.players || []).find(player => player.email === message.from) || null
        if (result.decision === 'respond_now' || result.decision === 'no_action') {
          this.queueArchivistRuntimeUpdate({
            sourceAgent: 'scene-master',
            focusSceneId: routing.focusSceneId || null,
            playerEmail: message.from,
            playerName: targetPlayer?.characterName || message.fromName || message.from,
            declarationText: normalizeNarrativeText(message.text),
            narrativeText: normalizeNarrativeText(result.response)
          })
        }

        if (result.decision === 'ask_for_roll' && targetPlayer) {
          ctx.session.pendingClarification = null
          ctx.session.pendingRoll = {
            targetCharacter: targetPlayer.characterName || '',
            targetPlayerEmail: targetPlayer.email,
            skill: normalizeNarrativeText(result.Skill),
            difficulty: normalizeNarrativeText(result.Difficulty),
            declarationText: normalizeNarrativeText(message.text),
            focusSceneId: routing.focusSceneId || null,
            source: 'scene-master',
            createdAt: new Date().toISOString()
          }
          await svc.saveSession(this.tableId, ctx.session)
          this.emitSessionUpdate()
          await this.setPlayerTurn(targetPlayer.email, 'mio-turno-prova')
          return
        }

        if (result.decision === 'ask_clarification' && targetPlayer) {
          ctx.session.pendingRoll = null
          ctx.session.pendingClarification = {
            targetCharacter: targetPlayer.characterName || '',
            targetPlayerEmail: targetPlayer.email,
            originalDeclarationText: normalizeNarrativeText(message.text),
            clarificationPrompt: normalizeNarrativeText(result.response),
            focusSceneId: routing.focusSceneId || null,
            source: 'scene-master',
            createdAt: new Date().toISOString()
          }
          await svc.saveSession(this.tableId, ctx.session)
          this.emitSessionUpdate()
          await this.setPlayerTurn(targetPlayer.email, 'mio-turno-libero')
          return
        }
      }
    } finally {
      const hasPendingTurn = (ctx.session.players || []).some(player =>
        player.playerState === 'mio-turno-prova' || player.playerState === 'mio-turno-libero'
      )
      if (!hasPendingTurn) {
        await svc.setAllPlayersState(this.tableId, 'gioco-libero')
        for (const player of (ctx.session.players || [])) {
          this.io.to(this.room).emit('session:player-update', {
            email: player.email,
            playerState: 'gioco-libero',
            connected: player.connected
          })
        }
      }
    }
  }

  async buildSceneMasterClarificationContext(message, pendingClarification) {
    const table = await getTableOrNull(this.tableId)
    const notesResources = getModuleNotesResources(table?.moduleId)
    const index = notesResources?.index || null
    const resolveEntityLabel = (value) => {
      const normalized = normalizeChatText(value)
      if (!normalized || !index) return value
      const candidate = Object.values(index.byId || {}).find(entry => normalizeChatText(entry.id) === normalized)
      if (candidate?.name) return candidate.name
      return value
    }
    const scene = pendingClarification?.focusSceneId
      ? await runtimeStore.getScene(this.tableId, pendingClarification.focusSceneId)
      : null
    const actorPg = pendingClarification?.targetCharacter
      ? await runtimeStore.getCharacterByName(this.tableId, pendingClarification.targetCharacter)
      : null
    const recentChat = recentPlayerMessagesSummary(svc.getSession(this.tableId)?.messages || [])
    const sections = []
    if (scene) sections.push(`SCENA FOCUS\n${renderSceneSummary(scene, { resolveEntityLabel })}`)
    if (actorPg) sections.push(`PG ATTIVO\n${await buildPgActiveContextText(this.tableId, actorPg)}`)
    if (recentChat) sections.push(`STORICO CHAT\n${recentChat}`)
    const skillsCatalog = renderSkillsCatalogSummary({ dialogueOnly: true })
    if (skillsCatalog) sections.push(`ABILITA DISPONIBILI\n${skillsCatalog}`)

    const originalDeclarationText = normalizeNarrativeText(pendingClarification?.originalDeclarationText || '')
    const clarificationText = normalizeNarrativeText(message.text)
    const declarationText = [
      originalDeclarationText ? `Dichiarazione originaria: ${originalDeclarationText}` : '',
      clarificationText ? `Chiarimento del giocatore: ${clarificationText}` : ''
    ].filter(Boolean).join('\n')

    return {
      playerName: pendingClarification?.targetCharacter || message.fromName || message.from,
      pgName: pendingClarification?.targetCharacter || message.fromName || message.from,
      declarationText,
      contextText: sections.join('\n\n') || 'Nessun contesto strutturato disponibile.'
    }
  }

  async buildNpcMasterContext(message, routingOrPending = {}) {
    const table = await getTableOrNull(this.tableId)
    const ctx = svc.getSession(this.tableId)
    const notesResources = getModuleNotesResources(table?.moduleId)
    const index = notesResources?.index || null
    const resolveEntityLabel = (value) => {
      const normalized = normalizeChatText(value)
      if (!normalized || !index) return value
      const candidate = Object.values(index.byId || {}).find(entry => normalizeChatText(entry.id) === normalized)
      if (candidate?.name) return candidate.name
      for (const type of ['npc', 'scene', 'object', 'clue']) {
        const ref = lookupEntityRefByName(index, type, value)
        if (ref?.name) return ref.name
      }
      return value
    }

    const npcTargetName = routingOrPending?.npcTarget || routingOrPending?.targetNpc || routingOrPending?.npcName || ''
    const focusSceneId = routingOrPending?.focusSceneId || null
    const scene = focusSceneId ? await runtimeStore.getScene(this.tableId, focusSceneId) : null
    const actorPg = await runtimeStore.getCharacterByPlayerId(this.tableId, message.from)
      || await runtimeStore.getCharacterByName(this.tableId, message.fromName)
    const actorName = actorPg?.name
      || actorPg?.nome
      || ctx?.session?.players?.find(player => player.email === message.from)?.characterName
      || message.fromName
      || message.from

    const npc = npcTargetName
      ? await runtimeStore.getNpc(this.tableId, lookupEntityRefByName(index, 'npc', npcTargetName)?.id || '')
      : null

    const moduleCatalog = getModuleQuestionCatalog(table?.moduleId) || {}
    const mentionedObjectNames = findMentionedNames(message.text, moduleCatalog.objectNames || []).slice(0, 2)
    const mentionedClueNames = findMentionedNames(message.text, moduleCatalog.clueNames || []).slice(0, 2)

    const loadEntityByName = async (type, value) => {
      const ref = lookupEntityRefByName(index, type, value)
      if (!ref) return null
      if (type === 'object') return runtimeStore.getObject(this.tableId, ref.id)
      if (type === 'clue') return runtimeStore.getClue(this.tableId, ref.id)
      return null
    }

    const sections = []
    if (scene) sections.push(`SCENA FOCUS\n${renderSceneSummary(scene, { resolveEntityLabel })}`)
    if (npc) {
      sections.push(`PNG ATTIVO\n${renderNpcSummary(npc, { resolveEntityLabel })}`)
      const heldClues = await loadCluesHeldByNpc(this.tableId, npc.id_png, index)
      for (const clue of heldClues) {
        sections.push(`INDIZIO IN POSSESSO DEL PNG\n${renderClueSummary(clue, { resolveEntityLabel })}`)
      }
    }
    if (actorPg) sections.push(`PG ATTIVO\n${await buildPgActiveContextText(this.tableId, actorPg)}`)
    const spatialContext = await buildNpcMasterSpatialContext(this.tableId, {
      scene,
      actorPg,
      actorName,
      npc,
      npcTargetName,
      resolveEntityLabel
    })
    if (spatialContext) sections.push(`POSIZIONI IN SCENA\n${spatialContext}`)
    const transcriptMessages = Array.isArray(ctx?.messages) ? [...ctx.messages] : []
    const currentText = normalizeNarrativeText(message.text)
    if (currentText) {
      const last = transcriptMessages[transcriptMessages.length - 1]
      if (!last || normalizeNarrativeText(last.text) !== currentText || last.from !== message.from) {
        transcriptMessages.push({
          from: message.from,
          fromName: actorName,
          text: currentText,
          type: 'normal'
        })
      }
    }
    const transcript = fullConversationTranscript(transcriptMessages, ctx?.session?.players || [])
    if (transcript) sections.push(`FINESTRA COMPLETA DELLA CONVERSAZIONE\n${transcript}`)
    const skillsCatalog = renderSkillsCatalogSummary({ dialogueOnly: true })
    if (skillsCatalog) sections.push(`ABILITA DISPONIBILI\n${skillsCatalog}`)

    for (const name of mentionedObjectNames) {
      const object = await loadEntityByName('object', name)
      if (object) sections.push(`OGGETTO CITATO\n${renderObjectSummary(object, { resolveEntityLabel })}`)
    }
    for (const name of mentionedClueNames) {
      const clue = await loadEntityByName('clue', name)
      if (clue) sections.push(`INDIZIO CITATO\n${renderClueSummary(clue, { resolveEntityLabel })}`)
    }

    return {
      npcName: npcTargetName,
      atteggiamento_verso_pg: normalizeNarrativeText(npc?.runtime?.atteggiamento_verso_pg || ''),
      playerName: actorName,
      playerUtterance: normalizeNarrativeText(message.text),
      contextText: sections.join('\n\n') || 'Nessun contesto strutturato disponibile.'
    }
  }

  async answerNpcMasterInteraction(message, routing) {
    const ctx = svc.getSession(this.tableId)
    if (!ctx) return

    try {
      const handoff = await this.buildNpcMasterContext(message, routing)
      const npc = routing?.npcTarget
        ? await runtimeStore.getNpc(this.tableId, lookupEntityRefByName(getModuleNotesResources((await getTableOrNull(this.tableId))?.moduleId)?.index, 'npc', routing.npcTarget)?.id || '')
        : null
      const result = await this.llm(getNpcConversationPromptFile(npc), handoff)
      if (!result?.response) return
      result.Skill = normalizeNarrativeText(result.Skill)
      result.Difficulty = normalizeNarrativeText(result.Difficulty)
      await this.waitForFocusSilence('npc-master-response')
      await svc.setAllPlayersState(this.tableId, 'turno-custode')
      for (const player of (ctx.session.players || [])) {
        this.io.to(this.room).emit('session:player-update', {
          email: player.email,
          playerState: 'turno-custode',
          connected: player.connected
        })
      }
      const messageKind = result.decision === 'ask_clarification' || result.decision === 'ask_for_roll'
        ? 'npc_dialogue'
        : 'npc_dialogue'
      await this.emitNarrative(result.response, {
        messageKind,
        from: 'npc-master',
        fromName: routing.npcTarget || 'PNG'
      })
      const targetPlayer = (ctx.session.players || []).find(player => player.email === message.from) || null
      if (result.decision === 'respond_now' || result.decision === 'no_action') {
        this.queueArchivistRuntimeUpdate({
          sourceAgent: 'npc-master',
          focusSceneId: routing.focusSceneId || null,
          playerEmail: message.from,
          playerName: targetPlayer?.characterName || message.fromName || message.from,
          npcName: routing.npcTarget || '',
          declarationText: normalizeNarrativeText(message.text),
          narrativeText: normalizeNarrativeText(result.response)
        })
      }

      if (result.decision === 'ask_for_roll' && targetPlayer) {
        ctx.session.pendingClarification = null
        ctx.session.pendingRoll = {
          targetCharacter: targetPlayer.characterName || '',
          targetPlayerEmail: targetPlayer.email,
          targetNpc: routing.npcTarget || '',
          skill: normalizeNarrativeText(result.Skill),
          difficulty: normalizeNarrativeText(result.Difficulty),
          declarationText: normalizeNarrativeText(message.text),
          focusSceneId: routing.focusSceneId || null,
          source: 'npc-master',
          createdAt: new Date().toISOString()
        }
        await svc.saveSession(this.tableId, ctx.session)
        this.emitSessionUpdate()
        await this.setPlayerTurn(targetPlayer.email, 'mio-turno-prova')
        return
      }

      if (result.decision === 'ask_clarification' && targetPlayer) {
        ctx.session.pendingRoll = null
        ctx.session.pendingClarification = {
          targetCharacter: targetPlayer.characterName || '',
          targetPlayerEmail: targetPlayer.email,
          targetNpc: routing.npcTarget || '',
          originalDeclarationText: normalizeNarrativeText(message.text),
          clarificationPrompt: normalizeNarrativeText(result.response),
          focusSceneId: routing.focusSceneId || null,
          source: 'npc-master',
          createdAt: new Date().toISOString()
        }
        await svc.saveSession(this.tableId, ctx.session)
        this.emitSessionUpdate()
        await this.setPlayerTurn(targetPlayer.email, 'mio-turno-libero')
        return
      }
    } finally {
      const hasPendingTurn = (ctx.session.players || []).some(player =>
        player.playerState === 'mio-turno-prova' || player.playerState === 'mio-turno-libero'
      )
      if (!hasPendingTurn) {
        await svc.setAllPlayersState(this.tableId, 'gioco-libero')
        for (const player of (ctx.session.players || [])) {
          this.io.to(this.room).emit('session:player-update', {
            email: player.email,
            playerState: 'gioco-libero',
            connected: player.connected
          })
        }
      }
    }
  }

  async answerNpcMasterClarification(message, pendingClarification) {
    const ctx = svc.getSession(this.tableId)
    if (!ctx) return

    try {
      const composedMessage = {
        ...message,
        text: [
          pendingClarification?.originalDeclarationText ? `Battuta originaria del PG: ${pendingClarification.originalDeclarationText}` : '',
          normalizeNarrativeText(message.text) ? `Chiarimento del PG: ${normalizeNarrativeText(message.text)}` : ''
        ].filter(Boolean).join('\n')
      }
      const handoff = await this.buildNpcMasterContext(composedMessage, {
        npcTarget: pendingClarification?.targetNpc || '',
        focusSceneId: pendingClarification?.focusSceneId || null
      })
      const npc = pendingClarification?.targetNpc
        ? await runtimeStore.getNpc(this.tableId, lookupEntityRefByName(getModuleNotesResources((await getTableOrNull(this.tableId))?.moduleId)?.index, 'npc', pendingClarification.targetNpc)?.id || '')
        : null
      const result = await this.llm(getNpcConversationPromptFile(npc), handoff)
      if (!result?.response) return
      result.Skill = normalizeNarrativeText(result.Skill)
      result.Difficulty = normalizeNarrativeText(result.Difficulty)
      await this.waitForFocusSilence('npc-master-clarification-response')
      await svc.setAllPlayersState(this.tableId, 'turno-custode')
      for (const player of (ctx.session.players || [])) {
        this.io.to(this.room).emit('session:player-update', {
          email: player.email,
          playerState: 'turno-custode',
          connected: player.connected
        })
      }
      await this.emitNarrative(result.response, {
        messageKind: 'npc_dialogue',
        from: 'npc-master',
        fromName: pendingClarification?.targetNpc || 'PNG'
      })
      if (result.decision === 'respond_now' || result.decision === 'no_action') {
        this.queueArchivistRuntimeUpdate({
          sourceAgent: 'npc-master',
          focusSceneId: pendingClarification?.focusSceneId || null,
          playerEmail: pendingClarification?.targetPlayerEmail || message.from,
          playerName: pendingClarification?.targetCharacter || message.fromName || message.from,
          npcName: pendingClarification?.targetNpc || '',
          declarationText: normalizeNarrativeText(pendingClarification?.originalDeclarationText || message.text),
          narrativeText: normalizeNarrativeText(result.response)
        })
      }

      const targetPlayer = (ctx.session.players || []).find(player => player.email === pendingClarification?.targetPlayerEmail) || null
      if (result.decision === 'ask_for_roll' && targetPlayer) {
        ctx.session.pendingClarification = null
        ctx.session.pendingRoll = {
          targetCharacter: targetPlayer.characterName || pendingClarification?.targetCharacter || '',
          targetPlayerEmail: targetPlayer.email,
          targetNpc: pendingClarification?.targetNpc || '',
          skill: normalizeNarrativeText(result.Skill),
          difficulty: normalizeNarrativeText(result.Difficulty),
          declarationText: normalizeNarrativeText(pendingClarification?.originalDeclarationText || ''),
          focusSceneId: pendingClarification?.focusSceneId || null,
          source: 'npc-master',
          createdAt: new Date().toISOString()
        }
        await svc.saveSession(this.tableId, ctx.session)
        this.emitSessionUpdate()
        await this.setPlayerTurn(targetPlayer.email, 'mio-turno-prova')
        return
      }
      if (result.decision === 'ask_clarification' && targetPlayer) {
        ctx.session.pendingRoll = null
        ctx.session.pendingClarification = {
          ...(pendingClarification || {}),
          targetCharacter: targetPlayer.characterName || pendingClarification?.targetCharacter || '',
          targetPlayerEmail: targetPlayer.email,
          clarificationPrompt: normalizeNarrativeText(result.response),
          createdAt: new Date().toISOString()
        }
        await svc.saveSession(this.tableId, ctx.session)
        this.emitSessionUpdate()
        await this.setPlayerTurn(targetPlayer.email, 'mio-turno-libero')
        return
      }

      ctx.session.pendingClarification = null
      ctx.session.pendingRoll = null
      await svc.saveSession(this.tableId, ctx.session)
      this.emitSessionUpdate()
    } finally {
      const hasPendingTurn = (ctx.session.players || []).some(player =>
        player.playerState === 'mio-turno-prova' || player.playerState === 'mio-turno-libero'
      )
      if (!hasPendingTurn) {
        await svc.setAllPlayersState(this.tableId, 'gioco-libero')
        for (const player of (ctx.session.players || [])) {
          this.io.to(this.room).emit('session:player-update', {
            email: player.email,
            playerState: 'gioco-libero',
            connected: player.connected
          })
        }
      }
    }
  }

  async answerSceneMasterClarification(message, pendingClarification) {
    const ctx = svc.getSession(this.tableId)
    if (!ctx) return

    try {
      const handoff = await this.buildSceneMasterClarificationContext(message, pendingClarification)
      const result = await this.llm('scene_master_v0_dichiarazione.md', handoff)
      if (!result?.response) return
      result.Skill = normalizeNarrativeText(result.Skill)
      result.Difficulty = normalizeNarrativeText(result.Difficulty)
      await this.waitForFocusSilence('scene-master-clarification-response')
      await svc.setAllPlayersState(this.tableId, 'turno-custode')
      for (const player of (ctx.session.players || [])) {
        this.io.to(this.room).emit('session:player-update', {
          email: player.email,
          playerState: 'turno-custode',
          connected: player.connected
        })
      }
      const messageKind = result.decision === 'ask_clarification' || result.decision === 'ask_for_roll'
        ? 'question'
        : null
      await this.emitNarrative(result.response, { messageKind })

      const targetPlayer = (ctx.session.players || []).find(player => player.email === pendingClarification?.targetPlayerEmail) || null

      if (result.decision === 'ask_for_roll' && targetPlayer) {
        ctx.session.pendingClarification = null
        ctx.session.pendingRoll = {
          targetCharacter: targetPlayer.characterName || pendingClarification?.targetCharacter || '',
          targetPlayerEmail: targetPlayer.email,
          skill: normalizeNarrativeText(result.Skill),
          difficulty: normalizeNarrativeText(result.Difficulty),
          declarationText: normalizeNarrativeText(pendingClarification?.originalDeclarationText || ''),
          focusSceneId: pendingClarification?.focusSceneId || null,
          source: 'scene-master',
          createdAt: new Date().toISOString()
        }
        await svc.saveSession(this.tableId, ctx.session)
        this.emitSessionUpdate()
        await this.setPlayerTurn(targetPlayer.email, 'mio-turno-prova')
        return
      }

      if (result.decision === 'ask_clarification' && targetPlayer) {
        ctx.session.pendingRoll = null
        ctx.session.pendingClarification = {
          ...(pendingClarification || {}),
          targetCharacter: targetPlayer.characterName || pendingClarification?.targetCharacter || '',
          targetPlayerEmail: targetPlayer.email,
          clarificationPrompt: normalizeNarrativeText(result.response),
          createdAt: new Date().toISOString()
        }
        await svc.saveSession(this.tableId, ctx.session)
        this.emitSessionUpdate()
        await this.setPlayerTurn(targetPlayer.email, 'mio-turno-libero')
        return
      }

      ctx.session.pendingClarification = null
      ctx.session.pendingRoll = null
      await svc.saveSession(this.tableId, ctx.session)
      this.emitSessionUpdate()
    } finally {
      const hasPendingTurn = (ctx.session.players || []).some(player =>
        player.playerState === 'mio-turno-prova' || player.playerState === 'mio-turno-libero'
      )
      if (!hasPendingTurn) {
        await svc.setAllPlayersState(this.tableId, 'gioco-libero')
        for (const player of (ctx.session.players || [])) {
          this.io.to(this.room).emit('session:player-update', {
            email: player.email,
            playerState: 'gioco-libero',
            connected: player.connected
          })
        }
      }
    }
  }

  async narrateSceneMasterRollOutcome(pendingRoll, rollResult) {
    const table = await getTableOrNull(this.tableId)
    const notesResources = getModuleNotesResources(table?.moduleId)
    const index = notesResources?.index || null
    const resolveEntityLabel = (value) => {
      const normalized = normalizeChatText(value)
      if (!normalized || !index) return value
      const candidate = Object.values(index.byId || {}).find(entry => normalizeChatText(entry.id) === normalized)
      if (candidate?.name) return candidate.name
      return value
    }
    const scene = pendingRoll?.focusSceneId
      ? await runtimeStore.getScene(this.tableId, pendingRoll.focusSceneId)
      : (await getWorldState(this.tableId)).focusScene
        ? await runtimeStore.getScene(this.tableId, (await getWorldState(this.tableId)).focusScene)
        : null
    const actorPg = pendingRoll?.targetCharacter
      ? await runtimeStore.getCharacterByName(this.tableId, pendingRoll.targetCharacter)
      : null
    const sections = []
    if (scene) sections.push(`SCENA FOCUS\n${renderSceneSummary(scene, { resolveEntityLabel })}`)
    if (actorPg) sections.push(`PG ATTIVO\n${await buildPgActiveContextText(this.tableId, actorPg)}`)
    const contextText = sections.join('\n\n') || 'Nessun contesto strutturato disponibile.'
    const outcomePromptFile = rollResult.esito === 'successo'
      ? 'scene_master_v0_esito_prova_successo.md'
      : 'scene_master_v0_esito_prova_fallimento.md'
    const response = await this.llmText(outcomePromptFile, {
      playerName: pendingRoll?.targetCharacter || '',
      pgName: pendingRoll?.targetCharacter || '',
      declarationText: pendingRoll?.declarationText || '',
      skill: pendingRoll?.skill || '',
      difficulty: pendingRoll?.difficulty || '',
      rollValue: String(rollResult.valore),
      contextText
    })
    await this.waitForFocusSilence('scene-master-roll-outcome')
    await svc.setAllPlayersState(this.tableId, 'turno-custode')
    for (const player of ((svc.getSession(this.tableId)?.session?.players) || [])) {
      this.io.to(this.room).emit('session:player-update', {
        email: player.email,
        playerState: 'turno-custode',
        connected: player.connected
      })
    }
    await this.emitNarrative(response)
    this.queueArchivistRuntimeUpdate({
      sourceAgent: 'scene-master',
      focusSceneId: pendingRoll?.focusSceneId || null,
      playerEmail: pendingRoll?.targetPlayerEmail || null,
      playerName: pendingRoll?.targetCharacter || '',
      declarationText: normalizeNarrativeText(pendingRoll?.declarationText || ''),
      narrativeText: normalizeNarrativeText(response)
    })
    const ctx = svc.getSession(this.tableId)
    if (ctx) {
      ctx.session.pendingRoll = null
      await svc.saveSession(this.tableId, ctx.session)
      this.emitSessionUpdate()
    }
    const worldState = await getWorldState(this.tableId)
    await this.setGroupState(worldState.focusScene, worldState, 'gioco-libero')
  }

  async narrateNpcMasterRollOutcome(pendingRoll, rollResult) {
    const table = await getTableOrNull(this.tableId)
    const notesResources = getModuleNotesResources(table?.moduleId)
    const index = notesResources?.index || null
    const resolveEntityLabel = (value) => {
      const normalized = normalizeChatText(value)
      if (!normalized || !index) return value
      const candidate = Object.values(index.byId || {}).find(entry => normalizeChatText(entry.id) === normalized)
      if (candidate?.name) return candidate.name
      for (const type of ['npc', 'scene', 'object', 'clue']) {
        const ref = lookupEntityRefByName(index, type, value)
        if (ref?.name) return ref.name
      }
      return value
    }

    const scene = pendingRoll?.focusSceneId
      ? await runtimeStore.getScene(this.tableId, pendingRoll.focusSceneId)
      : (await getWorldState(this.tableId)).focusScene
        ? await runtimeStore.getScene(this.tableId, (await getWorldState(this.tableId)).focusScene)
        : null
    const actorPg = pendingRoll?.targetCharacter
      ? await runtimeStore.getCharacterByName(this.tableId, pendingRoll.targetCharacter)
      : null
    const npc = pendingRoll?.targetNpc
      ? await runtimeStore.getNpc(this.tableId, lookupEntityRefByName(index, 'npc', pendingRoll.targetNpc)?.id || '')
      : null
    const sections = []
    if (scene) sections.push(`SCENA FOCUS\n${renderSceneSummary(scene, { resolveEntityLabel })}`)
    if (npc) sections.push(`PNG ATTIVO\n${renderNpcSummary(npc, { resolveEntityLabel })}`)
    if (actorPg) sections.push(`PG ATTIVO\n${renderPgSummary(actorPg)}`)
    const npcCtx = svc.getSession(this.tableId)
    const transcript = fullConversationTranscript(npcCtx?.messages || [], npcCtx?.session?.players || [])
    if (transcript) sections.push(`FINESTRA COMPLETA DELLA CONVERSAZIONE\n${transcript}`)
    const contextText = sections.join('\n\n') || 'Nessun contesto strutturato disponibile.'
    const outcomePromptFile = rollResult.esito === 'successo'
      ? 'npc_master_v0_esito_prova_successo.md'
      : 'npc_master_v0_esito_prova_fallimento.md'
    const response = await this.llmText(outcomePromptFile, {
      npcName: pendingRoll?.targetNpc || '',
      playerName: pendingRoll?.targetCharacter || '',
      declarationText: pendingRoll?.declarationText || '',
      skill: pendingRoll?.skill || '',
      contextText
    })
    await this.waitForFocusSilence('npc-master-roll-outcome')
    await svc.setAllPlayersState(this.tableId, 'turno-custode')
    for (const player of ((svc.getSession(this.tableId)?.session?.players) || [])) {
      this.io.to(this.room).emit('session:player-update', {
        email: player.email,
        playerState: 'turno-custode',
        connected: player.connected
      })
    }
    await this.emitNarrative(response, {
      messageKind: 'npc_dialogue',
      from: 'npc-master',
      fromName: pendingRoll?.targetNpc || 'PNG'
    })
    this.queueArchivistRuntimeUpdate({
      sourceAgent: 'npc-master',
      focusSceneId: pendingRoll?.focusSceneId || null,
      playerEmail: pendingRoll?.targetPlayerEmail || null,
      playerName: pendingRoll?.targetCharacter || '',
      npcName: pendingRoll?.targetNpc || '',
      declarationText: normalizeNarrativeText(pendingRoll?.declarationText || ''),
      narrativeText: normalizeNarrativeText(response)
    })
    const ctx = svc.getSession(this.tableId)
    if (ctx) {
      ctx.session.pendingRoll = null
      await svc.saveSession(this.tableId, ctx.session)
      this.emitSessionUpdate()
      await svc.setAllPlayersState(this.tableId, 'gioco-libero')
      for (const player of (ctx.session.players || [])) {
        this.io.to(this.room).emit('session:player-update', {
          email: player.email,
          playerState: 'gioco-libero',
          connected: player.connected
        })
      }
    }
  }

  async pauseForTechnicalIssue(message) {
    svc.pauseAllTimers(this.tableId)
    await svc.updateSessionState(this.tableId, 'technical-pause')
    this.io.to(this.room).emit('session:status-update', { state: 'technical-pause' })
    await this.emitError(message)
    this.paused = true
  }

  abortIfPaused() {
    return this.paused
  }

  // ── Contesto comune ───────────────────────────────────────────────────────

  async buildContext() {
    const [table, worldState, diary, chars] = await Promise.all([
      getTableOrNull(this.tableId),
      getWorldState(this.tableId),
      getDiary(this.tableId),
      getCharacters(this.tableId)
    ])
    if (!table) {
      throw Object.assign(new Error(`Tavolo ${this.tableId} non trovato`), { isTableMissing: true })
    }
    const mod = await getModule(table.moduleId)
    const schede_PG = chars.map(synthChar).join('\n')
    const pgLookup = buildPgLookup(chars)
    const { normalized: normalizedStatoPgs, changed: statoPgsChanged } = normalizeStatoPgsMap(worldState.stato_pgs, pgLookup)
    if (statoPgsChanged) {
      worldState.stato_pgs = normalizedStatoPgs
      await saveWorldState(this.tableId, worldState)
    } else {
      worldState.stato_pgs = normalizedStatoPgs
    }
    const focusScene = worldState.focusScene
      ? await getScene(this.tableId, worldState.focusScene)
      : null

    return { table, worldState, diary, chars, mod, schede_PG, pgLookup, focusScene }
  }

  // ── FASE 1: Apertura ──────────────────────────────────────────────────────

  async fase1() {
    const { table, worldState, diary, chars, mod, schede_PG, focusScene } = await this.buildContext()
    const sessionNumber = svc.getSession(this.tableId)?.session?.sessionNumber ?? 1
    const isFirstSession = sessionNumber === 1

    if (isFirstSession) {
      await this.emitPhaseChange('fase-1a')
      await this.emitThinking('fase-1a')
      let result
      const cachePath = fase1aCachePath(this.tableId)
      if (await fileExists(cachePath)) {
        console.log(`[Custode] fase1a: uso cache pre-generata per ${this.tableId}`)
        result = await readJSON(cachePath)
      } else {
        console.log(`[Custode] fase1a: cache assente, chiamo LLM per ${this.tableId}`)
        result = await this.llm('fase1a_prima_sessione.md', { schede_PG })
      }
      if (this.abortIfPaused()) return null
      await this.emitNarrative(result.narrativa)
      if (result.diary) await appendDiary(this.tableId, result.diary, sessionNumber, mod.title)

      // Salva la data di inizio avventura (ISO) se fornita dal LLM
      if (result.data_inizio_avventura) {
        const parsed = parseItalianDate(result.data_inizio_avventura)
        worldState.data_inizio_avventura = parsed?.toISOString() || ''
      }

      // Inizializza world_state: tutti i PG in un unico gruppo
      worldState.groups = [{
        groupId: 'group01',
        sceneId: null,
        participants: chars.map(c => c.playerID),
        subLocation: null,
        activity: null
      }]
      // Inizializza stato_pgs come struttura vuota: sarà popolato da fase2
      worldState.stato_pgs = Object.fromEntries(
        chars.map(c => [c.name, { stato: '' }])
      )
      await saveWorldState(this.tableId, worldState)
    } else {
      await this.emitPhaseChange('fase-1b')
      await this.emitThinking('fase-1b')
      const vars = {
        diary: diary || '(nessun diario disponibile)',
        schede_PG,
        momento_corrente: sceneMomentoTesto(focusScene),
        progressione: focusScene?.progressione || '(nessuna progressione)',
        stato_pgs: formatStatoPgs(worldState.stato_pgs),
        stato_pngs: formatStatoNpcs(worldState.npcs, focusScene?.id_scena)
      }
      const result = await this.llm('fase1b_sessioni_successive.md', vars)
      if (this.abortIfPaused()) return null
      await this.emitNarrative(result.narrativa)
    }

    // Prossima fase
    const hasActiveScene = worldState.focusScene && await getScene(this.tableId, worldState.focusScene)

    return hasActiveScene ? 'fase-3' : 'fase-2'
  }

  // ── FASE 2: Opening New Scene ─────────────────────────────────────────────

  async fase2(suggerimento = null) {
    await this.emitPhaseChange('fase-2')
    const { worldState, mod, schede_PG, pgLookup } = await this.buildContext()
    const sessionNumber = svc.getSession(this.tableId)?.session?.sessionNumber ?? 1
    const suggerimento_scena = suggerimento || 'scena introduttiva'

    await this.emitThinking('fase-2')

    // Determina il momento corrente per la nuova scena:
    // se una scena precedente era in focus usa il suo tempo, altrimenti nessuno
    const prevScene = worldState.focusScene
      ? await getScene(this.tableId, worldState.focusScene)
      : null
    const prevMomento = prevScene?.momento_corrente || null

    // momento_corrente iniziale: scena precedente > data inizio avventura > LLM lo inventa
    const inizioISO = prevMomento || worldState.data_inizio_avventura || null
    const result = await this.llm('fase2_opening_new_scene.md', {
      suggerimento_scena,
      schede_PG,
      stato_pgs: formatStatoPgs(worldState.stato_pgs),
      conoscenze_party: worldState.conoscenze_party || '(nessuna conoscenza acquisita)',
      momento_corrente: inizioISO ? formatItalianDate(new Date(inizioISO)) : ''
    })
    if (this.abortIfPaused()) return null

    result.PNG = normalizeSceneListOutput(result.PNG)
    result.opportunita = normalizeSceneListOutput(result.opportunita)
    result.minacce = normalizeSceneListOutput(result.minacce)
    result.indizi = normalizeSceneListOutput(result.indizi)

    // Inizializza momento_corrente della scena
    const parsedMomento = inizioISO
      ? new Date(inizioISO)
      : parseItalianDate(result.contesto_quando)
    result.momento_corrente = parsedMomento?.toISOString() || ''
    delete result.contesto_quando  // sostituito da momento_corrente

    // Assegna ID progressivo e inizializza progressione
    result.id_scena = await nextSceneId(this.tableId)
    result.progressione = ''
    result.sessionNumber = sessionNumber

    // Salva scena runtime nella directory scenes/
    await saveScene(this.tableId, result)

    // Stato PG iniziale per questa scena (generato dalla LLM)
    mergeStatoPgs(worldState.stato_pgs, result.stato_pgs, pgLookup)

    // PNG della scena: posizione e stato generati dalla LLM.
    // Nota: essere "in scena" NON significa essere noti al party — la conoscenza si acquisisce
    // solo durante il gioco (presentazione in ruolo, dialogo, ecc.).
    if (result.stato_pngs && typeof result.stato_pngs === 'object') {
      for (const [nome, s] of Object.entries(result.stato_pngs)) {
        const existing = worldState.npcs.find(n => n.name === nome)
        if (existing) {
          existing.scena_id = result.id_scena
          if (s?.stato) existing.stato = s.stato
        } else {
          worldState.npcs.push({
            name: nome,
            scena_id: result.id_scena,
            stato: s?.stato || 'presente in scena, non ancora incontrato dal party'
          })
        }
      }
    } else if (result.PNG?.length) {
      // Fallback: se la LLM non ha restituito stato_pngs, aggiungi i PNG con stato generico
      result.PNG.forEach(nome => {
        if (!worldState.npcs.find(n => n.name === nome)) {
          worldState.npcs.push({
            name: nome,
            scena_id: result.id_scena,
            posizione: result.contesto_dove || '',
            stato: 'presente in scena, non ancora incontrato dal party'
          })
        }
      })
    }

    // Aggiorna world_state: sceneId del gruppo in focus
    const focusGroup = worldState.groups.find(g => g.groupId === (worldState.focusGroupId || 'group01'))
    if (focusGroup) focusGroup.sceneId = result.id_scena

    // focusScene: diventa la nuova scena solo se è l'unica scena attiva,
    // altrimenti "tbd" (custode deve scegliere il prossimo focus)
    const activeScenes = (await runtimeStore.listScenes(this.tableId))
      .filter(scene => scene?.runtime?.stato !== 'completata' && scene?.runtime?.stato !== 'abbandonata')
    worldState.focusScene = activeScenes.length === 1 ? result.id_scena : 'tbd'

    await saveWorldState(this.tableId, worldState)

    return { next: 'fase-3' }
  }

  // ── FASE 3: Scene Orchestrator ────────────────────────────────────────────

  async fase3() {
    const { worldState, pgLookup } = await this.buildContext()
    const ctx = svc.getSession(this.tableId)
    const engagement = engagementForLlm(ctx?.session?.engagement || {}, pgLookup)

    // ── 3a (opzionale): scelta focus scena ──
    const activeScenes = (await runtimeStore.listScenes(this.tableId))
      .filter(scene => scene?.runtime?.stato !== 'completata' && scene?.runtime?.stato !== 'abbandonata')
    const needsFocusChoice = worldState.focusScene === 'tbd' || activeScenes.length > 1

    if (needsFocusChoice) {
      await this.emitPhaseChange('fase-3')
      await this.emitThinking('fase-3')
      const narrativeGroups = await buildNarrativeGroups(this.tableId, worldState, pgLookup)
      const result3a = await this.llm('fase3_scene_orchestrator.md', {
        narrative_groups: narrativeGroups,
        engagement: JSON.stringify(engagement),
        scene_attive: JSON.stringify(activeScenes)
      }, true)  // light LLM
      if (this.abortIfPaused()) return null

      worldState.focusScene = result3a.focus_scene
      await saveWorldState(this.tableId, worldState)
    }

    return { next: 'fase-4a' }
  }

  // ── FASE 4a: Scene Opening (solo per nuove scene) ─────────────────────────

  async fase4aSceneOpening() {
    await this.emitPhaseChange('fase-4a')
    await this.emitThinking('fase-4a')
    const { worldState, schede_PG, pgLookup, diary } = await this.buildContext()
    const focusScene = await getScene(this.tableId, worldState.focusScene)
    if (!focusScene) return null

    const result = await this.llm('fase4a_scene_opening.md', {
      schede_PG,
      diary: diary || '(nessun diario disponibile)',
      stato_pgs: formatStatoPgs(worldState.stato_pgs),
      stato_pngs: formatStatoNpcs(worldState.npcs, focusScene?.id_scena),
      conoscenze_party: worldState.conoscenze_party || '(nessuna conoscenza acquisita)',
      momento_corrente: sceneMomentoTesto(focusScene),
      PNG: focusScene?.PNG || '',
      opportunita: focusScene?.opportunita || '',
      minacce: focusScene?.minacce || '',
      indizi: focusScene?.indizi || '',
      contesto_dove: focusScene?.contesto_dove || ''
    })
    if (this.abortIfPaused()) return null

    await this.emitNarrative(result.narrativa)

    for (const s of result.sussurri || []) {
      const targetEmail = pgLookup.toEmail[s.target?.toLowerCase()] || s.target
      await this.emitNarrative(s.testo, { whisper: true, to: targetEmail, type: 'whisper' })
    }

    focusScene.openingNarratedAt = new Date().toISOString()
    await saveScene(this.tableId, focusScene)

    // Imposta tutti i PG del gruppo in focus a gioco-libero
    await this.setGroupState(worldState.focusScene, worldState, 'gioco-libero')

    // Avvia timer proattività
    svc.setTimer(this.tableId, 'proattivita', PROACTIVITY_TIMER_MS, async () => {
      if (!this.paused) await this.runLoop('fase-4b')
    })

    // Avvia raccolta buffer
    this.startBuffer()

    return null  // attende messaggi
  }

  // ── FASE 4b: Analisi Dichiarazioni ────────────────────────────────────────

  async fase4(pianoParziale = null) {
    await this.emitPhaseChange('fase-4b')
    svc.clearTimer(this.tableId, 'proattivita')
    svc.clearTimer(this.tableId, 'silenzio')
    await svc.setAllPlayersState(this.tableId, 'turno-custode')
    const ctx4 = svc.getSession(this.tableId)
    ctx4?.session.players.forEach(p => {
      this.io.to(`table:${this.tableId}`).emit('session:player-update', {
        email: p.email, connected: p.connected, playerState: 'turno-custode'
      })
    })
    await this.emitThinking('fase-4b')

    // Round fresco: azzera il piano residuo da round precedenti
    if (!pianoParziale) {
      const ctx = svc.getSession(this.tableId)
      if (ctx) {
        ctx.session.pianoAzione = null
        await svc.saveSession(this.tableId, ctx.session)
      }
    }

    const msgs = this.buffer.map(m => `[${m.tag || '?'}] ${m.fromName || m.from}: ${m.text}`).join('\n')
    const { worldState, schede_PG, pgLookup, diary } = await this.buildContext()
    const focusScene = await getScene(this.tableId, worldState.focusScene)

    const result = await this.llm('fase4b_analisi_dichiarazioni.md', {
      schede_PG,
      messaggi_buffer: msgs,
      piano_azione: pianoParziale ? JSON.stringify(pianoParziale) : 'nessuno',
      diary: diary || '(nessun diario disponibile)',
      contesto_dove: focusScene?.contesto_dove || '',
      momento_corrente: sceneMomentoTesto(focusScene),
      PNG: focusScene?.PNG || '',
      opportunita: focusScene?.opportunita || '',
      minacce: focusScene?.minacce || '',
      indizi: focusScene?.indizi || '',
      progressione: focusScene?.progressione || '(nessuna progressione ancora)',
      stato_pgs: formatStatoPgs(worldState.stato_pgs),
      stato_pngs: formatStatoNpcs(worldState.npcs, focusScene?.id_scena),
      conoscenze_party: worldState.conoscenze_party || '(nessuna conoscenza acquisita)'
    })
    if (this.abortIfPaused()) return null

    // result è l'array piano — conversione nomi → email
    const pianoRaw = Array.isArray(result) ? result : (result.piano || [])
    const piano = pianoToEmails(pianoRaw, pgLookup)
    console.log(`[Custode] Piano azione [${this.tableId}] raw=${debugString(pianoRaw)}`)
    console.log(`[Custode] Piano azione [${this.tableId}] normalized=${debugString(piano)}`)

    // Salva piano in sessione
    const ctx = svc.getSession(this.tableId)
    if (ctx) {
      ctx.session.pianoAzione = piano
      await svc.saveSession(this.tableId, ctx.session)
    }

    // Controlla completezza
    const isCompleto = piano.every(e =>
      e.stato === 'dichiarazione' ||
      e.stato === 'domanda' ||
      (e.stato === 'prova' && e.risultato_prova != null)
    )

    if (isCompleto) {
      this.buffer = []
      return { next: 'fase-5', piano }
    }

    // Trova prossima entry pendente per priorità
    const pending = piano
      .filter(e => e.stato === 'incompleta' || e.stato === 'assente' ||
                   (e.stato === 'prova' && e.risultato_prova == null))[0]

    if (!pending) {
      console.warn(`[Custode] Nessuna entry pendente trovata nonostante il piano risulti incompleto [${this.tableId}] piano=${debugString(piano)}`)
      this.buffer = []
      return { next: 'fase-4a' }
    }

    if (!pending.pg) {
      console.warn(`[Custode] Entry pendente senza pg_target [${this.tableId}] entry=${debugString(pending)} piano=${debugString(piano)}`)
      this.buffer = []
      return { next: 'fase-4a' }
    }

    // Costruisce l'entry con pg già convertito in nome per le sottofasi
    const entryPerLlm = (e, lookup) => ({ ...e, pg: lookup.toName[e.pg] || e.pg })

    if (pending.stato === 'incompleta')
      return { next: 'sottofase-4b-chiarimenti', data: { pg_target: pending.pg, dichiarazione: pending.azione || '', scena_focus_ID: focusScene?.id_scena || '' } }
    if (pending.stato === 'assente')
      return { next: 'sottofase-4b-dichiarazione-assente', data: { pg_target: pending.pg, richiesta_dichiarazione: entryPerLlm(pending, pgLookup) } }
    if (pending.stato === 'prova')
      return { next: 'sottofase-4b-necessita-prova', data: { pg_target: pending.pg, dichiarazione_con_richiesta_prova: {
        azione: pending.azione || '',
        abilita_o_caratteristica: pending.abilita_o_caratteristica || '',
        difficolta: pending.difficolta || ''
      }, scena_focus_ID: focusScene?.id_scena || '' } }
  }

  async fase4bSubChiarimenti(data) {
    await this.emitPhaseChange('sottofase-4b-chiarimenti')
    await this.emitThinking('sottofase-4b-chiarimenti')
    const { worldState, pgLookup, schede_PG } = await this.buildContext()
    const focusScene = await getScene(this.tableId, worldState.focusScene)
    if (!data?.pg_target) {
      console.warn(`[Custode] sottofase-4b-chiarimenti senza pg_target [${this.tableId}] data=${debugString(data)}`)
      return { next: 'fase-4a' }
    }
    const pgNome = pgLookup.toName[data.pg_target] || data.pg_target
    const result = await this.llm('fase4b_sub_chiarimenti.md', {
      pg_target: pgNome,
      schede_PG,
      dichiarazione: data.dichiarazione || '',
      stato_pgs: formatStatoPgs(worldState.stato_pgs),
      contesto_dove: focusScene?.contesto_dove || '',
      progressione: focusScene?.progressione || '(nessuna progressione ancora)'
    })
    if (this.abortIfPaused()) return null
    await this.emitNarrative(result.narrativa)
    const assigned = await this.setPlayerTurn(data.pg_target, 'mio-turno-libero')
    if (!assigned) {
      await this.setGroupState(worldState.focusScene, worldState, 'gioco-libero')
    }
    return null
  }

  async fase4bSubDichiarazioneAssente(data) {
    await this.emitPhaseChange('sottofase-4b-dichiarazione-assente')
    await this.emitThinking('sottofase-4b-dichiarazione-assente')
    const { worldState, pgLookup } = await this.buildContext()
    const focusScene = await getScene(this.tableId, worldState.focusScene)
    if (!data?.pg_target) {
      console.warn(`[Custode] sottofase-4b-dichiarazione-assente senza pg_target [${this.tableId}] data=${debugString(data)}`)
      return { next: 'fase-4a' }
    }
    const pgNome = pgLookup.toName[data.pg_target] || data.pg_target
    const result = await this.llm('fase4b_sub_dichiarazione_assente.md', {
      pg_target: pgNome,
      richiesta_dichiarazione: JSON.stringify(data.richiesta_dichiarazione),
      stato_pgs: formatStatoPgs(worldState.stato_pgs),
      contesto_dove: focusScene?.contesto_dove || '',
      progressione: focusScene?.progressione || '(nessuna progressione ancora)'
    })
    if (this.abortIfPaused()) return null
    await this.emitNarrative(result.narrativa)
    const assigned = await this.setPlayerTurn(data.pg_target, 'mio-turno-libero')
    if (!assigned) {
      await this.setGroupState(worldState.focusScene, worldState, 'gioco-libero')
    }
    return null
  }

  async fase4bSubNecessitaProva(data) {
    await this.emitPhaseChange('sottofase-4b-necessita-prova')
    await this.emitThinking('sottofase-4b-necessita-prova')
    const { worldState, pgLookup, schede_PG } = await this.buildContext()
    const focusScene = await getScene(this.tableId, worldState.focusScene)
    if (!data?.pg_target) {
      console.warn(`[Custode] sottofase-4b-necessita-prova senza pg_target [${this.tableId}] data=${debugString(data)}`)
      return { next: 'fase-4a' }
    }
    const pgNome = pgLookup.toName[data.pg_target] || data.pg_target
    const result = await this.llm('fase4b_sub_necessita_prova.md', {
      pg_target: pgNome,
      schede_PG,
      dichiarazione_con_richiesta_prova: JSON.stringify(data.dichiarazione_con_richiesta_prova),
      stato_pgs: formatStatoPgs(worldState.stato_pgs),
      contesto_dove: focusScene?.contesto_dove || '',
      progressione: focusScene?.progressione || '(nessuna progressione ancora)'
    })
    if (this.abortIfPaused()) return null
    await this.emitNarrative(result.narrativa)
    const assigned = await this.setPlayerTurn(data.pg_target, 'mio-turno-prova')
    if (!assigned) {
      await this.setGroupState(worldState.focusScene, worldState, 'gioco-libero')
    }
    return null
  }

  // ── FASE 5: Risoluzione Stato Scena ───────────────────────────────────────

  async fase5(piano) {
    await this.emitPhaseChange('fase-5')
    await this.emitThinking('fase-5')
    const { worldState, schede_PG, mod, pgLookup, diary } = await this.buildContext()
    const sessionNumber = svc.getSession(this.tableId)?.session?.sessionNumber ?? 1
    const focusScene = await getScene(this.tableId, worldState.focusScene)

    const result = await this.llm('fase5_risoluzione.md', {
      piano_azione: JSON.stringify(piano),
      diary: diary || '(nessun diario disponibile)',
      contesto_dove: focusScene?.contesto_dove || '',
      momento_corrente: sceneMomentoTesto(focusScene),
      PNG: focusScene?.PNG || '',
      opportunita: focusScene?.opportunita || '',
      minacce: focusScene?.minacce || '',
      indizi: focusScene?.indizi || '',
      progressione: focusScene?.progressione || '(nessuna progressione ancora)',
      stato_pgs: formatStatoPgs(worldState.stato_pgs),
      stato_pngs: formatStatoNpcs(worldState.npcs, focusScene?.id_scena),
      conoscenze_party: worldState.conoscenze_party || '(nessuna conoscenza acquisita)',
      schede_PG
    })
    if (this.abortIfPaused()) return null

    // ── Narrativa per i giocatori ─────────────────────────────────────────────
    await this.emitNarrative(result.narrativa)
    for (const s of result.sussurri || []) {
      const targetEmail = pgLookup.toEmail[s.target?.toLowerCase()] || s.target
      await this.emitNarrative(s.testo, { whisper: true, to: targetEmail, type: 'whisper' })
    }

    // ── Aggiorna engagement ───────────────────────────────────────────────────
    const ctx = svc.getSession(this.tableId)
    if (ctx) {
      if (!ctx.session.engagement) ctx.session.engagement = {}
      for (const azione of piano || []) {
        if (azione.pg) ctx.session.engagement[azione.pg] = (ctx.session.engagement[azione.pg] || 0) + 1
      }
      await svc.saveSession(this.tableId, ctx.session)
    }

    const agg = result.aggiornamenti || {}

    // ── Aggiorna progressione scena (append) e tempo ──────────────────────────
    if (result.narrativa && focusScene) {
      const prev = focusScene.progressione || ''
      focusScene.progressione = prev ? `${prev}\n\n${result.narrativa}` : result.narrativa
      const minutiFloat = normalizeDurationOutput(result.durata)
      advanceSceneTime(focusScene, minutiFloat)
      await saveScene(this.tableId, focusScene)
    }

    // ── Aggiorna world state ──────────────────────────────────────────────────
    const ws = await getWorldState(this.tableId)

    // stato_pgs
    mergeStatoPgs(ws.stato_pgs, agg.stato_pgs, pgLookup)

    if (agg.nuove_conoscenze && typeof agg.nuove_conoscenze === 'string' && agg.nuove_conoscenze.trim()) {
      await runtimeStore.appendPartyKnowledgeEntry(this.tableId, {
        scena: ws.focusScene || null,
        text: agg.nuove_conoscenze.trim()
      })
    }

    // npcs
    if (agg.npcs?.length) {
      agg.npcs.forEach(n => {
        const existing = ws.npcs.find(x => x.name === n.name)
        if (existing) Object.assign(existing, n)
        else ws.npcs.push(n)
      })
    }

    await saveWorldState(this.tableId, ws)

    // ── Diario ────────────────────────────────────────────────────────────────
    if (agg.diary) await appendDiary(this.tableId, agg.diary, sessionNumber, mod.title)

    // ── Aggiorna diario in UI ─────────────────────────────────────────────────
    if (agg.diary) this.io.to(this.room).emit('session:diary', await getDiary(this.tableId))

    if (result.divisione_gruppi) return { next: 'fase-5a' }
    if (result.ricongiungimento_gruppi) return { next: 'fase-5b' }
    if (result.chiusura_scena) return { next: 'fase-5c' }

    // Torna ad attendere dichiarazioni (niente più fase-4a intermedia)
    await this.setGroupState(worldState.focusScene, worldState, 'gioco-libero')
    svc.setTimer(this.tableId, 'proattivita', PROACTIVITY_TIMER_MS, async () => {
      if (!this.paused) await this.runLoop('fase-4b')
    })
    this.startBuffer()
    return null  // attende messaggi
  }

  async fase5a(data) {
    await this.emitPhaseChange('fase-5a')
    await this.emitThinking('fase-5a')
    const { worldState, pgLookup } = await this.buildContext()
    const focusScene = await getScene(this.tableId, worldState.focusScene)
    const recentMsgs = svc.getSession(this.tableId)?.messages.slice(-5)
      .map(m => `${m.fromName}: ${m.text}`).join('\n') || ''

    const result = await this.llm('fase5a_divisione_gruppi.md', {
      stato_pgs: formatStatoPgs(worldState.stato_pgs),
      contesto_dove: focusScene?.contesto_dove || '',
      progressione: focusScene?.progressione || '',
      messaggi_recenti: recentMsgs
    })
    if (this.abortIfPaused()) return null
    await this.emitNarrative(result.narrativa)

    // Aggiorna world_state.groups: divide il gruppo in focus in due
    const focusGroup = worldState.groups.find(g => g.sceneId === worldState.focusScene)
    if (focusGroup && Array.isArray(result.gruppo_principale) && Array.isArray(result.gruppo_separato)) {
      // Converte nomi → email per entrambi i gruppi
      const principaleEmails = result.gruppo_principale
        .map(n => pgLookup.toEmail[n?.toLowerCase()] || n).filter(Boolean)
      const separatoEmails = result.gruppo_separato
        .map(n => pgLookup.toEmail[n?.toLowerCase()] || n).filter(Boolean)

      // Aggiorna il gruppo principale
      focusGroup.participants = principaleEmails.length ? principaleEmails : focusGroup.participants

      // Crea nuovo gruppo per il gruppo separato
      if (separatoEmails.length) {
        const newGroupId = `group${String(worldState.groups.length + 1).padStart(2, '0')}`
        worldState.groups.push({
          groupId: newGroupId,
          sceneId: null,  // sarà assegnata da fase-2
          participants: separatoEmails,
          subLocation: null,
          activity: null
        })
      }

      worldState.focusScene = 'tbd'
      await saveWorldState(this.tableId, worldState)
    }

    return { next: 'fase-2', suggerimento: result.suggerimento_nuova_scena || '' }
  }

  async fase5b(data) {
    await this.emitPhaseChange('fase-5b')
    await this.emitThinking('fase-5b')
    const { worldState, pgLookup } = await this.buildContext()
    const activeScenes = await this.getActiveScenes()

    const result = await this.llm('fase5b_ricongiungimento.md', {
      estratti_scene_attive: JSON.stringify(activeScenes.map(s => ({
        id_scena: s.id_scena,
        contesto_dove: s.contesto_dove,
        momento_corrente: sceneMomentoTesto(s)
      }))),
      stato_pgs: formatStatoPgs(worldState.stato_pgs)
    })
    if (this.abortIfPaused()) return null
    await this.emitNarrative(result.narrativa)

    // Aggiorna world_state.groups: unisce tutti i gruppi nella scena di ricongiungimento
    const targetSceneId = result.scena_ricongiungimento
    if (targetSceneId) {
      const allParticipants = [...new Set(worldState.groups.flatMap(g => g.participants || []))]
      worldState.groups = [{
        groupId: worldState.groups[0]?.groupId || 'group01',
        sceneId: targetSceneId,
        participants: allParticipants,
        subLocation: null,
        activity: null
      }]
      worldState.focusScene = targetSceneId
      await saveWorldState(this.tableId, worldState)
    }

    return { next: 'fase-3' }
  }

  async fase5c(data) {
    await this.emitPhaseChange('fase-5c')
    await this.emitThinking('fase-5c')
    const { worldState, mod } = await this.buildContext()
    const sessionNumber = svc.getSession(this.tableId)?.session?.sessionNumber ?? 1
    const focusScene = await getScene(this.tableId, worldState.focusScene)

    const result = await this.llm('fase5c_chiusura_scena.md', {
      contesto_dove: focusScene?.contesto_dove || '',
      progressione: focusScene?.progressione || '',
      stato_pgs: formatStatoPgs(worldState.stato_pgs),
      stato_pngs: formatStatoNpcs(worldState.npcs, focusScene?.id_scena),
      conoscenze_party: worldState.conoscenze_party || '(nessuna conoscenza acquisita)'
    })
    if (this.abortIfPaused()) return null

    await this.emitNarrative(result.narrativa)

    // Diario: sempre richiesto a chiusura scena (campo obbligatorio nello schema)
    const diaryEntry = result.aggiornamenti?.diary || ''
    if (diaryEntry) await appendDiary(this.tableId, diaryEntry, sessionNumber, mod.title)

    if (result.aggiornamenti?.scena_chiusa) {
      await closeScene(
        this.tableId,
        result.aggiornamenti.scena_chiusa,
        result.suggerimento_prossima_scena || ''
      )
      const ws = await getWorldState(this.tableId)
      ws.focusScene = null
      await saveWorldState(this.tableId, ws)
    }

    // Invia aggiornamento diario ai client
    this.io.to(this.room).emit('session:diary', await getDiary(this.tableId))

    // Ci sono altre scene attive?
    const active = await this.getActiveScenes()
    if (active.length > 0) {
      const ws = await getWorldState(this.tableId)
      ws.focusScene = active[0].id_scena
      await saveWorldState(this.tableId, ws)
      return { next: 'fase-3' }
    }

    return { next: 'fase-2', suggerimento: result.suggerimento_prossima_scena }
  }

  // ── Loop principale ───────────────────────────────────────────────────────

  async start() {
    if (this.running) return
    const table = await getTableOrNull(this.tableId)
    if (!table) {
      console.warn(`[Custode] Avvio annullato: tavolo ${this.tableId} non trovato`)
      destroy(this.tableId)
      return
    }
    this.running = true
    this.paused = false
    console.log(`[Custode] Start — tavolo ${this.tableId}`)

    try {
      let next = await this.fase1()
      await this.runLoop(next)
    } catch (err) {
      this.running = false
      if (err.isTableMissing) {
        console.warn(`[Custode] Stop: tavolo ${this.tableId} non piu' disponibile`)
        destroy(this.tableId)
        return
      }
      if (!this.paused) {
        console.error('[Custode] Errore fatale:', err)
        await this.emitError('Errore imprevisto del Custode')
      }
    }
  }

  async resume() {
    // Se il custode non era mai partito (es. errore in start), riparti da capo
    if (!this.running && !this.paused) {
      return this.start()
    }
    if (!this.paused) return
    this.paused = false
    this.running = true
    const ctx = svc.getSession(this.tableId)
    const phase = ctx?.session?.custodePhase || 'fase-3'
    const piano = ctx?.session?.pianoAzione
    try {
      await this.runLoop(phase, piano)
    } catch (err) {
      this.running = false
      console.error('[Custode] Errore in resume:', err)
      await this.emitError('Errore riprendendo il Custode')
    }
  }

  async startPassiveOrchestrator() {
    this.running = true
    this.paused = false
    this.passiveOrchestratorMode = true
    this.buffer = []
    this.startBuffer()
    await this.emitPhaseChange('orchestrator-passive')
    console.log(`[Custode] Passive orchestrator start — tavolo ${this.tableId}`)
  }

  async runLoop(startPhase, extraData = null) {
    let current = startPhase
    let data = extraData

    while (current && !this.paused) {
      try {
        console.log(`[Custode] runLoop [${this.tableId}] entering ${current} data=${debugString(data)}`)
        let result

        if (current === 'fase-2') result = await this.fase2(data?.suggerimento)
        else if (current === 'fase-3') result = await this.fase3()
        else if (current === 'fase-4a') result = await this.fase4aSceneOpening()
        else if (current === 'fase-4b') result = await this.fase4(data)
        else if (current === 'sottofase-4b-chiarimenti') result = await this.fase4bSubChiarimenti(data)
        else if (current === 'sottofase-4b-dichiarazione-assente') result = await this.fase4bSubDichiarazioneAssente(data)
        else if (current === 'sottofase-4b-necessita-prova') result = await this.fase4bSubNecessitaProva(data)
        else if (current === 'fase-5') result = await this.fase5(data?.piano || data)
        else if (current === 'fase-5a') result = await this.fase5a(data?.data || data)
        else if (current === 'fase-5b') result = await this.fase5b(data?.data || data)
        else if (current === 'fase-5c') result = await this.fase5c(data?.data || data)
        else break  // fase-1 già eseguita, fase-3 attende input

        if (!result) break  // in attesa di input giocatori

        console.log(`[Custode] runLoop [${this.tableId}] phase ${current} -> next ${result.next || '(none)'} result=${debugString(result)}`)

        current = result.next
        data = result

      } catch (err) {
        if (this.paused) break
        console.error(`[Custode] Errore in ${current}:`, err.message)
        this.running = false
        break
      }
    }
  }

  // ── Buffer messaggi ───────────────────────────────────────────────────────

  startBuffer() {
    this.bufferActive = true
    this.flushInProgress = false
    console.log(`[Custode] Buffer start [${this.tableId}]`)
  }

  async onPlayerMessage(message) {
    const ctx = svc.getSession(this.tableId)
    if (!ctx) return
    const phase = ctx.session.custodePhase
    const worldState = await getWorldState(this.tableId)
    const table = await getTableOrNull(this.tableId)
    const otherPgNames = (ctx.session.players || [])
      .filter(p => p.email !== message.from)
      .map(p => p.characterName || '')
      .filter(Boolean)
    const otherPlayerNames = await Promise.all(
      (ctx.session.players || [])
        .filter(p => p.email !== message.from)
        .map(p => getUserNameByEmail(p.email))
    )
    const npcEntries = (worldState.npcs || [])
      .filter(Boolean)
    const allNpcNames = npcEntries
      .map(npc => npc.name)
      .filter(Boolean)
    const focusSceneId = worldState.focusScene
    const scopedNpcNames = npcEntries
      .filter(npc => !focusSceneId || !npc.scena_id || npc.scena_id === focusSceneId)
      .map(npc => npc.name)
      .filter(Boolean)
    const moduleCatalog = getModuleQuestionCatalog(table?.moduleId) || {}
    const focusSceneLabel = moduleCatalog.sceneById?.[focusSceneId] || focusSceneId || null
    const questionNpcNames = Array.from(new Set([
      ...allNpcNames,
      ...(moduleCatalog.npcNames || [])
    ]))
    const locationNames = Array.from(new Set([
      ...(moduleCatalog.locationNames || [])
    ]))
    const objectNames = Array.from(new Set([
      ...(moduleCatalog.objectNames || [])
    ]))
    const clueNames = Array.from(new Set([
      ...(moduleCatalog.clueNames || [])
    ]))
    const recentClassifications = getRecentClassifications(ctx.messages, message.id)
    const lastSystemPromptKind = getLastSystemPromptKind(ctx.messages)

    if (this.passiveOrchestratorMode) {
      if (ctx.session.pendingClarification?.targetPlayerEmail === message.from) {
        await svc.updateMessage(this.tableId, message.id, {
          classificationTag: 'dichiarazione'
        })
        try {
          if (ctx.session.pendingClarification?.source === 'npc-master') {
            await this.answerNpcMasterClarification(message, ctx.session.pendingClarification)
          } else {
            await this.answerSceneMasterClarification(message, ctx.session.pendingClarification)
          }
        } catch (err) {
          console.error(`[SceneMaster] Chiarimento fallito [${this.tableId}]: ${err.message}`)
        }
        return
      }

      const implicitNpcHandlers = await this.getImplicitNpcHandlersForPlayer(message.from)
      const implicitNpcTarget = ctx?.session?.conversationTargets?.[message.from]
        || await this.getImplicitNpcTargetForPlayer(message.from)
        || null

      const routing = buildOrchestratorRoutingDecision(message.text, {
        otherPgNames,
        otherPlayerNames,
        npcNames: scopedNpcNames,
        questionNpcNames,
        locationNames,
        objectNames,
        clueNames,
        activeNpcTarget: implicitNpcTarget,
        implicitNpcHandlerNames: implicitNpcHandlers,
        phase: ctx?.session?.phase || 'inizio_sessione',
        recentClassifications,
        lastSystemPromptKind,
        focusSceneId,
        focusSceneLabel
      })
      const nextConversationPhase = inferConversationPhase(ctx?.session?.phase, routing, {
        recentClassifications
      })
      if (nextConversationPhase && nextConversationPhase !== (ctx?.session?.phase || 'inizio_sessione')) {
        await svc.updateSessionPhase(this.tableId, nextConversationPhase)
        this.emitSessionUpdate()
      }
      await svc.updateMessage(this.tableId, message.id, {
        classificationTag: routing.tag || '?'
      })
      let conversationTargetsChanged = false
      if (!ctx.session.conversationTargets || typeof ctx.session.conversationTargets !== 'object') {
        ctx.session.conversationTargets = {}
        conversationTargetsChanged = true
      }
      const nextConversationTarget = extractSingleNpcConversationTarget(routing)
      if (nextConversationTarget) {
        if (ctx.session.conversationTargets[message.from] !== nextConversationTarget) {
          ctx.session.conversationTargets[message.from] = nextConversationTarget
          conversationTargetsChanged = true
        }
      } else if (routing.tag === 'dichiarazione' || routing.agent === 'Scene Master') {
        if (ctx.session.conversationTargets[message.from]) {
          delete ctx.session.conversationTargets[message.from]
          conversationTargetsChanged = true
        }
      }
      if (conversationTargetsChanged) {
        await svc.saveSession(this.tableId, ctx.session)
      }
      this.buffer.push({ ...message, tag: routing.tag })
      console.log(
        `[Orchestrator] Routing [${this.tableId}] tag=${routing.tag} agent=${routing.agent || 'none'} reason=${routing.reason} msg=${message.fromName || message.from}: ${message.text}`
      )
      const targetLabel = routing.agent
        ? (routing.npcTarget ? `${routing.agent} (${routing.npcTarget})` : routing.agent)
        : 'Nessun agente'
      const debugBundle = formatContextBundleForDebug(routing)
      const bundleText = debugBundle.length
        ? ` | bundle=${debugBundle.join(', ')}`
        : ''
      await this.emitOrchestratorDebug(`[DEBUG ROUTING] ${targetLabel} | tag=${routing.tag} | ${routing.reason}${bundleText}`)
      if (routing.agent === 'Custode') {
        try {
          await this.answerCustodeQuestion(message, routing)
        } catch (err) {
          console.error(`[Custode] Risposta diretta fallita [${this.tableId}]: ${err.message}`)
        }
      } else if (routing.agent === 'Scene Master') {
        try {
          await this.answerSceneMasterDeclaration(message, routing)
        } catch (err) {
          console.error(`[SceneMaster] Risposta diretta fallita [${this.tableId}]: ${err.message}`)
        }
      } else if (routing.agent === 'NPC Master') {
        try {
          await this.answerNpcMasterInteraction(message, routing)
        } catch (err) {
          console.error(`[NpcMaster] Risposta diretta fallita [${this.tableId}]: ${err.message}`)
        }
      }
      return
    }

    // Dopo tiro dado: gestito interamente da onDiceRoll
    if (phase === 'sottofase-4b-necessita-prova') return

    // Turno singolo dopo una sottofase: accumula senza tagging, timer silenzio
    if (phase === 'sottofase-4b-chiarimenti' || phase === 'sottofase-4b-dichiarazione-assente') {
      this.buffer.push({ ...message, tag: 'dichiarazione' })
      console.log(`[Custode] Buffer add [${this.tableId}] phase=${phase} msg=${message.fromName || message.from}: ${message.text}`)
      svc.setTimer(this.tableId, 'silenzio', SILENCE_TIMER_MS, () => {
        this.flushBuffer('turno-singolo').catch(console.error)
      })
      return
    }

    // Gioco libero: accumula nel buffer
    if (!this.bufferActive) return
    const classified = classifyChatMessage(message.text, {
      otherPgNames,
      otherPlayerNames,
      npcNames: scopedNpcNames,
      phase: ctx?.session?.phase || 'inizio_sessione',
      recentClassifications,
      lastSystemPromptKind
    })
    await svc.updateMessage(this.tableId, message.id, {
      classificationTag: classified.tag || '?'
    })
    this.buffer.push({ ...message, tag: classified.tag || '?' })
    console.log(`[Custode] Buffer add [${this.tableId}] phase=${phase} msg=${message.fromName || message.from}: ${message.text}`)

    if (this.buffer.length >= MSG_BUFFER_SIZE) {
      this.flushBuffer('buffer-pieno').catch(console.error)
      return
    }

    svc.setTimer(this.tableId, 'silenzio', SILENCE_TIMER_MS, () => {
      this.flushBuffer('timer-silenzio').catch(console.error)
    })
  }

  async onDiceRoll(email, valore, soglia, caratteristica) {
    const ctx = svc.getSession(this.tableId)
    if (!ctx) return

    if (this.passiveOrchestratorMode && ctx.session.pendingRoll?.targetPlayerEmail === email) {
      const rollResult = {
        email,
        caratteristica,
        soglia,
        valore,
        esito: valore <= soglia ? 'successo' : 'fallimento'
      }
      if (ctx.session.pendingRoll?.source === 'npc-master') {
        await this.narrateNpcMasterRollOutcome(ctx.session.pendingRoll, rollResult)
      } else {
        await this.narrateSceneMasterRollOutcome(ctx.session.pendingRoll, rollResult)
      }
      return
    }

    if (ctx.session.custodePhase !== 'sottofase-4b-necessita-prova') return

    const esito = valore <= soglia ? 'successo' : 'fallimento'
    const piano = ctx.session.pianoAzione || []

    // Aggiorna risultato_prova nell'entry corrispondente
    const entry = piano.find(e => e.pg === email && e.stato === 'prova')
    if (entry) {
      entry.risultato_prova = { valore_tiro: valore, esito }
      ctx.session.pianoAzione = piano
      await svc.saveSession(this.tableId, ctx.session)
    }

    this.buffer.push({
      from: email,
      tag: 'dichiarazione',
      text: `[Tiro dado] ${caratteristica}: ${valore}/${soglia} → ${esito}`
    })

    await this.runLoop('fase-4b', piano)
  }

  async getFlushParticipants() {
    const ctx = svc.getSession(this.tableId)
    if (!ctx) return []
    const phase = ctx.session.custodePhase

    if (
      phase === 'sottofase-4b-chiarimenti' ||
      phase === 'sottofase-4b-dichiarazione-assente' ||
      phase === 'sottofase-4b-necessita-prova'
    ) {
      return ctx.session.players
        .filter(p => p.playerState === 'mio-turno-libero' || p.playerState === 'mio-turno-prova')
        .map(p => p.email)
    }

    const worldState = await getWorldState(this.tableId)
    const focusGroup = worldState.groups?.find(g => g.sceneId === worldState.focusScene)
    return focusGroup?.participants || []
  }

  async flushBuffer(reason) {
    if (!this.running || !this.buffer.length || this.flushInProgress) return
    const participants = await this.getFlushParticipants()
    const typingPlayers = svc.getTypingPlayers(this.tableId)
    if (hasActiveTypingInFocus(typingPlayers, participants)) {
      console.log(`[Custode] Buffer flush postponed [${this.tableId}] reason=${reason} participants=${debugString(participants)} typing=${debugString(typingPlayers)}`)
      svc.clearTimer(this.tableId, 'silenzio')
      svc.setTimer(this.tableId, 'silenzio', Math.max(SILENCE_TIMER_MS, 3000), () => {
        this.flushBuffer(`retry-${reason}`).catch(console.error)
      })
      return
    }

    this.flushInProgress = true
    svc.clearTimer(this.tableId, 'silenzio')
    console.log(`[Custode] Buffer flush [${this.tableId}] reason=${reason} msgs=${this.buffer.length} payload=${debugString(this.buffer.map(m => ({ from: m.fromName || m.from, tag: m.tag, text: m.text })))}`)
    this.bufferActive = false
    // In turno singolo passa il piano parziale corrente, altrimenti null (round fresco)
    const ctx = svc.getSession(this.tableId)
    const phase = ctx?.session?.custodePhase
    const piano = (
      phase === 'sottofase-4b-chiarimenti' ||
      phase === 'sottofase-4b-dichiarazione-assente'
    )
      ? (ctx?.session?.pianoAzione || null)
      : null
    this.runLoop('fase-4b', piano)
      .catch(console.error)
      .finally(() => {
        this.flushInProgress = false
      })
  }

  // ── Utilità ───────────────────────────────────────────────────────────────

  async setGroupState(sceneId, worldState, playerState) {
    const group = worldState.groups.find(g => g.sceneId === sceneId)
    if (!group) return
    for (const email of group.participants) {
      await svc.updatePlayerState(this.tableId, email, playerState)
      this.io.to(this.room).emit('session:player-update', {
        email, connected: true, playerState
      })
    }
  }

  async setPlayerTurn(email, playerState) {
    const ctx = svc.getSession(this.tableId)
    if (!ctx) return false
    const targetExists = ctx.session.players.some(p => p.email === email)
    if (!targetExists) {
      console.warn(`[Custode] Target turno non valido [${this.tableId}] target=${email} phase=${ctx.session.custodePhase} players=${debugString(ctx.session.players.map(p => ({ email: p.email, playerState: p.playerState })))} piano=${debugString(ctx.session.pianoAzione)}`)
      return false
    }
    // Tutti gli altri: fuori-turno
    for (const p of ctx.session.players) {
      const state = p.email === email ? playerState : 'fuori-turno'
      await svc.updatePlayerState(this.tableId, p.email, state)
      this.io.to(this.room).emit('session:player-update', {
        email: p.email, connected: p.connected, playerState: state
      })
    }
    return true
  }

  async getActiveScenes() {
    const scenes = await runtimeStore.listScenes(this.tableId)
    return scenes.filter(scene => scene?.runtime?.stato !== 'completata' && scene?.runtime?.stato !== 'abbandonata')
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Registro engine attivi ────────────────────────────────────────────────────

const engines = new Map()

function getOrCreate(tableId, io) {
  if (!engines.has(tableId)) engines.set(tableId, new CustodeEngine(tableId, io))
  return engines.get(tableId)
}

function pause(tableId) {
  const engine = engines.get(tableId)
  if (engine) engine.paused = true
}

function destroy(tableId) {
  const engine = engines.get(tableId)
  if (engine) {
    engine.paused = true   // interrompe il runLoop se in esecuzione
    engine.running = false
  }
  engines.delete(tableId)
}

module.exports = {
  getOrCreate,
  pause,
  destroy,
  prepareSessionBootstrap,
  prepareSessionBootstrapInBackground,
  isSessionBootstrapReady,
  promoteTableToReadyIfPossible,
  buildRagResolver,
  buildPgLookup,
  canonicalPgName,
  extractChatFeatures,
  resolveChatMessageTag,
  classifyChatMessage,
  extractQuestionMetadata,
  buildOrchestratorRoutingDecision,
  mergeStatoPgs,
  normalizeStatoPgsMap
}
