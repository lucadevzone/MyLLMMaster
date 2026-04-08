const assert = require('assert')
const {
  buildPgLookup,
  canonicalPgName,
  mergeStatoPgs,
  normalizeStatoPgsMap
} = require('../src/services/custodeEngine')

function main() {
  const lookup = buildPgLookup([
    { playerID: 'lsabatucci+emilio@gmail.com', name: 'Emil' },
    { playerID: 'lsabatucci+luca@gmail.com', name: 'Luk' }
  ])

  assert.strictEqual(canonicalPgName('lsabatucci+emilio@gmail.com', lookup), 'Emil')
  assert.strictEqual(canonicalPgName('luk', lookup), 'Luk')

  const statoPgs = {
    Emil: { stato: 'entra nella sala' },
    'lsabatucci+emilio@gmail.com': { stato: 'osserva Durmont' },
    'lsabatucci+luca@gmail.com': { stato: "studia il catalogo dell'asta" }
  }

  const { normalized, changed } = normalizeStatoPgsMap(statoPgs, lookup)
  assert.strictEqual(changed, true)
  assert.deepStrictEqual(normalized, {
    Emil: { stato: 'osserva Durmont' },
    Luk: { stato: "studia il catalogo dell'asta" }
  })

  const target = { Emil: { stato: 'entra nella sala' } }
  const merged = mergeStatoPgs(target, {
    'lsabatucci+emilio@gmail.com': { stato: 'osserva Durmont' },
    luk: { stato: "studia il catalogo dell'asta" }
  }, lookup)
  assert.strictEqual(merged, true)
  assert.deepStrictEqual(target, {
    Emil: { stato: 'osserva Durmont' },
    Luk: { stato: "studia il catalogo dell'asta" }
  })

  console.log('custode_state_normalization_test: ok')
}

main()
