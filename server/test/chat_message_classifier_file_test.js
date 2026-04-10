const fs = require('fs').promises
const path = require('path')
const { classifyChatMessage } = require('../src/services/custodeEngine')

const INPUT_PATH = process.argv[2] || path.join(__dirname, 'fixtures_chat_classifier_input.txt')
const OUTPUT_PATH = process.argv[3] || path.join(__dirname, 'artifacts_chat_classifier_output.txt')

const OTHER_PG_NAMES = ['Emil', 'Luk', 'Ada', 'Stefan', 'Marguerite']
const OTHER_PLAYER_NAMES = ['Luca', 'Emilio', 'Ada player', 'Stefan player']
const NPC_NAMES = ['Durmont', 'Madame Fouchet', 'Il banditore', 'La donna in prima fila']

async function main() {
  const raw = await fs.readFile(INPUT_PATH, 'utf8')
  const lines = raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  const annotated = lines.map((line, index) => {
    const result = classifyChatMessage(line, {
      otherPgNames: OTHER_PG_NAMES,
      otherPlayerNames: OTHER_PLAYER_NAMES,
      npcNames: NPC_NAMES
    })
    const tag = result.tag || '?'
    const confidence = typeof result.confidence === 'number'
      ? result.confidence.toFixed(2)
      : '0.00'
    return `${String(index + 1).padStart(2, '0')}. [${tag}] (${confidence}) ${line}`
  })

  await fs.writeFile(OUTPUT_PATH, annotated.join('\n') + '\n', 'utf8')
  console.log(`Input: ${INPUT_PATH}`)
  console.log(`Output: ${OUTPUT_PATH}`)
  console.log(`Frasi classificate: ${annotated.length}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
