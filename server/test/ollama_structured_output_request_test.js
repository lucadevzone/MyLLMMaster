const assert = require('assert')

async function main() {
  const ollama = require('../src/services/ollamaService')

  const originalFetch = global.fetch
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    assert.equal(body.model, 'test-model')
    assert.ok(body.format)
    assert.equal(body.format.type, 'object')
    assert.ok(body.format.properties)
    assert.ok(Array.isArray(body.format.required))

    return {
      ok: true,
      async json() {
        return {
          response: JSON.stringify({
            storyLog: [],
            partyKnowledge: [],
            pgUpdates: [],
            npcUpdates: [],
            elapsedMinutes: 0
          })
        }
      }
    }
  }

  try {
    const result = await ollama.runPhase('test-model', 'archivist_v0_runtime_update.md', {
      sourceAgent: 'npc-master',
      playerName: 'Luk',
      npcName: 'Sophia Hapgood',
      declarationText: 'ciao',
      narrativeText: 'ciao',
      contextText: 'contesto'
    })

    assert.deepEqual(result, {
      storyLog: [],
      partyKnowledge: [],
      pgUpdates: [],
      npcUpdates: [],
      elapsedMinutes: 0
    })
  } finally {
    global.fetch = originalFetch
  }

  console.log('ollama_structured_output_request_test: ok')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
