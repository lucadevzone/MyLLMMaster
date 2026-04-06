/**
 * Test RAG — indicizzazione modulo esistente
 * Uso: node test/rag_test.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

const path = require('path')
const fs = require('fs').promises
const ragService = require('../src/services/ragService')

const MODULES_DIR = path.join(__dirname, '../../data/modules')

const {
  splitTextIntoChunks,
  splitTextIntoTagChunks,
  splitIntoRawChunks,
  extractTagCandidates,
  deduplicateTagCandidates,
  consolidateExtractedTags,
  annotateRawChunksWithTagCatalog
} = ragService._test || {}

async function loadModule() {
  const files = (await fs.readdir(MODULES_DIR)).filter(f => f.endsWith('.json') && !f.includes('_rag'))
  if (!files.length) { console.error('Nessun modulo trovato in', MODULES_DIR); process.exit(1) }
  return JSON.parse(await fs.readFile(path.join(MODULES_DIR, files[0]), 'utf-8'))
}

async function runTagExtractionPreview(label, textChunks) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`TAG EXTRACTION PREVIEW — ${label} (${textChunks.length} chunk)\n`)

  const rawCandidates = await extractTagCandidates(textChunks)
  const deduped = deduplicateTagCandidates(rawCandidates)
  const consolidated = consolidateExtractedTags(rawCandidates)

  console.log(`Candidati grezzi: ${rawCandidates.length}`)
  console.log(`Dopo deduplica esatta: ${deduped.length}`)
  console.log(`Dopo consolidamento finale: ${consolidated.length}`)

  const byType = {}
  for (const e of consolidated) {
    if (!byType[e.type]) byType[e.type] = []
    byType[e.type].push(e)
  }
  for (const [type, tags] of Object.entries(byType)) {
    console.log(`\n  [${type}] (${tags.length})`)
    for (const tag of tags) {
      const aliasText = tag.aliases?.length ? ` | alias: ${tag.aliases.join(', ')}` : ''
      console.log(`    - ${tag.canonical}${aliasText}`)
    }
  }
  return consolidated
}

function showRawChunks(chapterText) {
  const chunks = splitIntoRawChunks(chapterText)
  console.log(`\n${'='.repeat(60)}`)
  console.log(`CHUNK RAW — ${chunks.length} chunk (usati come input strategia B)\n`)
  for (const c of chunks) {
    const preview = c.content.replace(/\n/g, ' ').slice(0, 90)
    console.log(`  [${c.id}] "${c.name}" (${c.content.length} char) ${preview}...`)
  }
  return chunks
}

async function rebuildIndex(mod) {
  console.log(`\n${'='.repeat(60)}`)
  console.log('REBUILD INDICE\n')
  const count = await ragService.indexModule(mod.id, mod.chapters || [])
  console.log(`\nIndicizzazione completata: ${count} chunk totali`)
}

async function testQueries(mod, queries) {
  console.log(`\n${'='.repeat(60)}`)
  console.log('TEST QUERY\n')
  for (const q of queries) {
    console.log(`\nQuery: "${q}"`)
    console.log('-'.repeat(50))
    const results = await ragService.queryModule(mod.id, q, 3)
    if (!results.length) { console.log('  (nessun risultato)'); continue }
    for (const r of results) {
      const preview = r.content.replace(/\n/g, ' ').slice(0, 120)
      console.log(`  [${r.type.padEnd(13)}] ${r.name} (score: ${r.score.toFixed(3)})`)
      console.log(`    ${preview}...`)
    }
  }
}

async function runTagExtraction(mod) {
  const chapterText = mod.chapters[0]?.content || ''
  const textChunks = splitTextIntoTagChunks(chapterText)
  console.log(`\n${'='.repeat(60)}`)
  console.log(`TAG EXTRACTION (${textChunks.length} chunk)\n`)

  const rawCandidates = await extractTagCandidates(textChunks)
  const deduped = deduplicateTagCandidates(rawCandidates)

  console.log(`Candidati grezzi: ${rawCandidates.length}`)
  console.log(`Dopo deduplica esatta: ${deduped.length}\n`)

  const byType = {}
  for (const tag of deduped) {
    if (!byType[tag.type]) byType[tag.type] = []
    byType[tag.type].push(tag)
  }

  for (const [type, tags] of Object.entries(byType)) {
    console.log(`[${type}] (${tags.length})`)
    for (const tag of tags) {
      const aliasText = tag.aliases.length ? ` | alias: ${tag.aliases.join(', ')}` : ''
      console.log(`  - ${tag.canonical}${aliasText}`)
    }
    console.log('')
  }
}

async function runAnnotatedRawPreview(mod) {
  const chapterText = mod.chapters[0]?.content || ''
  const rawChunks = splitIntoRawChunks(chapterText)
  const tagChunks = splitTextIntoTagChunks(chapterText)
  const rawCandidates = await extractTagCandidates(tagChunks)
  const consolidated = consolidateExtractedTags(rawCandidates)
  const annotated = annotateRawChunksWithTagCatalog(rawChunks, consolidated)

  console.log(`\n${'='.repeat(60)}`)
  console.log(`RAW ANNOTATI (${annotated.length} chunk)\n`)

  for (const chunk of annotated) {
    const preview = chunk.content.replace(/\n/g, ' ').slice(0, 90)
    const tags = chunk.relatedTags?.length ? chunk.relatedTags.join(', ') : 'nessuno'
    console.log(`  [${chunk.id}] "${chunk.name}"`)
    console.log(`    relatedTags: ${tags}`)
    console.log(`    ${preview}...`)
  }
}

async function main() {
  const mod = await loadModule()
  console.log(`\nModulo: ${mod.title} (${mod.id})`)

  const args = process.argv.slice(2)

  if (args[0] === 'rebuild') {
    await rebuildIndex(mod)
    return
  }

  if (args[0] === 'query') {
    // Modalità query: node rag_test.js query "parola chiave" "altra query"
    const queries = args.slice(1).length ? args.slice(1) : [
      'appartamento di Belloq',
      'Sophia Hapgood',
      'nazisti Kerner',
      'indizi tavoletta',
      'Knossos destinazione',
      'come inizia la sessione'
    ]
    await testQueries(mod, queries)
    return
  }

  if (args[0] === 'tags') {
    await runTagExtraction(mod)
    return
  }

  if (args[0] === 'annotated') {
    await runAnnotatedRawPreview(mod)
    return
  }

  // Default: mostra chunk raw + preview pipeline nuova
  const chapterText = mod.chapters[0]?.content || ''
  const rawChunks = showRawChunks(chapterText)
  const chunksA = splitTextIntoChunks(chapterText)
  await runTagExtractionPreview('chunk tag-aware', chunksA)
  console.log(`\nChunk raw disponibili: ${rawChunks.length}`)
}

main().catch(err => { console.error('\nErrore:', err.message); process.exit(1) })
