'use strict'

const path = require('path')
const fs = require('fs').promises

const svc = require('../src/services/sessionService')
const custodeRegistry = require('../src/services/custodeEngine')
const rag = require('../src/services/ragService')
const { DATA_DIR } = require('../src/utils/dataInit')
const { ensureDir, writeJSON, readJSON, fileExists } = require('../src/utils/fileStore')

const TABLE_ID = 'tbl_engine_cycle_test'
const MODULE_ID = 'mod_21a79df1da33'
const ARTIFACTS_DIR = path.join(__dirname, 'artifacts_engine_cycle')

function tDir(tableId) {
  return path.join(DATA_DIR, 'tables', tableId)
}

function buildFakeIo() {
  const emitted = []
  return {
    emitted,
    sockets: { sockets: new Map() },
    to() {
      return {
        emit(event, payload) {
          emitted.push({ event, payload })
        }
      }
    }
  }
}

async function writeArtifact(name, data, isJson = true) {
  await ensureDir(ARTIFACTS_DIR)
  const p = path.join(ARTIFACTS_DIR, name)
  if (isJson) await fs.writeFile(p, JSON.stringify(data, null, 2), 'utf-8')
  else await fs.writeFile(p, String(data), 'utf-8')
}

async function resetTable() {
  await fs.rm(tDir(TABLE_ID), { recursive: true, force: true }).catch(() => {})
  await ensureDir(path.join(tDir(TABLE_ID), 'characters'))
  await ensureDir(path.join(tDir(TABLE_ID), 'sessions'))
  await ensureDir(path.join(tDir(TABLE_ID), 'logs'))
}

