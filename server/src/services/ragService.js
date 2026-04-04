/**
 * RAG Service — embedding, vector storage e retrieval
 *
 * Fase 1: infrastruttura base
 * - Embedding via Ollama (nomic-embed-text o altro modello configurabile)
 * - Vector store JSON su filesystem (nessuna dipendenza esterna)
 * - Chunking placeholder per paragrafi (sarà sostituito in Fase 2 con preprocessing LLM)
 *
 * Struttura dati:
 *   data/modules/{moduleId}_rag/index.json   ← indice del modulo
 *   data/tables/{tableId}/rag/index.json     ← indice diary + scene per tavolo
 */

const fs = require('fs').promises
const path = require('path')
const { DATA_DIR } = require('../utils/dataInit')
const { ensureDir, fileExists } = require('../utils/fileStore')
const ollama = require('./ollamaService')

const OLLAMA_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
const EMBED_MODEL = process.env.RAG_EMBED_MODEL || 'nomic-embed-text'
const RAG_TOP_K = parseInt(process.env.RAG_TOP_K || '5')
const DEFAULT_HEAVY_MODEL = process.env.DEFAULT_HEAVY_LLM_MODEL
const PRELIM_CHUNK_SIZE = parseInt(process.env.RAG_CHUNK_SIZE || '3000')
const PRELIM_CHUNK_OVERLAP = parseInt(process.env.RAG_CHUNK_OVERLAP || '200')

// Configurazione per il prompt pass1 — solo i tipi più affidabili per estrazione semantica.
// Tutto il resto (indizi, risorse, eventi, scene, mostri) è coperto dai chunk raw.
const TYPE_CONFIG = {
  location: {
    descrizione: 'luoghi fisici con un nome proprio o nome comune (città, aree geografiche, location specifiche)',
    esempi:      'Il Giappone, Londra, Roma, una biblioteca, un porto abbandonato, Viale Della Libertà',
    escludi:     'personaggi, oggetti, eventi, informazioni — solo luoghi con un nome proprio'
  },
  personaggio: {
    descrizione: 'persone con nome proprio (protagonisti, comprimari, dramatis personae) con un ruolo nella storia',
    esempi:      'Dr. Brown, Alice Meraviglia, John Mylopoulos, Mister X',
    escludi:     'luoghi, oggetti, eventi, informazioni astratte — solo esseri umani identificati con un nome'
  }
}

// Priorità per deduplicazione cross-tipo (tipo con indice più basso "vince" in caso di nome identico)
const TYPE_PRIORITY = ['personaggio', 'location']

// Etichette leggibili usate nell'header di embedding per migliorare il retrieval
// con query categoriali ("personaggi non giocanti", "luoghi dell'atto I", ecc.)
const TYPE_LABELS = {
  location:      'Luogo',
  personaggio:   'Personaggio non giocante',
  ambientazione: 'Ambientazione del modulo',
  raw:           'Sezione del modulo',
  diario:        'Diario di sessione',
  prima_sessione: 'Prima sessione'
}

/**
 * Costruisce il testo da passare all'embedding.
 * Aggiunge un header con tipo leggibile, nome e contesto del modulo/atto
 * così che query categoriali ("personaggi non giocanti dell'atto I") trovino corrispondenza.
 * Il campo `content` rimane invariato per la visualizzazione nei prompt.
 */
function buildEmbedText(chunk) {
  const typeLabel = TYPE_LABELS[chunk.type] || chunk.type
  const chapterPart = chunk.chapter ? `, Atto ${chunk.chapter}` : ''
  const modulePart  = chunk.moduleTitle ? ` — ${chunk.moduleTitle}${chapterPart}` : ''
  const header = `[${typeLabel}] ${chunk.name}${modulePart}`
  return `${header}\n${chunk.content}`
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function moduleRagDir(moduleId) {
  return path.join(DATA_DIR, 'modules', `${moduleId}_rag`)
}

function moduleIndexPath(moduleId) {
  return path.join(moduleRagDir(moduleId), 'index.json')
}

function tableRagDir(tableId) {
  return path.join(DATA_DIR, 'tables', tableId, 'rag')
}

function tableIndexPath(tableId) {
  return path.join(tableRagDir(tableId), 'index.json')
}

// ── Embedding ─────────────────────────────────────────────────────────────────

async function embed(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text })
  })
  if (!res.ok) throw new Error(`Ollama embeddings HTTP ${res.status}`)
  const data = await res.json()
  if (!Array.isArray(data.embedding)) throw new Error('Risposta embedding non valida')
  return data.embedding
}

