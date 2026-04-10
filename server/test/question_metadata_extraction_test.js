const assert = require('assert')
const path = require('path')
const { extractQuestionMetadata } = require('../src/services/custodeEngine')
const { analyzeNotesDirectory, buildQuestionCatalogFromNotesIndex } = require('../src/services/moduleNotesAnalyzer')

function main() {
  const options = {
    npcNames: ['Durmont', 'Mr. Johns', 'Sophia Hapgood'],
    objectNames: ['medaglione', 'tavoletta'],
    clueNames: ['simbolo inciso'],
    locationNames: ['Grand Palais', 'podio'],
    skillNames: ['Psicologia', 'Osservare'],
    pgNames: ['Emil', 'Luk']
  }

  let result = extractQuestionMetadata('Abbiamo già scoperto qualcosa sul medaglione?', options)
  assert.strictEqual(result.questionType, 'object_question')
  assert.strictEqual(result.primaryEntity.type, 'object')
  assert.strictEqual(result.primaryEntity.value, 'medaglione')
  assert.strictEqual(result.entities.objects[0], 'medaglione')
  assert.strictEqual(result.needs.object, true)
  assert.strictEqual(result.needs.scene, true)
  assert.ok(result.contextBundle.includes('objectSummary:primary'))
  assert.ok(result.contextBundle.includes('focusScene'))

  result = extractQuestionMetadata('Custode, posso fare Psicologia su Durmont?', options)
  assert.strictEqual(result.questionType, 'rule_or_roll_question')
  assert.strictEqual(result.entities.npcs[0], 'Durmont')
  assert.strictEqual(result.entities.skills[0], 'Psicologia')
  assert.strictEqual(result.operator, 'mechanical_check')
  assert.strictEqual(result.needs.rules, true)
  assert.strictEqual(result.needs.npc, true)
  assert.ok(result.contextBundle.includes('rulesExcerpt:primarySkill'))
  assert.ok(result.contextBundle.includes('npcSummary:primary'))
  assert.ok(!result.contextBundle.includes('partyKnowledgeShort'))

  result = extractQuestionMetadata('Ma Durmont che sta facendo in questo momento?', options)
  assert.strictEqual(result.questionType, 'npc_clarification')
  assert.strictEqual(result.entities.npcs[0], 'Durmont')
  assert.strictEqual(result.operator, 'evaluate')

  result = extractQuestionMetadata('Vedo qualcosa di strano sul podio?', options)
  assert.strictEqual(result.questionType, 'scene_clarification')
  assert.strictEqual(result.entities.locations[0], 'podio')
  assert.strictEqual(result.operator, 'perceive')

  result = extractQuestionMetadata('Conosco i simboli sulla tavoletta?', options)
  assert.strictEqual(result.questionType, 'object_question')
  assert.strictEqual(result.entities.objects[0], 'tavoletta')
  assert.strictEqual(result.operator, 'remember')

  result = extractQuestionMetadata('Master, abbiamo già incontrato Sophia Hapgood?', options)
  assert.strictEqual(result.questionType, 'npc_clarification')
  assert.strictEqual(result.entities.npcs[0], 'Sophia Hapgood')
  assert.strictEqual(result.operator, 'history')
  assert.ok(result.contextBundle.includes('npcSummary:primary'))

  const notesDir = path.join(process.cwd(), 'data/modules/21a79df1da33/notes')
  const catalog = buildQuestionCatalogFromNotesIndex(analyzeNotesDirectory(notesDir))
  result = extractQuestionMetadata('Master, abbiamo già incontrato Sophia Hapgood o Marcel Dumont prima di oggi?', {
    ...catalog,
    pgNames: ['Emil', 'Luk']
  })
  assert.strictEqual(result.questionType, 'npc_clarification')
  assert.ok(result.contextBundle.includes('npcSummary:primary'))
  assert.ok(result.contextBundle.includes('npcSummary:secondary'))

  result = extractQuestionMetadata("Master, abbiamo già scoperto qualcosa sull'Amuleto di Nur-Ab-Sal?", {
    ...catalog,
    pgNames: ['Emil', 'Luk']
  })
  assert.strictEqual(result.questionType, 'object_question')
  assert.strictEqual(result.entities.objects[0], 'Amuleto di Nur-Ab-Sal')
  assert.ok(result.contextBundle.includes('objectSummary:primary'))

  result = extractQuestionMetadata('Custode, cosa vedo nella Sala delle Antichità, Grand Palais?', {
    ...catalog,
    pgNames: ['Emil', 'Luk']
  })
  assert.strictEqual(result.questionType, 'scene_clarification')
  assert.strictEqual(result.entities.locations[0], 'Sala delle Antichità, Grand Palais')
  assert.ok(result.contextBundle.includes('focusScene'))

  result = extractQuestionMetadata('Custode, posso usare FOR per sfondare la porta?', {
    ...catalog,
    pgNames: ['Emil', 'Luk']
  })
  assert.strictEqual(result.questionType, 'rule_or_roll_question')
  assert.strictEqual(result.entities.skills[0], 'FOR')
  assert.ok(result.contextBundle.includes('rulesExcerpt:primarySkill'))
  assert.ok(!result.contextBundle.includes('partyKnowledgeShort'))

  result = extractQuestionMetadata("Cosa sai dirmi dell'abilità Furtività?", {
    ...catalog,
    pgNames: ['Emil', 'Luk']
  })
  assert.strictEqual(result.questionType, 'rules_reference_question')
  assert.deepStrictEqual(result.contextBundle, ['rulesExcerpt:primarySkill'])
  assert.strictEqual(result.entities.skills[0], 'Furtività')

  console.log('question_metadata_extraction_test: ok')
}

main()
