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
      { name: 'Sophia Hapgood', scena_id: 'scene_001' },
      { name: 'Madame Fouchet', scena_id: 'scene_002' }
    ],
    items: []
  })

  await getOrCreateSession(tableId, ['emilio@example.com', 'luca@example.com'])
  const ctx = getSession(tableId)
  ctx.session.custodePhase = 'fase-4a'
  ctx.session.phase = 'inizio_sessione'
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
  engine.answerSceneMasterDeclaration = async () => {}
  engine.answerNpcMasterInteraction = async () => {}

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

  await engine.onPlayerMessage(messages[0])
  assert.equal(ctx.session.phase, 'first_person')

  await engine.onPlayerMessage(messages[1])
  await engine.onPlayerMessage(messages[2])
  assert.equal(ctx.session.phase, 'first_person')

  await engine.onPlayerMessage(messages[3])
  assert.equal(ctx.session.phase, 'scene')

  await engine.onPlayerMessage(messages[4])

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
    '[DEBUG ROUTING] Scene Master | tag=dichiarazione | azione o dichiarazione che fa avanzare la scena | bundle=focusScene, recentChat, pgSummary:actor',
    '[DEBUG ROUTING] Custode | tag=domanda al custode | domanda diretta sul mondo | bundle=focusScene, recentChat, partyKnowledgeShort'
  ])

  const { buildOrchestratorRoutingDecision } = require('../src/services/custodeEngine')
  const declarationRouting = buildOrchestratorRoutingDecision('Voglio persuadere Sophia a farmi vedere il suo amuleto', {
    otherPgNames: ['Emil', 'Luk'],
    npcNames: ['Sophia Hapgood'],
    questionNpcNames: ['Sophia Hapgood'],
    objectNames: ['Amuleto di Nur-Ab-Sal'],
    focusSceneId: 'scena_asta_grand_palais',
    focusSceneLabel: "L'asta al Grand Palais"
  })
  assert.deepStrictEqual(
    declarationRouting.contextBundle,
    ['focusScene', 'recentChat', 'pgSummary:actor', 'npcSummary:primary', 'objectSummary:secondary']
  )

  const ambiguousSceneRouting = buildOrchestratorRoutingDecision('Non mi fido di lei', {
    otherPgNames: ['Emil', 'Luk'],
    focusSceneId: 'scena_asta_grand_palais',
    focusSceneLabel: "L'asta al Grand Palais",
    phase: 'scene'
  })
  assert.equal(ambiguousSceneRouting.tag, '?')
  assert.equal(ambiguousSceneRouting.agent, 'Scene Master')
  assert.equal(ambiguousSceneRouting.reason, 'messaggio ambiguo: fallback alla fase scene')

  const continuingNpcRouting = buildOrchestratorRoutingDecision('"Cosa è successo? Cosa la sconvolge tanto?"', {
    otherPgNames: ['Emil', 'Luk'],
    npcNames: ['Sophia Hapgood'],
    activeNpcTarget: 'Sophia Hapgood',
    focusSceneId: 'scena_asta_grand_palais',
    focusSceneLabel: "L'asta al Grand Palais",
    phase: 'first_person'
  })
  assert.equal(continuingNpcRouting.tag, 'frase in-character')
  assert.equal(continuingNpcRouting.agent, 'NPC Master')
  assert.equal(continuingNpcRouting.npcTarget, 'Sophia Hapgood')

  const quotedQuestionRouting = buildOrchestratorRoutingDecision('"Posso solo chiederle di farmi vedere l\'amuleto?"', {
    otherPgNames: ['Emil', 'Luk'],
    npcNames: ['Sophia Hapgood'],
    activeNpcTarget: 'Sophia Hapgood',
    focusSceneId: 'scena_asta_grand_palais',
    focusSceneLabel: "L'asta al Grand Palais",
    phase: 'first_person'
  })
  assert.equal(quotedQuestionRouting.tag, 'frase in-character')
  assert.equal(quotedQuestionRouting.agent, 'NPC Master')
  assert.equal(quotedQuestionRouting.npcTarget, 'Sophia Hapgood')

  const genericInCharacterRouting = buildOrchestratorRoutingDecision('"Buongiorno."', {
    otherPgNames: ['Emil', 'Luk'],
    npcNames: ['Sophia Hapgood'],
    focusSceneId: 'scena_asta_grand_palais',
    focusSceneLabel: "L'asta al Grand Palais",
    phase: 'first_person'
  })
  assert.equal(genericInCharacterRouting.tag, 'frase in-character')
  assert.equal(genericInCharacterRouting.agent, 'NPC Master')

  const ambiguousNearbyNpcRouting = buildOrchestratorRoutingDecision('"Buongiorno."', {
    otherPgNames: ['Emil', 'Luk'],
    npcNames: ['Sophia Hapgood', 'Marcel Dumont'],
    implicitNpcHandlerNames: ['Sophia Hapgood', 'Marcel Dumont'],
    focusSceneId: 'scena_asta_grand_palais',
    focusSceneLabel: "L'asta al Grand Palais",
    phase: 'first_person'
  })
  assert.equal(ambiguousNearbyNpcRouting.tag, 'frase in-character')
  assert.equal(ambiguousNearbyNpcRouting.agent, 'Scene Master')
  assert.equal(ambiguousNearbyNpcRouting.reason, 'battuta ambigua: ci sono piu PNG a portata del PG')

  const ambiguousInitialRouting = buildOrchestratorRoutingDecision('Non so', {
    otherPgNames: ['Emil', 'Luk'],
    phase: 'inizio_sessione'
  })
  assert.equal(ambiguousInitialRouting.tag, '?')
  assert.equal(ambiguousInitialRouting.agent, null)
  assert.equal(ambiguousInitialRouting.reason, 'messaggio ambiguo: ignorato in fase inizio_sessione')

  await engine.onPlayerMessage({
    from: 'luca@example.com',
    fromName: 'Luca',
    text: 'Mi avvicino a Sophia per parlarle a bassa voce.'
  })
  assert.equal(ctx.session.conversationTargets['luca@example.com'], 'Sophia Hapgood')

  await engine.onPlayerMessage({
    from: 'luca@example.com',
    fromName: 'Luca',
    text: '"Vorrei sapere di piu di Belloq."'
  })
  assert.equal(engine.buffer[engine.buffer.length - 1].tag, 'frase in-character')
  assert.equal(ctx.session.conversationTargets['luca@example.com'], 'Sophia Hapgood')

  clearAllTimers(tableId)
  destroy(tableId)
  destroySession(tableId)

  console.log('chat_buffer_runtime_test: ok')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
