'use strict'
/**
 * Test di well-formness dei prompt: verifica solo che il JSON di output
 * rispetti lo schema. Salva prompt completo e risposta grezza su disco
 * per analisi manuale.
 *
 * Output per ogni fase:
 *   artifacts_prompt_review/<fase>_prompt.txt    — prompt completo renderizzato
 *   artifacts_prompt_review/<fase>_response.txt  — risposta grezza della LLM
 *   artifacts_prompt_review/<fase>_result.json   — JSON parsato (se valido)
 *
 * Uso: node test/prompt_review_test.js [modello] [moduleId]
 * Default modello: mistral-nemo:latest
 * Default moduleId: mod_21a79df1da33
 */

const path = require('path')
const fs   = require('fs').promises
const ollama  = require('../src/services/ollamaService')
const { buildRagResolver } = require('../src/services/custodeEngine')

const MODEL       = process.argv[2] || 'mistral-nemo:latest'
const MODULE_ID   = process.argv[3] || 'mod_21a79df1da33'
const OLLAMA_URL  = process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
const TIMEOUT_MS  = parseInt(process.env.LLM_TIMEOUT_MS || '120000')
const ARTIFACTS   = path.join(__dirname, 'artifacts_prompt_review')

// Usa il RAG reale del modulo (tableId=null: query table restituiranno vuoto)
const ragResolver = buildRagResolver(MODULE_ID, null)

// ── Scenario: Parigi 1936 — asta Grand Palais ────────────────────────────────

const SCHEDE_PG = `Marguerite Vidal — giornalista investigativa, 32 anni. Capelli corti castani, trench beige.
Abilità principali: Psicologia 65%, Osservare 70%, Biblioteconomia 55%, Persuadere 60%.

Stefan Kowalski — antiquario polacco, 50 anni. Corporatura robusta, baffi grigi.
Abilità principali: Valutare 75%, Linguaggi (francese, polacco) 65%, Individuare 60%.`

const DIARY = `Sessione 1 — 14 giugno 1936: Marguerite e Stefan sono arrivati a Parigi su richiesta del prof. Émile Fontaine, loro comune amico. Al loro arrivo, il professore era scomparso. Dalla sua corrispondenza hanno scoperto che aveva acquistato una tavoletta di pietra scura con incisioni in uno script sconosciuto, appartenuta al prof. Henri Belloq, e che sarebbe stata battuta all'asta al Grand Palais il giorno successivo.`

const MOMENTO        = '15 giugno 1936, ore 14:30'
const CONTESTO_DOVE  = 'Sala aste principale, Grand Palais, Parigi — piano nobile'
const PROGRESSIONE   = `Marguerite e Stefan sono entrati nella sala aste. Il banditore ha aperto la seduta. Il lotto 12 — la tavoletta di pietra — è ancora sul podio. Mme. Arnaud è in prima fila.`
const STATO_PGS      = `Marguerite Vidal: seduta in seconda fila, catalogo in mano\nStefan Kowalski: in piedi vicino all'ingresso laterale`
const STATO_PNGS     = `Mme. Arnaud: in prima fila, non ancora incontrata.\nIl banditore Dumont: sul podio, non ancora incontrato.`
const CONOSCENZE     = `Il prof. Belloq è scomparso tre mesi fa dopo aver studiato la tavoletta.\nLa tavoletta (lotto 12) ha incisioni in uno script sconosciuto. Il prof. Fontaine la cercava per decifrarne il significato.`
const PNG_LIST       = '["Mme. Arnaud", "Il banditore Dumont", "L\'assistente muto"]'
const OPPORTUNITA    = '["Esaminare il catalogo d\'aste", "Osservare il lotto 12", "Avvicinarsi a Mme. Arnaud"]'
const MINACCE        = '["Un uomo dai capelli rossi vi osserva dall\'ingresso"]'
const INDIZI         = '["Script sconosciuto inciso sulla tavoletta", "Venditore: proprietà di H. Belloq, scomparso"]'

