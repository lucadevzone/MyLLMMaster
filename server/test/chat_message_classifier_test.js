const assert = require('assert')
const { classifyChatMessage } = require('../src/services/custodeEngine')

function main() {
  const names = ['Emil', 'Luk']
  const playerNames = ['Emilio', 'Luca']

  assert.strictEqual(
    classifyChatMessage('Mi avvicino a Durmont e gli chiedo da dove viene il lotto.', { otherPgNames: names }).tag,
    'dichiarazione'
  )

  assert.strictEqual(
    classifyChatMessage('Per ora non faccio nulla.', { otherPgNames: names }).tag,
    'dichiarazione'
  )

  assert.strictEqual(
    classifyChatMessage('Corro fino al podio.', { otherPgNames: names }).tag,
    'dichiarazione'
  )

  assert.strictEqual(
    classifyChatMessage('Io vorrei parlare con Mr. Johns.', { otherPgNames: names, npcNames: ['Mr. Johns'] }).tag,
    'dichiarazione'
  )

  assert.strictEqual(
    classifyChatMessage('Voglio persuadere Sophia a farmi vedere il suo amuleto.', {
      otherPgNames: names,
      npcNames: ['Sophia Hapgood'],
      skillNames: ['Persuadere']
    }).tag,
    'dichiarazione'
  )

  assert.strictEqual(
    classifyChatMessage('Provo a convincere Sophia a parlarmi di Belloq.', {
      otherPgNames: names,
      npcNames: ['Sophia Hapgood'],
      skillNames: ['Persuadere']
    }).tag,
    'dichiarazione'
  )

  assert.strictEqual(
    classifyChatMessage('Mi nascondo dietro la tenda.', {
      otherPgNames: names,
      skillNames: ['Furtività']
    }).tag,
    'dichiarazione'
  )

  assert.strictEqual(
    classifyChatMessage('Custode, vedo qualcosa di strano sul podio?', { otherPgNames: names }).tag,
    'domanda al custode'
  )

  assert.strictEqual(
    classifyChatMessage('Master ma Durmont che sta facendo in questo momento?', { otherPgNames: names, npcNames: ['Durmont'] }).tag,
    'domanda al custode'
  )

  assert.strictEqual(
    classifyChatMessage('Luk, tu vai all’ingresso e io controllo il catalogo.', { otherPgNames: names }).tag,
    'discutendo tra PG'
  )

  assert.strictEqual(
    classifyChatMessage('"Signor Durmont, non mi ha convinto affatto."', { otherPgNames: names }).tag,
    'frase in-character'
  )

  assert.strictEqual(
    classifyChatMessage('Luk, perché sei così nervoso?', { otherPgNames: names }).tag,
    'frase in-character'
  )

  assert.strictEqual(
    classifyChatMessage('Durmont, perché è così nervoso?', { otherPgNames: names, npcNames: ['Durmont'] }).tag,
    'frase in-character'
  )

  assert.strictEqual(
    classifyChatMessage('"Buongiorno Sophia"', { otherPgNames: names, npcNames: ['Sophia Hapgood'] }).tag,
    'frase in-character'
  )

  assert.strictEqual(
    classifyChatMessage('"Buongiorno signorina Hapgood"', { otherPgNames: names, npcNames: ['Sophia Hapgood'] }).tag,
    'frase in-character'
  )

  assert.strictEqual(
    classifyChatMessage('Signor Durmont, temo che lei non mi stia dicendo tutto.', { otherPgNames: names, npcNames: ['Durmont'] }).tag,
    'frase in-character'
  )

  assert.strictEqual(
    classifyChatMessage('Luca, aspettami un secondo.', { otherPgNames: names, otherPlayerNames: playerNames }).tag,
    'fuori ruolo'
  )

  assert.strictEqual(
    classifyChatMessage('Secondo me Luca ha ragione', { otherPgNames: names, otherPlayerNames: playerNames }).tag,
    'fuori ruolo'
  )

  assert.strictEqual(
    classifyChatMessage('Riesco a vedere cosa sta facendo Durmont?', { otherPgNames: names, npcNames: ['Durmont'] }).tag,
    'domanda al custode'
  )

  assert.strictEqual(
    classifyChatMessage('Scusate, un attimo che torno subito.', { otherPgNames: names }).tag,
    'fuori ruolo'
  )

  assert.strictEqual(
    classifyChatMessage('Ok vado in bagno', { otherPgNames: names }).tag,
    'fuori ruolo'
  )

  assert.strictEqual(
    classifyChatMessage('Arrivo subito', { otherPgNames: names }).tag,
    'fuori ruolo'
  )

  assert.strictEqual(
    classifyChatMessage('Mi assento due minuti', { otherPgNames: names }).tag,
    'fuori ruolo'
  )

  assert.strictEqual(
    classifyChatMessage('Sono pronto', { otherPgNames: names }).tag,
    'fuori ruolo'
  )

  assert.strictEqual(
    classifyChatMessage('Iniziamo', { otherPgNames: names }).tag,
    'fuori ruolo'
  )

  assert.strictEqual(
    classifyChatMessage('Copritemi mentre provo ad aprire la porta', {
      otherPgNames: names,
      phase: 'combattimento',
      recentClassifications: ['discutendo tra PG', 'discutendo tra PG']
    }).tag,
    'discutendo tra PG'
  )

  assert.strictEqual(
    classifyChatMessage('Posso provare Psicologia?', {
      otherPgNames: names,
      skillNames: ['Psicologia'],
      phase: 'post_rivelazione'
    }).tag,
    'domanda al custode'
  )

  assert.strictEqual(
    classifyChatMessage('Ok', { otherPgNames: names }).tag,
    null
  )

  console.log('chat_message_classifier_test: ok')
}

main()
