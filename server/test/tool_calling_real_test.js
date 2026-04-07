'use strict'
/**
 * Test REALE tool calling con Ollama in esecuzione.
 *
 * Chiama runPhaseWithTools con prompt fase5_risoluzione.md.
 * Il tool handler restituisce testo RAG statico (nessun indice necessario).
 * Verifica che il modello:
 *   1. Usi (o meno) consulto_il_manuale
 *   2. Restituisca JSON valido con i campi attesi
 *
 * Uso: node test/tool_calling_real_test.js [modello]
 * Default: llama3.1:8b
 */

const ollama = require('../src/services/ollamaService')

const MODEL = process.argv[2] || 'llama3.1:8b'

const TOOL_DEFINITION = [{
  type: 'function',
  function: {
    name: 'consulto_il_manuale',
    description: "Recupera informazioni dal manuale dell'avventura su un PNG, luogo, oggetto, pericolo o indizio specifico.",
    parameters: {
      type: 'object',
      properties: {
        argomento: {
          description: "Nome o tipo dell'elemento da cercare"
        }
      },
      required: ['argomento']
    }
  }
}]

// Handler con risposte statiche per argomenti comuni
const FAKE_RAG = {
  'madame fouchet': '[personaggio] Madame Fouchet:\nAnziana libraia parigina, capelli grigi raccolti. Riconosce il simbolo sul retro del lotto 47 ma finge di non sapere nulla. Porta sempre con sé un piccolo bloc-notes.',
  'lotto 47': '[indizio] Lotto 47 — Maschera cerimoniale:\nMaschera in bronzo di fattura sconosciuta, fori oculari vuoti. Sul retro un simbolo inciso: tre cerchi concentrici con un occhio al centro. Proviene da una collezione privata di Marsiglia.',
  'simbolo': '[indizio] Simbolo dei Tre Cerchi:\nRicorrente nei testi della setta del Dio Che Dorme. Indica un luogo di convocazione.',
  'sala d\'aste': '[luogo] Sala d\'aste principale Hotel Drouot:\nGrande salone al piano nobile, sedie rosse in fila, podio del banditore. Uscita laterale conduce ai magazzini. Sorvegliato da due inservienti.'
}

function toolHandler(query) {
  const key = query.toLowerCase()
  for (const [k, v] of Object.entries(FAKE_RAG)) {
    if (key.includes(k)) return v
  }
  return '(nessuna informazione specifica trovata per questa query)'
}

const VARS = {
  piano_azione: JSON.stringify([
    { pg: 'Emil', stato: 'dichiarazione', azione: 'Osserva il lotto 47 sul podio da vicino', abilita_o_caratteristica: null, difficolta: null, risultato_prova: null },
    { pg: 'Luk',  stato: 'domanda',      azione: 'Chiede al Custode: c\'è qualcuno che sorveglia i magazzini sul retro?', abilita_o_caratteristica: null, difficolta: null, risultato_prova: null }
  ]),
  diary: 'I PG sono arrivati a Parigi e hanno scoperto che la maschera cerimoniale di loro interesse sarà battuta all\'asta all\'Hotel Drouot.',
  contesto_dove: "Sala d'aste principale, Hotel Drouot, Parigi — 14 ottobre 1923, ore 14:30",
  momento_corrente: '14 ottobre 1923, ore 14:30',
  progressione: "Emil e Luk sono entrati in sala. L'asta sta per cominciare. Il banditore sistema i fogli sul podio.",
  stato_pgs: 'Emil: seduto in seconda fila, scheda d\'asta in mano\nLuk: in piedi vicino all\'ingresso laterale',
  stato_pngs: 'Madame Fouchet: seduta in prima fila, volge le spalle ai PG\nInserviente: sorveglia l\'uscita laterale',
  conoscenze_party: 'La maschera cerimoniale (lotto 47) è di origine sconosciuta e potrebbe essere collegata alla setta.',
  nomi_disponibili: 'PNG: Madame Fouchet, L\'assistente muto, Il banditore\nIndizi: Lotto 47 — maschera cerimoniale, simbolo sul retro\nLuoghi: magazzini sul retro, uscita laterale\nMinacce: cultista infiltrato tra i compratori',
  schede_PG: 'Emil Voss — giornalista investigativo, Psicologia 65%, Osservare 70%\nLuk Barański — antiquario polacco, Valutare 75%, Biblioteconomia 60%'
}

async function run() {
  console.log(`\n=== Tool Calling REALE — modello: ${MODEL} ===\n`)

  const toolCalls = []
  const handlers = {
    consulto_il_manuale: async ({ argomento }) => {
      toolCalls.push(argomento)
      const result = toolHandler(argomento)
      console.log(`  🔧 Tool chiamato: "${argomento}"`)
      console.log(`     → ${result.slice(0, 80)}...`)
      return result
    }
  }

  console.log('Invio prompt fase5_risoluzione.md...\n')
  const t0 = Date.now()

  let result
  try {
    result = await ollama.runPhaseWithTools(
      MODEL,
      'fase5_risoluzione.md',
      VARS,
      TOOL_DEFINITION,
      handlers,
      { num_ctx: 4096 },
      null  // no tableId → no log su disco
    )
  } catch (err) {
    console.error('ERRORE:', err.message)
    process.exit(1)
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`\nRisposta ricevuta in ${elapsed}s\n`)

  // ── Stampa risultato
  console.log('--- NARRATIVA ---')
  console.log(result.narrativa || '(mancante)')

  if (result.sussurri?.length) {
    console.log('\n--- SUSSURRI ---')
    result.sussurri.forEach(s => console.log(`  [${s.target}] ${s.testo}`))
  }

  console.log(`\ndurata: ${result.durata}`)
  console.log(`divisione_gruppi: ${result.divisione_gruppi}`)
  console.log(`chiusura_scena: ${result.chiusura_scena}`)

  if (result.aggiornamenti?.nuove_conoscenze) {
    console.log('\nnuove_conoscenze:', result.aggiornamenti.nuove_conoscenze)
  }
  if (result.aggiornamenti?.diary) {
    console.log('diary entry:', result.aggiornamenti.diary)
  }

  const stato = result.aggiornamenti?.stato_pgs || {}
  if (Object.keys(stato).length) {
    console.log('\nstato_pgs aggiornato:')
    for (const [pg, s] of Object.entries(stato)) console.log(`  ${pg}: ${s.stato}`)
  }

  // ── Statistiche tool
  console.log(`\n--- TOOL CALLS: ${toolCalls.length} ---`)
  toolCalls.forEach((q, i) => console.log(`  [${i+1}] "${q}"`))

  // ── Verifica campi obbligatori
  const required = ['narrativa', 'durata', 'divisione_gruppi', 'chiusura_scena', 'aggiornamenti']
  const missing = required.filter(k => !(k in result))
  if (missing.length) {
    console.error(`\n⚠ Campi mancanti: ${missing.join(', ')}`)
    process.exit(1)
  }

  console.log('\n✓ Tutti i campi obbligatori presenti. Test superato.\n')
}

run().catch(err => { console.error(err); process.exit(1) })
