/**
 * Test end-to-end prompt + RAG + Ollama.
 *
 * Genera i prompt completi dopo la risoluzione del RAG per:
 * - fase1a_prima_sessione.md
 * - fase2_opening_new_scene.md
 *
 * Poi invia i prompt a Ollama usando il modello di default configurato in env
 * (`DEFAULT_HEAVY_LLM_MODEL`) e salva su file:
 * - prompt completo
 * - risposta raw della LLM
 * - risposta parse-ata come JSON, se valida
 *
 * Uso:
 *   node test/prompt_rag_ollama_test.js
 *   node test/prompt_rag_ollama_test.js --table tbl_xxx
 *   node test/prompt_rag_ollama_test.js --table tbl_xxx --scene "asta al Grand Palais"
 *   node test/prompt_rag_ollama_test.js --only fase2
 */

'use strict'

require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

const fs = require('fs').promises
const path = require('path')

const rag = require('../src/services/ragService')
const ollama = require('../src/services/ollamaService')
const { DATA_DIR } = require('../src/utils/dataInit')

const OLLAMA_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
const DEFAULT_MODEL = process.env.DEFAULT_HEAVY_LLM_MODEL
const OUTPUT_DIR = path.join(__dirname, 'artifacts_prompt_rag')
const TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '120000', 10)

const RAG_PATTERN = /\{\{rag:(module|table):"([^"]+)"(?::(cascade|iterate))?\}\}/g
const RAG_PROMPT_TOP_K = parseInt(process.env.RAG_PROMPT_TOP_K || '3', 10)
const HEAVY_LLM_NUM_CTX = parseInt(process.env.HEAVY_LLM_NUM_CTX || '8192', 10)

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
    } catch {}
  }
  return raw
    .split(/[\n,;]+/)
    .map(item => item.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
}

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

function formatRagResults(results) {
  if (!results?.length) return '(nessun contesto disponibile)'
  return results
    .map(r => `[${r.type}] ${r.name}:\n${r.content}`)
    .join('\n\n---\n\n')
}

function buildRagResolver(moduleId, tableId) {
  return async (template, vars) => {
    const matches = [...template.matchAll(RAG_PATTERN)]
    if (!matches.length) return template

    for (const match of matches) {
      const [fullMatch, source, queryTemplate, mode = ''] = match
      let query = queryTemplate
      for (const [key, val] of Object.entries(vars)) {
        const value = typeof val === 'object' ? JSON.stringify(val) : String(val ?? '')
        query = query.replaceAll(`{{${key}}}`, value)
      }

      const isCascade = mode === 'cascade'
      const isIterate = mode === 'iterate'
      let results = []
      if (source === 'module') {
        if (isIterate) {
          for (const item of splitIterateItems(query)) {
            results.push(...await rag.queryModule(moduleId, item, RAG_PROMPT_TOP_K))
          }
          results = dedupeRagResults(results)
        } else {
          results = isCascade
            ? await rag.cascadeQueryModule(moduleId, query, RAG_PROMPT_TOP_K)
            : await rag.queryModule(moduleId, query, RAG_PROMPT_TOP_K)
        }
      } else if (tableId) {
        if (isIterate) {
          for (const item of splitIterateItems(query)) {
            results.push(...await rag.queryTable(tableId, item, RAG_PROMPT_TOP_K))
          }
          results = dedupeRagResults(results)
        } else {
          results = await rag.queryTable(tableId, query, RAG_PROMPT_TOP_K)
        }
      }

      template = template.replaceAll(fullMatch, formatRagResults(results))
    }

    return template
  }
}

function synthChar(char) {
  const c = char.characteristics || {}
  const desc = char.descrizionePersonale ? ` — ${char.descrizionePersonale}` : ''
  return `${char.name} (${char.profession}, ${char.eta}a)${desc}: ` +
    `FOR${c.FOR} COS${c.COS} DES${c.DES} TAG${c.TAG} INT${c.INT} POT${c.POT} APP${c.APP} EDU${c.EDU} ` +
    `PF${char.derivedAttributes?.hp?.current}/${char.derivedAttributes?.hp?.max} ` +
    `SAN${char.derivedAttributes?.sanita?.current}`
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf-8'))
}

async function listTables() {
  const tablesDir = path.join(DATA_DIR, 'tables')
  let entries = []
  try {
    entries = await fs.readdir(tablesDir, { withFileTypes: true })
  } catch {
    return []
  }

  const tables = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const tablePath = path.join(tablesDir, entry.name, 'table.json')
    try {
      const table = await readJson(tablePath)
      tables.push(table)
    } catch {
      // ignora directory non valide
    }
  }
  return tables
}

async function getTable(tableId = null) {
  if (tableId) {
    return readJson(path.join(DATA_DIR, 'tables', tableId, 'table.json'))
  }
  const tables = await listTables()
  if (!tables.length) throw new Error('Nessun tavolo trovato in data/tables')
  return tables[0]
}

async function getModule(moduleId) {
  return readJson(path.join(DATA_DIR, 'modules', `${moduleId}.json`))
}

