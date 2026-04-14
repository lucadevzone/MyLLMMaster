const assert = require('assert')
const fs = require('fs').promises
const os = require('os')
const path = require('path')

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myllm-archivist-nonfatal-'))
  process.env.DATA_DIR_OVERRIDE = dataDir
  process.env.DEFAULT_LLM_MODEL = 'test-model:latest'

  const { ensureDir, writeJSON } = require('../src/utils/fileStore')
  const { getOrCreateSession, getSession, destroySession, clearAllTimers } = require('../src/services/sessionService')
  const { getOrCreate, destroy } = require('../src/services/custodeEngine')
  const ollama = require('../src/services/ollamaService')

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

  const tableId = 'test_archivist_error_nonfatal'
  const tableDir = path.join(dataDir, 'tables', tableId)
  await ensureDir(tableDir)
  await writeJSON(path.join(tableDir, 'table.json'), {
    id: tableId,
    players: [],
    moduleId: 'mod_21a79df1da33'
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

  engine.buildArchivistRuntimeContext = async () => ({ sourceAgent: 'npc-master' })
  const originalRunPhase = ollama.runPhase
  ollama.runPhase = async () => {
    const err = new Error('Schema risposta non valido')
    err.isLlmError = true
    throw err
  }

  try {
    await engine.runArchivistRuntimeUpdate({ sourceAgent: 'npc-master' })
    assert.equal(ctx.session.state, 'sessione-iniziata')
    assert.equal(engine.paused, false)
  } finally {
    ollama.runPhase = originalRunPhase
    clearAllTimers(tableId)
    destroy(tableId)
    destroySession(tableId)
  }

  console.log('archivist_error_nonfatal_test: ok')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
