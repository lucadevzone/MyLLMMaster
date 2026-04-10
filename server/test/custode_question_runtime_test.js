const assert = require('assert')
const fs = require('fs').promises
const os = require('os')
const path = require('path')

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myllm-custode-question-'))
  process.env.DATA_DIR_OVERRIDE = dataDir

  const { ensureDir, writeJSON } = require('../src/utils/fileStore')
  const { getOrCreateSession, getSession, destroySession, clearAllTimers } = require('../src/services/sessionService')
  const { getOrCreate, destroy } = require('../src/services/custodeEngine')

  await ensureDir(path.join(dataDir, 'tables'))
  const notesDir = path.join(dataDir, 'modules', '21a79df1da33', 'notes')
  await ensureDir(notesDir)
  await writeJSON(path.join(dataDir, 'users.json'), [
    { email: 'emilio@example.com', name: 'Emilio' },
    { email: 'luca@example.com', name: 'Luca' }
  ])
  await writeJSON(path.join(notesDir, 'png_sophia_hapgood.json'), {
    id_png: 'png_sophia_hapgood',
    nome: 'Sophia Hapgood',
    profilo: {
      descrizione: 'Medium e conferenziera inquieta, legata ai reperti di Belloq.',
      occupazione: 'Conferenziera e medium',
      personalita: ['inquieta', 'sincera'],
      segreto: 'Custodisce l amuleto di Nur-Ab-Sal.',
      obiettivo_primario: 'Capire cosa le sta succedendo.',
      obiettivi_secondari: [],
      agenda: [],
      conoscenze: {
        rivela_liberamente: ['Conosceva Belloq.'],
        rivela_se_fiducia: ['Ha ricevuto un amuleto da lui.'],
        non_rivela_mai: []
      },
      stile_dialogo: 'Diretta ma turbata.'
    },
    runtime: {
      stato: 'vivo',
      posizione: null,
      atteggiamento_verso_pg: 'neutrale',
      informazioni_rivelate: [],
      note_npc_master: null
    }
  })
  await writeJSON(path.join(notesDir, 'scena_asta_grand_palais.json'), {
    id_scena: 'scena_asta_grand_palais',
    titolo: "L'asta al Grand Palais",
    preparazione: {
      location: {
        nome: 'Sala delle Antichità, Grand Palais',
        descrizione_atmosfera: 'Asta privata elegante e tesa.',
        dettagli_sensoriali: ['brusio sommesso']
      },
      connessioni: [],
      png_presenti: ['png_sophia_hapgood'],
      indizi_disponibili: [],
      minacce: [],
      trigger: [],
      condizioni_uscita: { naturale: '', forzata: '', fallimento: '' }
    },
    runtime: {
      stato: 'in_corso',
      tempo_inizio: null,
      tempo_corrente: null,
      eventi_accaduti: [],
      trigger_attivati: [],
      indizi_trovati: [],
      note_scene_master: null
    }
  })
  await writeJSON(path.join(notesDir, 'module_notes_index.json'), {
    generatedAt: new Date().toISOString(),
    notesDir,
    counts: { files: 2, npc: 1, scene: 1, object: 0, clue: 0, relation: 0 },
    files: [
      { file: 'png_sophia_hapgood.json', kind: 'npc', entityCount: 1 },
      { file: 'scena_asta_grand_palais.json', kind: 'scene', entityCount: 1 }
    ],
    entities: {
      npc: [{
        type: 'npc',
        id: 'png_sophia_hapgood',
        name: 'Sophia Hapgood',
        file: 'png_sophia_hapgood.json',
        referencedBy: { scenes: [{ id: 'scena_asta_grand_palais', name: "L'asta al Grand Palais", file: 'scena_asta_grand_palais.json' }], objects: [], outgoingRelations: [], incomingRelations: [] }
      }],
      scene: [{
        type: 'scene',
        id: 'scena_asta_grand_palais',
        name: "L'asta al Grand Palais",
        locationName: 'Sala delle Antichità, Grand Palais',
        file: 'scena_asta_grand_palais.json',
        references: { npcs: ['png_sophia_hapgood'], clues: [], connections: [] },
        appearsWith: { npcs: [{ id: 'png_sophia_hapgood', name: 'Sophia Hapgood', file: 'png_sophia_hapgood.json', type: 'npc' }], clues: [], connections: [] }
      }],
      object: [],
      clue: [],
      relation: []
    },
    byId: {
      png_sophia_hapgood: { type: 'npc', id: 'png_sophia_hapgood', name: 'Sophia Hapgood', file: 'png_sophia_hapgood.json' },
      scena_asta_grand_palais: { type: 'scene', id: 'scena_asta_grand_palais', name: "L'asta al Grand Palais", locationName: 'Sala delle Antichità, Grand Palais', file: 'scena_asta_grand_palais.json' }
    },
    byName: {
      npc: { 'sophia hapgood': { type: 'npc', id: 'png_sophia_hapgood', name: 'Sophia Hapgood', file: 'png_sophia_hapgood.json' } },
      scene: { "l'asta al grand palais": { type: 'scene', id: 'scena_asta_grand_palais', name: "L'asta al Grand Palais", file: 'scena_asta_grand_palais.json' } },
      object: {},
      clue: {}
    }
  })

  const tableId = 'test_custode_question_runtime'
  const tableDir = path.join(dataDir, 'tables', tableId)
  await ensureDir(tableDir)
  await ensureDir(path.join(tableDir, 'characters'))
  await writeJSON(path.join(tableDir, 'table.json'), {
    id: tableId,
    players: [],
    moduleId: 'mod_21a79df1da33'
  })
  await writeJSON(path.join(tableDir, 'groups.json'), {
    turno_corrente: null,
    gruppi_attivi: [
      {
        groupId: 'group01',
        sceneId: 'scena_asta_grand_palais',
        participants: ['Emil', 'Luk']
      }
    ]
  })
  await writeJSON(path.join(tableDir, 'party_knowledge.json'), {
    entries: [
      {
        id: 1,
        scena: 'scena_asta_grand_palais',
        text: 'Il party sa che Belloq e scomparso da mesi.'
      }
    ]
  })

  await getOrCreateSession(tableId, ['emilio@example.com', 'luca@example.com'])
  const ctx = getSession(tableId)
  ctx.session.custodePhase = 'orchestrator-passive'
  ctx.session.state = 'sessione-iniziata'
  ctx.session.players = [
    { email: 'emilio@example.com', characterName: 'Emil', playerState: 'gioco-libero', connected: true },
    { email: 'luca@example.com', characterName: 'Luk', playerState: 'gioco-libero', connected: true }
  ]

  const io = { to: () => ({ emit: () => {} }), sockets: { sockets: new Map() } }
  const engine = getOrCreate(tableId, io)
  await engine.startPassiveOrchestrator()

  let llmCalled = false
  engine.llmText = async (promptFile, vars) => {
    llmCalled = true
    assert.equal(promptFile, 'custode_v1_domanda_diretta.md')
    assert.equal(vars.questionType, 'npc_clarification')
    assert.ok(vars.contextText.includes('Sophia Hapgood'))
    assert.ok(vars.contextText.includes('COSA SANNO I PG'))
    return 'Per quanto ne sapete finora, no: Sophia Hapgood entra in gioco proprio in questa fase degli eventi.'
  }

  await engine.onPlayerMessage({
    type: 'normal',
    from: 'emilio@example.com',
    fromName: 'Emilio',
    text: 'Master, abbiamo già incontrato Sophia Hapgood prima di oggi?'
  })

  assert.equal(llmCalled, true)
  const custodeMessages = ctx.messages.filter(message => message.type === 'custode')
  assert.equal(custodeMessages.length, 1)
  assert.ok(custodeMessages[0].text.includes('Sophia Hapgood'))
  assert.ok(ctx.session.players.every(player => player.playerState === 'gioco-libero'))

  let rulesPromptCalled = false
  engine.llmText = async (promptFile, vars) => {
    rulesPromptCalled = true
    assert.equal(promptFile, 'custode_v1_domanda_regole.md')
    assert.equal(vars.questionType, 'rules_reference_question')
    assert.ok(vars.contextText.includes('ESTRATTO REGOLE'))
    return 'Furtivita serve a muoversi o agire senza attirare attenzione.'
  }

  await engine.onPlayerMessage({
    type: 'normal',
    from: 'luca@example.com',
    fromName: 'Luca',
    text: "Cosa sai dirmi dell'abilita Furtivita?"
  })

  assert.equal(rulesPromptCalled, true)

  clearAllTimers(tableId)
  destroy(tableId)
  destroySession(tableId)
  console.log('custode_question_runtime_test: ok')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
