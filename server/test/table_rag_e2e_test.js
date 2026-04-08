'use strict'

const path = require('path')
const fs = require('fs').promises

const rag = require('../src/services/ragService')
const svc = require('../src/services/sessionService')
const custodeRegistry = require('../src/services/custodeEngine')
const { DATA_DIR } = require('../src/utils/dataInit')
const { ensureDir, writeJSON, readJSON, fileExists } = require('../src/utils/fileStore')

const TABLE_ID = 'tbl_rag_e2e_test'
const MODULE_ID = 'mod_21a79df1da33'
const ARTIFACTS_DIR = path.join(__dirname, 'artifacts_table_rag_e2e')

function tDir(tableId) {
  return path.join(DATA_DIR, 'tables', tableId)
}

function tableRagDir(tableId) {
  return path.join(tDir(tableId), 'rag')
}

function fakeIo() {
  return {
    emitted: [],
    sockets: { sockets: new Map() },
    to() {
      return {
        emit: (event, payload) => {
          this.emitted?.push?.({ event, payload })
        }
      }
    }
  }
}

async function resetTestTable() {
  await fs.rm(tDir(TABLE_ID), { recursive: true, force: true }).catch(() => {})
  await ensureDir(tDir(TABLE_ID))
  await ensureDir(path.join(tDir(TABLE_ID), 'characters'))
  await ensureDir(path.join(tDir(TABLE_ID), 'active_scenes'))
  await ensureDir(path.join(tDir(TABLE_ID), 'closed_scenes'))
  await ensureDir(path.join(tDir(TABLE_ID), 'sessions'))
  await ensureDir(path.join(tDir(TABLE_ID), 'logs'))
}

