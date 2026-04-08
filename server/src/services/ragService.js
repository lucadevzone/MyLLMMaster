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
const RAG_TOP_K_BASE = parseInt(process.env.RAG_TOP_K_BASE || '5')
const RAG_TOP_K_L1 = parseInt(process.env.RAG_TOP_K_L1 || '3')
const RAG_TOP_K_L2 = parseInt(process.env.RAG_TOP_K_L2 || '1')
const RAG_CASCADE_MAX_TAGS = parseInt(process.env.RAG_CASCADE_MAX_TAGS || '5')
const RAG_CATEGORY_TOP_K_PER_TAG = parseInt(process.env.RAG_CATEGORY_TOP_K_PER_TAG || '1')
const RAG_CATEGORY_MAX_TAGS = parseInt(process.env.RAG_CATEGORY_MAX_TAGS || '8')
const RAG_ITERATE_MAX_ITEMS = parseInt(process.env.RAG_ITERATE_MAX_ITEMS || '8')
const DEFAULT_LLM_MODEL = process.env.DEFAULT_LLM_MODEL
const PRELIM_CHUNK_SIZE = parseInt(process.env.RAG_CHUNK_SIZE || '3000')
const PRELIM_CHUNK_OVERLAP = parseInt(process.env.RAG_CHUNK_OVERLAP || '200')
const TAG_CHUNK_SIZE = parseInt(
  process.env.RAG_TAG_CHUNK_SIZE || String(Math.max(1000, Math.floor(PRELIM_CHUNK_SIZE * 2 / 3)))
)

const TAG_EXTRACTION_PROMPTS = {
  location: 'rag_pass1_tags_location.md',
  personaggio: 'rag_pass1_tags_personaggio.md',
  indizio: 'rag_pass1_tags_indizio.md'
}

