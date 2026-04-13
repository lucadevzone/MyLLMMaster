const assert = require('assert')

async function main() {
  const { normalizeSchemaResponse } = require('../src/services/ollamaService')

  const payload = normalizeSchemaResponse('archivist_v0_runtime_update.md', {
    storyLog: [],
    partyKnowledge: [],
    npcUpdates: [
      {
        npcName: 'Sophia Hapgood',
        atteggiameno_verso_pg: 'amichevole: si e aperta con cautela'
      }
    ],
    elapsedMinutes: 0
  })

  assert.equal(payload.npcUpdates[0].atteggiamento_verso_pg, 'amichevole: si e aperta con cautela')
  assert.equal(payload.npcUpdates[0].atteggiameno_verso_pg, 'amichevole: si e aperta con cautela')

  console.log('ollama_service_schema_normalization_test: ok')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