async function getCharacters(tableId) {
  const charsDir = path.join(DATA_DIR, 'tables', tableId, 'characters')
  let files = []
  try {
    files = await fs.readdir(charsDir)
  } catch {
    return []
  }

  const chars = []
  for (const file of files.filter(f => f.endsWith('.json'))) {
    chars.push(await readJson(path.join(charsDir, file)))
  }
  return chars
}

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
}

async function callOllamaRaw(model, prompt, expectJson = true) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const body = {
    model,
    prompt,
    stream: false,
    options: { num_ctx: HEAVY_LLM_NUM_CTX }
  }
  if (expectJson) body.format = 'json'

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal
  })
  clearTimeout(timer)

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Ollama HTTP ${res.status}: ${text}`)
  }

  const data = await res.json()
  return data.response?.trim() || ''
}

async function runPhaseArtifact({ outDir, fileBase, prompt, model }) {
  console.log(`[TEST] Invio a Ollama: ${fileBase}`)
  try {
    const raw = await callOllamaRaw(model, prompt, true)
    await writeFile(path.join(outDir, `${fileBase}.response.raw.txt`), raw + '\n')

    const parsed = extractJSON(raw)
    if (parsed) {
      await writeFile(path.join(outDir, `${fileBase}.response.json`), JSON.stringify(parsed, null, 2) + '\n')
    }
    console.log(`[TEST] Risposta ${fileBase} salvata`)
  } catch (err) {
    const message = err.name === 'AbortError'
      ? `Timeout Ollama dopo ${TIMEOUT_MS} ms`
      : err.message
    await writeFile(path.join(outDir, `${fileBase}.error.txt`), message + '\n')
    console.error(`[TEST] ${fileBase} fallita: ${message}`)
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

async function buildPromptArtifacts({ table, moduleData, sceneSuggestion }) {
  const chars = await getCharacters(table.id)
  const schede_PG = chars.length
    ? chars.map(synthChar).join('\n')
    : '(nessuna scheda PG disponibile)'

  const ragResolver = buildRagResolver(moduleData.id, table.id)
  const phase1Vars = { schede_PG }
  const phase2Vars = { suggerimento_scena: sceneSuggestion || 'scena introduttiva' }

  const phase1Prompt = await ollama.loadPrompt('fase1a_prima_sessione.md', phase1Vars, ragResolver)
  const phase2Prompt = await ollama.loadPrompt('fase2_opening_new_scene.md', phase2Vars, ragResolver)

  return {
    phase1Vars,
    phase2Vars,
    phase1Prompt,
    phase2Prompt
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!DEFAULT_MODEL) {
    throw new Error('DEFAULT_HEAVY_LLM_MODEL non configurato nel file .env')
  }

  const table = await getTable(args.table || null)
  const moduleData = await getModule(table.moduleId)
  const sceneSuggestion = args.scene || 'scena introduttiva'
  const only = String(args.only || 'all').toLowerCase()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = path.join(OUTPUT_DIR, `${stamp}_${table.id}`)

  const artifacts = await buildPromptArtifacts({ table, moduleData, sceneSuggestion })

  const manifest = {
    generatedAt: new Date().toISOString(),
    tableId: table.id,
    moduleId: moduleData.id,
    moduleTitle: moduleData.title,
    model: DEFAULT_MODEL,
    ollamaUrl: OLLAMA_URL,
    sceneSuggestion,
    only,
    files: {
      phase1Prompt: 'fase1a_prima_sessione.prompt.txt',
      phase1ResponseRaw: 'fase1a_prima_sessione.response.raw.txt',
      phase1ResponseJson: 'fase1a_prima_sessione.response.json',
      phase2Prompt: 'fase2_opening_new_scene.prompt.txt',
      phase2ResponseRaw: 'fase2_opening_new_scene.response.raw.txt',
      phase2ResponseJson: 'fase2_opening_new_scene.response.json'
    }
  }

  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  if (only === 'all' || only === 'fase1a') {
    await writeFile(path.join(outDir, 'fase1a_prima_sessione.prompt.txt'), artifacts.phase1Prompt + '\n')
    console.log(`[TEST] Prompt fase1a salvato in ${path.join(outDir, 'fase1a_prima_sessione.prompt.txt')}`)
  }
  if (only === 'all' || only === 'fase2' || only === 'fase2b') {
    await writeFile(path.join(outDir, 'fase2_opening_new_scene.prompt.txt'), artifacts.phase2Prompt + '\n')
    console.log(`[TEST] Prompt fase2 salvato in ${path.join(outDir, 'fase2_opening_new_scene.prompt.txt')}`)
  }

  if (only === 'all' || only === 'fase1a') {
    await runPhaseArtifact({
      outDir,
      fileBase: 'fase1a_prima_sessione',
      prompt: artifacts.phase1Prompt,
      model: DEFAULT_MODEL
    })
  }
  if (only === 'all' || only === 'fase2' || only === 'fase2b') {
    await runPhaseArtifact({
      outDir,
      fileBase: 'fase2_opening_new_scene',
      prompt: artifacts.phase2Prompt,
      model: DEFAULT_MODEL
    })
  }

  console.log(`[TEST] Modello usato: ${DEFAULT_MODEL}`)
  console.log(`[TEST] Artifacts: ${outDir}`)
}

main().catch(err => {
  console.error(`\n[TEST] Errore: ${err.message}`)
  process.exit(1)
})
