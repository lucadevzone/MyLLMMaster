'use strict'
/**
 * Test automatico delle fasi principali del Custode Engine.
 * Interroga Ollama con prompt reali e verifica schema + coerenza dell'output.
 *
 * Fasi testate: 1a, 1b, 2, 3, 4a, 4b, 5
 * Escluse (non ancora stabili): 4b_sub*, 5a, 5b, 5c
 *
 * Uso: node test/prompt_phases_test.js [modello]
 * Default: mistral-nemo:latest
 */

const path = require('path')
const fs = require('fs').promises
const ollama = require('../src/services/ollamaService')

const MODEL = process.argv[2] || 'mistral-nemo:latest'
const ARTIFACTS_DIR = path.join(__dirname, 'artifacts_prompt_fields')

// ── Scenario fisso: Parigi 1923 ───────────────────────────────────────────────

const SCHEDE_PG = `Emil Voss — giornalista investigativo, 35 anni. Capelli scuri, impermeabile logoro.
Abilità principali: Psicologia 65%, Osservare 70%, Biblioteconomia 55%, Persuadere 60%.

Luk Barański — antiquario polacco, 48 anni. Corporatura robusta, baffi grigi.
Abilità principali: Valutare 75%, Linguaggi (francese, polacco) 65%, Individuare 60%.`

const DIARY = `Sessione 1 — 13 ottobre 1923: Emil e Luk sono giunti a Parigi su richiesta del prof. Armand Beaumont, loro comune amico, che li ha contattati con un telegramma urgente. Al loro arrivo, hanno trovato il professore scomparso. Dalla sua corrispondenza hanno scoperto che aveva acquistato una maschera cerimoniale di origine ignota e che questa sarebbe stata rimessa all'asta all'Hotel Drouot il giorno successivo.`

const MOMENTO = '14 ottobre 1923, ore 14:30'

const CONTESTO_DOVE = "Sala d'aste principale, Hotel Drouot, Parigi — primo piano nobile"

const PROGRESSIONE = `Emil e Luk sono entrati nella sala d'aste affollata. Il banditore ha aperto la seduta presentando i primi lotti. Il lotto 47 — la maschera cerimoniale — è ancora sul podio, in attesa di essere battuto. Madame Fouchet è seduta in prima fila e non ha ancora parlato con i PG.`

const STATO_PGS = `Emil Voss: seduto in seconda fila, catalogo d'aste in mano, osserva i presenti con attenzione
Luk Barański: in piedi vicino all'ingresso laterale, sorveglia le uscite`

const STATO_PNGS = `Madame Fouchet: seduta in prima fila, schiena dritta, borsetta in grembo. Non ancora incontrata dal party.
Il banditore Rousseau: sul podio, presenta il lotto 46. Non ancora incontrato dal party.`

const CONOSCENZE = `Il prof. Armand è scomparso dopo aver acquistato la maschera cerimoniale.
La maschera (lotto 47) proviene da una collezione privata di Marsiglia.
Un simbolo inciso sul retro della maschera è stato fotografato dal professore prima di scomparire.`

const PNG_LIST = '["Madame Fouchet", "Il banditore Rousseau", "L\'assistente muto"]'
const OPPORTUNITA_LIST = '["Esaminare il catalogo d\'aste", "Osservare il lotto 47 da vicino", "Avvicinarsi a Madame Fouchet"]'
const MINACCE_LIST = '["Un uomo dai capelli rossi vi osserva dall\'ingresso"]'
const INDIZI_LIST = '["Simbolo dei tre cerchi sul retro della maschera", "Il nome del venditore nel catalogo: E. Vallois, Marsiglia"]'

// ── Fake RAG resolver ─────────────────────────────────────────────────────────
// Sostituisce tutti i tag {{rag:...}} con contenuto statico, senza indice reale.