// ── Vector math ───────────────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  if (magA === 0 || magB === 0) return 0
  return dot / (Math.sqrt(magA) * Math.sqrt(magB))
}

// ── Index I/O ─────────────────────────────────────────────────────────────────

async function loadIndex(indexPath) {
  try {
    const raw = await fs.readFile(indexPath, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return { chunks: [] }
  }
}

async function saveIndex(indexPath, index) {
  await ensureDir(path.dirname(indexPath))
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2))
}

// ── Chunking raw del testo originale (strategia 1+3) ─────────────────────────
//
// Strategia combinata:
//   3. Rileva sezioni naturali: paragrafo breve (<= TITLE_MAX_LEN) non puntato
//      seguito da contenuto più lungo = titolo implicito di sezione
//   1. Raggruppa i paragrafi di ogni sezione con overlap di 1 paragrafo
//      se la sezione supera RAW_CHUNK_MAX caratteri
//
// Ogni chunk raw mantiene il testo originale intatto: nessuna elaborazione LLM.

const RAW_TITLE_MAX_LEN  = 80   // caratteri massimi per una riga-titolo implicita
const RAW_CHUNK_MAX      = parseInt(process.env.RAG_RAW_CHUNK_MAX  || '800')
const RAW_CHUNK_MIN      = parseInt(process.env.RAG_RAW_CHUNK_MIN  || '150')

function isImplicitTitle(line, nextLine) {
  if (!line || line.length > RAW_TITLE_MAX_LEN) return false
  // Le righe-titolo non terminano con punteggiatura di frase
  if (/[,;]$/.test(line)) return false
  // Il contenuto successivo deve essere sostanzialmente più lungo
  return nextLine && nextLine.length > line.length * 1.5
}

function splitIntoRawChunks(text) {
  const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean)
  const chunks = []
  let idx = 0

  // Raggruppa i paragrafi in sezioni usando titoli impliciti come boundary
  const sections = []
  let currentTitle = null
  let currentParas = []

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i]
    const next = paragraphs[i + 1] || ''

    if (isImplicitTitle(para, next) && currentParas.length > 0) {
      sections.push({ title: currentTitle, paras: currentParas })
      currentTitle = para
      currentParas = []
    } else if (isImplicitTitle(para, next) && currentParas.length === 0) {
      currentTitle = para
    } else {
      currentParas.push(para)
    }
  }
  if (currentParas.length > 0 || currentTitle) {
    sections.push({ title: currentTitle, paras: currentParas })
  }

  // Per ogni sezione: emetti uno o più chunk rispettando RAW_CHUNK_MAX
  for (const section of sections) {
    const header = section.title ? section.title + '\n\n' : ''
    let current = header
    let prevPara = ''

    for (const para of section.paras) {
      if (current.length + para.length > RAW_CHUNK_MAX && current.trim().length > RAW_CHUNK_MIN) {
        chunks.push({
          id:      `raw_${String(idx).padStart(3, '0')}`,
          type:    'raw',
          name:    section.title || `Sezione ${idx + 1}`,
          content: current.trim()
        })
        idx++
        // Overlap: ricomincia con l'ultimo paragrafo del chunk precedente
        current = header + (prevPara ? prevPara + '\n\n' : '') + para
      } else {
        current = current ? current + '\n\n' + para : para
      }
      prevPara = para
    }

    if (current.trim().length >= RAW_CHUNK_MIN) {
      chunks.push({
        id:      `raw_${String(idx).padStart(3, '0')}`,
        type:    'raw',
        name:    section.title || `Sezione ${idx + 1}`,
        content: current.trim()
      })
      idx++
    } else if (chunks.length > 0 && current.trim()) {
      // Sezione troppo piccola: fondila con il chunk precedente
      chunks[chunks.length - 1].content += '\n\n' + current.trim()
    }
  }

  return chunks
}

