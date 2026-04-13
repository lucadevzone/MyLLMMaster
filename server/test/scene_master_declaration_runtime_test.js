const assert = require('assert')
const fs = require('fs').promises
const os = require('os')
const path = require('path')

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myllm-scene-master-'))
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
      png_presenti: [],
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
    counts: { files: 1, npc: 0, scene: 1, object: 0, clue: 0, relation: 0 },
    files: [
      { file: 'scena_asta_grand_palais.json', kind: 'scene', entityCount: 1 }
    ],
    entities: {
      npc: [],
      scene: [{
        type: 'scene',
        id: 'scena_asta_grand_palais',
        name: "L'asta al Grand Palais",
        locationName: 'Sala delle Antichità, Grand Palais',
        file: 'scena_asta_grand_palais.json',
        references: { npcs: [], clues: [], connections: [] },
        appearsWith: { npcs: [], clues: [], connections: [] }
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
        locationName: 'Sala delle Antichità, Grand Palais',
        file: 'scena_asta_grand_palais.json'
      }
    },
    byName: {
      npc: {},
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

  const tableId = 'test_scene_master_runtime'
  const tableDir = path.join(dataDir, 'tables', tableId)
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
        participants: ['Emil']
      }
    ]
  })
  await writeJSON(path.join(tableDir, 'characters', 'emil.json'), {
    name: 'Emil',
    playerID: 'emilio@example.com',
    archetype: 'Investigatore'
  })
  await writeJSON(path.join(tableDir, 'party_knowledge.json'), {
    entries: [
      {
        id: 1,
        scena: 'scena_asta_grand_palais',
        timestamp: '1936-07-15T20:30:00.000Z',
        text: 'Il party sa che l asta e tesa e sorvegliata.'
      }
    ]
  })

  await getOrCreateSession(tableId, ['emilio@example.com'])
  const ctx = getSession(tableId)
  ctx.session.custodePhase = 'orchestrator-passive'
  ctx.session.state = 'sessione-iniziata'
  ctx.session.players = [
    { email: 'emilio@example.com', characterName: 'Emil', playerState: 'gioco-libero', connected: true }
  ]

  const io = { to: () => ({ emit: () => {} }), sockets: { sockets: new Map() } }
  const engine = getOrCreate(tableId, io)
  await engine.startPassiveOrchestrator()

  let llmCalled = false
  engine.llm = async (promptFile, vars) => {
    if (promptFile === 'scene_master_v0_dichiarazione.md') {
      llmCalled = true
      assert.equal(vars.playerName, 'Emil')
      assert.equal(vars.pgName, 'Emil')
      assert.ok(vars.declarationText.includes('Corro fino al podio'))
      assert.ok(vars.contextText.includes('SCENA FOCUS'))
      assert.ok(vars.contextText.includes('PG ATTIVO'))
      assert.ok(vars.contextText.includes('Conoscenze gia acquisite dai PG'))
      assert.ok(vars.contextText.includes('Il party sa che l asta e tesa e sorvegliata'))
      assert.ok(vars.contextText.includes('ABILITA DISPONIBILI'))
      assert.ok(vars.contextText.includes('Persuadere'))
      return {
        decision: 'respond_now',
        response: 'Ti lanci verso il podio, facendoti largo tra gli invitati.',
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
    text: 'Corro fino al podio.'
  })

  assert.equal(llmCalled, true)
  const sceneMessages = ctx.messages.filter(message => message.type === 'custode')
  assert.equal(sceneMessages.length, 1)
  assert.ok(sceneMessages[0].text.includes('podio'))
  assert.ok(ctx.session.players.every(player => player.playerState === 'gioco-libero'))

  clearAllTimers(tableId)
  destroy(tableId)
  destroySession(tableId)
  console.log('scene_master_declaration_runtime_test: ok')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
