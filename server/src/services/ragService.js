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
const TAG_CHUNK_SIZE = parseInt(
  process.env.RAG_TAG_CHUNK_SIZE || String(Math.max(1000, Math.floor(PRELIM_CHUNK_SIZE * 2 / 3)))
)

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

const TAG_EXTRACTION_PROMPTS = {
  location: 'rag_pass1_tags_location.md',
  personaggio: 'rag_pass1_tags_personaggio.md',
  indizio: 'rag_pass1_tags_indizio.md'
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
 * Tutti i metadati sono racchiusi in [parentesi quadre] per uniformità e per
 * migliorare il retrieval con query categoriali ("personaggi non giocanti dell'atto I").
 * Il campo `content` rimane invariato per la visualizzazione nei prompt.
 *
 * Formato: [Tipo] [Nome] [Modulo] [Atto N] [Sessione N]
 * Più eventuale footer: Ricerche correlate: [Entità1] [Entità2]
 */
function buildEmbedText(chunk) {
  const typeLabel = TYPE_LABELS[chunk.type] || chunk.type
  const parts = [`[${typeLabel}]`, `[${chunk.name}]`]
  if (chunk.moduleTitle)   parts.push(`[${chunk.moduleTitle}]`)
  if (chunk.chapter)       parts.push(`[Atto ${chunk.chapter}]`)
  if (chunk.sessionNumber) parts.push(`[Sessione ${chunk.sessionNumber}]`)
  let text = parts.join(' ') + '\n' + chunk.content
  if (chunk.relatedTags?.length) {
    text += '\nRicerche correlate: ' + chunk.relatedTags.map(t => `[${t}]`).join(' ')
  }
  return text
}

// ── Tag expansion e arricchimento chunk raw ───────────────────────────────────

const STOP_WORDS = new Set([
  'di','del','della','dello','dei','degli','delle',
  'la','il','lo','le','un','una','e','in','a','da','su','per',
  'du','de','des','le','la'   // francese (moduli ambientati a Parigi, ecc.)
])

const MIN_TAG_LENGTH = 4

function normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function containsWholeTag(normalizedContent, tag) {
  const normalizedTag = normalizeText(tag)
  if (!normalizedTag) return false
  const pattern = new RegExp(`(^|\\s)${escapeRegex(normalizedTag)}(?=\\s|$)`, 'i')
  return pattern.test(normalizedContent)
}

/**
 * Espande un nome di entità in una lista di tag per la rilevazione nei chunk raw.
 * "Sophia Hapgood"          → ["Sophia Hapgood", "Sophia", "Hapgood"]
 * "Biblioteca della Sorbona" → ["Biblioteca della Sorbona", "Biblioteca", "Sorbona"]
 */
function expandEntityTags(name, type) {
  const tags = [name]
  const words = name.split(/[\s,\-]+/).filter(Boolean)

  if (type === 'personaggio') {
    // Ogni parola capitalizzata (nome, cognome, titolo)
    for (const word of words) {
      if (word.length >= MIN_TAG_LENGTH && /^[A-ZÀÈÉÌÒÙÜ]/.test(word))
        tags.push(word)
    }
  } else {
    // Per le location tieni solo token distintivi dal nome originale:
    // niente blacklist manuali, solo parole abbastanza lunghe e con iniziale maiuscola.
    for (const word of words) {
      const lowerWord = word.toLowerCase()
      if (
        word.length >= MIN_TAG_LENGTH &&
        !STOP_WORDS.has(lowerWord) &&
        /^[A-ZÀÈÉÌÒÙÜ]/.test(word)
      ) {
        tags.push(word)
      }
    }
  }

  return [...new Set(tags)]
}

/**
 * Arricchisce i chunk raw aggiungendo `relatedTags` con i nomi canonici
 * delle entità semantiche (location, personaggio) citate nel testo.
 *
 * La rilevazione usa i tag espansi (cerca "Sophia" oltre a "Sophia Hapgood"),
 * ma relatedTags contiene solo il nome canonico completo per non duplicare.
 * L'arricchimento avviene solo nell'embedding — il campo `content` non cambia.
 */
function enrichRawChunks(rawChunks, semanticChunks) {
  // Costruisce la mappa: tag espanso (lowercase) → nome canonico
  const tagMap = new Map()  // normalizedTag → canonicalName
  for (const chunk of semanticChunks) {
    if (chunk.type !== 'location' && chunk.type !== 'personaggio') continue
    for (const tag of expandEntityTags(chunk.name, chunk.type)) {
      const normalizedTag = normalizeText(tag)
      if (!normalizedTag || normalizedTag.length < MIN_TAG_LENGTH) continue
      tagMap.set(normalizedTag, chunk.name)
    }
  }
  if (tagMap.size === 0) return rawChunks

  return rawChunks.map(chunk => {
    const normalizedContent = normalizeText(chunk.content)
    const mentioned = new Set()

    for (const [normalizedTag, canonicalName] of tagMap) {
      if (containsWholeTag(normalizedContent, normalizedTag)) {
        mentioned.add(canonicalName)
      }
    }

    if (!mentioned.size) return chunk
    return { ...chunk, relatedTags: [...mentioned] }
  })
}

function buildTagCatalogMap(tagCatalog) {
  const tagMap = new Map() // normalizedTag -> canonical

  for (const tag of tagCatalog || []) {
    const canonical = String(tag.canonical || '').trim()
    if (!canonical) continue

    const candidates = [canonical, ...(tag.aliases || [])]
    for (const candidate of candidates) {
      const normalized = normalizeText(candidate)
      if (!normalized || normalized.length < MIN_TAG_LENGTH) continue
      tagMap.set(normalized, canonical)
    }
  }

  return tagMap
}

function annotateRawChunksWithTagCatalog(rawChunks, tagCatalog) {
  const tagMap = buildTagCatalogMap(tagCatalog)
  if (!tagMap.size) return rawChunks

  return rawChunks.map(chunk => {
    const normalizedContent = normalizeText(chunk.content)
    const related = new Set()

    for (const [normalizedTag, canonical] of tagMap) {
      if (containsWholeTag(normalizedContent, normalizedTag)) {
        related.add(canonical)
      }
    }

    if (!related.size) return chunk
    return {
      ...chunk,
      relatedTags: [...related].sort((a, b) => a.localeCompare(b, 'it'))
    }
  })
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

function scoreChunks(chunks, queryEmbedding, topK = null) {
  const scored = chunks
    .map(chunk => ({
      type:        chunk.type,
      name:        chunk.name,
      chapter:     chunk.chapter,
      content:     chunk.content,
      relatedTags: chunk.relatedTags,
      score:       cosineSimilarity(queryEmbedding, chunk.embedding)
    }))
    .sort((a, b) => b.score - a.score)

  return topK == null ? scored : scored.slice(0, topK)
}

function deduplicateTagCandidates(candidates) {
  const grouped = new Map()

  for (const candidate of candidates) {
    const type = String(candidate.type || '').trim()
    const canonical = String(candidate.canonical || '').trim()
    if (!type || !canonical) continue

    const key = `${type}::${normalizeText(canonical)}`
    if (!grouped.has(key)) {
      grouped.set(key, {
        type,
        canonical,
        aliases: new Set(),
        evidences: []
      })
    }

    const entry = grouped.get(key)
    for (const alias of candidate.aliases || []) {
      const cleanAlias = String(alias || '').trim()
      if (!cleanAlias) continue
      if (normalizeText(cleanAlias) === normalizeText(canonical)) continue
      entry.aliases.add(cleanAlias)
    }

    const evidence = String(candidate.evidence || '').trim()
    if (evidence && !entry.evidences.includes(evidence)) {
      entry.evidences.push(evidence)
    }
  }

  return [...grouped.values()]
    .map(entry => ({
      type: entry.type,
      canonical: entry.canonical,
      aliases: [...entry.aliases],
      evidences: entry.evidences
    }))
    .sort((a, b) =>
      a.type.localeCompare(b.type, 'it') ||
      a.canonical.localeCompare(b.canonical, 'it')
    )
}

function serializeKnownTagsForPrompt(tags) {
  if (!Array.isArray(tags) || !tags.length) return 'nessun tag noto'
  return tags
    .map(tag => {
      const aliases = Array.isArray(tag.aliases) && tag.aliases.length
        ? ` | aliases: ${tag.aliases.join(', ')}`
        : ''
      return `- canonical: ${tag.canonical}${aliases}`
    })
    .join('\n')
}

function mergeKnownTags(existingTags, newTags, type) {
  const normalizedExisting = (existingTags || []).map(tag => ({ type, ...tag }))
  const normalizedNew = (newTags || []).map(tag => ({ type, ...tag }))
  const merged = deduplicateTagCandidates([...normalizedExisting, ...normalizedNew])
  return merged.map(tag => ({
    canonical: tag.canonical,
    aliases: tag.aliases || [],
    evidences: tag.evidences || []
  }))
}

function tokenizeCanonical(text) {
  return normalizeText(text).split(' ').filter(Boolean)
}

function canonicalScore(tag, type) {
  const canonical = String(tag.canonical || '').trim()
  const tokens = tokenizeCanonical(canonical)
  const tokenCount = tokens.length
  let score = tokenCount * 10 + canonical.length

  if (type === 'personaggio') {
    if (tokenCount >= 2) score += 30
    if (/^(dott|dottssa|dr|prof|professoressa|commissaire|ispettore|monsieur|madame)\b/i.test(normalizeText(canonical))) {
      score += 5
    }
    if (tokenCount === 1) score -= 15
  }

  if (type === 'indizio') {
    if (tokenCount >= 3) score += 10
    if (/(tavoletta|lettera|diario|appunti|amuleto|sigillo|frammento|ricevuta|mappa|rapporto)/i.test(canonical)) {
      score += 8
    }
  }

  if (type === 'location') {
    if (/,/.test(canonical)) score += 5
    if (tokenCount === 1) score -= 2
  }

  return score
}

function areEquivalentTags(a, b, type) {
  const canonA = normalizeText(a.canonical)
  const canonB = normalizeText(b.canonical)
  if (!canonA || !canonB) return false
  if (canonA === canonB) return true

  const aliasesA = new Set((a.aliases || []).map(normalizeText).filter(Boolean))
  const aliasesB = new Set((b.aliases || []).map(normalizeText).filter(Boolean))

  if (type === 'location') {
    return aliasesA.has(canonB) || aliasesB.has(canonA)
  }

  if (aliasesA.has(canonB) || aliasesB.has(canonA)) return true
  for (const alias of aliasesA) {
    if (aliasesB.has(alias)) return true
  }

  const tokensA = tokenizeCanonical(a.canonical)
  const tokensB = tokenizeCanonical(b.canonical)

  if (type === 'personaggio') {
    const setA = new Set(tokensA)
    const setB = new Set(tokensB)
    if (tokensA.length >= 2 && tokensB.length === 1 && setA.has(tokensB[0])) return true
    if (tokensB.length >= 2 && tokensA.length === 1 && setB.has(tokensA[0])) return true

    const strippedA = canonA.replace(/^(dott|dottssa|dr|prof|professoressa|commissaire|ispettore)\s+/i, '')
    const strippedB = canonB.replace(/^(dott|dottssa|dr|prof|professoressa|commissaire|ispettore)\s+/i, '')
    if (strippedA === strippedB) return true
  }

  if (type === 'indizio') {
    if (canonA.includes(canonB) || canonB.includes(canonA)) {
      const shorter = canonA.length < canonB.length ? canonA : canonB
      if (shorter.length >= 12) return true
    }
  }

  return false
}

function chooseBestCanonical(group, type) {
  const sorted = [...group].sort((a, b) => canonicalScore(b, type) - canonicalScore(a, type))
  return sorted[0]
}

function consolidateTagsByType(tags, type) {
  const items = (tags || []).filter(tag => tag.type === type)
  const groups = []

  for (const item of items) {
    const matchingIndexes = []
    for (let idx = 0; idx < groups.length; idx++) {
      if (groups[idx].some(existing => areEquivalentTags(existing, item, type))) {
        matchingIndexes.push(idx)
      }
    }

    if (!matchingIndexes.length) {
      groups.push([item])
      continue
    }

    const mergedGroup = [item]
    for (const idx of matchingIndexes.sort((a, b) => b - a)) {
      mergedGroup.push(...groups[idx])
      groups.splice(idx, 1)
    }
    groups.push(mergedGroup)
  }

  const consolidated = groups.map(group => {
    const best = chooseBestCanonical(group, type)
    const aliasSet = new Set()
    const evidences = []
    const sources = new Set()

    for (const item of group) {
      const candidateCanonical = String(item.canonical || '').trim()
      if (candidateCanonical && normalizeText(candidateCanonical) !== normalizeText(best.canonical)) {
        aliasSet.add(candidateCanonical)
      }
      for (const alias of item.aliases || []) {
        const cleanAlias = String(alias || '').trim()
        if (!cleanAlias) continue
        if (normalizeText(cleanAlias) === normalizeText(best.canonical)) continue
        aliasSet.add(cleanAlias)
      }
      const evidence = String(item.evidence || '').trim()
      if (evidence && !evidences.includes(evidence)) evidences.push(evidence)
      const evidencesList = Array.isArray(item.evidences) ? item.evidences : []
      for (const ev of evidencesList) {
        const cleanEv = String(ev || '').trim()
        if (cleanEv && !evidences.includes(cleanEv)) evidences.push(cleanEv)
      }
      if (item.sourceChunk != null) sources.add(item.sourceChunk)
      for (const src of item.sources || []) {
        if (src != null) sources.add(src)
      }
    }

    return {
      type,
      canonical: best.canonical,
      aliases: [...aliasSet]
        .filter(alias => normalizeText(alias) !== normalizeText(best.canonical))
        .sort((a, b) => a.localeCompare(b, 'it')),
      evidences,
      sources: [...sources].sort((a, b) => a - b)
    }
  }).sort((a, b) => a.canonical.localeCompare(b.canonical, 'it'))

  if (type !== 'location') return consolidated

  const canonicalNorms = new Set(consolidated.map(tag => normalizeText(tag.canonical)))
  const aliasOwners = new Map()

  for (const tag of consolidated) {
    const ownerKey = normalizeText(tag.canonical)
    for (const alias of tag.aliases || []) {
      const aliasNorm = normalizeText(alias)
      if (!aliasNorm) continue
      if (!aliasOwners.has(aliasNorm)) aliasOwners.set(aliasNorm, new Set())
      aliasOwners.get(aliasNorm).add(ownerKey)
    }
  }

  return consolidated.map(tag => ({
    ...tag,
    aliases: (tag.aliases || []).filter(alias => {
      const aliasNorm = normalizeText(alias)
      if (!aliasNorm) return false
      if (aliasNorm === normalizeText(tag.canonical)) return false
      if (canonicalNorms.has(aliasNorm) && aliasNorm !== normalizeText(tag.canonical)) return false
      const owners = aliasOwners.get(aliasNorm)
      if (owners && owners.size > 1) return false
      return true
    })
  }))
}

function consolidateExtractedTags(tags) {
  const types = [...new Set((tags || []).map(tag => tag.type).filter(Boolean))]
  const consolidated = types.flatMap(type => consolidateTagsByType(tags, type))
  return deduplicateTagCandidates(consolidated).map(tag => ({
    type: tag.type,
    canonical: tag.canonical,
    aliases: (tag.aliases || []).filter(alias => normalizeText(alias) !== normalizeText(tag.canonical)),
    evidences: tag.evidences || [],
    sources: [...new Set(tag.sources || [])].sort((a, b) => a - b)
  }))
}

async function extractTagCandidates(textChunks) {
  const allTags = []
  const knownByType = Object.fromEntries(
    Object.keys(TAG_EXTRACTION_PROMPTS).map(type => [type, []])
  )

  for (let i = 0; i < textChunks.length; i++) {
    for (const [type, promptFile] of Object.entries(TAG_EXTRACTION_PROMPTS)) {
      try {
        const result = await ollama.runPhase(
          DEFAULT_HEAVY_MODEL,
          promptFile,
          {
            testo_chunk: textChunks[i],
            known_tags: serializeKnownTagsForPrompt(knownByType[type])
          },
          { num_ctx: ollama.HEAVY_LLM_NUM_CTX }
        )

        const tags = Array.isArray(result?.tags) ? result.tags : []
        for (const tag of tags) {
          allTags.push({
            type,
            ...tag,
            sourceChunk: i
          })
        }
        knownByType[type] = mergeKnownTags(knownByType[type], tags, type)
      } catch (err) {
        console.warn(`[RAG] Tag extraction [${type}] chunk ${i + 1} fallita:`, err.message)
      }
    }
  }

  return allTags
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
//   1. Raggruppa i paragrafi di ogni sezione senza overlap, così il corpus raw
//      resta fedele e non ripete testo tra chunk consecutivi
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

    for (const para of section.paras) {
      if (current.length + para.length > RAW_CHUNK_MAX && current.trim().length > RAW_CHUNK_MIN) {
        chunks.push({
          id:      `raw_${String(idx).padStart(3, '0')}`,
          type:    'raw',
          name:    section.title || `Sezione ${idx + 1}`,
          content: current.trim()
        })
        idx++
        current = header + para
      } else {
        current = current ? current + '\n\n' + para : para
      }
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

function splitTextIntoTagChunks(text) {
  return splitTextIntoChunks(text, TAG_CHUNK_SIZE)
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
    return splitTextIntoChunks(chapterText).map((content, i) => ({
      id:      `fallback_${String(i).padStart(3, '0')}`,
      type:    'raw',
      name:    `Estratto capitolo ${chapterNumber}`,
      chapter: chapterNumber,
      content
    }))
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
async function indexModule(moduleId, chapterSource, chapterNumber = 1) {
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

  const chapters = Array.isArray(chapterSource)
    ? chapterSource.map((chapter, idx) => ({
        content: typeof chapter === 'string' ? chapter : chapter?.content || '',
        chapter: idx + 1
      }))
    : [{ content: chapterSource || '', chapter: chapterNumber }]

  for (const currentChapter of chapters) {
    const text = String(currentChapter.content || '').trim()
    if (!text) continue

    const tagCurrent = chunk => ({ ...chunk, moduleTitle, chapter: chunk.chapter ?? currentChapter.chapter })

    // 2. Chunk semantici (LLM)
    let semanticChunks = []
    if (DEFAULT_HEAVY_MODEL) {
      try {
        semanticChunks = await preprocessModuleWithLLM(text, currentChapter.chapter)
        allChunks.push(...semanticChunks.map(tagCurrent))
      } catch (err) {
        console.warn(`[RAG] Preprocessing LLM fallito per ${moduleId} capitolo ${currentChapter.chapter}:`, err.message)
      }
    } else {
      console.warn('[RAG] DEFAULT_HEAVY_LLM_MODEL non configurato, solo chunk raw')
    }

    // 3. Chunk raw — arricchiti con "Ricerche correlate" dalle entità semantiche
    const rawChunks = enrichRawChunks(splitIntoRawChunks(text), semanticChunks)
    const enrichedCount = rawChunks.filter(c => c.relatedTags?.length).length
    console.log(`[RAG] Capitolo ${currentChapter.chapter}: ${rawChunks.length} chunk raw generati (${enrichedCount} arricchiti con tag correlati)`)
    allChunks.push(...rawChunks.map(tagCurrent))
  }

  return indexModuleChunks(moduleId, allChunks)
}

/**
 * Indicizza la narrativa di apertura sessione nel RAG del tavolo.
 * Chiamato da custodeEngine dopo la generazione della fase1a cache.
 * @param {string} tableId
 * @param {string} introText
 * @param {string} moduleTitle — titolo del modulo per tagging (opzionale)
 */
async function indexSessionIntro(tableId, introText, moduleTitle = '') {
  const indexPath = tableIndexPath(tableId)
  const index = await loadIndex(indexPath)

  // Rimuovi eventuale chunk precedente (un solo chunk "Prima Sessione" per tavolo)
  index.chunks = index.chunks.filter(c => c.id !== 'special_prima_sessione')

  const chunk = {
    id:          'special_prima_sessione',
    type:        'prima_sessione',
    name:        'Prima Sessione',
    moduleTitle,
    content:     introText,
    addedAt:     new Date().toISOString()
  }

  let embedding
  try {
    embedding = await embed(buildEmbedText(chunk))
  } catch (err) {
    console.warn(`[RAG] Embedding Prima Sessione fallito per tavolo ${tableId}:`, err.message)
    return
  }

  index.chunks.push({ ...chunk, embedding })
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
 * Restituisce array di { type, name, chapter, content, relatedTags, score }.
 */
async function queryModule(moduleId, queryText, topK = RAG_TOP_K) {
  const indexPath = moduleIndexPath(moduleId)
  if (!await fileExists(indexPath)) return []

  const index = await loadIndex(indexPath)
  if (!index.chunks?.length) return []

  const queryEmbedding = await embed(queryText)
  return scoreChunks(index.chunks, queryEmbedding, topK)
}

/**
 * Query a cascata su due livelli:
 *  Livello 1 — query semantica normale (topK risultati)
 *  Livello 2 — per ogni relatedTag nei risultati del L1, recupera il chunk
 *              semantico corrispondente (location/personaggio) direttamente
 *              dall'indice per nome, senza ulteriori chiamate embedding.
 *
 * I risultati L2 vengono aggiunti solo se non già presenti nel L1.
 * Usato con la sintassi {{rag:module:cascade:"query"}} nei prompt.
 */
async function cascadeQueryModule(moduleId, queryText, topK = RAG_TOP_K) {
  const indexPath = moduleIndexPath(moduleId)
  if (!await fileExists(indexPath)) return []

  const index = await loadIndex(indexPath)
  if (!index.chunks?.length) return []

  const queryEmbedding = await embed(queryText)
  const rawChunks = index.chunks.filter(chunk => chunk.type === 'raw')

  // Livello 1: raw-first per sfruttare relatedTags come ponte verso i chunk semantici.
  let level1 = scoreChunks(rawChunks, queryEmbedding, topK)

  // Fallback: se il retrieval raw non produce nulla, torna al retrieval misto classico.
  if (!level1.length) {
    console.log('[RAG] Cascade fallback: nessun chunk raw, uso retrieval misto')
    return scoreChunks(index.chunks, queryEmbedding, topK)
  }

  // Livello 2: lookup per nome dei tag correlati trovati nel L1
  const included = new Set(level1.map(r => r.name.toLowerCase()))
  const semanticByName = new Map(
    index.chunks
      .filter(c => c.type === 'location' || c.type === 'personaggio')
      .map(c => [c.name.toLowerCase(), c])
  )

  const level2 = []
  for (const result of level1) {
    for (const tag of result.relatedTags || []) {
      const key = tag.toLowerCase()
      if (!included.has(key) && semanticByName.has(key)) {
        const chunk = semanticByName.get(key)
        level2.push({
          type:    chunk.type,
          name:    chunk.name,
          chapter: chunk.chapter,
          content: chunk.content,
          score:   null   // risultato cascade, non scoring diretto
        })
        included.add(key)
      }
    }
  }

  if (level2.length) {
    console.log(`[RAG] Cascade L2: +${level2.length} chunk da relatedTags`)
  }

  return [...level1, ...level2]
}

// ── Table (diary) indexing ────────────────────────────────────────────────────

/**
 * Aggiunge una voce di diario all'indice RAG del tavolo.
 * Chiamato da custodeEngine.appendDiary().
 * @param {string} tableId
 * @param {string} entryText
 * @param {number} sessionNumber — numero di sessione per tagging (es. [Sessione 3])
 * @param {string} moduleTitle  — titolo del modulo per tagging (opzionale)
 */
async function indexDiaryEntry(tableId, entryText, sessionNumber = 0, moduleTitle = '') {
  const indexPath = tableIndexPath(tableId)
  const index = await loadIndex(indexPath)

  const chunk = {
    id:            `diary_${Date.now()}`,
    type:          'diario',
    name:          `Sessione ${sessionNumber}`,
    sessionNumber,
    moduleTitle,
    content:       entryText,
    addedAt:       new Date().toISOString()
  }

  let embedding
  try {
    embedding = await embed(buildEmbedText(chunk))
  } catch (err) {
    console.warn(`[RAG] Embedding diary entry fallito per tavolo ${tableId}:`, err.message)
    return
  }

  index.chunks.push({ ...chunk, embedding })
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
  cascadeQueryModule,
  indexSessionIntro,
  indexDiaryEntry,
  queryTable,
  // Esposto solo per test
  _test: {
    extractEntitiesForType,
    deduplicateEntities,
    splitTextIntoChunks,
    splitTextIntoTagChunks,
    splitIntoRawChunks,
    rawChunksToTextArray,
    extractTagCandidates,
    deduplicateTagCandidates,
    serializeKnownTagsForPrompt,
    mergeKnownTags,
    consolidateTagsByType,
    consolidateExtractedTags,
    annotateRawChunksWithTagCatalog
  },
  _typeConfig: TYPE_CONFIG
}