// ── Chunking preliminare per pass1 ───────────────────────────────────────────
//
// Strategia A: accumula paragrafi fino a PRELIM_CHUNK_SIZE senza tagliare a metà
// paragrafo. Overlap di 1 paragrafo tra chunk consecutivi.
//
// Strategia B (usata via rawChunksToTextArray): usa i chunk raw già calcolati
// da splitIntoRawChunks — sono sezione-aware e hanno titoli impliciti.

function splitTextIntoChunks(text, size = PRELIM_CHUNK_SIZE) {
  const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean)
  const chunks = []
  let current = ''
  let prevPara = ''

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > size && current) {
      chunks.push(current.trim())
      // Overlap: ricomincia con l'ultimo paragrafo del chunk precedente
      current = prevPara ? prevPara + '\n\n' + para : para
    } else {
      current = current ? current + '\n\n' + para : para
    }
    prevPara = para
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}

// Converte chunk raw in array di stringhe testuali per il pass1 (strategia B)
function rawChunksToTextArray(rawChunks) {
  return rawChunks.map(c => c.content)
}

// ── Preprocessing LLM — Pass 1: lista entità per tipo ────────────────────────

async function extractEntitiesForType(type, textChunks) {
  const cfg = TYPE_CONFIG[type]
  const found = new Set()

  for (let i = 0; i < textChunks.length; i++) {
    try {
      const raw = await ollama.runTextPhase(
        DEFAULT_HEAVY_MODEL,
        'rag_pass1_entita.md',
        {
          tipo_descrizione: cfg.descrizione,
          tipo_esempi:      cfg.esempi,
          tipo_escludi:     cfg.escludi,
          testo_chunk:      textChunks[i]
        }
      )
      for (const line of raw.split('\n')) {
        const name = line.replace(/^[-•*]\s*/, '').trim()  // rimuove bullet list
        if (!name || name.toLowerCase() === 'nessuno') continue
        if (name.length > 120) continue  // scarta righe troppo lunghe (spiegazioni)
        found.add(name)
      }
    } catch (err) {
      console.warn(`[RAG] Pass 1 "${type}" chunk ${i + 1} fallito:`, err.message)
    }
  }

  return [...found].map(name => ({ type, name }))
}

// ── Deduplicazione entità cross-tipo ─────────────────────────────────────────
// Rimuove duplicati e forme brevi: "Sophia" viene eliminata se esiste "Sophia Hapgood".
// In caso di stesso nome in tipi diversi, vince quello con priorità più alta.

function deduplicateEntities(allEntities) {
  // 1. Rimuove forme brevi NELLO STESSO TIPO
  //    "Sophia" viene eliminata se nello stesso tipo esiste "Sophia Hapgood"
  const withoutIntraTypeDups = allEntities.filter(entity => {
    const key = entity.name.toLowerCase()
    return !allEntities.some(other =>
      other !== entity &&
      other.type === entity.type &&
      other.name.toLowerCase().includes(key) &&
      other.name.toLowerCase() !== key
    )
  })

  // 2. In caso di stesso nome identico tra tipi diversi, tieni il tipo con priorità più alta
  const byName = new Map()
  for (const entity of withoutIntraTypeDups) {
    const key = entity.name.toLowerCase()
    const existing = byName.get(key)
    if (!existing) {
      byName.set(key, entity)
      continue
    }
    if (TYPE_PRIORITY.indexOf(entity.type) < TYPE_PRIORITY.indexOf(existing.type)) {
      byName.set(key, entity)
    }
  }

  return [...byName.values()]
}

