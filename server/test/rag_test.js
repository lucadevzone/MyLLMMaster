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

async function main() {
  const mod = await loadModule()
  const chapterText = mod.chapters[0]?.content || ''
  console.log(`\nModulo: ${mod.title} (${mod.id}) — Capitolo 1: ${chapterText.length} caratteri`)

  // Mostra i chunk raw
  const rawChunks = showRawChunks(chapterText)

  // Strategia A: paragrafo-aware (~3000 char, no tagli a metà paragrafo)
  const chunksA = splitTextIntoChunks(chapterText)
  const resultA = await runPass1('Strategia A — paragrafo-aware', chunksA)

  // Strategia B: chunk raw come input (sezione-aware)
  const chunksB = rawChunksToTextArray(rawChunks)
  const resultB = await runPass1('Strategia B — chunk raw', chunksB)

  // Confronto finale
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
