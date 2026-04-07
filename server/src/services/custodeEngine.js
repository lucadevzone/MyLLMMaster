/**
 * Custode Engine — macchina a stati procedurale del Game Master LLM
 *
 * Fasi: 1 → 2(opening) → 3(orchestrator) → 4a(scene progress) →
 * 4b(analisi dichiarazioni + sottofasi) → 5(risoluzione stato) → torna a 4a o 2
 */

const path = require('path')
const fs = require('fs').promises
const { readJSON, writeJSON, fileExists, ensureDir } = require('../utils/fileStore')
const { DATA_DIR } = require('../utils/dataInit')
const svc = require('./sessionService')
const ollama = require('./ollamaService')
const rag = require('./ragService')

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
const EARLY_FLUSH_IDLE_MS = parseInt(process.env.EARLY_FLUSH_IDLE_MS || '5000')
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

async function getWorldState(tableId) {
  const p = path.join(tDir(tableId), 'world_state.json')
  if (!await fileExists(p)) {
    const ws = {
      currentChapter: 1,
      focusScene: null,
      groups: [],
      stato_pgs: {},
      conoscenze_party: '',
      npcs: [],
      items: []
    }
    await writeJSON(p, ws)
    return ws
  }
  const ws = await readJSON(p)
  // Migrazione da vecchio schema
  if (!ws.stato_pgs || typeof ws.stato_pgs !== 'object') ws.stato_pgs = {}
  if (typeof ws.conoscenze_party !== 'string') ws.conoscenze_party = ''
  if (!Array.isArray(ws.npcs)) ws.npcs = []
  if (!Array.isArray(ws.items)) ws.items = []
  return ws
}

async function saveWorldState(tableId, ws) {
  await writeJSON(path.join(tDir(tableId), 'world_state.json'), ws)
}

async function getDiary(tableId) {
  const p = path.join(tDir(tableId), 'diary.txt')
  try { return await fs.readFile(p, 'utf-8') } catch { return '' }
}

async function appendDiary(tableId, entry, sessionNumber = 0, moduleTitle = '') {
  const p = path.join(tDir(tableId), 'diary.txt')
  await fs.appendFile(p, '\n\n' + entry)
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
  const active = path.join(tDir(tableId), 'active_scenes', `${sceneId}.json`)
  if (await fileExists(active)) return readJSON(active)
  const closed = path.join(tDir(tableId), 'closed_scenes', `${sceneId}.json`)
  if (await fileExists(closed)) return readJSON(closed)
  return null
}

async function nextSceneId(tableId) {
  let count = 0
  for (const dir of ['active_scenes', 'closed_scenes']) {
    const p = path.join(tDir(tableId), dir)
    try {
      const files = await fs.readdir(p)
      count += files.filter(f => f.endsWith('.json')).length
    } catch { /* cartella assente */ }
  }
  return `scene_${String(count).padStart(3, '0')}`
}

function buildPgLookup(chars) {
  return {
    toName:  Object.fromEntries(chars.map(c => [c.playerID, c.name])),
    toEmail: Object.fromEntries(chars.map(c => [c.name.toLowerCase(), c.playerID]))
  }
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
  const dir = closed ? 'closed_scenes' : 'active_scenes'
  await ensureDir(path.join(tDir(tableId), dir))
  await writeJSON(path.join(tDir(tableId), dir, `${scene.id_scena}.json`), scene)
}

async function closeScene(tableId, sceneId, suggerimentoProssimaScena = '') {
  const scene = await getScene(tableId, sceneId)
  if (!scene) return
  scene.suggerimento_prossima_scena = suggerimentoProssimaScena || ''
  // Sposta in closed_scenes
  const src = path.join(tDir(tableId), 'active_scenes', `${sceneId}.json`)
  const dst = path.join(tDir(tableId), 'closed_scenes', `${sceneId}.json`)
  await ensureDir(path.join(tDir(tableId), 'closed_scenes'))
  await writeJSON(dst, scene)
  try { await fs.unlink(src) } catch {}
}

const USEFUL_TAGS = new Set(['dichiarazione', 'domanda al custode', 'discutendo tra PG'])