// ── Preprocessing LLM — Pass 2: estrai contenuto per entità ──────────────────

async function extractEntityContent(type, name, textChunks) {
  // Usa solo i chunk che menzionano l'entità; fallback ai primi 2 chunk
  const lowerName = name.toLowerCase()
  const relevant = textChunks.filter(c => c.toLowerCase().includes(lowerName))
  const context = (relevant.length > 0 ? relevant : textChunks.slice(0, 2)).join('\n\n---\n\n')

  return ollama.runTextPhase(
    DEFAULT_HEAVY_MODEL,
    'rag_pass2_estrai.md',
    { tipo: type, nome: name, testo_estratto: context }
  )
}

// ── Pipeline completa: preprocessing LLM → chunks ────────────────────────────

async function preprocessModuleWithLLM(chapterText, chapterNumber = 1) {
  const textChunks = splitTextIntoChunks(chapterText)
  console.log(`[RAG] Testo diviso in ${textChunks.length} chunk preliminari`)

  // Pass 1: un tipo alla volta, su tutti i chunk
  console.log('[RAG] Pass 1 — identificazione entità per tipo...')
  const allEntities = []
  for (const type of Object.keys(TYPE_CONFIG)) {
    const found = await extractEntitiesForType(type, textChunks)
    console.log(`[RAG] Pass 1 "${type}": ${found.length} entità trovate`)
    allEntities.push(...found)
  }

  if (!allEntities.length) {
    console.warn('[RAG] Pass 1 non ha prodotto entità, uso fallback paragrafi')
    return splitIntoChunks(chapterText, chapterNumber)
  }

  console.log(`[RAG] Pass 1 completato: ${allEntities.length} entità totali`)

  const deduplicated = deduplicateEntities(allEntities)
  console.log(`[RAG] Dopo deduplicazione: ${deduplicated.length} entità uniche`)
  const entities = deduplicated

  // Pass 2: estrai contenuto per ogni entità con contesto mirato
  const chunks = []
  for (let i = 0; i < entities.length; i++) {
    const { type, name } = entities[i]
    console.log(`[RAG] Pass 2 [${i + 1}/${allEntities.length}] — ${type} | ${name}`)
    try {
      const content = await extractEntityContent(type, name, textChunks)
      if (content?.trim()) {
        chunks.push({
          id:      `chunk_${String(i).padStart(3, '0')}`,
          type,
          name,
          chapter: chapterNumber,
          content: content.trim()
        })
      } else {
        console.warn(`[RAG] Contenuto vuoto per "${name}", chunk ignorato`)
      }
    } catch (err) {
      console.warn(`[RAG] Pass 2 fallito per "${name}":`, err.message)
    }
  }

  console.log(`[RAG] Pass 2 completato: ${chunks.length}/${entities.length} chunk generati`)
  return chunks
}

// ── Module indexing ───────────────────────────────────────────────────────────

/**
 * Indicizza un array di chunk già pronti (con type, name, chapter, content).
 * Chiamato internamente da indexModule e, in Fase 4, dal preprocessing LLM.
 */
async function indexModuleChunks(moduleId, chunks) {
  console.log(`[RAG] Inizio embedding di ${chunks.length} chunk per modulo ${moduleId}`)
  const embeddedChunks = []

  for (const chunk of chunks) {
    try {
      const embedding = await embed(buildEmbedText(chunk))
      embeddedChunks.push({ ...chunk, embedding })
    } catch (err) {
      console.warn(`[RAG] Embedding fallito per chunk "${chunk.name}":`, err.message)
    }
  }

  const index = {
    moduleId,
    embedModel: EMBED_MODEL,
    indexedAt: new Date().toISOString(),
    chunks: embeddedChunks
  }
  await saveIndex(moduleIndexPath(moduleId), index)
  console.log(`[RAG] Modulo ${moduleId}: ${embeddedChunks.length}/${chunks.length} chunk indicizzati`)
  return embeddedChunks.length
}