// Etichette leggibili usate nell'header di embedding per migliorare il retrieval
// con query categoriali ("personaggi non giocanti", "luoghi dell'atto I", ecc.)
const TYPE_LABELS = {
  location:      'Luogo',
  personaggio:   'Personaggio non giocante',
  ambientazione: 'Ambientazione del modulo',
  raw:           'Sezione del modulo',
  diario:        'Diario di sessione',
  prima_sessione: 'Prima sessione',
  scene_progressione: 'Progressione scena',
  scene_conclusione: 'Conclusione scena'
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
  if (chunk.sequenceNumber) parts.push(`[Sequenza ${chunk.sequenceNumber}]`)
  if (chunk.sceneId)       parts.push(`[Scena ${chunk.sceneId}]`)
  let text = parts.join(' ') + '\n' + chunk.content
  if (chunk.relatedTags?.length) {
    text += '\nRicerche correlate: ' + chunk.relatedTags.map(t => `[${t}]`).join(' ')
  }
  if (chunk.relatedTagsDetailed?.length) {
    text += '\nTag semantici: ' + chunk.relatedTagsDetailed
      .map(tag => `[${tag.type || 'tag'}: ${tag.canonical}]`)
      .join(' ')
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
  const tagMap = new Map() // normalizedTag -> { canonical, type }

  for (const tag of tagCatalog || []) {
    const canonical = String(tag.canonical || '').trim()
    if (!canonical) continue
    const type = String(tag.type || '').trim()

    const candidates = [canonical, ...(tag.aliases || [])]
    for (const candidate of candidates) {
      const normalized = normalizeText(candidate)
      if (!normalized || normalized.length < MIN_TAG_LENGTH) continue
      tagMap.set(normalized, { canonical, type })
    }
  }

  return tagMap
}

function annotateChunksWithTagCatalog(chunks, tagCatalog) {
  const tagMap = buildTagCatalogMap(tagCatalog)
  if (!tagMap.size) return chunks

  return chunks.map(chunk => {
    const normalizedContent = normalizeText(chunk.content)
    const related = new Map() // canonical -> type

    for (const [normalizedTag, tagInfo] of tagMap) {
      if (containsWholeTag(normalizedContent, normalizedTag)) {
        related.set(tagInfo.canonical, tagInfo.type)
      }
    }

    if (!related.size) return chunk
    const relatedTagsDetailed = [...related.entries()]
      .map(([canonical, type]) => ({ canonical, type }))
      .sort((a, b) =>
        (a.type || '').localeCompare(b.type || '', 'it') ||
        a.canonical.localeCompare(b.canonical, 'it')
      )

    return {
      ...chunk,
      relatedTags: [...related.keys()].sort((a, b) => a.localeCompare(b, 'it')),
      relatedTagsDetailed
    }
  })
}

function annotateRawChunksWithTagCatalog(rawChunks, tagCatalog) {
  return annotateChunksWithTagCatalog(rawChunks, tagCatalog)
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function moduleRagDir(moduleId) {
  return path.join(DATA_DIR, 'modules', `${moduleId}_rag`)
}

function moduleIndexPath(moduleId) {
  return path.join(moduleRagDir(moduleId), 'index.json')
}

function moduleTagCatalogPath(moduleId) {
  return path.join(moduleRagDir(moduleId), 'tag_catalog.json')
}

function moduleAnnotatedRawDebugPath(moduleId) {
  return path.join(moduleRagDir(moduleId), 'annotated_raw_chunks.debug.json')
}

function tableRagDir(tableId) {
  return path.join(DATA_DIR, 'tables', tableId, 'rag')
}

function tableIndexPath(tableId) {
  return path.join(tableRagDir(tableId), 'index.json')
}

function splitSceneListField(value) {
  const items = Array.isArray(value)
    ? value
    : String(value || '').split(/[\n,;]+/)
  return items
    .map(item => String(item || '').replace(/^[-*]\s*/, '').trim())
    .filter(item => item && item.length <= 80)
}

function buildSceneRelatedTags(scene) {
  const tags = new Set()
  for (const field of [
    scene?.id_scena,
    scene?.contesto_dove,
    ...splitSceneListField(scene?.PNG),
    ...splitSceneListField(scene?.opportunita),
    ...splitSceneListField(scene?.minacce),
    ...splitSceneListField(scene?.indizi)
  ]) {
    const clean = String(field || '').trim()
    if (clean) tags.add(clean)
  }
  return [...tags]
}

function buildSceneProgressioneChunk(scene, moduleTitle = '') {
  const progressione = String(scene?.progressione || '').trim() || '(nessuna progressione ancora)'
  return {
    id: `scene_${scene.id_scena}_progressione`,
    type: 'scene_progressione',
    name: `Scena ${scene.id_scena}`,
    sceneId: scene.id_scena,
    sessionNumber: scene.sessionNumber || 0,
    sequenceNumber: scene.sequenceNumber || 0,
    moduleTitle,
    relatedTags: buildSceneRelatedTags(scene),
    content: [
      `Dove: ${scene.contesto_dove || 'sconosciuto'}`,
      `Quando: ${scene.momento_corrente || 'non specificato'}`,
      `Scena: ${scene.id_scena}`,
      '',
      'Progressione:',
      progressione
    ].join('\n')
  }
}

function buildSceneConclusioneChunk(scene, moduleTitle = '') {
  const summary = String(scene?.progressione || '').trim()
  if (!summary) return null
  const suggestion = String(scene?.suggerimento_prossima_scena || '').trim()
  const lines = [
    `Dove: ${scene.contesto_dove || 'sconosciuto'}`,
    `Quando: ${scene.momento_corrente || 'non specificato'}`,
    `Scena: ${scene.id_scena}`,
    '',
    'Conclusione:',
    summary
  ]
  if (suggestion) {
    lines.push('', 'Suggerimento prossima scena:', suggestion)
  }
  return {
    id: `scene_${scene.id_scena}_conclusione`,
    type: 'scene_conclusione',
    name: `Conclusione ${scene.id_scena}`,
    sceneId: scene.id_scena,
    sessionNumber: scene.sessionNumber || 0,
    sequenceNumber: scene.closingSequenceNumber || scene.sequenceNumber || 0,
    moduleTitle,
    relatedTags: buildSceneRelatedTags(scene),
    content: lines.join('\n')
  }
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
      relatedTagsDetailed: chunk.relatedTagsDetailed,
      score:       cosineSimilarity(queryEmbedding, chunk.embedding)
    }))
    .sort((a, b) => b.score - a.score)

  return topK == null ? scored : scored.slice(0, topK)
}

