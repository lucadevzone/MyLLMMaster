'use strict'
/**
 * Test del loop tool-calling in callOllamaWithTools.
 *
 * Mocka fetch globale per simulare:
 *  Round 0: Ollama chiama consulto_il_manuale("Madame Fouchet")
 *  Round 1: Ollama restituisce il JSON finale
 *
 * Non richiede Ollama in esecuzione.
 */

const assert = require('assert')

// ── Mock fetch prima di richiedere ollamaService ───────────────────────────────

let fetchCallCount = 0
const fetchResponses = []

global.fetch = async (url, opts) => {
  fetchCallCount++
  const idx = fetchCallCount - 1
  const responseData = fetchResponses[idx] || fetchResponses[fetchResponses.length - 1]
  return {
    ok: true,
    json: async () => responseData
  }
}

// ── Carica il modulo dopo aver sostituito fetch ────────────────────────────────

// Rimuovi dalla cache se già caricato (sicurezza in ambienti con test multipli)
Object.keys(require.cache)
  .filter(k => k.includes('ollamaService'))
  .forEach(k => delete require.cache[k])

const ollama = require('../src/services/ollamaService')

// ── Helper ────────────────────────────────────────────────────────────────────

function makeToolCallResponse(toolName, args) {
  return {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: toolName, arguments: args } }]
    }
  }
}

function makeFinalResponse(jsonObj) {
  return {
    message: {
      role: 'assistant',
      content: JSON.stringify(jsonObj),
      tool_calls: null
    }
  }
}

// ── Test 1: loop base (1 tool call + risposta finale) ─────────────────────────

async function testToolCallLoop() {
  fetchCallCount = 0
  fetchResponses.length = 0

  const ragResults = []  // il tool handler raccoglie le chiamate qui

  const toolHandlers = {
    consulto_il_manuale: async ({ argomento }) => {
      ragResults.push(argomento)
      return `[personaggio] Madame Fouchet:\nAnziana libraia parigina, occhi acuti. Conosce il venditore del lotto 47.`
    }
  }

  const toolDefinition = [{
    type: 'function',
    function: {
      name: 'consulto_il_manuale',
      description: 'Recupera informazioni dal manuale.',
      parameters: {
        type: 'object',
        properties: { argomento: { type: 'string' } },
        required: ['argomento']
      }
    }
  }]

  const finalJson = {
    narrativa: 'La sala d\'aste si anima. Madame Fouchet vi guarda con sospetto.',
    sussurri: [],
    durata: 'minuti',
    divisione_gruppi: false,
    ricongiungimento_gruppi: false,
    chiusura_scena: false,
    aggiornamenti: {
      diary: '',
      stato_pgs: { Emil: { stato: 'In sala, osserva Madame Fouchet' } },
      nuove_conoscenze: '',
      npcs: []
    }
  }

  // Round 0: Ollama chiama il tool
  fetchResponses.push(makeToolCallResponse('consulto_il_manuale', { argomento: 'Madame Fouchet' }))
  // Round 1: risposta finale JSON
  fetchResponses.push(makeFinalResponse(finalJson))

  const result = await ollama.runPhaseWithTools(
    'test-model',
    'fase5_risoluzione.md',  // prompt reale (verrà caricato dal disco)
    {
      piano_azione: '[]',
      diary: 'Prima sessione.',
      contesto_dove: 'Sala d\'aste Hotel Drouot',
      momento_corrente: '14 ottobre 1923, ore 14:30',
      progressione: '(nessuna)',
      stato_pgs: 'Emil: in sala',
      stato_pngs: '(nessuno)',
      conoscenze_party: '(nessuna)',
      nomi_disponibili: 'PNG: Madame Fouchet',
      schede_PG: 'Emil Voss, giornalista'
    },
    toolDefinition,
    toolHandlers,
    {},
    null  // tableId null → nessun log su disco
  )

  assert.strictEqual(fetchCallCount, 2, `Atteso 2 fetch, ottenuto ${fetchCallCount}`)
  assert.deepStrictEqual(ragResults, ['Madame Fouchet'], `Tool chiamato con arg sbagliato: ${JSON.stringify(ragResults)}`)
  assert.strictEqual(result.narrativa, finalJson.narrativa, 'narrativa non coincide')
  assert.strictEqual(result.durata, 'minuti', 'durata non coincide')
  assert.strictEqual(result.aggiornamenti.stato_pgs.Emil.stato, 'In sala, osserva Madame Fouchet')

  console.log('  ✓ Loop base: 1 tool call + risposta JSON finale')
}

// ── Test 2: nessun tool call (risposta diretta al primo round) ────────────────