// ── I/O helpers ───────────────────────────────────────────────────────────────

async function save(filename, content) {
  await fs.mkdir(ARTIFACTS, { recursive: true })
  await fs.writeFile(path.join(ARTIFACTS, filename), content, 'utf-8')
}

function extractJSON(text) {
  try { return JSON.parse(text) } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) { try { return JSON.parse(fenced[1].trim()) } catch {} }
  const start = text.search(/[{[]/)
  if (start === -1) return null
  const open = text[start], close = open === '{' ? '}' : ']'
  let depth = 0, end = -1
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++
    else if (text[i] === close) { depth--; if (depth === 0) { end = i; break } }
  }
  if (end === -1) return null
  try { return JSON.parse(text.slice(start, end + 1)) } catch { return null }
}

// ── Chiamata Ollama raw: restituisce [rawText, parsedObject|null] ──────────────

async function callRaw(prompt, useLight = false) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const body = { model: MODEL, prompt, stream: false, format: 'json' }
    if (!useLight) body.options = { num_ctx: ollama.HEAVY_LLM_NUM_CTX }
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(body)
    })
    clearTimeout(timer)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const raw = (data.response || '').trim()
    return [raw, extractJSON(raw)]
  } catch (err) {
    clearTimeout(timer)
    throw err
  }
}

// ── Runner per singola fase ───────────────────────────────────────────────────

async function runPhase(label, promptFile, vars, useLight = false) {
  const slug = promptFile.replace('.md', '')
  process.stdout.write(`  ${label}... `)
  const t0 = Date.now()

  // 1. Renderizza prompt completo con RAG reale
  let renderedPrompt
  try {
    renderedPrompt = await ollama.loadPrompt(promptFile, vars, ragResolver)
    await save(`${slug}_prompt.txt`, renderedPrompt)
  } catch (err) {
    console.log(`✗ render (${((Date.now()-t0)/1000).toFixed(1)}s): ${err.message}`)
    return false
  }

  // 2. Chiama LLM e salva risposta grezza
  let raw, parsed
  try {
    ;[raw, parsed] = await callRaw(renderedPrompt, useLight)
    await save(`${slug}_response.txt`, raw)
  } catch (err) {
    console.log(`✗ LLM (${((Date.now()-t0)/1000).toFixed(1)}s): ${err.message}`)
    await save(`${slug}_response.txt`, `ERRORE: ${err.message}`)
    return false
  }

  const elapsed = ((Date.now()-t0)/1000).toFixed(1)

  // 3. Verifica JSON valido
  if (!parsed) {
    console.log(`✗ JSON non valido (${elapsed}s)`)
    return false
  }
  await save(`${slug}_result.json`, JSON.stringify(parsed, null, 2))

  // 4. Verifica schema (required fields)
  const schema = await ollama.loadPromptSchema(promptFile)
  if (schema?.required) {
    const missing = schema.required.filter(f => !(f in parsed))
    if (missing.length) {
      console.log(`⚠  (${elapsed}s) — campi mancanti: [${missing.join(', ')}]`)
      return false
    }
  }

  console.log(`✓ (${elapsed}s)`)
  return true
}