function getMatchedCatalogTags(queryText, tagCatalogPayload) {
  const tags = Array.isArray(tagCatalogPayload?.tags) ? tagCatalogPayload.tags : []
  if (!tags.length) return []

  const normalizedQuery = normalizeText(queryText)
  if (!normalizedQuery) return []

  const matched = new Map()
  for (const tag of tags) {
    const canonical = String(tag.canonical || '').trim()
    if (!canonical) continue
    const candidates = [canonical, ...(tag.aliases || [])]
    for (const candidate of candidates) {
      if (containsWholeTag(normalizedQuery, candidate)) {
        matched.set(canonical, {
          type: String(tag.type || '').trim(),
          canonical
        })
        break
      }
    }
  }
  return [...matched.values()]
}

function getCanonicalTagsFromQuery(queryText, tagCatalogPayload) {
  return getMatchedCatalogTags(queryText, tagCatalogPayload).map(tag => tag.canonical)
}

function tokenizeForRetrieval(text) {
  return normalizeText(text)
    .split(' ')
    .filter(token => token && token.length >= 3 && !STOP_WORDS.has(token))
}

function countUniqueOverlap(a, b) {
  const setA = new Set(a)
  const setB = new Set(b)
  let count = 0
  for (const item of setA) {
    if (setB.has(item)) count++
  }
  return count
}

function isMetaChunkName(name) {
  const normalized = normalizeText(name)
  return [
    'rivelazione opzionale',
    'uso del soprannaturale',
    'guida i pg verso questi punti',
    'come interpretare i png'
  ].includes(normalized)
}

function getTagTypeMap(tagCatalogPayload) {
  const tags = Array.isArray(tagCatalogPayload?.tags) ? tagCatalogPayload.tags : []
  const map = new Map()
  for (const tag of tags) {
    const canonical = String(tag.canonical || '').trim()
    const type = String(tag.type || '').trim()
    if (canonical && type) map.set(canonical, type)
  }
  return map
}

function inferQueryCategory(queryTerms) {
  const hasAny = (...terms) => terms.some(term => queryTerms.includes(term))
  if (hasAny('location', 'locations', 'luogo', 'luoghi')) return 'location'
  if (hasAny('personaggio', 'personaggi', 'png', 'npc', 'npcs')) return 'personaggio'
  if (hasAny('indizio', 'indizi', 'oggetto', 'oggetti', 'reperto', 'reperti')) return 'indizio'
  return ''
}

function getCategoryQueryLabel(mode, filterText = '') {
  const normalized = String(mode || '').trim().toLowerCase()
  const base =
    normalized === 'locations' ? 'luoghi del modulo' :
    normalized === 'personaggi' ? 'personaggi del modulo' :
    normalized === 'indizi' ? 'indizi del modulo' :
    normalized
  return filterText ? `${base} ${filterText}` : base
}

function isSpecificEntityLikeQuery(queryText, explicitCategory) {
  const normalized = String(queryText || '').trim()
  if (!normalized) return false
  if (explicitCategory) return false
  if (/[,;]/.test(normalized)) return false
  return tokenizeForRetrieval(normalized).length >= 1
}

