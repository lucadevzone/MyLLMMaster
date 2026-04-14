const assert = require('assert')

async function main() {
  const { normalizeSchemaResponse } = require('../src/services/ollamaService')

  const payload = normalizeSchemaResponse('archivist_v0_runtime_update.md', {
    storyLog: [],
    partyKnowledge: [],
    pgUpdates: [
      {
        playerName: 'Luk',
        status: 'vicino a Sophia'
      },
      {
        playerName: 'Emil',
        state: 'in osservazione'
      }
    ],
    npcUpdates: [
      {
        npcName: 'Sophia Hapgood',
        atteggiameno_verso_pg: 'amichevole: si e aperta con cautela'
      }
    ],
    elapsedMinutes: 0
  })

  assert.equal(payload.pgUpdates[0].stato, 'vicino a Sophia')
  assert.equal(payload.pgUpdates[0].status, 'vicino a Sophia')
  assert.equal(payload.pgUpdates[1].stato, 'in osservazione')
  assert.equal(payload.pgUpdates[1].state, 'in osservazione')
  assert.equal(payload.npcUpdates[0].atteggiamento_verso_pg, 'amichevole: si e aperta con cautela')
  assert.equal(payload.npcUpdates[0].atteggiameno_verso_pg, 'amichevole: si e aperta con cautela')

  console.log('ollama_service_schema_normalization_test: ok')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
