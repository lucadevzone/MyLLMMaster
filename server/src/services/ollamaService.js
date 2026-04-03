const fs = require('fs').promises
const fsSync = require('fs')
const path = require('path')
const { DATA_DIR } = require('../utils/dataInit')

const OLLAMA_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
const MAX_RETRIES = parseInt(process.env.LLM_MAX_RETRIES || '3')
const TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '120000')
const HEAVY_LLM_NUM_CTX = parseInt(process.env.HEAVY_LLM_NUM_CTX || '8192')
const PROMPTS_DIR = path.join(__dirname, '../../../prompts')
const PROMPT_SCHEMAS_DIR = path.join(PROMPTS_DIR, 'schemas')
const schemaCache = new Map()

function tableLogsDir(tableId) {
  return path.join(DATA_DIR, 'tables', tableId, 'logs', 'prompts')
}

// ── LLM logger ────────────────────────────────────────────────────────────────

function llmLog(entry) {
  if (!entry.tableId) return

  const logsDir = tableLogsDir(entry.tableId)
  const phase = (entry.phase || 'unknown').replace(/\.md$/, '').replace(/[^a-z0-9_-]/gi, '_')
  const stamp = buildLogTimestamp(new Date())
  const filename = `${stamp}_${phase}_${entry.attempt}.txt`

  const lines = [
    `model:   ${entry.model}`,
    `phase:   ${entry.phase || '?'}`,
    `attempt: ${entry.attempt}`,
    '',
    '--- PROMPT ---',
    entry.prompt,
    '',
    '--- RESPONSE ---',
    entry.response,
  ]
  if (entry.error) {
    lines.push('', '--- ERROR ---', entry.error)
  }

  fsSync.mkdirSync(logsDir, { recursive: true })
  fsSync.writeFile(path.join(logsDir, filename), lines.join('\n') + '\n', () => {})
}

// ── Carica e compila un prompt template ───────────────────────────────────────

async function loadPrompt(filename, vars = {}) {
  const p = path.join(PROMPTS_DIR, filename)
  let text = await fs.readFile(p, 'utf-8')
  for (const [key, val] of Object.entries(vars)) {
    const value = typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val ?? '')
    text = text.replaceAll(`{{${key}}}`, value)
  }
  return text
}

async function loadPromptSchema(filename) {
  if (schemaCache.has(filename)) return schemaCache.get(filename)

  const schemaPath = path.join(PROMPT_SCHEMAS_DIR, filename.replace(/\.md$/, '.schema.json'))
  try {
    const raw = await fs.readFile(schemaPath, 'utf-8')
    const schema = JSON.parse(raw)
    schemaCache.set(filename, schema)
    return schema
  } catch (err) {
    if (err.code === 'ENOENT') {
      schemaCache.set(filename, null)
      return null
    }
    throw err
  }
}

// ── Chiamata Ollama con retry ─────────────────────────────────────────────────