function rerankModuleResults(results, queryText, tagCatalogPayload, topK = RAG_TOP_K_BASE) {
  if (!Array.isArray(results) || !results.length) return []

  const queryTerms = tokenizeForRetrieval(queryText)
  const matchedCatalogTags = getMatchedCatalogTags(queryText, tagCatalogPayload)
  const matchedCanonicals = new Set(matchedCatalogTags.map(tag => tag.canonical))
  const tagTypeMap = getTagTypeMap(tagCatalogPayload)
  const explicitCategory = inferQueryCategory(queryTerms)
  const strictEntityQuery = isSpecificEntityLikeQuery(queryText, explicitCategory)
  const normalizedQuery = normalizeText(queryText)
  const locationLikeQuery = explicitCategory === 'location'
    || matchedCatalogTags.some(tag => tag.type === 'location')
    || queryTerms.some(term => ['via', 'piazza', 'porto', 'isola', 'museo', 'palais', 'hotel', 'villa', 'grand'].includes(term))

  return results
    .map(result => {
      const relatedTags = Array.isArray(result.relatedTags) ? result.relatedTags : []
      const relatedTagsDetailed = Array.isArray(result.relatedTagsDetailed) ? result.relatedTagsDetailed : []
      const detailedTags = relatedTagsDetailed.length
        ? relatedTagsDetailed
        : relatedTags.map(canonical => ({
            canonical,
            type: tagTypeMap.get(canonical) || ''
          }))
      const normalizedName = normalizeText(result.name)
      const lexicalHaystack = tokenizeForRetrieval([
        result.name,
        ...relatedTags,
        String(result.content || '').slice(0, 500)
      ].join(' '))

      const lexicalOverlap = countUniqueOverlap(queryTerms, lexicalHaystack)
      const lexicalScore = Math.min(1, lexicalOverlap / Math.max(1, Math.min(4, queryTerms.length || 1)))

      const directTagMatches = relatedTags.filter(tag => matchedCanonicals.has(tag)).length
      const fuzzyTagMatches = relatedTags.filter(tag => containsWholeTag(normalizeText(queryText), tag)).length
      const tagMatchScore = Math.min(1, directTagMatches * 1 + fuzzyTagMatches * 0.6)

      const contentHasQuery = containsWholeTag(normalizeText(result.content), queryText)
      const tagsHaveQuery = relatedTags.some(tag => containsWholeTag(normalizedQuery, tag))
      const strictEntityScore = strictEntityQuery
        ? ((contentHasQuery ? 0.6 : 0) + (tagsHaveQuery ? 0.4 : 0))
        : 0
      const strictEntityPenalty = strictEntityQuery && strictEntityScore === 0 ? 0.18 : 0

      let categoryScore = 0
      if (explicitCategory) {
        const typedCount = detailedTags.filter(tag => tag.type === explicitCategory).length
        categoryScore = Math.min(1, typedCount / 2)
      }

      let nameMatchScore = 0
      if (containsWholeTag(normalizedName, queryText) || containsWholeTag(normalizeText(queryText), result.name)) {
        nameMatchScore = 1
      } else {
        const nameTerms = tokenizeForRetrieval(result.name)
        const nameOverlap = countUniqueOverlap(queryTerms, nameTerms)
        nameMatchScore = Math.min(1, nameOverlap / Math.max(1, Math.min(3, nameTerms.length || 1)))
      }

      let metaPenalty = 0
      if (locationLikeQuery && isMetaChunkName(result.name)) metaPenalty = 0.12

      const finalScore =
        (result.score || 0) * 0.44 +
        tagMatchScore * 0.20 +
        strictEntityScore * 0.18 +
        categoryScore * 0.12 +
        nameMatchScore * 0.10 +
        lexicalScore * 0.06 -
        strictEntityPenalty -
        metaPenalty

      return {
        ...result,
        relatedTagsDetailed: detailedTags,
        score: finalScore
      }
    })
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, topK)
}

async function listModuleCategory(moduleId, mode, filterText = '') {
  const categoryType = getCategoryType(mode)
  if (!categoryType) return []

  const [tagCatalogPayload, index] = await Promise.all([
    loadModuleTagCatalogPayload(moduleId),
    loadIndex(moduleIndexPath(moduleId))
  ])

  const tags = Array.isArray(tagCatalogPayload?.tags)
    ? tagCatalogPayload.tags.filter(tag => tag.type === categoryType)
    : []
  if (!tags.length) return []
  if (!filterText) {
    return tags.map(tag => tag.canonical).sort((a, b) => a.localeCompare(b, 'it'))
  }

  const matchingCanonicals = new Set()
  const chunks = Array.isArray(index.chunks) ? index.chunks : []
  for (const chunk of chunks) {
    if (!chunkMatchesCategoryFilter(chunk, filterText)) continue
    const detailed = Array.isArray(chunk.relatedTagsDetailed) ? chunk.relatedTagsDetailed : []
    for (const tag of detailed) {
      if (tag.type === categoryType) matchingCanonicals.add(tag.canonical)
    }
  }

  return tags
    .map(tag => tag.canonical)
    .filter(canonical => matchingCanonicals.has(canonical))
    .sort((a, b) => a.localeCompare(b, 'it'))
}

