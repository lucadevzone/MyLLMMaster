'use strict'
/**
 * Test automatico delle fasi principali del Custode Engine.
 * Verifica sia la correttezza sintattica (schema JSON) sia la coerenza semantica.
 *
 * Fasi testate: 1a, 1b, 2, 3, 4a, 4b, 5
 * Escluse: 4b_sub*, 5a, 5b, 5c
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

const PG_NAMES = ['Emil Voss', 'Luk Barański']

const SCHEDE_PG = `Emil Voss — giornalista investigativo, 35 anni. Capelli scuri, impermeabile logoro.
Abilità principali: Psicologia 65%, Osservare 70%, Biblioteconomia 55%, Persuadere 60%.

Luk Barański — antiquario polacco, 48 anni. Corporatura robusta, baffi grigi.
Abilità principali: Valutare 75%, Linguaggi (francese, polacco) 65%, Individuare 60%.`

const DIARY = `Sessione 1 — 13 ottobre 1923: Emil e Luk sono giunti a Parigi su richiesta del prof. Armand Beaumont, loro comune amico. Al loro arrivo, il professore era scomparso. Dalla sua corrispondenza hanno scoperto che aveva acquistato una maschera cerimoniale di origine ignota e che questa sarebbe stata rimessa all'asta all'Hotel Drouot il giorno successivo.`

const MOMENTO = '14 ottobre 1923, ore 14:30'
const CONTESTO_DOVE = "Sala d'aste principale, Hotel Drouot, Parigi — primo piano nobile"

const PROGRESSIONE = `Emil e Luk sono entrati nella sala d'aste affollata. Il banditore ha aperto la seduta presentando i primi lotti. Il lotto 47 — la maschera cerimoniale — è ancora sul podio. Madame Fouchet è seduta in prima fila.`

const STATO_PGS = `Emil Voss: seduto in seconda fila, catalogo d'aste in mano, osserva i presenti
Luk Barański: in piedi vicino all'ingresso laterale, sorveglia le uscite`

const STATO_PNGS = `Madame Fouchet: seduta in prima fila, schiena dritta, borsetta in grembo. Non ancora incontrata dal party.
Il banditore Rousseau: sul podio, presenta il lotto 46. Non ancora incontrato dal party.`

const CONOSCENZE = `Il prof. Armand è scomparso dopo aver acquistato la maschera cerimoniale.
La maschera (lotto 47) proviene da una collezione privata di Marsiglia.
Sul retro della maschera c'è un simbolo fotografato dal professore prima di scomparire.`

const PNG_LIST = '["Madame Fouchet", "Il banditore Rousseau", "L\'assistente muto"]'
const OPPORTUNITA_LIST = '["Esaminare il catalogo d\'aste", "Osservare il lotto 47 da vicino", "Avvicinarsi a Madame Fouchet"]'
const MINACCE_LIST = '["Un uomo dai capelli rossi vi osserva dall\'ingresso"]'
const INDIZI_LIST = '["Simbolo dei tre cerchi sul retro della maschera", "Nome del venditore nel catalogo: E. Vallois, Marsiglia"]'

// ── Fake RAG resolver ─────────────────────────────────────────────────────────

const FAKE_RAG_CONTENT = `[ambientazione] Parigi 1923:
La città della luce negli anni '20 — caffè fumosi, gallerie d'arte, espatriati americani. Sotto la superficie scintillante, un mercato nero di antichità di dubbia provenienza.

[personaggio] Madame Fouchet:
Antiquaria parigina, 68 anni. Capelli bianchi raccolti, occhi acuti. Frequenta le aste da decenni. Tiene un taccuino personale con annotazioni cifrate.

[personaggio] Il banditore Rousseau:
Funzionario dell'Hotel Drouot, 50 anni. Professionale, discreto. Sa chi ha venduto il lotto 47 ma non rivela informazioni sui venditori.

[indizio] Simbolo dei tre cerchi:
Tre cerchi concentrici con un occhio al centro, inciso sul retro della maschera. Ricorre in testi esoterici della setta "I Figli del Dio Dormiente", attiva a Marsiglia negli anni '10.

[luogo] Sala d'aste Hotel Drouot:
Grande salone al primo piano nobile. Sedie rosse in fila, podio del banditore al centro. Uscita laterale ai magazzini.`

const RAG_PATTERN = /\{\{rag:[^}]+\}\}/g

function makeFakeRagResolver() {
  return async (template) => template.replace(RAG_PATTERN, FAKE_RAG_CONTENT)
}

// ── Helpers di verifica ────────────────────────────────────────────────────────

function checkString(val, field, minLen = 20) {
  if (typeof val !== 'string') return `${field}: deve essere stringa, trovato ${typeof val}`
  if (val.trim().length < minLen) return `${field}: troppo corta (${val.length} chars)`
  return null
}

// Verifica che il testo contenga almeno uno dei termini (case-insensitive)
function checkContains(text, field, terms) {
  if (!text) return `${field}: campo vuoto`
  const lower = text.toLowerCase()
  return terms.some(t => lower.includes(t.toLowerCase()))
    ? null
    : `${field}: non contiene nessuno di [${terms.join(', ')}]`
}

// Verifica che il testo NON contenga un termine (evita allucinazioni)
function checkNotContains(text, field, term, reason) {
  if (!text) return null
  return text.toLowerCase().includes(term.toLowerCase())
    ? `${field}: contiene "${term}" — ${reason}`
    : null
}

// Verifica che tutte le chiavi dell'oggetto corrispondano ai nomi PG attesi
function checkStatoPgsKeys(stato_pgs, field, expectedNames) {
  if (typeof stato_pgs !== 'object' || Array.isArray(stato_pgs)) return `${field}: deve essere oggetto`
  const keys = Object.keys(stato_pgs)
  const unexpected = keys.filter(k => !expectedNames.some(n => k.toLowerCase().includes(n.split(' ')[0].toLowerCase())))
  return unexpected.length
    ? `${field}: chiavi inattese (allucinazioni?): [${unexpected.join(', ')}]`
    : null
}

// Seconda persona plurale italiana
const SECONDA_PERSONA = ['vi ', 'voi', 'siete', 'avete', 'entrate', 'vedete', 'trovate', 'notate', 'osservate', 'siete', 'potete', 'dovete', 'vostra', 'vostro', 'vi trovate']
function checkSecondaPersona(text, field) {
  return checkContains(text, field, SECONDA_PERSONA)
}

// ── Test runner ───────────────────────────────────────────────────────────────

async function runTest(label, promptFile, vars, checks, useLight = false) {
  const opts = useLight ? {} : { num_ctx: ollama.LLM_NUM_CTX }
  const ragResolver = makeFakeRagResolver()
  const t0 = Date.now()
  process.stdout.write(`  ${label}... `)

  try {
    const result = await ollama.runPhase(MODEL, promptFile, vars, opts, null, ragResolver)
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    const issues = checks(result).filter(Boolean)
    await writeArtifact(`${promptFile.replace('.md', '')}.json`, result)

    if (issues.length) {
      console.log(`⚠  (${elapsed}s)`)
      issues.forEach(e => console.log(`    ⚠  ${e}`))
    } else {
      console.log(`✓ (${elapsed}s)`)
    }
    return { ok: issues.length === 0, result }
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(`✗ (${elapsed}s)`)
    console.log(`    ERRORE: ${err.message}`)
    return { ok: false, result: null }
  }
}

async function writeArtifact(name, data) {
  await fs.mkdir(ARTIFACTS_DIR, { recursive: true })
  await fs.writeFile(path.join(ARTIFACTS_DIR, name), JSON.stringify(data, null, 2), 'utf-8')
}

// ── Test per fase ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Prompt Phase Tests — modello: ${MODEL} ===`)
  console.log('Legenda: ✓ ok  ⚠ problemi semantici  ✗ errore schema/crash\n')

  const results = []

  // ── FASE 1a: Prima sessione ────────────────────────────────────────────────
  // Il LLM deve presentare ambientazione + PG. Tono seconda persona plurale.
  results.push(await runTest(
    'fase1a — prima sessione',
    'fase1a_prima_sessione.md',
    { schede_PG: SCHEDE_PG },
    r => [
      // sintattico
      checkString(r.data_inizio_avventura, 'data_inizio_avventura', 4),
      checkString(r.narrativa, 'narrativa', 60),
      checkString(r.diary, 'diary', 20),
      // semantico: data parsabile (deve contenere un anno a 4 cifre)
      /\d{4}/.test(r.data_inizio_avventura || '')
        ? null : 'data_inizio_avventura: non contiene un anno riconoscibile',
      // semantico: presenta i PG
      checkContains(r.narrativa, 'narrativa/nomi-pg', ['Emil', 'Luk']),
      // semantico: seconda persona plurale
      checkSecondaPersona(r.narrativa, 'narrativa/seconda-persona'),
      // semantico: diary è più corto della narrativa
      r.diary?.length > r.narrativa?.length
        ? 'diary: più lungo della narrativa (dovrebbe essere una sintesi)' : null,
      // semantico: siamo a Parigi/anni 20
      checkContains(r.narrativa + r.diary, 'ambientazione', ['parigi', 'paris', '1923', 'anni venti', 'anni \'20'])
    ]
  ))

  // ── FASE 1b: Sessione successiva ──────────────────────────────────────────
  // Deve aprire con "Nelle giocate precedenti…", riprendere il filo del diario.
  results.push(await runTest(
    'fase1b — sessione successiva',
    'fase1b_sessioni_successive.md',
    { diary: DIARY, schede_PG: SCHEDE_PG, momento_corrente: MOMENTO,
      progressione: PROGRESSIONE, stato_pgs: STATO_PGS, stato_pngs: STATO_PNGS },
    r => [
      checkString(r.narrativa, 'narrativa', 60),
      // semantico: apertura riepilogativa
      checkContains(r.narrativa, 'narrativa/apertura', ['precedent', 'scorsa sessione', 'ultima', 'avete', 'siete']),
      // semantico: riferimento al diario (Parigi, Armand, maschera, Drouot)
      checkContains(r.narrativa, 'narrativa/riferimento-diario', ['parigi', 'armand', 'maschera', 'drouot', 'asta']),
      // semantico: seconda persona plurale
      checkSecondaPersona(r.narrativa, 'narrativa/seconda-persona')
    ]
  ))

  // ── FASE 2: Opening new scene ─────────────────────────────────────────────
  // Deve produrre struttura scena. stato_pgs deve avere i nomi dei PG reali.
  results.push(await runTest(
    'fase2 — opening new scene',
    'fase2_opening_new_scene.md',
    { suggerimento_scena: "magazzini sul retro dell'Hotel Drouot, di notte",
      schede_PG: SCHEDE_PG, stato_pgs: STATO_PGS,
      conoscenze_party: CONOSCENZE, momento_corrente: MOMENTO },
    r => [
      // sintattico
      checkString(r.contesto_dove, 'contesto_dove', 5),
      !Array.isArray(r.PNG) ? 'PNG: deve essere array' : null,
      r.PNG?.length === 0 ? 'PNG: array vuoto — almeno un PNG atteso' : null,
      !Array.isArray(r.opportunita) ? 'opportunita: deve essere array' : null,
      !Array.isArray(r.indizi) ? 'indizi: deve essere array' : null,
      typeof r.stato_pgs !== 'object' || Array.isArray(r.stato_pgs) ? 'stato_pgs: deve essere oggetto' : null,
      typeof r.stato_pngs !== 'object' || Array.isArray(r.stato_pngs) ? 'stato_pngs: deve essere oggetto' : null,
      // semantico: la location deve rispecchiare il suggerimento (magazzini/Drouot)
      checkContains(r.contesto_dove, 'contesto_dove/location', ['magazzin', 'drouot', 'retro', 'hotel']),
      // semantico: stato_pgs deve avere chiavi con i nomi dei PG (non altri)
      checkStatoPgsKeys(r.stato_pgs, 'stato_pgs', PG_NAMES),
      // semantico: ogni PG deve avere il campo stato
      ...Object.entries(r.stato_pgs || {}).map(([nome, s]) =>
        typeof s?.stato === 'string' && s.stato.length > 5
          ? null : `stato_pgs.${nome}.stato: mancante o troppo corto`)
    ]
  ))

  // ── FASE 3: Scene orchestrator ────────────────────────────────────────────
  // Deve scegliere uno degli ID scena forniti — non inventarne di nuovi.
  const sceneAttive = [
    { id_scena: 'scena_drouot_asta',      contesto_dove: "Sala d'aste Hotel Drouot",       progressione: PROGRESSIONE },
    { id_scena: 'scena_drouot_magazzini', contesto_dove: "Magazzini sul retro Hotel Drouot", progressione: 'Luk ha trovato una porta nascosta nei magazzini.' }
  ]
  results.push(await runTest(
    'fase3 — scene orchestrator',
    'fase3_scene_orchestrator.md',
    { narrative_groups: `Gruppo principale (Emil): sala d'aste\nGruppo separato (Luk): magazzini — sta investigando`,
      scene_attive: JSON.stringify(sceneAttive),
      engagement: JSON.stringify({ 'Emil Voss': 3, 'Luk Barański': 2 }) },
    r => [
      checkString(r.focus_scene, 'focus_scene', 3),
      // semantico: deve essere uno degli ID reali, non un'invenzione
      ['scena_drouot_asta', 'scena_drouot_magazzini'].includes(r.focus_scene)
        ? null : `focus_scene: ID inventato: "${r.focus_scene}" (allucinazione)`
    ],
    true
  ))

  // ── FASE 4a: Scene opening ─────────────────────────────────────────────────
  // Narrativa deve descrivere la sala d'aste. NON deve rivelare i nomi dei PNG
  // non ancora incontrati (Madame Fouchet, Il banditore Rousseau).
  results.push(await runTest(
    'fase4a — scene opening',
    'fase4a_scene_opening.md',
    { schede_PG: SCHEDE_PG, diary: DIARY, momento_corrente: MOMENTO,
      stato_pgs: STATO_PGS, stato_pngs: STATO_PNGS, conoscenze_party: CONOSCENZE,
      contesto_dove: CONTESTO_DOVE, PNG: PNG_LIST,
      opportunita: OPPORTUNITA_LIST, minacce: MINACCE_LIST, indizi: INDIZI_LIST },
    r => [
      checkString(r.narrativa, 'narrativa', 60),
      !Array.isArray(r.sussurri) ? 'sussurri: deve essere array' : null,
      // semantico: descrive la sala d'aste
      checkContains(r.narrativa, 'narrativa/location', ['sala', 'aste', 'drouot', 'podio', 'salone', 'sedie']),
      // semantico: seconda persona plurale
      checkSecondaPersona(r.narrativa, 'narrativa/seconda-persona'),
      // semantico: non deve rivelare "Madame Fouchet" per nome (non ancora incontrata)
      checkNotContains(r.narrativa, 'narrativa/rivelazione-npc', 'Madame Fouchet',
        'PNG non ancora incontrato non dovrebbe essere nominato')
    ]
  ))

  // ── FASE 4b: Analisi dichiarazioni ────────────────────────────────────────
  // Emil → dichiarazione (avvicinarsi non richiede tiro).
  // Luk  → domanda (sta chiedendo al Custode).
  const messaggiBuffer = `[dichiarazione] Emil Voss: Voglio avvicinarmi al podio per esaminare meglio la maschera del lotto 47
[domanda al custode] Luk Barański: Custode, riesco a vedere se quella donna in prima fila sta prendendo appunti?`

  let pianoResult = null
  const r4b = await runTest(
    'fase4b — analisi dichiarazioni',
    'fase4b_analisi_dichiarazioni.md',
    { schede_PG: SCHEDE_PG, messaggi_buffer: messaggiBuffer, piano_azione: 'nessuno',
      diary: DIARY, contesto_dove: CONTESTO_DOVE, momento_corrente: MOMENTO,
      PNG: PNG_LIST, opportunita: OPPORTUNITA_LIST, minacce: MINACCE_LIST, indizi: INDIZI_LIST,
      progressione: PROGRESSIONE, stato_pgs: STATO_PGS, stato_pngs: STATO_PNGS,
      conoscenze_party: CONOSCENZE },
    r => {
      pianoResult = r.piano
      const emilEntry = r.piano?.find(e => e.pg?.includes('Emil'))
      const lukEntry  = r.piano?.find(e => e.pg?.includes('Luk'))
      return [
        // sintattico
        !Array.isArray(r.piano) ? 'piano: deve essere array' : null,
        r.piano?.length !== 2 ? `piano: attesi 2 PG, trovati ${r.piano?.length}` : null,
        r.piano?.every(e => ['dichiarazione','domanda','prova','incompleta','assente'].includes(e.stato))
          ? null : 'piano: stato non valido in qualche entry',
        // semantico: Emil deve essere dichiarazione (non prova — avvicinarsi è azione libera)
        !emilEntry ? 'piano: Emil Voss non trovato nel piano' :
          emilEntry.stato !== 'dichiarazione'
            ? `Emil: atteso "dichiarazione", trovato "${emilEntry.stato}"` : null,
        // semantico: Luk deve essere domanda (sta interrogando il Custode)
        !lukEntry ? 'piano: Luk Barański non trovato nel piano' :
          lukEntry.stato !== 'domanda'
            ? `Luk: atteso "domanda", trovato "${lukEntry.stato}"` : null
      ]
    }
  )
  results.push(r4b)

  // ── FASE 5: Risoluzione ───────────────────────────────────────────────────
  // stato_pgs deve usare i nomi dei PG reali (Emil, Luk), non quelli degli esempi.
  // La narrativa deve menzionare le azioni del piano (lotto 47, maschera, donna).
  // divisione_gruppi e chiusura_scena devono essere false (situazione normale).
  const pianoAzione = JSON.stringify([
    { pg: 'Emil Voss',     stato: 'dichiarazione', azione: 'Si avvicina al podio per esaminare la maschera del lotto 47', abilita_o_caratteristica: null, difficolta: null, risultato_prova: null },
    { pg: 'Luk Barański', stato: 'domanda',      azione: 'Chiede al Custode se la donna in prima fila sta prendendo appunti', abilita_o_caratteristica: null, difficolta: null, risultato_prova: null }
  ])

  results.push(await runTest(
    'fase5 — risoluzione',
    'fase5_risoluzione.md',
    { piano_azione: pianoAzione, diary: DIARY, contesto_dove: CONTESTO_DOVE,
      momento_corrente: MOMENTO, PNG: PNG_LIST, opportunita: OPPORTUNITA_LIST,
      minacce: MINACCE_LIST, indizi: INDIZI_LIST, progressione: PROGRESSIONE,
      stato_pgs: STATO_PGS, stato_pngs: STATO_PNGS, conoscenze_party: CONOSCENZE,
      schede_PG: SCHEDE_PG },
    r => {
      const DURATE_VALIDE = ['turno', 'minuti', "mezz'ora", "un'ora", 'qualche ora', 'mezza giornata', 'un giorno']
      const agg = r.aggiornamenti || {}
      return [
        // sintattico
        checkString(r.narrativa, 'narrativa', 30),
        !Array.isArray(r.sussurri) ? 'sussurri: deve essere array' : null,
        !DURATE_VALIDE.includes(r.durata) ? `durata: valore non valido "${r.durata}"` : null,
        typeof r.divisione_gruppi !== 'boolean' ? 'divisione_gruppi: deve essere boolean' : null,
        typeof r.chiusura_scena !== 'boolean' ? 'chiusura_scena: deve essere boolean' : null,
        typeof agg.diary !== 'string' ? 'aggiornamenti.diary: deve essere stringa' : null,
        typeof agg.stato_pgs !== 'object' ? 'aggiornamenti.stato_pgs: deve essere oggetto' : null,
        typeof agg.nuove_conoscenze !== 'string' ? 'aggiornamenti.nuove_conoscenze: deve essere stringa' : null,
        !Array.isArray(agg.npcs) ? 'aggiornamenti.npcs: deve essere array' : null,
        // semantico: narrativa parla delle azioni del piano
        checkContains(r.narrativa, 'narrativa/azioni-piano', ['lotto', 'maschera', 'podio', 'donna', 'prima fila', 'Emil', 'Luk']),
        // semantico: stato_pgs usa i nomi reali dei PG (non Alice/Henry dagli esempi)
        checkStatoPgsKeys(agg.stato_pgs, 'stato_pgs', PG_NAMES),
        // semantico: la situazione non porta a divisione o chiusura scena
        r.divisione_gruppi === true ? 'divisione_gruppi: true inatteso — i PG sono nella stessa scena' : null,
        r.chiusura_scena === true   ? 'chiusura_scena: true inatteso — la scena è appena iniziata' : null
      ]
    }
  ))

  // ── Riepilogo ──────────────────────────────────────────────────────────────
  const passed  = results.filter(r => r.ok).length
  const warning = results.filter(r => !r.ok && r.result !== null).length
  const failed  = results.filter(r => r.result === null).length
  const total   = results.length

  console.log(`\n${'─'.repeat(55)}`)
  console.log(`Risultato: ${passed}/${total} fasi ok  |  ${warning} con warning  |  ${failed} con errore`)
  console.log(`Artifacts: ${ARTIFACTS_DIR}\n`)

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