const FAKE_RAG_CONTENT = `[ambientazione] Parigi 1923:
La città della luce negli anni '20 — caffè fumosi, gallerie d'arte, espatriati americani. Sotto la superficie scintillante, circola un mercato nero di antichità di dubbia provenienza.

[personaggio] Madame Fouchet:
Antiquaria parigina, 68 anni. Capelli bianchi raccolti, occhi acuti. Frequenta le aste da decenni e conosce ogni venditore del mercato nero locale. Tiene un taccuino personale con annotazioni cifrate.

[personaggio] Il banditore Rousseau:
Funzionario dell'Hotel Drouot, 50 anni. Professionale, discreto. Sa chi ha venduto il lotto 47 ma non rivela informazioni personali sui venditori senza ragioni formali.

[indizio] Simbolo dei tre cerchi:
Tre cerchi concentrici con un occhio al centro, inciso sul retro della maschera. Ricorre in testi esoterici di una setta chiamata "I Figli del Dio Dormiente", attiva a Marsiglia negli anni '10.

[luogo] Sala d'aste Hotel Drouot:
Grande salone al primo piano nobile. Sedie rosse in fila, podio del banditore al centro. Uscita laterale conduce ai magazzini. Due inservienti sorvegliano gli accessi.`

const RAG_PATTERN = /\{\{rag:[^}]+\}\}/g

function makeFakeRagResolver() {
  return async (template, vars) => {
    // Prima espandi le variabili nei tag rag (es. {{PNG}})
    let resolved = template
    for (const [key, val] of Object.entries(vars)) {
      resolved = resolved.replaceAll(`{{${key}}}`, typeof val === 'object' ? JSON.stringify(val) : String(val ?? ''))
    }
    // Poi sostituisci tutti i tag {{rag:...}} con contenuto fake
    resolved = resolved.replace(RAG_PATTERN, FAKE_RAG_CONTENT)
    // Reimposta i placeholder non ancora espansi (li gestirà loadPrompt)
    // (non serve: loadPrompt chiama il ragResolver PRIMA di espandere le {{var}})
    return template.replace(RAG_PATTERN, FAKE_RAG_CONTENT)
  }
}

// ── Helper ────────────────────────────────────────────────────────────────────

async function writeArtifact(name, data) {
  await fs.mkdir(ARTIFACTS_DIR, { recursive: true })
  await fs.writeFile(path.join(ARTIFACTS_DIR, name), JSON.stringify(data, null, 2), 'utf-8')
}

function checkString(val, field, minLen = 20) {
  if (typeof val !== 'string') return `${field}: deve essere stringa, trovato ${typeof val}`
  if (val.trim().length < minLen) return `${field}: troppo corto (${val.length} chars)`
  return null
}

function printResult(result, checks) {
  const errors = checks.map(c => c).filter(Boolean)
  if (errors.length) {
    errors.forEach(e => console.log(`    ⚠  ${e}`))
  }
  return errors.length === 0
}

// ── Test runner ───────────────────────────────────────────────────────────────

async function runTest(label, promptFile, vars, checks, useLight = false) {
  const opts = useLight ? {} : { num_ctx: ollama.HEAVY_LLM_NUM_CTX }
  const ragResolver = makeFakeRagResolver()
  const t0 = Date.now()
  process.stdout.write(`  ${label}... `)

  try {
    const result = await ollama.runPhase(MODEL, promptFile, vars, opts, null, ragResolver)
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    const contentOk = printResult(result, checks(result))
    await writeArtifact(`${promptFile.replace('.md', '')}.json`, result)
    const status = contentOk ? '✓' : '⚠ '
    console.log(`${status} (${elapsed}s)`)
    return { ok: contentOk, result }
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(`✗ (${elapsed}s)`)
    console.log(`    ERRORE: ${err.message}`)
    return { ok: false, result: null }
  }
}