async function queryModuleCategory(moduleId, mode, filterText = '', topK = RAG_TOP_K_BASE) {
  const categoryType = getCategoryType(mode)
  if (!categoryType) return []

  const tagCatalogPayload = await loadModuleTagCatalogPayload(moduleId)
  const queryLabel = getCategoryQueryLabel(mode, filterText)
  const baseResults = await queryModule(moduleId, queryLabel, Math.max(topK * 3, 8))
  const filtered = baseResults.filter(result => {
    if (!chunkMatchesCategoryFilter(result, filterText)) return false
    const detailed = Array.isArray(result.relatedTagsDetailed) ? result.relatedTagsDetailed : []
    return detailed.some(tag => tag.type === categoryType)
  })

  return rerankModuleResults(filtered, queryLabel, tagCatalogPayload, topK)
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
          DEFAULT_LLM_MODEL,
          promptFile,
          {
            testo_chunk: textChunks[i],
            known_tags: serializeKnownTagsForPrompt(knownByType[type])
          },
          { num_ctx: ollama.LLM_NUM_CTX }
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

async function loadModuleTagCatalog(moduleId) {
  try {
    const raw = await fs.readFile(moduleTagCatalogPath(moduleId), 'utf-8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
    if (Array.isArray(parsed?.tags)) return parsed.tags
    return []
  } catch {
    return []
  }
}

async function loadModuleTagCatalogPayload(moduleId) {
  try {
    if (!await fileExists(moduleTagCatalogPath(moduleId))) return null
    return JSON.parse(await fs.readFile(moduleTagCatalogPath(moduleId), 'utf-8'))
  } catch {
    return null
  }
}

function getCategoryType(mode) {
  const normalized = String(mode || '').trim().toLowerCase()
  if (normalized === 'locations' || normalized === 'location_list') return 'location'
  if (normalized === 'personaggi' || normalized === 'personaggi_list') return 'personaggio'
  if (normalized === 'indizi' || normalized === 'indizi_list') return 'indizio'
  return ''
}

function matchesFilterText(text, filterText) {
  const normalizedFilter = normalizeText(filterText)
  if (!normalizedFilter) return true
  return containsWholeTag(normalizeText(text), normalizedFilter)
}

function chunkMatchesCategoryFilter(chunk, filterText) {
  const filter = String(filterText || '').trim()
  if (!filter) return true

  const chapterMatch = filter.match(/^capitolo\s+(\d+)$/i)
  if (chapterMatch) {
    return Number(chunk.chapter || 0) === Number(chapterMatch[1])
  }

  const haystack = [
    chunk.name,
    chunk.content,
    ...(chunk.relatedTags || []),
    ...((chunk.relatedTagsDetailed || []).map(tag => `${tag.type} ${tag.canonical}`))
  ].join(' ')

  return matchesFilterText(haystack, filter)
}

function dedupeScoredResults(results) {
  const bestByKey = new Map()
  for (const result of results || []) {
    const key = [
      result.type || '',
      result.name || '',
      result.chapter || '',
      result.sessionNumber || '',
      result.content || ''
    ].join('::')
    const previous = bestByKey.get(key)
    if (!previous || (result.score || 0) > (previous.score || 0)) {
      bestByKey.set(key, result)
    }
  }
  return [...bestByKey.values()].sort((a, b) => (b.score || 0) - (a.score || 0))
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
 * Pipeline completa del modulo.
 *
 * 1. Chunk speciali: ambientazione pre-generata se disponibile
 * 2. Estrazione TAG dal modulo e consolidamento globale
 * 3. Chunk raw del testo originale, annotati con relatedTags dal catalogo consolidato
 *
 * Se DEFAULT_LLM_MODEL non è configurato, produce solo chunk speciali + raw.
 */
async function indexModule(moduleId, chapterSource, chapterNumber = 1) {
  const allChunks = []
  let ambientazioneChunk = null

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
      ambientazioneChunk = tag({
        id:      'special_ambientazione',
        type:    'ambientazione',
        name:    'Ambientazione',
        content: ambText.trim()
      })
      console.log(`[RAG] Chunk "Ambientazione" caricato dall'ambientazione pre-generata`)
    }
  } catch { /* file non ancora generato, ignorato */ }

  const chapters = Array.isArray(chapterSource)
    ? chapterSource.map((chapter, idx) => ({
        content: typeof chapter === 'string' ? chapter : chapter?.content || '',
        chapter: idx + 1
      }))
    : [{ content: chapterSource || '', chapter: chapterNumber }]

  const rawChunksByChapter = []
  let allTagCandidates = []
  let tagCatalog = await loadModuleTagCatalog(moduleId)
  let shouldPersistTagCatalog = false

  if (tagCatalog.length) {
    console.log(`[RAG] Modulo ${moduleId}: riuso catalogo TAG esistente (${tagCatalog.length} TAG)`)
  }

  if (!DEFAULT_LLM_MODEL) {
    console.warn('[RAG] DEFAULT_LLM_MODEL non configurato, solo chunk raw senza catalogo TAG')
  }

  for (const currentChapter of chapters) {
    const text = String(currentChapter.content || '').trim()
    if (!text) continue

    rawChunksByChapter.push({
      chapter: currentChapter.chapter,
      chunks: splitIntoRawChunks(text)
    })

    if (DEFAULT_LLM_MODEL && !tagCatalog.length) {
      try {
        const tagChunks = splitTextIntoTagChunks(text)
        const chapterTags = await extractTagCandidates(tagChunks)
        allTagCandidates.push(...chapterTags)
        console.log(`[RAG] Capitolo ${currentChapter.chapter}: ${chapterTags.length} candidati TAG estratti`)
      } catch (err) {
        console.warn(`[RAG] Tag extraction fallita per ${moduleId} capitolo ${currentChapter.chapter}:`, err.message)
      }
    }
  }

  if (!tagCatalog.length && DEFAULT_LLM_MODEL) {
    tagCatalog = consolidateExtractedTags(allTagCandidates)
    shouldPersistTagCatalog = true
  }

  await ensureDir(moduleRagDir(moduleId))
  if (shouldPersistTagCatalog || !(await fileExists(moduleTagCatalogPath(moduleId)))) {
    await fs.writeFile(
      moduleTagCatalogPath(moduleId),
      JSON.stringify({
        moduleId,
        indexedAt: new Date().toISOString(),
        tags: tagCatalog
      }, null, 2)
    )
  }

  if (tagCatalog.length) {
    console.log(`[RAG] Modulo ${moduleId}: catalogo consolidato con ${tagCatalog.length} TAG`)
  }

  if (ambientazioneChunk) {
    const [annotatedAmbientazione] = tagCatalog.length
      ? annotateChunksWithTagCatalog([ambientazioneChunk], tagCatalog)
      : [{ ...ambientazioneChunk, relatedTags: [], relatedTagsDetailed: [] }]
    allChunks.push(annotatedAmbientazione)
    console.log(`[RAG] Chunk "Ambientazione" aggiunto${annotatedAmbientazione.relatedTags?.length ? ' e annotato' : ''}`)
  }

  const annotatedRawDebug = []
  for (const chapterData of rawChunksByChapter) {
    const annotatedRawChunks = tagCatalog.length
      ? annotateRawChunksWithTagCatalog(chapterData.chunks, tagCatalog)
      : chapterData.chunks.map(chunk => ({ ...chunk, relatedTags: [], relatedTagsDetailed: [] }))
    const enrichedCount = annotatedRawChunks.filter(c => c.relatedTags?.length).length
    console.log(`[RAG] Capitolo ${chapterData.chapter}: ${annotatedRawChunks.length} chunk raw generati (${enrichedCount} annotati con relatedTags)`)
    annotatedRawDebug.push({
      chapter: chapterData.chapter,
      chunks: annotatedRawChunks
    })
    allChunks.push(...annotatedRawChunks.map(chunk => ({
      ...chunk,
      moduleTitle,
      chapter: chapterData.chapter
    })))
  }

  await fs.writeFile(
    moduleAnnotatedRawDebugPath(moduleId),
    JSON.stringify({
      moduleId,
      indexedAt: new Date().toISOString(),
      chapters: annotatedRawDebug
    }, null, 2)
  )

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
  const tagCatalog = await loadModuleTagCatalog(moduleId)

  // Rimuovi eventuale chunk precedente
  index.chunks = index.chunks.filter(c => c.id !== 'special_ambientazione')

  const [chunk] = tagCatalog.length
    ? annotateChunksWithTagCatalog([{
        id: 'special_ambientazione',
        type: 'ambientazione',
        name: 'Ambientazione',
        content: ambientazioneText
      }], tagCatalog)
    : [{
        id: 'special_ambientazione',
        type: 'ambientazione',
        name: 'Ambientazione',
        content: ambientazioneText,
        relatedTags: [],
        relatedTagsDetailed: []
      }]

  let embedding
  try {
    embedding = await embed(buildEmbedText(chunk))
  } catch (err) {
    console.warn(`[RAG] Embedding Ambientazione fallito per modulo ${moduleId}:`, err.message)
    return
  }

  index.chunks.unshift({
    ...chunk,
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
async function queryModule(moduleId, queryText, topK = RAG_TOP_K_BASE) {
  const indexPath = moduleIndexPath(moduleId)
  if (!await fileExists(indexPath)) return []

  const index = await loadIndex(indexPath)
  if (!index.chunks?.length) return []

  const queryEmbedding = await embed(queryText)
  const tagCatalogPayload = await loadModuleTagCatalogPayload(moduleId)
  const scored = scoreChunks(index.chunks, queryEmbedding, null)
  return rerankModuleResults(scored, queryText, tagCatalogPayload, topK)
}

/**
 * Query a cascata su due livelli sul nuovo indice raw-tagged:
 *  Livello 1 — retrieval semantico sui chunk raw
 *  Livello 2 — espansione verso altri chunk raw che condividono relatedTags
 *              con la query o con i risultati del livello 1
 *
 * I risultati vengono poi rerankati con un piccolo boost per i chunk che
 * hanno relatedTags esplicitamente coerenti con la query.
 * Usato con la sintassi {{rag:module:cascade:"query"}} nei prompt.
 */
async function cascadeQueryModule(moduleId, queryText, topK = RAG_TOP_K_BASE) {
  const tagCatalogPayload = await loadModuleTagCatalogPayload(moduleId)
  const level1Base = await queryModule(moduleId, queryText, topK)
  if (!level1Base.length) return []
  const directMatched = getMatchedCatalogTags(queryText, tagCatalogPayload)
  const directQueryTags = new Set(directMatched.map(tag => tag.canonical))
  const directQueryTypes = new Set(directMatched.map(tag => tag.type).filter(Boolean))

  const tagStats = new Map() // canonical -> { canonical, type, count, firstPos, inSeed }
  for (let idx = 0; idx < level1Base.length; idx++) {
    const result = level1Base[idx]
    const detailed = Array.isArray(result.relatedTagsDetailed) ? result.relatedTagsDetailed : []
    const tags = detailed.length
      ? detailed
      : (result.relatedTags || []).map(canonical => ({ canonical, type: '' }))

    for (const tag of tags) {
      const canonical = String(tag.canonical || '').trim()
      if (!canonical) continue
      if (directQueryTags.has(canonical)) continue

      if (!tagStats.has(canonical)) {
        tagStats.set(canonical, {
          canonical,
          type: String(tag.type || '').trim(),
          count: 0,
          firstPos: idx,
          inSeed: idx < Math.min(RAG_TOP_K_L1, level1Base.length)
        })
      }

      const entry = tagStats.get(canonical)
      entry.count += 1
      entry.firstPos = Math.min(entry.firstPos, idx)
      entry.inSeed = entry.inSeed || idx < Math.min(RAG_TOP_K_L1, level1Base.length)
      if (!entry.type && tag.type) entry.type = String(tag.type || '').trim()
    }
  }

  const limitedSeedTags = [...tagStats.values()]
    .sort((a, b) =>
      b.count - a.count ||
      Number((directQueryTypes.size > 0 && directQueryTypes.has(b.type)) || b.inSeed) -
      Number((directQueryTypes.size > 0 && directQueryTypes.has(a.type)) || a.inSeed) ||
      a.firstPos - b.firstPos ||
      a.canonical.localeCompare(b.canonical, 'it')
    )
    .slice(0, RAG_CASCADE_MAX_TAGS)
    .map(entry => entry.canonical)

  const level1Boosted = level1Base.map(result => ({ ...result, score: (result.score || 0) + 0.15 }))
  const level2Collected = []

  for (const tag of limitedSeedTags) {
    const partial = await queryModule(moduleId, tag, RAG_TOP_K_L2)
    for (const result of partial) {
      level2Collected.push({ ...result, score: (result.score || 0) - 0.03 })
    }
  }

  if (limitedSeedTags.length) {
    console.log(`[RAG] Cascade L2: ${limitedSeedTags.length} relatedTags espansi`)
  }

  const dedupedL1 = dedupeScoredResults(level1Boosted)
  const seen = new Set(dedupedL1.map(result => [
    result.type || '',
    result.name || '',
    result.chapter || '',
    result.sessionNumber || '',
    result.content || ''
  ].join('::')))
  const dedupedL2 = dedupeScoredResults(level2Collected).filter(result => {
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

  return [...dedupedL1, ...dedupedL2]
}

async function queryModuleIterate(moduleId, itemsText, topK = RAG_TOP_K_BASE, options = {}) {
  const items = splitSceneListField(itemsText).slice(0, RAG_ITERATE_MAX_ITEMS)
  const collected = []

  for (const item of items) {
    const partial = options.cascade
      ? await cascadeQueryModule(moduleId, item, topK)
      : await queryModule(moduleId, item, topK)
    collected.push(...partial)
  }

  return dedupeScoredResults(collected).slice(0, topK)
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

async function rebuildTableIndex(tableId, moduleTitle = '') {
  const ragDir = tableRagDir(tableId)
  const indexPath = tableIndexPath(tableId)
  const existingIndex = await loadIndex(indexPath)
  const preservedChunks = (existingIndex.chunks || []).filter(chunk => chunk.type === 'prima_sessione')

  const tableDir = path.join(DATA_DIR, 'tables', tableId)
  const sceneFiles = []
  for (const dir of ['active_scenes', 'closed_scenes']) {
    const sceneDir = path.join(tableDir, dir)
    try {
      const files = await fs.readdir(sceneDir)
      for (const file of files.filter(f => f.endsWith('.json'))) {
        sceneFiles.push(path.join(sceneDir, file))
      }
    } catch { /* dir assente */ }
  }

  const scenes = []
  for (const file of sceneFiles) {
    try {
      scenes.push(JSON.parse(await fs.readFile(file, 'utf-8')))
    } catch { /* scena corrotta, ignora */ }
  }

  const sceneChunks = []
  for (const scene of scenes) {
    if (!scene?.id_scena) continue
    sceneChunks.push(buildSceneProgressioneChunk(scene, moduleTitle))
    const finalChunk = buildSceneConclusioneChunk(scene, moduleTitle)
    if (finalChunk) sceneChunks.push(finalChunk)
  }

  const embeddedChunks = [...preservedChunks]
  for (const chunk of sceneChunks) {
    try {
      const embedding = await embed(buildEmbedText(chunk))
      embeddedChunks.push({ ...chunk, embedding })
    } catch (err) {
      console.warn(`[RAG] Embedding tavolo fallito per chunk "${chunk.name}" (${tableId}):`, err.message)
    }
  }

  await ensureDir(ragDir)
  await saveIndex(indexPath, {
    tableId,
    embedModel: EMBED_MODEL,
    indexedAt: new Date().toISOString(),
    chunks: embeddedChunks
  })
  console.log(`[RAG] Tavolo ${tableId}: indice ricostruito con ${embeddedChunks.length} chunk`)
  return embeddedChunks.length
}

/**
 * Recupera i topK chunk più rilevanti dall'indice del tavolo (diary + scene).
 * Restituisce array di { type, name, content, score }.
 */
async function queryTable(tableId, queryText, topK = RAG_TOP_K_BASE) {
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
      sessionNumber: chunk.sessionNumber || 0,
      sequenceNumber: chunk.sequenceNumber || 0,
      sceneId: chunk.sceneId || '',
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
  queryModuleCategory,
  listModuleCategory,
  queryModuleIterate,
  indexSessionIntro,
  indexDiaryEntry,
  rebuildTableIndex,
  queryTable,
  // Esposto solo per test
  _test: {
    splitTextIntoChunks,
    splitTextIntoTagChunks,
    splitIntoRawChunks,
    extractTagCandidates,
    deduplicateTagCandidates,
    serializeKnownTagsForPrompt,
    mergeKnownTags,
    consolidateTagsByType,
    consolidateExtractedTags,
    annotateRawChunksWithTagCatalog
  }
}