async function seedTable() {
  const table = {
    id: TABLE_ID,
    moduleId: MODULE_ID,
    'heavy-llmModel': process.env.DEFAULT_HEAVY_LLM_MODEL || 'mistral-nemo:latest',
    'light-llmModel': process.env.DEFAULT_LIGHT_LLM_MODEL || 'phi3:mini',
    state: 'open',
    invitedPlayers: ['pg1@example.test', 'pg2@example.test'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  await writeJSON(path.join(tDir(TABLE_ID), 'table.json'), table)
  await writeJSON(path.join(tDir(TABLE_ID), 'world_state.json'), {
    currentChapter: 1,
    focusScene: null,
    groups: [{
      groupId: 'group01',
      sceneId: null,
      participants: ['pg1@example.test', 'pg2@example.test'],
      subLocation: null,
      activity: null
    }],
    npcs: [],
    items: []
  })

  const chars = [
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

  for (const char of chars) {
    await writeJSON(path.join(tDir(TABLE_ID), 'characters', `${char.playerID}.json`), char)
  }
}

async function snapshot(name) {
  const files = {}
  for (const rel of [
    'table.json',
    'world_state.json',
    'diary.txt',
    'rag/index.json'
  ]) {
    const p = path.join(tDir(TABLE_ID), rel)
    if (!await fileExists(p)) continue
    if (rel.endsWith('.json')) files[rel] = await readJSON(p)
    else files[rel] = await fs.readFile(p, 'utf-8')
  }

  const activeDir = path.join(tDir(TABLE_ID), 'active_scenes')
  const closedDir = path.join(tDir(TABLE_ID), 'closed_scenes')
  files.active_scenes = {}
  files.closed_scenes = {}
  for (const [dirPath, key] of [[activeDir, 'active_scenes'], [closedDir, 'closed_scenes']]) {
    try {
      const entries = await fs.readdir(dirPath)
      for (const f of entries.filter(x => x.endsWith('.json'))) {
        files[key][f] = await readJSON(path.join(dirPath, f))
      }
    } catch {}
  }
  await writeArtifact(`${name}.json`, files)
}

async function main() {
  await resetTable()
  await seedTable()

  const io = buildFakeIo()
  const engine = custodeRegistry.getOrCreate(TABLE_ID, io)
  await svc.getOrCreateSession(TABLE_ID, ['pg1@example.test', 'pg2@example.test'])

  const report = {
    tableId: TABLE_ID,
    moduleId: MODULE_ID,
    checkedAt: new Date().toISOString(),
    phases: []
  }

  // Fase 1
  const nextAfter1 = await engine.fase1()
  report.phases.push({ phase: 'fase1', next: nextAfter1 })
  await snapshot('after_fase1')

  // Fase 2
  const after2 = await engine.fase2('scena introduttiva')
  report.phases.push({ phase: 'fase2', next: after2?.next || null })
  await snapshot('after_fase2')

  // Fase 3 orchestrator
  const after3 = await engine.fase3()
  report.phases.push({ phase: 'fase3_scene_orchestrator', next: after3?.next || null })
  await snapshot('after_fase3')

  // Fase 4a scene progress
  const after4a = await engine.fase4aSceneProgress(after3?.data || after3)
  report.phases.push({ phase: 'fase4a_scene_progress', next: after4a?.next || null })
  await snapshot('after_fase4a_scene_progress')

  // Simulate player messages clearly enough to avoid clarification/proof branches if possible.
  engine.buffer = [
    {
      id: 'm1',
      from: 'pg1@example.test',
      fromName: 'Ada',
      tag: 'dichiarazione',
      text: 'Resto in disparte e osservo le reazioni degli invitati alla tavoletta, senza espormi.'
    },
    {
      id: 'm2',
      from: 'pg2@example.test',
      fromName: 'Bruno',
      tag: 'dichiarazione',
      text: 'Mi avvicino a Marcel Dumont e gli chiedo con calma da dove provenga il lotto appena presentato.'
    }
  ]

  // Fase 4b analisi dichiarazioni
  const after4 = await engine.fase4()
  const ctxAfter4 = svc.getSession(TABLE_ID)
  report.phases.push({
    phase: 'fase4b_analisi_dichiarazioni',
    next: after4?.next || null,
    pianoLength: ctxAfter4?.session?.pianoAzione?.length || 0,
    piano: ctxAfter4?.session?.pianoAzione || []
  })
  await snapshot('after_fase4b')

  let finalResult = null

  if (after4?.next === 'fase-5') {
    finalResult = await engine.fase5(after4.piano)
    report.phases.push({ phase: 'fase5', next: finalResult?.next || null })
    await snapshot('after_fase5')
  } else if (after4?.next === 'sottofase-4b-chiarimenti') {
    const res4a = await engine.fase4bSubChiarimenti(after4.data)
    report.phases.push({ phase: 'fase4b_sub_chiarimenti', next: res4a?.next || null, note: 'LLM requested clarification' })
    await snapshot('after_fase4b_sub_chiarimenti')
  } else if (after4?.next === 'sottofase-4b-dichiarazione-assente') {
    const res4b = await engine.fase4bSubDichiarazioneAssente(after4.data)
    report.phases.push({ phase: 'fase4b_sub_dichiarazione_assente', next: res4b?.next || null, note: 'LLM requested declaration' })
    await snapshot('after_fase4b_sub_dichiarazione_assente')
  } else if (after4?.next === 'sottofase-4b-necessita-prova') {
    const res4c = await engine.fase4bSubNecessitaProva(after4.data)
    report.phases.push({ phase: 'fase4b_sub_necessita_prova', next: res4c?.next || null, note: 'LLM required a proof roll' })
    await snapshot('after_fase4b_sub_necessita_prova')
  }

  // Optionally close scene if engine chose that branch.
  if (finalResult?.next === 'fase-5c') {
    const closeResult = await engine.fase5c(finalResult.data || finalResult)
    report.phases.push({ phase: 'fase5c', next: closeResult?.next || null })
    await snapshot('after_fase5c')
  } else if (finalResult?.next === 'fase-4a') {
    const afterCycle4a = await engine.fase4aSceneProgress(finalResult)
    report.phases.push({ phase: 'fase4a_scene_progress_post_fase5', next: afterCycle4a?.next || null })
    await snapshot('after_fase4a_post_fase5')
  }

  // Retrieval sanity checks at end.
  const worldState = await readJSON(path.join(tDir(TABLE_ID), 'world_state.json'))
  const focusSceneId = worldState.focusScene
  const retrieval = {
    byFocusScene: focusSceneId ? await rag.queryTable(TABLE_ID, `scene ${focusSceneId}`, 5) : [],
    bySession: await rag.queryTable(TABLE_ID, 'Sessione 1', 5)
  }
  report.retrieval = {
    byFocusScene: retrieval.byFocusScene.map(r => ({
      type: r.type,
      name: r.name,
      sessionNumber: r.sessionNumber,
      sequenceNumber: r.sequenceNumber,
      sceneId: r.sceneId
    })),
    bySession: retrieval.bySession.map(r => ({
      type: r.type,
      name: r.name,
      sessionNumber: r.sessionNumber,
      sequenceNumber: r.sequenceNumber,
      sceneId: r.sceneId
    }))
  }

  report.ioEvents = io.emitted.slice(-30)
  await writeArtifact('report.json', report)

  svc.clearAllTimers(TABLE_ID)
  custodeRegistry.destroy(TABLE_ID)
  svc.destroySession(TABLE_ID)

  console.log(JSON.stringify(report, null, 2))
}

main().catch(async err => {
  try {
    await writeArtifact('error.txt', `${err.stack || err.message || err}`, false)
  } catch {}
  console.error(err)
  process.exit(1)
})