/**
 * Pipeline completa: approccio ibrido semantico + raw.
 *
 * 1. Chunk speciali: ambientazione pre-generata se disponibile (type: 'ambientazione')
 * 2. Chunk semantici (LLM pass1+pass2): location e personaggi estratti → alta precisione
 * 3. Chunk raw: sezioni naturali del testo originale → copertura totale
 *
 * Se DEFAULT_HEAVY_LLM_MODEL non è configurato, produce solo chunk speciali + raw.
 */
async function indexModule(moduleId, chapterText, chapterNumber = 1) {
  const allChunks = []

  // Carica titolo del modulo per arricchire l'header di embedding
  let moduleTitle = ''
  try {
    const modRaw = await fs.readFile(path.join(DATA_DIR, 'modules', `${moduleId}.json`), 'utf-8')
    moduleTitle = JSON.parse(modRaw).title || ''
  } catch { /* non critico */ }

  // Helper: aggiunge moduleTitle e chapter ai chunk prima dell'indicizzazione
  const tag = chunk => ({ ...chunk, moduleTitle, chapter: chunk.chapter ?? chapterNumber })

  // 1. Chunk speciali: ambientazione pre-generata
  const ambientazionePath = path.join(DATA_DIR, 'modules', `${moduleId}_ambientazione.txt`)
  try {
    const ambText = await fs.readFile(ambientazionePath, 'utf-8')
    if (ambText.trim()) {
      allChunks.push(tag({
        id:      'special_ambientazione',
        type:    'ambientazione',
        name:    'Ambientazione',
        content: ambText.trim()
      }))
      console.log(`[RAG] Chunk "Ambientazione" aggiunto dall'ambientazione pre-generata`)
    }
  } catch { /* file non ancora generato, ignorato */ }

  // 2. Chunk semantici (LLM)
  if (DEFAULT_HEAVY_MODEL) {
    try {
      const semanticChunks = await preprocessModuleWithLLM(chapterText, chapterNumber)
      allChunks.push(...semanticChunks.map(tag))
    } catch (err) {
      console.warn(`[RAG] Preprocessing LLM fallito per ${moduleId}:`, err.message)
    }
  } else {
    console.warn('[RAG] DEFAULT_HEAVY_LLM_MODEL non configurato, solo chunk raw')
  }

  // 3. Chunk raw (testo originale suddiviso per sezioni)
  const rawChunks = splitIntoRawChunks(chapterText)
  console.log(`[RAG] ${rawChunks.length} chunk raw generati`)
  allChunks.push(...rawChunks.map(tag))

  return indexModuleChunks(moduleId, allChunks)
}

/**
 * Indicizza il file avviare_la_sessione.txt nel RAG del tavolo.
 * Chiamato da custodeEngine dopo la generazione del file (Fase 4).
 */
async function indexSessionIntro(tableId, introText) {
  const indexPath = tableIndexPath(tableId)
  const index = await loadIndex(indexPath)

  // Rimuovi eventuale chunk precedente (un solo chunk "Prima Sessione" per tavolo)
  index.chunks = index.chunks.filter(c => c.id !== 'special_prima_sessione')

  let embedding
  try {
    embedding = await embed(introText)
  } catch (err) {
    console.warn(`[RAG] Embedding Prima Sessione fallito per tavolo ${tableId}:`, err.message)
    return
  }

  index.chunks.push({
    id:      'special_prima_sessione',
    type:    'prima_sessione',
    name:    'Prima Sessione',
    content: introText,
    embedding,
    addedAt: new Date().toISOString()
  })

  await saveIndex(indexPath, index)
  console.log(`[RAG] Chunk "Prima Sessione" indicizzato per tavolo ${tableId}`)
}

/**
 * Aggiunge o aggiorna il chunk "Ambientazione" nell'indice esistente del modulo,
 * senza rieseguire il preprocessing completo.
 */
