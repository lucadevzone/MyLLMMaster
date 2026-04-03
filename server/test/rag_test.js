/**
 * Test RAG — indicizzazione modulo esistente
 * Uso: node test/rag_test.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

const path = require('path')
const fs = require('fs').promises
const ragService = require('../src/services/ragService')

const MODULES_DIR = path.join(__dirname, '../../data/modules')

const { extractEntitiesForType, deduplicateEntities, splitTextIntoChunks, splitIntoRawChunks } = ragService._test || {}

async function loadModule() {
  const files = (await fs.readdir(MODULES_DIR)).filter(f => f.endsWith('.json') && !f.includes('_rag'))
  if (!files.length) { console.error('Nessun modulo trovato in', MODULES_DIR); process.exit(1) }
  return JSON.parse(await fs.readFile(path.join(MODULES_DIR, files[0]), 'utf-8'))
}

async function testPass1Only(chapterText) {
  const textChunks = splitTextIntoChunks(chapterText)
  console.log(`\n${'='.repeat(60)}`)
  console.log(`PASS 1 — Testo diviso in ${textChunks.length} chunk preliminari\n`)

  const allEntities = []
  for (const type of Object.keys(ragService._typeConfig || {})) {
    process.stdout.write(`  "${type}"... `)
    const found = await extractEntitiesForType(type, textChunks)
    console.log(`${found.length} entità`)
    allEntities.push(...found)
  }

  const deduped = deduplicateEntities(allEntities)
  console.log(`\nTotale grezzo: ${allEntities.length} → dopo deduplicazione: ${deduped.length}`)
  console.log('='.repeat(60))

  const byType = {}
  for (const e of deduped) {
    if (!byType[e.type]) byType[e.type] = []
    byType[e.type].push(e.name)
  }
  for (const [type, names] of Object.entries(byType)) {
    console.log(`\n[${type}] (${names.length})`)
    for (const name of names) console.log(`  - ${name}`)
  }
}

function testRawChunks(chapterText) {
  const chunks = splitIntoRawChunks(chapterText)
  console.log(`\n${'='.repeat(60)}`)
  console.log(`CHUNK RAW — ${chunks.length} chunk generati\n`)
  for (const c of chunks) {
    const preview = c.content.replace(/\n/g, ' ').slice(0, 100)
    console.log(`[${c.id}] "${c.name}" (${c.content.length} char)`)
    console.log(`  ${preview}...`)
  }
}

async function main() {
  const mod = await loadModule()
  const chapterText = mod.chapters[0]?.content || ''
  console.log(`\nModulo: ${mod.title} (${mod.id}) — Capitolo 1: ${chapterText.length} caratteri`)

  // Mostra prima i chunk raw (sincrono, veloce)
  testRawChunks(chapterText)

  // Poi il pass1 semantico
  await testPass1Only(chapterText)
}

main().catch(err => { console.error('\nErrore:', err.message); process.exit(1) })