// ── Definizione fasi ──────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Prompt Well-formness Review — modello: ${MODEL} ===`)
  console.log(`Modulo RAG: ${MODULE_ID}`)
  console.log(`Output: ${ARTIFACTS}\n`)

  const results = []

  results.push(await runPhase(
    'fase1a — prima sessione',
    'fase1a_prima_sessione.md',
    { schede_PG: SCHEDE_PG }
  ))

  results.push(await runPhase(
    'fase1b — sessione successiva',
    'fase1b_sessioni_successive.md',
    { diary: DIARY, schede_PG: SCHEDE_PG, momento_corrente: MOMENTO,
      progressione: PROGRESSIONE, stato_pgs: STATO_PGS, stato_pngs: STATO_PNGS }
  ))

  results.push(await runPhase(
    'fase2 — opening new scene',
    'fase2_opening_new_scene.md',
    { suggerimento_scena: 'magazzini sul retro del Grand Palais, di notte',
      schede_PG: SCHEDE_PG, stato_pgs: STATO_PGS,
      conoscenze_party: CONOSCENZE, momento_corrente: MOMENTO }
  ))

  results.push(await runPhase(
    'fase3 — scene orchestrator',
    'fase3_scene_orchestrator.md',
    { narrative_groups: 'Gruppo principale (Marguerite): sala aste\nGruppo separato (Stefan): magazzini',
      scene_attive: JSON.stringify([
        { id_scena: 'scena_grandpalais_asta',      contesto_dove: 'Sala aste Grand Palais',         progressione: PROGRESSIONE },
        { id_scena: 'scena_grandpalais_magazzini', contesto_dove: 'Magazzini sul retro Grand Palais', progressione: 'Stefan ha trovato una porta nascosta.' }
      ]),
      engagement: JSON.stringify({ 'Marguerite Vidal': 3, 'Stefan Kowalski': 2 }) },
    true  // light model
  ))

  results.push(await runPhase(
    'fase4a — scene opening',
    'fase4a_scene_opening.md',
    { schede_PG: SCHEDE_PG, diary: DIARY, momento_corrente: MOMENTO,
      stato_pgs: STATO_PGS, stato_pngs: STATO_PNGS, conoscenze_party: CONOSCENZE,
      contesto_dove: CONTESTO_DOVE, PNG: PNG_LIST,
      opportunita: OPPORTUNITA, minacce: MINACCE, indizi: INDIZI }
  ))

  results.push(await runPhase(
    'fase4b — analisi dichiarazioni',
    'fase4b_analisi_dichiarazioni.md',
    { schede_PG: SCHEDE_PG,
      messaggi_buffer: `[dichiarazione] Marguerite Vidal: Voglio avvicinarmi al podio per esaminare la tavoletta del lotto 12\n[domanda al custode] Stefan Kowalski: Custode, riesco a vedere se quella donna in prima fila sta prendendo appunti?`,
      piano_azione: 'nessuno', diary: DIARY, contesto_dove: CONTESTO_DOVE,
      momento_corrente: MOMENTO, PNG: PNG_LIST, opportunita: OPPORTUNITA,
      minacce: MINACCE, indizi: INDIZI, progressione: PROGRESSIONE,
      stato_pgs: STATO_PGS, stato_pngs: STATO_PNGS, conoscenze_party: CONOSCENZE }
  ))

  results.push(await runPhase(
    'fase5 — risoluzione',
    'fase5_risoluzione.md',
    { piano_azione: JSON.stringify([
        { pg: 'Marguerite Vidal', stato: 'dichiarazione', azione: 'Si avvicina al podio per esaminare la tavoletta del lotto 12', abilita_o_caratteristica: null, difficolta: null, risultato_prova: null },
        { pg: 'Stefan Kowalski', stato: 'domanda',        azione: 'Chiede se la donna in prima fila sta prendendo appunti',        abilita_o_caratteristica: null, difficolta: null, risultato_prova: null }
      ]),
      diary: DIARY, contesto_dove: CONTESTO_DOVE, momento_corrente: MOMENTO,
      PNG: PNG_LIST, opportunita: OPPORTUNITA, minacce: MINACCE, indizi: INDIZI,
      progressione: PROGRESSIONE, stato_pgs: STATO_PGS, stato_pngs: STATO_PNGS,
      conoscenze_party: CONOSCENZE, schede_PG: SCHEDE_PG }
  ))

  // ── Riepilogo ──────────────────────────────────────────────────────────────
  const ok = results.filter(Boolean).length
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`Well-formness: ${ok}/${results.length} fasi ok`)
  console.log(`\nFile salvati in ${ARTIFACTS}:`)
  console.log('  <fase>_prompt.txt   — prompt completo renderizzato')
  console.log('  <fase>_response.txt — risposta grezza della LLM')
  console.log('  <fase>_result.json  — JSON parsato (se valido)\n')

  process.exit(ok === results.length ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
