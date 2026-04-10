const assert = require('assert')
const path = require('path')

const {
  analyzeNotesDirectory,
  buildQuestionCatalogFromNotesIndex
} = require('../src/services/moduleNotesAnalyzer')

function run() {
  const notesDir = path.join(process.cwd(), 'data/modules/21a79df1da33/notes')
  const index = analyzeNotesDirectory(notesDir)

  assert.equal(index.counts.npc, 7)
  assert.equal(index.counts.scene, 7)
  assert.equal(index.counts.object, 5)
  assert.ok(index.counts.clue >= 10)

  assert.ok(index.byId.png_klaus_kerner)
  assert.ok(index.byId.scena_asta_grand_palais)
  assert.ok(index.byId.obj_amuleto_nur_ab_sal)
  assert.ok(index.byId.indizio_tavoletta_asta)
  assert.equal(index.byName.npc['sophia hapgood']?.id, 'png_sophia_hapgood')

  const sophia = index.entities.npc.find(entity => entity.id === 'png_sophia_hapgood')
  assert.ok(sophia)
  assert.ok(sophia.referencedBy.scenes.some(scene => scene.id === 'scena_asta_grand_palais'))
  assert.ok(sophia.referencedBy.objects.some(object => object.id === 'obj_amuleto_nur_ab_sal'))

  const catalog = buildQuestionCatalogFromNotesIndex(index)
  assert.ok(catalog.npcNames.includes('Sophia Hapgood'))
  assert.ok(catalog.objectNames.includes('Amuleto di Nur-Ab-Sal'))
  assert.ok(catalog.clueNames.includes("La tavoletta dell'asta"))
  assert.ok(catalog.locationNames.includes('Sala delle Antichità, Grand Palais'))
  assert.ok(catalog.locationNames.includes("L'asta al Grand Palais"))

  console.log('module_notes_analyzer_test: ok')
}

run()