async function testNoToolCall() {
  fetchCallCount = 0
  fetchResponses.length = 0

  const finalJson = {
    piano: [{
      pg: 'Emil',
      stato: 'dichiarazione',
      azione: 'Esamina il catalogo d\'aste',
      abilita_o_caratteristica: null,
      difficolta: null,
      risultato_prova: null
    }]
  }

  fetchResponses.push(makeFinalResponse(finalJson))

  const toolHandlers = {
    consulto_il_manuale: async () => 'non dovrebbe essere chiamato'
  }

  const result = await ollama.runPhaseWithTools(
    'test-model',
    'fase4b_analisi_dichiarazioni.md',
    {
      schede_PG: 'Emil Voss',
      messaggi_buffer: '[dichiarazione] Emil: Esamino il catalogo',
      piano_azione: 'nessuno',
      diary: '',
      contesto_dove: 'Sala d\'aste',
      momento_corrente: '14 ottobre 1923',
      progressione: '(nessuna)',
      stato_pgs: 'Emil: in piedi',
      stato_pngs: '(nessuno)',
      conoscenze_party: '(nessuna)',
      nomi_disponibili: 'PNG: Madame Fouchet'
    },
    [{ type: 'function', function: { name: 'consulto_il_manuale', description: '...', parameters: { type: 'object', properties: { argomento: { type: 'string' } }, required: ['argomento'] } } }],
    toolHandlers,
    {},
    null
  )

  assert.strictEqual(fetchCallCount, 1, `Atteso 1 fetch, ottenuto ${fetchCallCount}`)
  assert.ok(result.piano, 'piano mancante nel risultato')
  assert.strictEqual(result.piano[0].pg, 'Emil')

  console.log('  ✓ Nessun tool call: risposta JSON diretta al primo round')
}

// ── Test 3: tool chiamato più volte (2 tool call, poi risposta finale) ─────────

async function testMultipleToolCalls() {
  fetchCallCount = 0
  fetchResponses.length = 0

  const ragQueries = []

  const toolHandlers = {
    consulto_il_manuale: async ({ argomento }) => {
      ragQueries.push(argomento)
      return `Risultato per: ${argomento}`
    }
  }

  const finalJson = { narrativa: 'La scena si evolve.', sussurri: [], durata: 'turno', divisione_gruppi: false, ricongiungimento_gruppi: false, chiusura_scena: false, aggiornamenti: { diary: '', stato_pgs: {}, nuove_conoscenze: '', npcs: [] } }

  // Round 0: chiama tool per PNG
  fetchResponses.push(makeToolCallResponse('consulto_il_manuale', { argomento: 'Madame Fouchet' }))
  // Round 1: chiama tool per indizio
  fetchResponses.push(makeToolCallResponse('consulto_il_manuale', { argomento: 'simbolo sul retro del lotto 47' }))
  // Round 2: risposta finale
  fetchResponses.push(makeFinalResponse(finalJson))

  const result = await ollama.runPhaseWithTools(
    'test-model',
    'fase5_risoluzione.md',
    {
      piano_azione: '[]', diary: '', contesto_dove: 'Sala', momento_corrente: '14 ottobre 1923',
      progressione: '(nessuna)', stato_pgs: '', stato_pngs: '', conoscenze_party: '',
      nomi_disponibili: 'PNG: Madame Fouchet\nIndizi: simbolo sul retro del lotto 47', schede_PG: 'Emil'
    },
    [{ type: 'function', function: { name: 'consulto_il_manuale', description: '...', parameters: { type: 'object', properties: { argomento: { type: 'string' } }, required: ['argomento'] } } }],
    toolHandlers,
    {},
    null
  )

  assert.strictEqual(fetchCallCount, 3, `Atteso 3 fetch, ottenuto ${fetchCallCount}`)
  assert.deepStrictEqual(ragQueries, ['Madame Fouchet', 'simbolo sul retro del lotto 47'])
  assert.strictEqual(result.narrativa, 'La scena si evolve.')

  console.log('  ✓ Tool multipli: 2 query RAG in sequenza, poi risposta finale')
}

// ── Test 4: tool inesistente (handler mancante → graceful fallback) ─────────

async function testUnknownTool() {
  fetchCallCount = 0
  fetchResponses.length = 0

  const finalJson = { narrativa: 'Ok.', sussurri: [], durata: 'turno', divisione_gruppi: false, ricongiungimento_gruppi: false, chiusura_scena: false, aggiornamenti: { diary: '', stato_pgs: {}, nuove_conoscenze: '', npcs: [] } }

  fetchResponses.push(makeToolCallResponse('tool_inesistente', { argomento: 'test' }))
  fetchResponses.push(makeFinalResponse(finalJson))

  const result = await ollama.runPhaseWithTools(
    'test-model', 'fase5_risoluzione.md',
    {
      piano_azione: '[]', diary: '', contesto_dove: 'Sala', momento_corrente: '14 ottobre 1923',
      progressione: '', stato_pgs: '', stato_pngs: '', conoscenze_party: '', nomi_disponibili: '', schede_PG: ''
    },
    [{ type: 'function', function: { name: 'consulto_il_manuale', description: '...', parameters: { type: 'object', properties: { argomento: { type: 'string' } }, required: ['argomento'] } } }],
    {},  // nessun handler registrato
    {},
    null
  )

  assert.strictEqual(result.narrativa, 'Ok.')
  console.log('  ✓ Tool inesistente: graceful fallback, loop continua correttamente')
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== Tool Calling Tests ===\n')
  let passed = 0, failed = 0

  const tests = [
    ['Loop base (1 tool call)', testToolCallLoop],
    ['Nessun tool call', testNoToolCall],
    ['Tool multipli in sequenza', testMultipleToolCalls],
    ['Tool inesistente (graceful)', testUnknownTool],
  ]

  for (const [name, fn] of tests) {
    try {
      await fn()
      passed++
    } catch (err) {
      failed++
      console.error(`  ✗ ${name}: ${err.message}`)
      if (process.env.VERBOSE) console.error(err.stack)
    }
  }

  console.log(`\n${passed + failed} test, ${passed} passati, ${failed} falliti\n`)
  if (failed > 0) process.exit(1)
}

main().catch(err => { console.error(err); process.exit(1) })
