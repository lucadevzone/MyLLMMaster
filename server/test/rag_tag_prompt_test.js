/**
 * Test dedicato per l'estrazione TAG semantici.
 *
 * Per ogni chunk preliminare del modulo salva su file:
 * - chunk sorgente
 * - prompt completo inviato alla LLM
 * - risposta raw della LLM
 * - JSON parse-ato oppure file errore
 *
 * Uso:
 *   node test/rag_tag_prompt_test.js
 *   node test/rag_tag_prompt_test.js --module mod_xxx
 *   node test/rag_tag_prompt_test.js --chapter 1
 *   node test/rag_tag_prompt_test.js --chapter 1 --chunk 1
 *   node test/rag_tag_prompt_test.js --reuse-artifacts /path/to/artifacts_dir
 */

'use strict'

require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

const fs = require('fs').promises
const path = require('path')

const ollama = require('../src/services/ollamaService')
const ragService = require('../src/services/ragService')
const { DATA_DIR } = require('../src/utils/dataInit')

const OLLAMA_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
const DEFAULT_MODEL = process.env.DEFAULT_HEAVY_LLM_MODEL
const TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '120000', 10)
const OUTPUT_DIR = path.join(__dirname, 'artifacts_tag_extraction')
const TAG_PROMPTS = {
  location: 'rag_pass1_tags_location.md',
  personaggio: 'rag_pass1_tags_personaggio.md',
  indizio: 'rag_pass1_tags_indizio.md'
}

const { splitTextIntoTagChunks } = ragService._test || {}
const {
  mergeKnownTags,
  serializeKnownTagsForPrompt,
  consolidateExtractedTags,
  splitIntoRawChunks,
  annotateRawChunksWithTagCatalog
} = ragService._test || {}

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
    options[key] = value
  }
  return options
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf-8'))
}

async function listModules() {
  const modulesDir = path.join(DATA_DIR, 'modules')
  const files = (await fs.readdir(modulesDir)).filter(f => f.endsWith('.json') && !f.includes('_rag'))
  return files.map(file => path.join(modulesDir, file))
}

async function getModule(moduleId = null) {
  if (moduleId) return readJson(path.join(DATA_DIR, 'modules', `${moduleId}.json`))
  const files = await listModules()
  if (!files.length) throw new Error('Nessun modulo trovato in data/modules')
  return readJson(files[0])
}

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
}

async function collectExtractedTagsFromArtifacts(artifactsDir) {
  const extractedTags = []
  const chunkEntries = await fs.readdir(artifactsDir, { withFileTypes: true })

  for (const chunkEntry of chunkEntries) {
    if (!chunkEntry.isDirectory() || !/^chunk_\d+$/.test(chunkEntry.name)) continue
    const sourceChunk = parseInt(chunkEntry.name.replace('chunk_', ''), 10) - 1
    const chunkDir = path.join(artifactsDir, chunkEntry.name)
    const typeEntries = await fs.readdir(chunkDir, { withFileTypes: true })

    for (const typeEntry of typeEntries) {
      if (!typeEntry.isDirectory()) continue
      const responsePath = path.join(chunkDir, typeEntry.name, 'response.json')
      try {
        const parsed = await readJson(responsePath)
        for (const tag of Array.isArray(parsed.tags) ? parsed.tags : []) {
          extractedTags.push({ type: typeEntry.name, ...tag, sourceChunk })
        }
      } catch {
        // ignora sottodirectory senza response valida
      }
    }
  }

  return extractedTags
}

async function annotateRawFromArtifacts(artifactsDir, moduleData, chapterNumber) {
  const consolidatedPath = path.join(artifactsDir, 'consolidated_tags.json')
  const consolidated = await readJson(consolidatedPath)
  const chapterText = moduleData.chapters?.[chapterNumber - 1]?.content || ''
  const rawChunks = splitIntoRawChunks(chapterText)
  const annotated = annotateRawChunksWithTagCatalog(rawChunks, consolidated)

  await writeFile(path.join(artifactsDir, 'annotated_raw_chunks.json'), JSON.stringify(annotated, null, 2) + '\n')
  await writeFile(
    path.join(artifactsDir, 'annotated_raw_chunks.txt'),
    annotated.map(chunk => {
      const tags = chunk.relatedTags?.length ? chunk.relatedTags.join(', ') : 'nessuno'
      return `[${chunk.id}] ${chunk.name}\nrelatedTags: ${tags}\n${chunk.content}\n`
    }).join('\n---\n\n')
  )

  return annotated
}

