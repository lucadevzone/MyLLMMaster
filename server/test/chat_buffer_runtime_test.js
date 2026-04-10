const assert = require('assert')
const fs = require('fs').promises
const os = require('os')
const path = require('path')

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myllm-chat-buffer-'))
  process.env.DATA_DIR_OVERRIDE = dataDir

  const { ensureDir, writeJSON } = require('../src/utils/fileStore')
  const { getOrCreateSession, getSession, destroySession, clearAllTimers } = require('../src/services/sessionService')
  const { getOrCreate, destroy } = require('../src/services/custodeEngine')

  await ensureDir(path.join(dataDir, 'tables'))
  await writeJSON(path.join(dataDir, 'users.json'), [
    { email: 'emilio@example.com', name: 'Emilio' },
    { email: 'luca@example.com', name: 'Luca' }
  ])

  const tableId = 'test_chat_buffer_runtime'
  const tableDir = path.join(dataDir, 'tables', tableId)
  await ensureDir(tableDir)
  await writeJSON(path.join(tableDir, 'table.json'), { id: tableId, players: [] })
  await writeJSON(path.join(tableDir, 'world_state.json'), {
    currentChapter: 1,
    focusScene: 'scene_001',
    groups: [],
    stato_pgs: {},
    conoscenze_party: '',
    data_inizio_avventura: '',
    npcs: [
      { name: 'Durmont', scena_id: 'scene_001' },
      { name: 'Madame Fouchet', scena_id: 'scene_002' }
    ],
    items: []
  })

  await getOrCreateSession(tableId, ['emilio@example.com', 'luca@example.com'])
  const ctx = getSession(tableId)
  ctx.session.custodePhase = 'fase-4a'
  ctx.session.players = [
    {
      email: 'emilio@example.com',
      characterName: 'Emil',
      playerState: 'turno-pg',
      connected: true
    },
    {
      email: 'luca@example.com',
      characterName: 'Luk',
      playerState: 'turno-pg',
      connected: true
    }
  ]

  const io = { to: () => ({ emit: () => {} }), sockets: { sockets: new Map() } }
  const engine = getOrCreate(tableId, io)
  await engine.startPassiveOrchestrator()
  engine.answerCustodeQuestion = async () => {}

  const messages = [
    {
      from: 'emilio@example.com',
      fromName: 'Emilio',
      text: 'Durmont, perché è così nervoso?'
    },
    {
      from: 'luca@example.com',
      fromName: 'Luca',
      text: 'Secondo me Emilio ha ragione'
    },
    {
      from: 'emilio@example.com',
      fromName: 'Emilio',
      text: 'Signor Durmont, temo che lei non mi stia dicendo tutto.'
    },
    {
      from: 'luca@example.com',
      fromName: 'Luca',
      text: 'Per ora non faccio nulla.'
    },
    {
      from: 'emilio@example.com',
      fromName: 'Emilio',
      text: 'Custode, vedo qualcosa di strano sul podio?'
    }
  ]

  for (const message of messages) {
    await engine.onPlayerMessage(message)
  }

  const tags = engine.buffer.map(entry => ({ text: entry.text, tag: entry.tag }))
  assert.deepStrictEqual(tags, [
    { text: 'Durmont, perché è così nervoso?', tag: 'frase in-character' },
    { text: 'Secondo me Emilio ha ragione', tag: 'fuori ruolo' },
    { text: 'Signor Durmont, temo che lei non mi stia dicendo tutto.', tag: 'frase in-character' },
    { text: 'Per ora non faccio nulla.', tag: 'dichiarazione' },
    { text: 'Custode, vedo qualcosa di strano sul podio?', tag: 'domanda al custode' }
  ])

  const debugMessages = ctx.messages
    .filter(message => message.type === 'orchestrator-debug')
    .map(message => message.text)
  assert.deepStrictEqual(debugMessages, [
    '[DEBUG ROUTING] NPC Master (Durmont) | tag=frase in-character | interazione diretta con un PNG | bundle=focusScene, npcSummary:primary(Durmont), recentChat',
    '[DEBUG ROUTING] Nessun agente | tag=fuori ruolo | messaggio fuori ruolo',
    '[DEBUG ROUTING] NPC Master (Durmont) | tag=frase in-character | interazione diretta con un PNG | bundle=focusScene, npcSummary:primary(Durmont), recentChat',
    '[DEBUG ROUTING] Scene Master | tag=dichiarazione | azione o dichiarazione che fa avanzare la scena | bundle=focusScene, recentChat',
    '[DEBUG ROUTING] Custode | tag=domanda al custode | domanda diretta sul mondo | bundle=focusScene, recentChat, partyKnowledgeShort'
  ])

  clearAllTimers(tableId)
  destroy(tableId)
  destroySession(tableId)

  console.log('chat_buffer_runtime_test: ok')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
