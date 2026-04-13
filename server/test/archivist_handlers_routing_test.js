const assert = require('assert')
const fs = require('fs').promises
const os = require('os')
const path = require('path')

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myllm-archivist-handlers-'))
  process.env.DATA_DIR_OVERRIDE = dataDir

  const { ensureDir, writeJSON } = require('../src/utils/fileStore')
  const runtimeStore = require('../src/services/tableRuntimeStore')
  const { getOrCreateSession, getSession, destroySession, clearAllTimers } = require('../src/services/sessionService')
  const { getOrCreate, destroy } = require('../src/services/custodeEngine')

  await ensureDir(path.join(dataDir, 'tables'))
  const notesDir = path.join(dataDir, 'modules', '21a79df1da33', 'notes')
  await ensureDir(notesDir)
  await writeJSON(path.join(dataDir, 'users.json'), [
    { email: 'luca@example.com', name: 'Luca' }
  ])

  await writeJSON(path.join(notesDir, 'scena_asta_grand_palais.json'), {
    id_scena: 'scena_asta_grand_palais',
    titolo: "L'asta al Grand Palais",
    preparazione: {
      location: { nome: 'Sala delle Antichita, Grand Palais', descrizione_atmosfera: 'Asta privata elegante e tesa.', dettagli_sensoriali: ['brusio sommesso'] },
      connessioni: [],
      png_presenti: ['png_sophia_hapgood'],
      indizi_disponibili: [],
      minacce: [],
      trigger: [],
      condizioni_uscita: { naturale: '', forzata: '', fallimento: '' }
    },
    runtime: { stato: 'in_corso', tempo_inizio: null, tempo_corrente: null, eventi_accaduti: [], trigger_attivati: [], indizi_trovati: [], note_scene_master: null }
  })

  await writeJSON(path.join(notesDir, 'png_sophia_hapgood.json'), {
    id_png: 'png_sophia_hapgood',
    nome: 'Sophia Hapgood',
    profilo: {
      descrizione: 'Elegante ma inquieta.',
      occupazione: 'Conferenziera',
      personalita: ['sincera'],
      segreto: '',
      obiettivo_primario: '',
      obiettivi_secondari: [],
      agenda: [],
      conoscenze: { rivela_liberamente: [], rivela_se_fiducia: [], non_rivela_mai: [] },
      stile_dialogo: 'Voce bassa.'
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
      npc: [{ type: 'npc', id: 'png_sophia_hapgood', name: 'Sophia Hapgood', file: 'png_sophia_hapgood.json' }],
      scene: [{
        type: 'scene',
        id: 'scena_asta_grand_palais',
        name: "L'asta al Grand Palais",
        locationName: 'Sala delle Antichita, Grand Palais',
        file: 'scena_asta_grand_palais.json',
        references: { npcs: ['png_sophia_hapgood'], clues: [], connections: [] },
        appearsWith: { npcs: ['png_sophia_hapgood'], clues: [], connections: [] }
      }],
      object: [],
      clue: [],
      relation: []
    },
    byId: {
      scena_asta_grand_palais: { type: 'scene', id: 'scena_asta_grand_palais', name: "L'asta al Grand Palais", file: 'scena_asta_grand_palais.json' },
      png_sophia_hapgood: { type: 'npc', id: 'png_sophia_hapgood', name: 'Sophia Hapgood', file: 'png_sophia_hapgood.json' }
    },
    byName: {
      npc: {
        'sophia hapgood': { type: 'npc', id: 'png_sophia_hapgood', name: 'Sophia Hapgood', file: 'png_sophia_hapgood.json' }
      },
      scene: {
        "l'asta al grand palais": { type: 'scene', id: 'scena_asta_grand_palais', name: "L'asta al Grand Palais", file: 'scena_asta_grand_palais.json' }
      },
      object: {},
      clue: {}
    }
  })

  const tableId = 'test_archivist_handlers_routing'
  const tableDir = path.join(dataDir, 'tables', tableId)
  await ensureDir(path.join(tableDir, 'characters'))
  await ensureDir(path.join(tableDir, 'pngs'))
  await ensureDir(path.join(tableDir, 'scenes'))
  await writeJSON(path.join(tableDir, 'table.json'), { id: tableId, players: [], moduleId: 'mod_21a79df1da33' })
  await writeJSON(path.join(tableDir, 'groups.json'), {
    turno_corrente: null,
    gruppi_attivi: [{ groupId: 'group01', sceneId: 'scena_asta_grand_palais', participants: ['Luk'] }]
  })
  await writeJSON(path.join(tableDir, 'story_log.json'), { entries: [] })
  await writeJSON(path.join(tableDir, 'party_knowledge.json'), { entries: [] })
  await writeJSON(path.join(tableDir, 'game_clock.json'), {
    currentChapter: 1,
    data_inizio_avventura: '1936-07-15',
    giorno_avventura: 1,
    ora_gioco: '20:30'
  })
  await writeJSON(path.join(tableDir, 'characters', 'luk.json'), {
    name: 'Luk',
    playerID: 'luca@example.com',
    profession: 'Investigatore',
    runtime: {
      handlers: [{ type: 'npc', id: 'png_sophia_hapgood', name: 'Sophia Hapgood' }],
      position: 'accanto a Sophia Hapgood'
    }
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
  await writeJSON(path.join(tableDir, 'scenes', 'scena_asta_grand_palais.json'), {
    id_scena: 'scena_asta_grand_palais',
    runtime: { stato: 'in_corso', tempo_inizio: null, tempo_corrente: null, eventi_accaduti: [], trigger_attivati: [], indizi_trovati: [], note_scene_master: null }
  })

  await getOrCreateSession(tableId, ['luca@example.com'])
  const ctx = getSession(tableId)
  ctx.session.custodePhase = 'orchestrator-passive'
  ctx.session.phase = 'first_person'
  ctx.session.state = 'sessione-iniziata'
  ctx.session.players = [{ email: 'luca@example.com', characterName: 'Luk', playerState: 'gioco-libero', connected: true }]
  ctx.session.conversationTargets = {}

  const io = { to: () => ({ emit: () => {} }), sockets: { sockets: new Map() } }
  const engine = getOrCreate(tableId, io)
  await engine.startPassiveOrchestrator()
  let sceneMasterCalls = 0
  let npcMasterCalls = 0
  engine.answerCustodeQuestion = async () => {}
  engine.answerNpcMasterInteraction = async () => { npcMasterCalls += 1 }
  engine.answerSceneMasterDeclaration = async () => { sceneMasterCalls += 1 }

  await engine.onPlayerMessage({
    id: 'msg-1',
    type: 'normal',
    from: 'luca@example.com',
    fromName: 'Luca',
    text: '"Buongiorno."'
  })

  assert.equal(ctx.session.conversationTargets['luca@example.com'], 'Sophia Hapgood')
  assert.equal(engine.buffer[0].tag, 'frase in-character')
  assert.equal(npcMasterCalls, 1)
  assert.equal(sceneMasterCalls, 0)

  const actor = await runtimeStore.getCharacterByName(tableId, 'Luk')
  assert.equal(actor.runtime.handlers[0].name, 'Sophia Hapgood')

  await writeJSON(path.join(tableDir, 'characters', 'luk.json'), {
    ...actor,
    runtime: {
      ...(actor.runtime || {}),
      handlers: [
        { type: 'npc', id: 'png_sophia_hapgood', name: 'Sophia Hapgood' },
        { type: 'npc', id: 'png_marcel_dumont', name: 'Marcel Dumont' }
      ]
    }
  })
  ctx.session.conversationTargets = {}
  ctx.messages = []
  engine.buffer = []

  await engine.onPlayerMessage({
    id: 'msg-2',
    type: 'normal',
    from: 'luca@example.com',
    fromName: 'Luca',
    text: '"Buongiorno."'
  })

  assert.equal(ctx.session.conversationTargets['luca@example.com'], undefined)
  assert.equal(engine.buffer[0].tag, 'frase in-character')
  assert.equal(sceneMasterCalls, 1)
  assert.equal(npcMasterCalls, 1)

  clearAllTimers(tableId)
  destroy(tableId)
  destroySession(tableId)
  console.log('archivist_handlers_routing_test: ok')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
