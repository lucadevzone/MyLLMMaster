const assert = require('assert')
const fs = require('fs').promises
const os = require('os')
const path = require('path')

async function waitFor(predicate, { timeoutMs = 1500, intervalMs = 25 } = {}) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const result = await predicate()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  return null
}

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myllm-archivist-'))
  process.env.DATA_DIR_OVERRIDE = dataDir

  const { ensureDir, writeJSON } = require('../src/utils/fileStore')
  const runtimeStore = require('../src/services/tableRuntimeStore')
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
      tempo_inizio: '1936-07-15T20:00:00.000Z',
      tempo_corrente: '1936-07-15T20:30:00.000Z',
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
      scena_asta_grand_palais: { type: 'scene', id: 'scena_asta_grand_palais', name: "L'asta al Grand Palais", file: 'scena_asta_grand_palais.json' },
      png_sophia_hapgood: { type: 'npc', id: 'png_sophia_hapgood', name: 'Sophia Hapgood', file: 'png_sophia_hapgood.json' }
    },
    byName: {
      npc: { 'sophia hapgood': { type: 'npc', id: 'png_sophia_hapgood', name: 'Sophia Hapgood', file: 'png_sophia_hapgood.json' } },
      scene: { "l'asta al grand palais": { type: 'scene', id: 'scena_asta_grand_palais', name: "L'asta al Grand Palais", file: 'scena_asta_grand_palais.json' } },
      object: {},
      clue: {}
    }
  })

  const tableId = 'test_archivist_runtime_update'
  const tableDir = path.join(dataDir, 'tables', tableId)
  await ensureDir(path.join(tableDir, 'characters'))
  await ensureDir(path.join(tableDir, 'pngs'))
  await ensureDir(path.join(tableDir, 'scenes'))
  await writeJSON(path.join(tableDir, 'table.json'), { id: tableId, players: [], moduleId: 'mod_21a79df1da33' })
  await writeJSON(path.join(tableDir, 'groups.json'), {
    turno_corrente: null,
    gruppi_attivi: [{ groupId: 'group01', sceneId: 'scena_asta_grand_palais', participants: ['Emil'] }]
  })
  await writeJSON(path.join(tableDir, 'game_clock.json'), {
    currentChapter: 1,
    data_inizio_avventura: '1936-07-15',
    giorno_avventura: 1,
    ora_gioco: '20:30'
  })
  await writeJSON(path.join(tableDir, 'story_log.json'), { entries: [] })
  await writeJSON(path.join(tableDir, 'party_knowledge.json'), { entries: [] })
  await writeJSON(path.join(tableDir, 'characters', 'emil.json'), {
    name: 'Emil',
    playerID: 'emilio@example.com',
    profession: 'Investigatore'
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
    runtime: {
      stato: 'in_corso',
      tempo_inizio: '1936-07-15T20:00:00.000Z',
      tempo_corrente: '1936-07-15T20:30:00.000Z',
      eventi_accaduti: [],
      trigger_attivati: [],
      indizi_trovati: [],
      note_scene_master: null
    }
  })

  await getOrCreateSession(tableId, ['emilio@example.com'])
  const ctx = getSession(tableId)
  ctx.session.custodePhase = 'orchestrator-passive'
  ctx.session.phase = 'first_person'
  ctx.session.state = 'sessione-iniziata'
  ctx.session.players = [{ email: 'emilio@example.com', characterName: 'Emil', playerState: 'gioco-libero', connected: true }]

  const io = { to: () => ({ emit: () => {} }), sockets: { sockets: new Map() } }
  const engine = getOrCreate(tableId, io)
  await engine.startPassiveOrchestrator()

  engine.llm = async (promptFile) => {
    if (promptFile === 'npc_master_v0_conversazione_neutrale.md') {
      return {
        decision: 'respond_now',
        response: 'Sophia abbassa lo sguardo e ammette che la tavoletta le ricorda qualcosa di terribile.',
        Skill: '',
        Difficulty: ''
      }
    }
    if (promptFile === 'archivist_v0_runtime_update.md') {
      return {
        storyLog: ['Sophia ammette davanti a Emil che la tavoletta le ricorda qualcosa di terribile.'],
        partyKnowledge: ['Sophia collega apertamente la tavoletta a un ricordo terribile.'],
        pgUpdates: [{
          playerName: 'Emil',
          stato: 'Vicino a Sophia, in conversazione riservata.',
          position: 'accanto a Sophia Hapgood, a lato della sala',
          handlers: [{ type: 'npc', name: 'Sophia Hapgood' }]
        }],
        npcUpdates: [{
          npcName: 'Sophia Hapgood',
          addInformazioniRivelate: ['La tavoletta le ricorda qualcosa di terribile.'],
          atteggiamento_verso_pg: 'amichevole: si e aperta con cautela',
          note_npc_master: 'Dopo questo scambio si mostra piu propensa a confidarsi.'
        }],
        elapsedMinutes: 3
      }
    }
    throw new Error(`Prompt inatteso: ${promptFile}`)
  }

  await engine.onPlayerMessage({
    id: 'msg-1',
    type: 'normal',
    from: 'emilio@example.com',
    fromName: 'Emilio',
    text: 'Sophia, puoi dirmi cosa ti turba davvero?'
  })

  const storyLog = await waitFor(async () => {
    const current = await runtimeStore.getStoryLog(tableId)
    return current.entries.length ? current : null
  })
  assert.ok(storyLog)
  assert.equal(storyLog.entries.length, 1)
  assert.ok(storyLog.entries[0].text.includes('Sophia ammette'))

  const partyKnowledge = await waitFor(async () => {
    const current = await runtimeStore.getPartyKnowledge(tableId)
    return current.entries.length ? current : null
  })
  assert.ok(partyKnowledge)
  assert.equal(partyKnowledge.entries.length, 1)
  assert.ok(partyKnowledge.entries[0].text.includes('ricordo terribile'))

  const npc = await waitFor(async () => {
    const current = await runtimeStore.getNpc(tableId, 'png_sophia_hapgood')
    return current?.runtime?.informazioni_rivelate?.length ? current : null
  })
  assert.ok(npc)
  assert.ok(npc.runtime.informazioni_rivelate.includes('La tavoletta le ricorda qualcosa di terribile.'))
  assert.equal(npc.runtime.atteggiamento_verso_pg, 'amichevole: si e aperta con cautela')

  const actorPg = await waitFor(async () => {
    const current = await runtimeStore.getCharacterByName(tableId, 'Emil')
    return current?.runtime?.handlers?.length ? current : null
  })
  assert.ok(actorPg)
  assert.equal(actorPg.stato_corrente, 'Vicino a Sophia, in conversazione riservata.')
  assert.equal(actorPg.runtime.position, 'accanto a Sophia Hapgood, a lato della sala')
  assert.equal(actorPg.runtime.handlers.length, 1)
  assert.equal(actorPg.runtime.handlers[0].type, 'npc')
  assert.equal(actorPg.runtime.handlers[0].name, 'Sophia Hapgood')

  const scene = await waitFor(async () => {
    const current = await runtimeStore.getScene(tableId, 'scena_asta_grand_palais')
    return current?.runtime?.tempo_corrente === '1936-07-15T20:33:00.000Z' ? current : null
  })
  assert.ok(scene)
  assert.equal(scene.runtime.tempo_corrente, '1936-07-15T20:33:00.000Z')

  const clock = await runtimeStore.getGameClock(tableId)
  assert.equal(clock.ora_gioco, '20:33')

  clearAllTimers(tableId)
  destroy(tableId)
  destroySession(tableId)
  console.log('archivist_runtime_update_test: ok')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