async function callOllama(model, prompt, expectJson = true, phase = '?', schema = null, ollamaOptions = {}, tableId = null) {
  let lastError
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

      const body = { model, prompt, stream: false }
      if (expectJson) body.format = 'json'
      if (Object.keys(ollamaOptions).length > 0) body.options = ollamaOptions

      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(body)
      })
      clearTimeout(timer)

      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`)

      const data = await res.json()
      const raw = data.response?.trim() || ''

      if (!expectJson) {
        llmLog({ tableId, model, phase, attempt, prompt, response: raw })
        return raw
      }

      // Estrai JSON dalla risposta (il modello potrebbe aggiungere testo intorno)
      const parsed = extractJSON(raw)
      if (parsed !== null) {
        const schemaError = validateSchemaResponse(schema, parsed, phase)
        if (schemaError) {
          llmLog({ tableId, model, phase, attempt, prompt, response: raw, error: schemaError })
          throw new Error(`${schemaError} (tentativo ${attempt})`)
        }
        llmLog({ tableId, model, phase, attempt, prompt, response: raw })
        return parsed
      }

      console.warn(`[Ollama] Risposta grezza (tentativo ${attempt}):\n${raw.slice(0, 500)}`)
      llmLog({ tableId, model, phase, attempt, prompt, response: raw, error: `JSON non valido` })
      throw new Error(`JSON non valido (tentativo ${attempt}): ${raw.slice(0, 200)}`)

    } catch (err) {
      lastError = err
      if (err.name === 'AbortError') {
        lastError = new Error(`Timeout LLM (tentativo ${attempt})`)
        llmLog({ tableId, model, phase, attempt, prompt, response: '', error: lastError.message })
      }
      console.warn(`[Ollama] ${lastError.message}`)
      if (attempt < MAX_RETRIES) await sleep(1000 * attempt)
    }
  }
  throw Object.assign(lastError, { isLlmError: true })
}

function extractJSON(text) {
  // Prova diretto
  try { return JSON.parse(text) } catch {}
  // Cerca blocco ```json ... ```
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) { try { return JSON.parse(fenced[1].trim()) } catch {} }
  // Cerca prima { o [
  const start = text.search(/[{[]/)
  if (start === -1) return null
  // Trova la chiusura bilanciata
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0, end = -1
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++
    else if (text[i] === close) { depth--; if (depth === 0) { end = i; break } }
  }
  if (end === -1) return null
  try { return JSON.parse(text.slice(start, end + 1)) } catch { return null }
}

function validateSchemaResponse(schema, data, phase) {
  if (!schema) return null
  const error = validateJsonSchema(schema, data, '$')
  return error ? `Schema risposta non valido per ${phase}: ${error}` : null
}

function validateJsonSchema(schema, data, currentPath) {
  if (schema.anyOf) {
    const errors = schema.anyOf
      .map(option => validateJsonSchema(option, data, currentPath))
      .filter(Boolean)
    return errors.length === schema.anyOf.length ? errors[0] : null
  }

  if (schema.type) {
    const typeError = validateType(schema.type, data, currentPath)
    if (typeError) return typeError
  }

  if (schema.enum && !schema.enum.includes(data)) {
    return `${currentPath} deve essere uno tra: ${schema.enum.join(', ')}`
  }

  if (schema.type === 'object') {
    const required = schema.required || []
    for (const key of required) {
      if (!(key in data)) return `${currentPath}.${key} mancante`
    }

    const properties = schema.properties || {}
    for (const [key, value] of Object.entries(data)) {
      if (!properties[key]) {
        if (schema.additionalProperties === false) {
          return `${currentPath}.${key} non è consentito`
        }
        continue
      }
      const childError = validateJsonSchema(properties[key], value, `${currentPath}.${key}`)
      if (childError) return childError
    }
  }

  if (schema.type === 'array') {
    if (schema.minItems != null && data.length < schema.minItems) {
      return `${currentPath} deve contenere almeno ${schema.minItems} elementi`
    }
    if (schema.items) {
      for (let i = 0; i < data.length; i++) {
        const childError = validateJsonSchema(schema.items, data[i], `${currentPath}[${i}]`)
        if (childError) return childError
      }
    }
  }

  return null
}

function validateType(type, data, currentPath) {
  const types = Array.isArray(type) ? type : [type]
  const ok = types.some(singleType => matchesType(singleType, data))
  return ok ? null : `${currentPath} deve essere di tipo ${types.join('|')}`
}

function matchesType(type, data) {
  if (type === 'array') return Array.isArray(data)
  if (type === 'null') return data === null
  if (type === 'integer') return Number.isInteger(data)
  if (type === 'object') return !!data && typeof data === 'object' && !Array.isArray(data)
  return typeof data === type
}

function buildLogTimestamp(date) {
  const yyyy = String(date.getFullYear())
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mi = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  const ms = String(date.getMilliseconds()).padStart(3, '0')
  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}${ms}`
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── API pubblica ───────────────────────────────────────────────────────────────

async function runPhase(model, promptFile, vars, ollamaOptions = {}, tableId = null) {
  const [prompt, schema] = await Promise.all([
    loadPrompt(promptFile, vars),
    loadPromptSchema(promptFile)
  ])
  return callOllama(model, prompt, true, promptFile, schema, ollamaOptions, tableId)
}

async function runTextPhase(model, promptFile, vars, tableId = null) {
  const prompt = await loadPrompt(promptFile, vars)
  return callOllama(model, prompt, false, promptFile, null, { num_ctx: HEAVY_LLM_NUM_CTX }, tableId)
}

async function runTagging(model, promptFile, vars, tableId = null) {
  const [prompt, schema] = await Promise.all([
    loadPrompt(promptFile, vars),
    loadPromptSchema(promptFile)
  ])
  return callOllama(model, prompt, true, promptFile, schema, {}, tableId)
}

module.exports = { runPhase, runTextPhase, runTagging, loadPrompt, loadPromptSchema, callOllama, tableLogsDir, HEAVY_LLM_NUM_CTX }
