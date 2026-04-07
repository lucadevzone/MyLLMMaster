'use strict'

const path = require('path')
const fs = require('fs').promises
const { buildRagResolver } = require('../src/services/custodeEngine')

const MODULE_ID = process.argv[2] || 'mod_21a79df1da33'
const OUTPUT_DIR = path.join(__dirname, 'artifacts_rag_directives')
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'rag_directive_report.txt')

const CASES = [
  '{{rag:module:"Grand Palais"}}',
  '{{rag:module:"Grand Palais":cascade}}',
  '{{rag:module:locations}}',
  '{{rag:module:location_list|"Capitolo 1"}}',
  '{{rag:module:iterate:"Grand Palais, Henri Belloq"}}',
  '{{rag:module:iterate:"Grand Palais, Henri Belloq":cascade}}'
]

async function main() {
  const ragResolver = buildRagResolver(MODULE_ID, null)
  const sections = []

  for (const directive of CASES) {
    const rendered = await ragResolver(directive, {})
    sections.push([
      `QUERY RAG: ${directive}`,
      '',
      'RISULTATO:',
      rendered,
      '',
      '='.repeat(80)
    ].join('\n'))
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true })
  await fs.writeFile(OUTPUT_FILE, sections.join('\n\n'), 'utf-8')
  console.log(OUTPUT_FILE)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