// ── Definizione test per fase ─────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Prompt Phase Tests — modello: ${MODEL} ===\n`)

  const results = []

  // ── FASE 1a ────────────────────────────────────────────────────────────────
  results.push(await runTest(
    'fase1a — prima sessione',
    'fase1a_prima_sessione.md',
    { schede_PG: SCHEDE_PG },
    r => [
      checkString(r.narrativa, 'narrativa', 40),
      checkString(r.diary, 'diary', 20)
    ]
  ))

  // ── FASE 1b ────────────────────────────────────────────────────────────────
  results.push(await runTest(
    'fase1b — sessione successiva',
    'fase1b_sessioni_successive.md',
    {
      diary: DIARY,
      schede_PG: SCHEDE_PG,
      momento_corrente: MOMENTO,
      progressione: PROGRESSIONE,
      stato_pgs: STATO_PGS,
      stato_pngs: STATO_PNGS
    },
    r => [
      checkString(r.narrativa, 'narrativa', 40),
      r.narrativa?.toLowerCase().includes('paris') || r.narrativa?.toLowerCase().includes('parigi') || r.narrativa?.toLowerCase().includes('sessione') || r.narrativa?.toLowerCase().includes('asta')
        ? null : 'narrativa: non sembra riferirsi alla scena'
    ]
  ))

  // ── FASE 2 ─────────────────────────────────────────────────────────────────
  results.push(await runTest(
    'fase2 — opening new scene',
    'fase2_opening_new_scene.md',
    {
      suggerimento_scena: "magazzini sul retro dell'Hotel Drouot, di notte",
      schede_PG: SCHEDE_PG,
      stato_pgs: STATO_PGS,
      conoscenze_party: CONOSCENZE,
      momento_corrente: MOMENTO
    },
    r => [
      checkString(r.contesto_dove, 'contesto_dove', 5),
      !Array.isArray(r.PNG) ? 'PNG: deve essere array' : null,
      !Array.isArray(r.opportunita) ? 'opportunita: deve essere array' : null,
      !Array.isArray(r.minacce) ? 'minacce: deve essere array' : null,
      !Array.isArray(r.indizi) ? 'indizi: deve essere array' : null,
      typeof r.stato_pgs !== 'object' || Array.isArray(r.stato_pgs) ? 'stato_pgs: deve essere oggetto' : null,
      typeof r.stato_pngs !== 'object' || Array.isArray(r.stato_pngs) ? 'stato_pngs: deve essere oggetto' : null
    ]
  ))

  // ── FASE 3 ─────────────────────────────────────────────────────────────────
  const sceneAttive = [
    { id_scena: 'scena_drouot_asta', contesto_dove: "Sala d'aste Hotel Drouot", progressione: PROGRESSIONE },
    { id_scena: 'scena_drouot_magazzini', contesto_dove: "Magazzini sul retro dell'Hotel Drouot", progressione: 'Luk ha trovato una porta nascosta nei magazzini. Odore di muffa e vecchio.' }
  ]
  const narrativeGroups = `Gruppo principale (Emil): sala d'aste — in attesa dell'asta\nGruppo separato (Luk): magazzini — sta investigando in autonomia`
  const engagement = JSON.stringify({ 'Emil Voss': 3, 'Luk Barański': 2 })

  results.push(await runTest(
    'fase3 — scene orchestrator',
    'fase3_scene_orchestrator.md',
    {
      narrative_groups: narrativeGroups,
      scene_attive: JSON.stringify(sceneAttive),
      engagement
    },
    r => [
      checkString(r.focus_scene, 'focus_scene', 3),
      ['scena_drouot_asta', 'scena_drouot_magazzini'].includes(r.focus_scene)
        ? null : `focus_scene: valore non atteso: "${r.focus_scene}"`
    ],
    true  // light LLM
  ))

  // ── FASE 4a ────────────────────────────────────────────────────────────────
  results.push(await runTest(
    'fase4a — scene opening',
    'fase4a_scene_opening.md',
    {
      schede_PG: SCHEDE_PG,
      diary: DIARY,
      momento_corrente: MOMENTO,
      stato_pgs: STATO_PGS,
      stato_pngs: STATO_PNGS,
      conoscenze_party: CONOSCENZE,
      contesto_dove: CONTESTO_DOVE,
      PNG: PNG_LIST,
      opportunita: OPPORTUNITA_LIST,
      minacce: MINACCE_LIST,
      indizi: INDIZI_LIST
    },
    r => [
      checkString(r.narrativa, 'narrativa', 40),
      !Array.isArray(r.sussurri) ? 'sussurri: deve essere array' : null
    ]
  ))

  // ── FASE 4b ────────────────────────────────────────────────────────────────
  const messaggiBuffer = `[dichiarazione] Emil Voss: Voglio avvicinarmi al podio per esaminare meglio la maschera del lotto 47
[domanda al custode] Luk Barański: Custode, riesco a vedere se quella donna in prima fila sta prendendo appunti?`

  results.push(await runTest(
    'fase4b — analisi dichiarazioni',
    'fase4b_analisi_dichiarazioni.md',
    {
      schede_PG: SCHEDE_PG,
      messaggi_buffer: messaggiBuffer,
      piano_azione: 'nessuno',
      diary: DIARY,
      contesto_dove: CONTESTO_DOVE,
      momento_corrente: MOMENTO,
      PNG: PNG_LIST,
      opportunita: OPPORTUNITA_LIST,
      minacce: MINACCE_LIST,
      indizi: INDIZI_LIST,
      progressione: PROGRESSIONE,
      stato_pgs: STATO_PGS,
      stato_pngs: STATO_PNGS,
      conoscenze_party: CONOSCENZE
    },
    r => [
      !Array.isArray(r.piano) ? 'piano: deve essere array' : null,
      r.piano?.length !== 2 ? `piano: attesi 2 PG, trovati ${r.piano?.length}` : null,
      r.piano?.every(e => ['dichiarazione','domanda','prova','incompleta','assente'].includes(e.stato))
        ? null : 'piano: stato non valido in qualche entry'
    ]
  ))

  // ── FASE 5 ─────────────────────────────────────────────────────────────────
  const pianoAzione = JSON.stringify([
    { pg: 'Emil Voss', stato: 'dichiarazione', azione: "Si avvicina al podio per esaminare la maschera del lotto 47", abilita_o_caratteristica: null, difficolta: null, risultato_prova: null },
    { pg: 'Luk Barański', stato: 'domanda', azione: "Vuole sapere se la donna in prima fila sta prendendo appunti sulla maschera", abilita_o_caratteristica: null, difficolta: null, risultato_prova: null }
  ])

  const { ok: ok5, result: res5 } = await runTest(
    'fase5 — risoluzione',
    'fase5_risoluzione.md',
    {
      piano_azione: pianoAzione,
      diary: DIARY,
      contesto_dove: CONTESTO_DOVE,
      momento_corrente: MOMENTO,
      PNG: PNG_LIST,
      opportunita: OPPORTUNITA_LIST,
      minacce: MINACCE_LIST,
      indizi: INDIZI_LIST,
      progressione: PROGRESSIONE,
      stato_pgs: STATO_PGS,
      stato_pngs: STATO_PNGS,
      conoscenze_party: CONOSCENZE,
      schede_PG: SCHEDE_PG
    },
    r => {
      const DURATE_VALIDE = ['turno', 'minuti', "mezz'ora", "un'ora", 'qualche ora', 'mezza giornata', 'un giorno']
      return [
        checkString(r.narrativa, 'narrativa', 30),
        !Array.isArray(r.sussurri) ? 'sussurri: deve essere array' : null,
        !DURATE_VALIDE.includes(r.durata) ? `durata: valore non valido "${r.durata}"` : null,
        typeof r.divisione_gruppi !== 'boolean' ? 'divisione_gruppi: deve essere boolean' : null,
        typeof r.chiusura_scena !== 'boolean' ? 'chiusura_scena: deve essere boolean' : null,
        typeof r.aggiornamenti !== 'object' ? 'aggiornamenti: deve essere oggetto' : null,
        typeof r.aggiornamenti?.diary !== 'string' ? 'aggiornamenti.diary: deve essere stringa' : null,
        typeof r.aggiornamenti?.stato_pgs !== 'object' ? 'aggiornamenti.stato_pgs: deve essere oggetto' : null,
        typeof r.aggiornamenti?.nuove_conoscenze !== 'string' ? 'aggiornamenti.nuove_conoscenze: deve essere stringa' : null,
        !Array.isArray(r.aggiornamenti?.npcs) ? 'aggiornamenti.npcs: deve essere array' : null
      ]
    }
  )

  results.push({ ok: ok5, result: res5 })

  // ── Riepilogo ──────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.ok).length
  const total = results.length
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`Risultato: ${passed}/${total} fasi superate`)
  if (passed < total) console.log(`Attenzione: ${total - passed} fase/i con problemi — vedi output sopra`)
  console.log(`Artifacts salvati in: ${ARTIFACTS_DIR}\n`)

  // ── Preview narrativa fase5 (se disponibile) ───────────────────────────────
  if (res5?.narrativa) {
    console.log('Preview narrativa fase5:')
    console.log(`"${res5.narrativa}"\n`)
  }

  process.exit(passed === total ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