function shouldProcessByAnnotations(messages, focusParticipants = []) {
  if (!Array.isArray(messages) || !messages.length) return false
  if (!Array.isArray(focusParticipants) || !focusParticipants.length) return false

  const usefulMessages = messages.filter(m =>
    m?.from &&
    focusParticipants.includes(m.from) &&
    USEFUL_TAGS.has(m.tag)
  )
  if (!usefulMessages.length) return false

  const activePlayers = new Set(usefulMessages.map(m => m.from))
  const threshold = Math.ceil(focusParticipants.length / 2)
  return activePlayers.size >= threshold && usefulMessages.length >= threshold
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

function formatRagResults(results) {
  if (!results?.length) return '(nessun contesto disponibile)'
  return results
    .map(r => `[${r.type}] ${r.name}:\n${r.content}`)
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

// Sintassi: {{rag:source:"query"}}, {{rag:source:"query":cascade}} oppure
// {{rag:source:"query1, query2":iterate}}
const RAG_PATTERN = /\{\{rag:(module|table):"([^"]+)"(?::(cascade|iterate))?\}\}/g
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

function buildRagResolver(moduleId, tableId) {
  return async (template, vars) => {
    const matches = [...template.matchAll(RAG_PATTERN)]
    if (!matches.length) return template

    for (const match of matches) {
      const [fullMatch, source, queryTemplate, mode = ''] = match

      // Interpola la stringa di query con le variabili runtime
      let query = queryTemplate
      for (const [key, val] of Object.entries(vars)) {
        const value = typeof val === 'object' ? JSON.stringify(val) : String(val ?? '')
        query = query.replaceAll(`{{${key}}}`, value)
      }

      const isCascade = mode === 'cascade'
      const isIterate = mode === 'iterate'
      let results = []
      try {
        if (isIterate) {
          const items = splitIterateItems(query)
          for (const item of items) {
            const partial = source === 'module'
              ? await rag.queryModule(moduleId, item, RAG_PROMPT_TOP_K)
              : await rag.queryTable(tableId, item, RAG_PROMPT_TOP_K)
            results.push(...partial)
          }
          results = dedupeRagResults(results)
        } else if (source === 'module') {
          results = isCascade
            ? await rag.cascadeQueryModule(moduleId, query, RAG_PROMPT_TOP_K)
            : await rag.queryModule(moduleId, query, RAG_PROMPT_TOP_K)
        } else {
          results = await rag.queryTable(tableId, query, RAG_PROMPT_TOP_K)
        }
      } catch (err) {
        const suffix = isCascade ? ':cascade' : (isIterate ? ':iterate' : '')
        console.warn(`[Custode] RAG resolver [${source}${suffix}] "${query}" fallita:`, err.message)
      }

      template = template.replaceAll(fullMatch, formatRagResults(results))
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
  const heavyModel = table['heavy-llmModel']
  if (!heavyModel) return false

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
        heavyModel,
        'fase1a_prima_sessione.md',
        { schede_PG },
        { num_ctx: ollama.HEAVY_LLM_NUM_CTX },
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
      from: 'custode',
      fromName: 'Custode',
      to: options.to || null,
      text: safeText
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

  async emitThinking(phaseKey) {
    const messages = await loadThinkingMessages()
    const list = messages[phaseKey]
    if (!list?.length) return
    const text = list[Math.floor(Math.random() * list.length)]
    const label = phaseLabel(phaseKey)
    this.io.to(this.room).emit('custode:thinking', { message: `${label} ${text}...` })
  }

  // ── LLM call con gestione errori ──────────────────────────────────────────

  async llm(promptFile, vars, useLight = false) {
    const table = await getTableOrNull(this.tableId)
    if (!table) {
      const err = Object.assign(new Error(`Tavolo ${this.tableId} non trovato`), { isTableMissing: true })
      throw err
    }
    const model = useLight
      ? (table['light-llmModel'] || table['heavy-llmModel'])
      : table['heavy-llmModel']

    if (!model) {
      const err = Object.assign(
        new Error('Modello LLM non configurato sul tavolo'),
        { isLlmError: true }
      )
      await this.pauseForTechnicalIssue('Modello LLM non configurato – vai in Gestione Tavoli e seleziona un modello')
      throw err
    }

    try {
      const ollamaOptions = useLight ? {} : { num_ctx: ollama.HEAVY_LLM_NUM_CTX }
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

    const model = table['heavy-llmModel']
    if (!model) {
      await this.pauseForTechnicalIssue('Modello LLM non configurato – vai in Gestione Tavoli e seleziona un modello')
      throw Object.assign(new Error('Modello LLM non configurato sul tavolo'), { isLlmError: true })
    }

    try {
      const toolHandlers = buildConsultoToolHandler(table.moduleId, this.tableId)
      return await ollama.runPhaseWithTools(
        model, promptFile, vars,
        [CONSULTO_TOOL_DEFINITION], toolHandlers,
        { num_ctx: ollama.HEAVY_LLM_NUM_CTX }, this.tableId
      )
    } catch (err) {
      if (err.isLlmError) {
        await this.pauseForTechnicalIssue(`Errore LLM (${model}): ${err.message} – sessione in pausa`)
      }
      throw err
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
    const hasActiveScene = worldState.focusScene &&
      await fileExists(path.join(tDir(this.tableId), 'active_scenes', `${worldState.focusScene}.json`))

    return hasActiveScene ? 'fase-3' : 'fase-2'
  }

  // ── FASE 2: Opening New Scene ─────────────────────────────────────────────

  async fase2(suggerimento = null) {
    await this.emitPhaseChange('fase-2')
    const { worldState, mod, schede_PG } = await this.buildContext()
    const sessionNumber = svc.getSession(this.tableId)?.session?.sessionNumber ?? 1
    const suggerimento_scena = suggerimento || 'scena introduttiva'

    await this.emitThinking('fase-2')

    // Determina il momento corrente per la nuova scena:
    // se una scena precedente era in focus usa il suo tempo, altrimenti nessuno
    const prevScene = worldState.focusScene
      ? await getScene(this.tableId, worldState.focusScene)
      : null
    const prevMomento = prevScene?.momento_corrente || null

    const result = await this.llm('fase2_opening_new_scene.md', {
      suggerimento_scena,
      schede_PG,
      stato_pgs: formatStatoPgs(worldState.stato_pgs),
      conoscenze_party: worldState.conoscenze_party || '(nessuna conoscenza acquisita)',
      momento_corrente: prevMomento ? formatItalianDate(new Date(prevMomento)) : ''
    })
    if (this.abortIfPaused()) return null

    result.PNG = normalizeSceneListOutput(result.PNG)
    result.opportunita = normalizeSceneListOutput(result.opportunita)
    result.minacce = normalizeSceneListOutput(result.minacce)
    result.indizi = normalizeSceneListOutput(result.indizi)

    // Inizializza momento_corrente della scena
    const parsedMomento = prevMomento
      ? new Date(prevMomento)
      : parseItalianDate(result.contesto_quando)
    result.momento_corrente = parsedMomento?.toISOString() || ''
    delete result.contesto_quando  // sostituito da momento_corrente

    // Assegna ID progressivo e inizializza progressione
    result.id_scena = await nextSceneId(this.tableId)
    result.progressione = ''
    result.sessionNumber = sessionNumber

    // Salva scena in active_scenes
    await saveScene(this.tableId, result)

    // Stato PG iniziale per questa scena (generato dalla LLM)
    if (result.stato_pgs && typeof result.stato_pgs === 'object') {
      for (const [nome, s] of Object.entries(result.stato_pgs)) {
        if (s && typeof s.stato === 'string') {
          worldState.stato_pgs[nome] = { stato: s.stato }
        }
      }
    }

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
    const activeSceneFiles = await fs.readdir(path.join(tDir(this.tableId), 'active_scenes')).catch(() => [])
    worldState.focusScene = activeSceneFiles.filter(f => f.endsWith('.json')).length === 1
      ? result.id_scena
      : 'tbd'

    await saveWorldState(this.tableId, worldState)

    return { next: 'fase-3' }
  }

  // ── FASE 3: Scene Orchestrator ────────────────────────────────────────────

  async fase3() {
    const { worldState, pgLookup } = await this.buildContext()
    const ctx = svc.getSession(this.tableId)
    const engagement = engagementForLlm(ctx?.session?.engagement || {}, pgLookup)

    // ── 3a (opzionale): scelta focus scena ──
    const activeSceneFiles = await fs.readdir(path.join(tDir(this.tableId), 'active_scenes')).catch(() => [])
    const needsFocusChoice = worldState.focusScene === 'tbd' ||
      activeSceneFiles.filter(f => f.endsWith('.json')).length > 1

    if (needsFocusChoice) {
      await this.emitPhaseChange('fase-3')
      await this.emitThinking('fase-3')
      const activeScenes = await Promise.all(
        activeSceneFiles.filter(f => f.endsWith('.json'))
          .map(f => readJSON(path.join(tDir(this.tableId), 'active_scenes', f)))
      )
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
    svc.clearTimer(this.tableId, 'early-flush')
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
    if (agg.stato_pgs && typeof agg.stato_pgs === 'object') {
      for (const [nome, s] of Object.entries(agg.stato_pgs)) {
        if (s && typeof s.stato === 'string') {
          ws.stato_pgs[nome] = { stato: s.stato }
        }
      }
    }

    // conoscenze_party (append-only)
    if (agg.nuove_conoscenze && typeof agg.nuove_conoscenze === 'string' && agg.nuove_conoscenze.trim()) {
      ws.conoscenze_party = ws.conoscenze_party
        ? `${ws.conoscenze_party}\n${agg.nuove_conoscenze.trim()}`
        : agg.nuove_conoscenze.trim()
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
    this.buffer.push(message)
    console.log(`[Custode] Buffer add [${this.tableId}] phase=${phase} msg=${message.fromName || message.from}: ${message.text}`)
    this.tagMessageAsync(message)

    if (this.buffer.length >= MSG_BUFFER_SIZE) {
      this.flushBuffer('buffer-pieno').catch(console.error)
      return
    }

    svc.setTimer(this.tableId, 'silenzio', SILENCE_TIMER_MS, () => {
      this.flushBuffer('timer-silenzio').catch(console.error)
    })
    svc.setTimer(this.tableId, 'early-flush', EARLY_FLUSH_IDLE_MS, () => {
      this.evaluateEarlyFlush().catch(console.error)
    })
  }

  async onDiceRoll(email, valore, soglia, caratteristica) {
    const ctx = svc.getSession(this.tableId)
    if (!ctx || ctx.session.custodePhase !== 'sottofase-4b-necessita-prova') return

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
      svc.setTimer(this.tableId, 'silenzio', Math.max(EARLY_FLUSH_IDLE_MS, 3000), () => {
        this.flushBuffer(`retry-${reason}`).catch(console.error)
      })
      return
    }

    this.flushInProgress = true
    svc.clearTimer(this.tableId, 'silenzio')
    svc.clearTimer(this.tableId, 'early-flush')
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

  async tagMessageAsync(message) {
    const table = await getTable(this.tableId)
    const lightModel = table['light-llmModel'] || table['heavy-llmModel']
    if (!lightModel) return

    try {
      const recentContext = this.buffer
        .filter(m => m.id !== message.id)
        .slice(-5)
        .map(m => `${m.fromName || m.from}: ${m.text}`)
        .join('\n') || '(nessun contesto recente)'

      const result = await ollama.runTagging(lightModel, 'tagging_buffer.md', {
        messaggio_corrente: message.text,
        contesto_recente: recentContext
      }, this.tableId)

      const msg = this.buffer.find(m => m.id === message.id)
      if (msg && Object.prototype.hasOwnProperty.call(result, 'annotazione')) {
        msg.tag = result.annotazione
        console.log(`[Custode] Tagging buffer [${this.tableId}] message=${message.id} tag=${result.annotazione}`)
      }

      await this.evaluateEarlyFlush()
    } catch {
      // Il tagging è best-effort, non blocca il gioco
    }
  }

  async evaluateEarlyFlush() {
    if (!this.bufferActive || this.flushInProgress || !this.buffer.length) return

    const ctx = svc.getSession(this.tableId)
    if (!ctx || ctx.session.custodePhase !== 'fase-4a') return

    const worldState = await getWorldState(this.tableId)
    const focusGroup = worldState.groups?.find(g => g.sceneId === worldState.focusScene)
    const focusParticipants = focusGroup?.participants || []
    const typingPlayers = svc.getTypingPlayers(this.tableId)

    if (hasActiveTypingInFocus(typingPlayers, focusParticipants)) {
      console.log(`[Custode] Early flush blocked by typing [${this.tableId}] participants=${debugString(focusParticipants)} typing=${debugString(typingPlayers)}`)
      return
    }

    if (shouldProcessByAnnotations(this.buffer, focusParticipants)) {
      console.log(`[Custode] Early flush triggered by annotations [${this.tableId}] participants=${debugString(focusParticipants)}`)
      this.flushBuffer('annotazioni').catch(console.error)
    }
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
    const dir = path.join(tDir(this.tableId), 'active_scenes')
    try {
      const files = await fs.readdir(dir)
      return Promise.all(
        files.filter(f => f.endsWith('.json')).map(f => readJSON(path.join(dir, f)))
      )
    } catch { return [] }
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

module.exports = { getOrCreate, pause, destroy, prepareSessionBootstrap, prepareSessionBootstrapInBackground, isSessionBootstrapReady, promoteTableToReadyIfPossible }
