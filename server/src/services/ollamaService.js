const fs = require('fs').promises
const path = require('path')

const OLLAMA_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
const MAX_RETRIES = parseInt(process.env.LLM_MAX_RETRIES || '3')
const TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '120000')
const PROMPTS_DIR = path.join(__dirname, '../../../prompts')

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

// ── Chiamata Ollama con retry ─────────────────────────────────────────────────

async function callOllama(model, prompt, expectJson = true) {
  let lastError
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ model, prompt, stream: false })
      })
      clearTimeout(timer)

      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`)

      const data = await res.json()
      const raw = data.response?.trim() || ''

      if (!expectJson) return raw

      // Estrai JSON dalla risposta (il modello potrebbe aggiungere testo intorno)
      const parsed = extractJSON(raw)
      if (parsed !== null) return parsed

      console.warn(`[Ollama] Risposta grezza (tentativo ${attempt}):\n${raw.slice(0, 500)}`)
      throw new Error(`JSON non valido (tentativo ${attempt}): ${raw.slice(0, 200)}`)

    } catch (err) {
      lastError = err
      if (err.name === 'AbortError') {
        lastError = new Error(`Timeout LLM (tentativo ${attempt})`)
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── API pubblica ───────────────────────────────────────────────────────────────

async function runPhase(model, promptFile, vars) {
  const prompt = await loadPrompt(promptFile, vars)
  return callOllama(model, prompt, true)
}

async function runTagging(model, promptFile, vars) {
  const prompt = await loadPrompt(promptFile, vars)
  return callOllama(model, prompt, true)
}

module.exports = { runPhase, runTagging, loadPrompt, callOllama }