async function indexAmbientazione(moduleId, ambientazioneText) {
  const indexPath = moduleIndexPath(moduleId)
  const index = await loadIndex(indexPath)

  // Rimuovi eventuale chunk precedente
  index.chunks = index.chunks.filter(c => c.id !== 'special_ambientazione')

  let embedding
  try {
    embedding = await embed(ambientazioneText)
  } catch (err) {
    console.warn(`[RAG] Embedding Ambientazione fallito per modulo ${moduleId}:`, err.message)
    return
  }

  index.chunks.unshift({
    id:      'special_ambientazione',
    type:    'ambientazione',
    name:    'Ambientazione',
    content: ambientazioneText,
    embedding,
    addedAt: new Date().toISOString()
  })

  index.moduleId = moduleId
  await saveIndex(indexPath, index)
  console.log(`[RAG] Chunk "Ambientazione" aggiornato per modulo ${moduleId}`)
}

async function deleteModuleIndex(moduleId) {
  try {
    await fs.rm(moduleRagDir(moduleId), { recursive: true, force: true })
    console.log(`[RAG] Indice modulo ${moduleId} eliminato`)
  } catch (err) {
    console.warn(`[RAG] Errore eliminazione indice ${moduleId}:`, err.message)
  }
}

/**
 * Recupera i topK chunk più rilevanti per una query testuale.
 * Restituisce array di { type, name, chapter, content, score }.
 */
async function queryModule(moduleId, queryText, topK = RAG_TOP_K) {
  const indexPath = moduleIndexPath(moduleId)
  if (!await fileExists(indexPath)) return []

  const index = await loadIndex(indexPath)
  if (!index.chunks?.length) return []

  const queryEmbedding = await embed(queryText)

  return index.chunks
    .map(chunk => ({
      type:    chunk.type,
      name:    chunk.name,
      chapter: chunk.chapter,
      content: chunk.content,
      score:   cosineSimilarity(queryEmbedding, chunk.embedding)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

// ── Table (diary) indexing ────────────────────────────────────────────────────

/**
 * Aggiunge una voce di diario all'indice RAG del tavolo.
 * Chiamato da custodeEngine.appendDiary() in Fase 4.
 */
async function indexDiaryEntry(tableId, entryText) {
  const indexPath = tableIndexPath(tableId)
  const index = await loadIndex(indexPath)

  let embedding
  try {
    embedding = await embed(entryText)
  } catch (err) {
    console.warn(`[RAG] Embedding diary entry fallito per tavolo ${tableId}:`, err.message)
    return
  }

  index.chunks.push({
    id:      `diary_${Date.now()}`,
    type:    'diario',
    name:    `Voce ${new Date().toLocaleDateString('it-IT')}`,
    content: entryText,
    embedding,
    addedAt: new Date().toISOString()
  })

  await saveIndex(indexPath, index)
}

/**
 * Recupera i topK chunk più rilevanti dall'indice del tavolo (diary + scene).
 * Restituisce array di { type, name, content, score }.
 */
async function queryTable(tableId, queryText, topK = RAG_TOP_K) {
  const indexPath = tableIndexPath(tableId)
  if (!await fileExists(indexPath)) return []

  const index = await loadIndex(indexPath)
  if (!index.chunks?.length) return []

  const queryEmbedding = await embed(queryText)

  return index.chunks
    .map(chunk => ({
      type:    chunk.type,
      name:    chunk.name,
      content: chunk.content,
      score:   cosineSimilarity(queryEmbedding, chunk.embedding)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

module.exports = {
  indexModule,
  indexModuleChunks,
  indexAmbientazione,
  deleteModuleIndex,
  queryModule,
  indexSessionIntro,
  indexDiaryEntry,
  queryTable,
  // Esposto solo per test
  _test: { extractEntitiesForType, deduplicateEntities, splitTextIntoChunks, splitIntoRawChunks, rawChunksToTextArray },
  _typeConfig: TYPE_CONFIG
}
