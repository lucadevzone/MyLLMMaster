const assert = require('assert')
const fs = require('fs').promises
const os = require('os')
const path = require('path')

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myllm-custode-question-error-'))
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
  await writeJSON(path.join(notesDir, 'module_notes_index.json'), {
    generatedAt: new Date().toISOString(),
    notesDir,
    counts: { files: 0, npc: 0, scene: 0, object: 0, clue: 0, relation: 0 },
    files: [],
    entities: { npc: [], scene: [], object: [], clue: [], relation: [] },
    byId: {},
    byName: { npc: {}, scene: {}, object: {}, clue: {} }
  })

  const tableId = 'test_custode_question_error_runtime'
  const tableDir = path.join(dataDir, 'tables', tableId)
  await ensureDir(tableDir)
  await writeJSON(path.join(tableDir, 'table.json'), {
    id: tableId,
    players: [],
    moduleId: 'mod_21a79df1da33'
  })
  await writeJSON(path.join(tableDir, 'world_state.json'), {
    focusScene: 'scena_000',
    groups: [],
    stato_pgs: {},
    conoscenze_party: '',
    npcs: [],
    items: []
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

  engine.llmText = async () => {
    await engine.pauseForTechnicalIssue('Errore LLM (test): fetch failed – sessione in pausa')
    const err = new Error('fetch failed')
    err.isLlmError = true
    throw err
  }

  await engine.onPlayerMessage({
    type: 'normal',
    from: 'emilio@example.com',
    fromName: 'Emilio',
    text: 'Custode, vedo qualcosa?'
  })

  assert.equal(ctx.session.state, 'technical-pause')

  clearAllTimers(tableId)
  destroy(tableId)
  destroySession(tableId)
  console.log('custode_question_error_runtime_test: ok')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