async function callOllamaRaw(model, prompt, expectJson = true) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const body = {
      model,
      prompt,
      stream: false,
      options: { num_ctx: ollama.HEAVY_LLM_NUM_CTX }
    }
    if (expectJson) body.format = 'json'

    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Ollama HTTP ${res.status}: ${text}`)
    }

    const data = await res.json()
    return data.response?.trim() || ''
  } finally {
    clearTimeout(timer)
  }
}

function extractJSON(text) {
  try { return JSON.parse(text) } catch {}

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()) } catch {}
  }

  const start = text.search(/[{[]/)
  if (start === -1) return null
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let end = -1

  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++
    else if (text[i] === close) {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }

  if (end === -1) return null
  try { return JSON.parse(text.slice(start, end + 1)) } catch { return null }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (typeof consolidateExtractedTags !== 'function') throw new Error('Helper consolidateExtractedTags non disponibile')
  if (typeof splitIntoRawChunks !== 'function') throw new Error('Helper splitIntoRawChunks non disponibile')
  if (typeof annotateRawChunksWithTagCatalog !== 'function') throw new Error('Helper annotateRawChunksWithTagCatalog non disponibile')

  if (args['reuse-artifacts']) {
    const artifactsDir = path.resolve(args['reuse-artifacts'])
    const extractedTags = await collectExtractedTagsFromArtifacts(artifactsDir)
    const consolidated = consolidateExtractedTags(extractedTags)
    await writeFile(path.join(artifactsDir, 'consolidated_tags.json'), JSON.stringify(consolidated, null, 2) + '\n')
    await writeFile(
      path.join(artifactsDir, 'consolidated_tags.txt'),
      consolidated.map(tag => {
        const aliases = tag.aliases.length ? ` | aliases: ${tag.aliases.join(', ')}` : ''
        const sources = tag.sources?.length ? ` | chunks: ${tag.sources.map(s => s + 1).join(', ')}` : ''
        return `[${tag.type}] ${tag.canonical}${aliases}${sources}`
      }).join('\n') + '\n'
    )
    const manifest = await readJson(path.join(artifactsDir, 'manifest.json'))
    const moduleData = await getModule(manifest.moduleId)
    await annotateRawFromArtifacts(artifactsDir, moduleData, manifest.chapterNumber)
    console.log(`[TAG-TEST] Consolidamento offline completato: ${artifactsDir}`)
    return
  }

  if (!DEFAULT_MODEL) throw new Error('DEFAULT_HEAVY_LLM_MODEL non configurato nel file .env')
  if (typeof splitTextIntoTagChunks !== 'function') throw new Error('Helper splitTextIntoTagChunks non disponibile')
  if (typeof mergeKnownTags !== 'function') throw new Error('Helper mergeKnownTags non disponibile')
  if (typeof serializeKnownTagsForPrompt !== 'function') throw new Error('Helper serializeKnownTagsForPrompt non disponibile')

  const moduleData = await getModule(args.module || null)
  const chapterNumber = Math.max(1, parseInt(args.chapter || '1', 10))
  const selectedChunk = args.chunk ? Math.max(1, parseInt(args.chunk, 10)) : null
  const chapterText = moduleData.chapters?.[chapterNumber - 1]?.content || ''
  if (!chapterText.trim()) throw new Error(`Capitolo ${chapterNumber} non disponibile o vuoto`)

  const textChunks = splitTextIntoTagChunks(chapterText)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = path.join(OUTPUT_DIR, `${stamp}_${moduleData.id}_ch${chapterNumber}`)

  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    moduleId: moduleData.id,
    moduleTitle: moduleData.title,
    chapterNumber,
    model: DEFAULT_MODEL,
    ollamaUrl: OLLAMA_URL,
    chunkCount: textChunks.length,
    selectedChunk
  }, null, 2) + '\n')

  console.log(`[TAG-TEST] Modulo: ${moduleData.title} (${moduleData.id})`)
  console.log(`[TAG-TEST] Capitolo: ${chapterNumber}`)
  console.log(`[TAG-TEST] Chunk preliminari: ${textChunks.length}`)
  if (selectedChunk) console.log(`[TAG-TEST] Chunk selezionato: ${selectedChunk}`)

  const knownByType = Object.fromEntries(
    Object.keys(TAG_PROMPTS).map(type => [type, []])
  )
  const extractedTags = []

  for (let i = 0; i < textChunks.length; i++) {
    if (selectedChunk && i + 1 !== selectedChunk) continue

    const chunkId = `chunk_${String(i + 1).padStart(3, '0')}`
    const chunkDir = path.join(outDir, chunkId)
    await writeFile(path.join(chunkDir, 'source.txt'), textChunks[i] + '\n')

    for (const [type, promptFile] of Object.entries(TAG_PROMPTS)) {
      const typeDir = path.join(chunkDir, type)
      const vars = {
        testo_chunk: textChunks[i],
        known_tags: serializeKnownTagsForPrompt(knownByType[type])
      }
      await writeFile(path.join(typeDir, 'known_tags.json'), `${vars.known_tags}\n`)
      const prompt = await ollama.loadPrompt(promptFile, vars)
      await writeFile(path.join(typeDir, 'prompt.txt'), prompt + '\n')

      console.log(`[TAG-TEST] Invio ${chunkId}/${type} a Ollama...`)

      try {
        const raw = await callOllamaRaw(DEFAULT_MODEL, prompt, true)
        await writeFile(path.join(typeDir, 'response.raw.txt'), raw + '\n')

        const parsed = extractJSON(raw)
        if (parsed) {
          await writeFile(path.join(typeDir, 'response.json'), JSON.stringify(parsed, null, 2) + '\n')
          for (const tag of Array.isArray(parsed.tags) ? parsed.tags : []) {
            extractedTags.push({ type, ...tag, sourceChunk: i })
          }
          knownByType[type] = mergeKnownTags(
            knownByType[type],
            Array.isArray(parsed.tags) ? parsed.tags : [],
            type
          )
          await writeFile(
            path.join(typeDir, 'known_tags.updated.txt'),
            serializeKnownTagsForPrompt(knownByType[type]) + '\n'
          )
        } else {
          await writeFile(path.join(typeDir, 'parse.error.txt'), 'Risposta non parseabile come JSON\n')
        }
      } catch (err) {
        const message = err.name === 'AbortError'
          ? `Timeout Ollama dopo ${TIMEOUT_MS} ms`
          : err.message
        await writeFile(path.join(typeDir, 'error.txt'), message + '\n')
        console.error(`[TAG-TEST] ${chunkId}/${type} fallito: ${message}`)
      }
    }
  }

  const consolidated = consolidateExtractedTags(extractedTags)
  await writeFile(path.join(outDir, 'consolidated_tags.json'), JSON.stringify(consolidated, null, 2) + '\n')
  await writeFile(
    path.join(outDir, 'consolidated_tags.txt'),
    consolidated.map(tag => {
      const aliases = tag.aliases.length ? ` | aliases: ${tag.aliases.join(', ')}` : ''
      const sources = tag.sources?.length ? ` | chunks: ${tag.sources.map(s => s + 1).join(', ')}` : ''
      return `[${tag.type}] ${tag.canonical}${aliases}${sources}`
      }).join('\n') + '\n'
  )
  await annotateRawFromArtifacts(outDir, moduleData, chapterNumber)

  console.log(`[TAG-TEST] Artifacts: ${outDir}`)
}

main().catch(err => {
  console.error(`\n[TAG-TEST] Errore: ${err.message}`)
  process.exit(1)
})