async function seedBaseTable() {
  const table = {
    id: TABLE_ID,
    moduleId: MODULE_ID,
    state: 'open',
    invitedPlayers: ['pg1@example.test', 'pg2@example.test'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  await writeJSON(path.join(tDir(TABLE_ID), 'table.json'), table)
  await writeJSON(path.join(tDir(TABLE_ID), 'world_state.json'), {
    currentChapter: 1,
    focusScene: null,
    groups: [
      {
        groupId: 'group01',
        sceneId: null,
        participants: ['pg1@example.test', 'pg2@example.test'],
        subLocation: null,
        activity: null
      }
    ],
    npcs: [],
    items: []
  })

  const characters = [
    {
      playerID: 'pg1@example.test',
      name: 'Ada',
      profession: 'giornalista',
      eta: 31,
      descrizionePersonale: 'determinata e curiosa',
      characteristics: { FOR: 50, COS: 55, DES: 60, TAG: 65, INT: 70, POT: 55, APP: 60, EDU: 75 },
      derivedAttributes: { hp: { current: 11, max: 11 }, sanita: { current: 55 } }
    },
    {
      playerID: 'pg2@example.test',
      name: 'Bruno',
      profession: 'medico',
      eta: 43,
      descrizionePersonale: 'calmo e razionale',
      characteristics: { FOR: 45, COS: 60, DES: 50, TAG: 55, INT: 75, POT: 65, APP: 50, EDU: 80 },
      derivedAttributes: { hp: { current: 12, max: 12 }, sanita: { current: 65 } }
    }
  ]

  for (const char of characters) {
    await writeJSON(path.join(tDir(TABLE_ID), 'characters', `${char.playerID}.json`), char)
  }
}

async function snapshotIndex() {
  const indexPath = path.join(tableRagDir(TABLE_ID), 'index.json')
  if (!await fileExists(indexPath)) return null
  return readJSON(indexPath)
}

async function writeArtifact(name, data, isJson = true) {
  await ensureDir(ARTIFACTS_DIR)
  const outPath = path.join(ARTIFACTS_DIR, name)
  if (isJson) {
    await fs.writeFile(outPath, JSON.stringify(data, null, 2), 'utf-8')
  } else {
    await fs.writeFile(outPath, String(data), 'utf-8')
  }
}

async function main() {
  const report = {
    tableId: TABLE_ID,
    moduleId: MODULE_ID,
    checkedAt: new Date().toISOString(),
    steps: {}
  }

  await resetTestTable()
  await seedBaseTable()

  const sessionCtx = await svc.getOrCreateSession(TABLE_ID, ['pg1@example.test', 'pg2@example.test'])
  report.steps.session = {
    sessionId: sessionCtx.session.sessionId,
    sessionNumber: sessionCtx.session.sessionNumber,
    ragSequenceNumber: sessionCtx.session.ragSequenceNumber
  }

  // Seed prima sessione directly in table RAG to verify preservation across rebuild.
  await rag.indexSessionIntro(TABLE_ID, 'Parigi vi accoglie con una pioggia sottile e presagi inquieti.', 'Il Richiamo di Atlantide')
  report.steps.primaSessioneIndexed = Boolean(await snapshotIndex())

  // Simulate scene creation akin fase2.
  const sequence1 = await svc.nextRagSequenceNumber(TABLE_ID)
  const scene = {
    id_scena: 'scene_000',
    contesto_dove: 'Sala delle Antichità del Grand Palais a Parigi',
    contesto_quando: 'Sera della sessione inaugurale',
    PNG: 'Sophia Hapgood, Marcel Dumont, Commissaire Renard',
    opportunita: 'Osservare la tavoletta, parlare con Dumont',
    minacce: 'Un uomo tedesco osserva la sala con attenzione',
    indizi: 'Tavoletta di pietra scura, simboli sconosciuti',
    progressione: '',
    sessionNumber: sessionCtx.session.sessionNumber,
    sequenceNumber: sequence1
  }
  await writeJSON(path.join(tDir(TABLE_ID), 'active_scenes', `${scene.id_scena}.json`), scene)

  const worldState = await readJSON(path.join(tDir(TABLE_ID), 'world_state.json'))
  worldState.focusScene = scene.id_scena
  worldState.groups[0].sceneId = scene.id_scena
  await writeJSON(path.join(tDir(TABLE_ID), 'world_state.json'), worldState)

  await rag.rebuildTableIndex(TABLE_ID, 'Il Richiamo di Atlantide')
  const indexAfterCreate = await snapshotIndex()
  report.steps.sceneCreated = {
    sequenceNumber: sequence1,
    chunkTypes: (indexAfterCreate?.chunks || []).map(c => c.type),
    hasSceneProgressione: (indexAfterCreate?.chunks || []).some(c => c.type === 'scene_progressione' && c.sceneId === scene.id_scena),
    preservedPrimaSessione: (indexAfterCreate?.chunks || []).some(c => c.type === 'prima_sessione')
  }

  // Simulate a backend player message in sottofase-4b-chiarimenti (no LLM tagging involved).
  const io = fakeIo()
  const engine = custodeRegistry.getOrCreate(TABLE_ID, io)
  sessionCtx.session.custodePhase = 'sottofase-4b-chiarimenti'
  await svc.saveSession(TABLE_ID, sessionCtx.session)
  await engine.onPlayerMessage({
    id: 'msg_backend_1',
    from: 'pg1@example.test',
    fromName: 'Ada',
    text: 'Voglio avvicinarmi al podio senza farmi notare.'
  })
  report.steps.playerMessage = {
    phase: sessionCtx.session.custodePhase,
    bufferSize: engine.buffer.length,
    bufferedTag: engine.buffer[0]?.tag || null,
    bufferedText: engine.buffer[0]?.text || null
  }

  // Simulate backend proof-result persistence without invoking the LLM loop.
  sessionCtx.session.custodePhase = 'sottofase-4b-necessita-prova'
  sessionCtx.session.pianoAzione = [{
    pg: 'pg1@example.test',
    stato: 'prova',
    azione: 'Raggiungere il podio senza farsi notare',
    abilita_o_caratteristica: 'Furtivita',
    difficolta: 'difficile',
    risultato_prova: null
  }]
  await svc.saveSession(TABLE_ID, sessionCtx.session)
  const ctxBeforeDice = svc.getSession(TABLE_ID)
  const proofEntry = ctxBeforeDice.session.pianoAzione.find(e => e.pg === 'pg1@example.test' && e.stato === 'prova')
  proofEntry.risultato_prova = { valore_tiro: 34, esito: 'successo' }
  await svc.saveSession(TABLE_ID, ctxBeforeDice.session)
  engine.buffer.push({
    from: 'pg1@example.test',
    tag: 'dichiarazione',
    text: '[Tiro dado] Furtivita: 34/50 -> successo'
  })
  const ctxAfterDice = svc.getSession(TABLE_ID)
  report.steps.diceRoll = {
    pianoAfterRoll: ctxAfterDice?.session?.pianoAzione || [],
    bufferSizeAfterRoll: engine.buffer.length
  }

  // Simulate scene progression update akin fase5.
  const sceneAfterCreate = await readJSON(path.join(tDir(TABLE_ID), 'active_scenes', `${scene.id_scena}.json`))
  const sequence2 = await svc.nextRagSequenceNumber(TABLE_ID)
  sceneAfterCreate.progressione = [
    'Ada si avvicina al podio approfittando di un brusio improvviso.',
    'Bruno nota i simboli sulla tavoletta e riconosce un motivo ricorrente nei taccuini di Kerner.'
  ].join('\n')
  sceneAfterCreate.sequenceNumber = sequence2
  await writeJSON(path.join(tDir(TABLE_ID), 'active_scenes', `${scene.id_scena}.json`), sceneAfterCreate)
  await rag.rebuildTableIndex(TABLE_ID, 'Il Richiamo di Atlantide')
  const indexAfterProgress = await snapshotIndex()
  const progressChunk = (indexAfterProgress?.chunks || []).find(c => c.type === 'scene_progressione' && c.sceneId === scene.id_scena)
  report.steps.sceneProgressione = {
    sequenceNumber: sequence2,
    progressioneLength: sceneAfterCreate.progressione.length,
    chunkFound: Boolean(progressChunk),
    chunkSequenceNumber: progressChunk?.sequenceNumber || 0,
    relatedTags: progressChunk?.relatedTags || []
  }

  // Simulate closure akin fase5c.
  const sequence3 = await svc.nextRagSequenceNumber(TABLE_ID)
  sceneAfterCreate.summary = 'L’asta si conclude nel caos contenuto di sguardi tesi e mezze verita; i PG capiscono che la tavoletta e Kerner sono collegati.'
  sceneAfterCreate.suggerimento_prossima_scena = 'Un appartamento svuotato in fretta'
  sceneAfterCreate.closingSequenceNumber = sequence3
  await ensureDir(path.join(tDir(TABLE_ID), 'closed_scenes'))
  await writeJSON(path.join(tDir(TABLE_ID), 'closed_scenes', `${scene.id_scena}.json`), sceneAfterCreate)
  await fs.rm(path.join(tDir(TABLE_ID), 'active_scenes', `${scene.id_scena}.json`), { force: true })
  await rag.rebuildTableIndex(TABLE_ID, 'Il Richiamo di Atlantide')
  const indexAfterClose = await snapshotIndex()
  const conclusionChunk = (indexAfterClose?.chunks || []).find(c => c.type === 'scene_conclusione' && c.sceneId === scene.id_scena)
  report.steps.sceneConclusione = {
    closingSequenceNumber: sequence3,
    chunkFound: Boolean(conclusionChunk),
    chunkSequenceNumber: conclusionChunk?.sequenceNumber || 0,
    hasSuggestion: String(conclusionChunk?.content || '').includes('Suggerimento prossima scena')
  }

  // Retrieval checks.
  const qScene = await rag.queryTable(TABLE_ID, `scene ${scene.id_scena}`, 5)
  const qLocation = await rag.queryTable(TABLE_ID, 'Grand Palais', 5)
  const qSession = await rag.queryTable(TABLE_ID, `Sessione ${sessionCtx.session.sessionNumber}`, 5)
  report.steps.retrieval = {
    bySceneId: qScene.map(r => ({
      type: r.type,
      name: r.name,
      sessionNumber: r.sessionNumber || 0,
      sequenceNumber: r.sequenceNumber || 0,
      sceneId: r.sceneId || ''
    })),
    byLocation: qLocation.map(r => ({
      type: r.type,
      name: r.name,
      sessionNumber: r.sessionNumber || 0,
      sequenceNumber: r.sequenceNumber || 0,
      sceneId: r.sceneId || ''
    })),
    bySession: qSession.map(r => ({
      type: r.type,
      name: r.name,
      sessionNumber: r.sessionNumber || 0,
      sequenceNumber: r.sequenceNumber || 0,
      sceneId: r.sceneId || ''
    }))
  }

  // Reset-like cleanup check on RAG directory semantics without hitting HTTP route.
  report.steps.resetExpectation = {
    ragDirExistsBeforeReset: await fileExists(tableRagDir(TABLE_ID)),
    note: 'La route /api/tables/:id/reset ora elimina anche la directory rag.'
  }

  await writeArtifact('report.json', report)
  await writeArtifact('index_after_create.json', indexAfterCreate)
  await writeArtifact('index_after_progress.json', indexAfterProgress)
  await writeArtifact('index_after_close.json', indexAfterClose)
  await writeArtifact('scene_closed.json', sceneAfterCreate)

  custodeRegistry.destroy(TABLE_ID)
  svc.destroySession(TABLE_ID)
  console.log(JSON.stringify(report, null, 2))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
