const assert = require('assert')
const fs = require('fs').promises
const os = require('os')
const path = require('path')

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myllm-npc-master-'))
  process.env.DATA_DIR_OVERRIDE = dataDir

  const { ensureDir, writeJSON } = require('../src/utils/fileStore')
  const { getOrCreateSession, getSession, destroySession, clearAllTimers } = require('../src/services/sessionService')
  const { getOrCreate, destroy } = require('../src/services/custodeEngine')

  await ensureDir(path.join(dataDir, 'tables'))
  const notesDir = path.join(dataDir, 'modules', '21a79df1da33', 'notes')
  await ensureDir(notesDir)
  await writeJSON(path.join(dataDir, 'users.json'), [
    { email: 'emilio@example.com', name: 'Emilio' }
  ])

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

  await writeJSON(path.join(notesDir, 'png_sophia_hapgood.json'), {
    id_png: 'png_sophia_hapgood',
    nome: 'Sophia Hapgood',
    profilo: {
      descrizione: 'Elegante ma inquieta.',
      occupazione: 'Conferenziera',
      personalita: ['sincera', 'inquieta'],
      segreto: 'Segreto test',
      obiettivo_primario: 'Capire cosa sta succedendo',
      obiettivi_secondari: [],
      agenda: [],
      conoscenze: {
        rivela_liberamente: ['Conosceva Belloq'],
        rivela_se_fiducia: ['Ha un amuleto'],
        non_rivela_mai: []
      },
      stile_dialogo: 'Voce bassa e sincera.'
    },
    runtime: {
      stato: 'vivo',
      posizione: { tipo: 'scena', id: 'scena_asta_grand_palais' },
      atteggiamento_verso_pg: 'neutrale: guardinga ma disponibile',
      informazioni_rivelate: []
    }
  })

  await writeJSON(path.join(notesDir, 'module_notes_index.json'), {
    generatedAt: new Date().toISOString(),
    notesDir,
    counts: { files: 2, npc: 1, scene: 1, object: 0, clue: 0, relation: 0 },
    files: [
      { file: 'scena_asta_grand_palais.json', kind: 'scene', entityCount: 1 },
      { file: 'png_sophia_hapgood.json', kind: 'npc', entityCount: 1 }
    ],
    entities: {
      npc: [{
        type: 'npc',
        id: 'png_sophia_hapgood',
        name: 'Sophia Hapgood',
        file: 'png_sophia_hapgood.json'
      }],
      scene: [{
        type: 'scene',
        id: 'scena_asta_grand_palais',
        name: "L'asta al Grand Palais",
        locationName: 'Sala delle Antichità, Grand Palais',
        file: 'scena_asta_grand_palais.json',
        references: { npcs: ['png_sophia_hapgood'], clues: [], connections: [] },
        appearsWith: { npcs: ['png_sophia_hapgood'], clues: [], connections: [] }
      }],
      object: [],
      clue: [],
      relation: []
    },
    byId: {
      scena_asta_grand_palais: {
        type: 'scene',
        id: 'scena_asta_grand_palais',
        name: "L'asta al Grand Palais",
        file: 'scena_asta_grand_palais.json'
      },
      png_sophia_hapgood: {
        type: 'npc',
        id: 'png_sophia_hapgood',
        name: 'Sophia Hapgood',
        file: 'png_sophia_hapgood.json'
      }
    },
    byName: {
      npc: {
        'sophia hapgood': {
          type: 'npc',
          id: 'png_sophia_hapgood',
          name: 'Sophia Hapgood',
          file: 'png_sophia_hapgood.json'
        }
      },
      scene: {
        "l'asta al grand palais": {
          type: 'scene',
          id: 'scena_asta_grand_palais',
          name: "L'asta al Grand Palais",
          file: 'scena_asta_grand_palais.json'
        }
      },
      object: {},
      clue: {}
    }
  })

  const tableId = 'test_npc_master_runtime'
  const tableDir = path.join(dataDir, 'tables', tableId)
  await ensureDir(path.join(tableDir, 'characters'))
  await ensureDir(path.join(tableDir, 'pngs'))
  await writeJSON(path.join(tableDir, 'table.json'), {
    id: tableId,
    players: [],
    moduleId: 'mod_21a79df1da33'
  })
  await writeJSON(path.join(tableDir, 'groups.json'), {
    turno_corrente: null,
    gruppi_attivi: [
      { groupId: 'group01', sceneId: 'scena_asta_grand_palais', participants: ['Emil'] }
    ]
  })
  await writeJSON(path.join(tableDir, 'characters', 'emil.json'), {
    name: 'Emil',
    playerID: 'emilio@example.com',
    archetype: 'Investigatore'
  })
  await writeJSON(path.join(tableDir, 'pngs', 'png_sophia_hapgood.json'), {
    id_png: 'png_sophia_hapgood',
    runtime: {
      stato: 'vivo',
      posizione: { tipo: 'scena', id: 'scena_asta_grand_palais' },
      atteggiamento_verso_pg: 'neutrale: guardinga ma disponibile',
      informazioni_rivelate: []
    }
  })

  await getOrCreateSession(tableId, ['emilio@example.com'])
  const ctx = getSession(tableId)
  ctx.session.custodePhase = 'orchestrator-passive'
  ctx.session.phase = 'first_person'
  ctx.session.state = 'sessione-iniziata'
  ctx.session.players = [
    { email: 'emilio@example.com', characterName: 'Emil', playerState: 'gioco-libero', connected: true }
  ]

  const io = { to: () => ({ emit: () => {} }), sockets: { sockets: new Map() } }
  const engine = getOrCreate(tableId, io)
  await engine.startPassiveOrchestrator()

  let llmCalled = false
  engine.llm = async (promptFile, vars) => {
    if (promptFile === 'npc_master_v1_conversazione_neutrale.md') {
      llmCalled = true
      assert.equal(vars.npcName, 'Sophia Hapgood')
      assert.equal(vars.atteggiamento_verso_pg, 'neutrale: guardinga ma disponibile')
      assert.equal(vars.playerName, 'Emil')
      assert.equal(vars.pgName, 'Emil')
      assert.ok(vars.contextText.includes('PNG ATTIVO'))
      assert.ok(vars.contextText.includes('POSIZIONI IN SCENA'))
      assert.ok(vars.contextText.includes('FINESTRA COMPLETA DELLA CONVERSAZIONE'))
      assert.ok(vars.contextText.includes('ABILITA DISPONIBILI'))
      assert.ok(vars.contextText.includes('Persuadere'))
      assert.ok(!vars.contextText.includes('Armi da Fuoco'))
      return {
        decision: 'respond_now',
        response: 'Sophia abbassa lo sguardo e ti risponde con voce esitante: "Non qui, non davanti a tutti."',
        Skill: '',
        Difficulty: ''
      }
    }
    assert.equal(promptFile, 'archivist_v0_runtime_update.md')
    return {
      storyLog: [],
      partyKnowledge: [],
      npcUpdates: [],
      elapsedMinutes: 0
    }
  }

  await engine.onPlayerMessage({
    id: 'msg-1',
    type: 'normal',
    from: 'emilio@example.com',
    fromName: 'Emilio',
    text: 'Sophia, puoi dirmi cosa ti turba davvero?'
  })

  assert.equal(llmCalled, true)
  const npcMessages = ctx.messages.filter(message => message.type === 'custode')
  assert.equal(npcMessages.length, 1)
  assert.equal(npcMessages[0].fromName, 'Sophia Hapgood')
  assert.ok(npcMessages[0].text.includes('Non qui'))

  clearAllTimers(tableId)
  destroy(tableId)
  destroySession(tableId)
  console.log('npc_master_runtime_test: ok')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
