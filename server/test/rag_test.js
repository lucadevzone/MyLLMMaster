/**
 * Test RAG — indicizzazione modulo esistente
 * Uso: node test/rag_test.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

const path = require('path')
const fs = require('fs').promises
const ragService = require('../src/services/ragService')

const MODULES_DIR = path.join(__dirname, '../../data/modules')

const { extractEntitiesForType, deduplicateEntities, splitTextIntoChunks, splitIntoRawChunks, rawChunksToTextArray } = ragService._test || {}

async function loadModule() {
  const files = (await fs.readdir(MODULES_DIR)).filter(f => f.endsWith('.json') && !f.includes('_rag'))
  if (!files.length) { console.error('Nessun modulo trovato in', MODULES_DIR); process.exit(1) }
  return JSON.parse(await fs.readFile(path.join(MODULES_DIR, files[0]), 'utf-8'))
}

async function runPass1(label, textChunks) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`PASS 1 — ${label} (${textChunks.length} chunk)\n`)

  const allEntities = []
  for (const type of Object.keys(ragService._typeConfig || {})) {
    process.stdout.write(`  "${type}"... `)
    const found = await extractEntitiesForType(type, textChunks)
    console.log(`${found.length} entità`)
    allEntities.push(...found)
  }

  const deduped = deduplicateEntities(allEntities)
  console.log(`\nTotale grezzo: ${allEntities.length} → dopo deduplicazione: ${deduped.length}`)

  const byType = {}
  for (const e of deduped) {
    if (!byType[e.type]) byType[e.type] = []
    byType[e.type].push(e.name)
  }
  for (const [type, names] of Object.entries(byType)) {
    console.log(`\n  [${type}] (${names.length})`)
    for (const name of names) console.log(`    - ${name}`)
  }
  return deduped
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

  // Default: mostra chunk raw + pass1 (come prima)
  const chapterText = mod.chapters[0]?.content || ''
  const rawChunks = showRawChunks(chapterText)
  const chunksA = splitTextIntoChunks(chapterText)
  const resultA = await runPass1('Strategia A — paragrafo-aware', chunksA)
  const chunksB = rawChunksToTextArray(rawChunks)
  const resultB = await runPass1('Strategia B — chunk raw', chunksB)

  console.log(`\n${'='.repeat(60)}`)
  console.log('CONFRONTO\n')
  const namesA = new Set(resultA.map(e => e.name.toLowerCase()))
  const namesB = new Set(resultB.map(e => e.name.toLowerCase()))
  const onlyA = resultA.filter(e => !namesB.has(e.name.toLowerCase())).map(e => `${e.name} (${e.type})`)
  const onlyB = resultB.filter(e => !namesA.has(e.name.toLowerCase())).map(e => `${e.name} (${e.type})`)
  const both  = resultA.filter(e =>  namesB.has(e.name.toLowerCase())).map(e => `${e.name} (${e.type})`)
  console.log(`  Comuni (${both.length}):      ${both.join(', ') || '—'}`)
  console.log(`  Solo A (${onlyA.length}):     ${onlyA.join(', ') || '—'}`)
  console.log(`  Solo B (${onlyB.length}):     ${onlyB.join(', ') || '—'}`)
}

main().catch(err => { console.error('\nErrore:', err.message); process.exit(1) })
