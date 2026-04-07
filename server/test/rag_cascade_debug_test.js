'use strict'

const path = require('path')
const fs = require('fs')
const fsp = require('fs').promises
const rag = require('../src/services/ragService')

const MODULE_ID = process.argv[2] || 'mod_21a79df1da33'
const QUERY = process.argv[3] || 'Grand Palais'
const OUTPUT_DIR = path.join(__dirname, 'artifacts_rag_cascade_debug')
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'rag_cascade_debug_report.txt')

const RAG_TOP_K = parseInt(process.env.RAG_TOP_K || '5')
const RAG_CASCADE_TOP_K_L1 = parseInt(process.env.RAG_CASCADE_TOP_K_L1 || '1')
const RAG_CASCADE_TOP_K_L2 = parseInt(process.env.RAG_CASCADE_TOP_K_L2 || '1')
const RAG_CASCADE_MAX_TAGS = parseInt(process.env.RAG_CASCADE_MAX_TAGS || '5')

function normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function containsWholeTag(normalizedContent, tag) {
  const normalizedTag = normalizeText(tag)
  if (!normalizedTag) return false
  const pattern = new RegExp(`(^|\\s)${escapeRegex(normalizedTag)}(?=\\s|$)`, 'i')
  return pattern.test(normalizedContent)
}

function getMatchedCatalogTags(queryText, tagCatalogPayload) {
  const tags = Array.isArray(tagCatalogPayload?.tags) ? tagCatalogPayload.tags : []
  if (!tags.length) return []

  const normalizedQuery = normalizeText(queryText)
  if (!normalizedQuery) return []

  const matched = new Map()
  for (const tag of tags) {
    const canonical = String(tag.canonical || '').trim()
    if (!canonical) continue
    const candidates = [canonical, ...(tag.aliases || [])]
    for (const candidate of candidates) {
      if (containsWholeTag(normalizedQuery, candidate)) {
        matched.set(canonical, {
          type: String(tag.type || '').trim(),
          canonical
        })
        break
      }
    }
  }
  return [...matched.values()]
}

function dedupeScoredResults(results) {
  const bestByKey = new Map()
  for (const result of results || []) {
    const key = [
      result.type || '',
      result.name || '',
      result.chapter || '',
      result.sessionNumber || '',
      result.content || ''
    ].join('::')
    const previous = bestByKey.get(key)
    if (!previous || (result.score || 0) > (previous.score || 0)) {
      bestByKey.set(key, result)
    }
  }
  return [...bestByKey.values()].sort((a, b) => (b.score || 0) - (a.score || 0))
}

function formatChunk(result, index) {
  const detailed = Array.isArray(result.relatedTagsDetailed) ? result.relatedTagsDetailed : []
  const tags = detailed.length
    ? detailed.map(tag => `${tag.type}:${tag.canonical}`).join(', ')
    : (result.relatedTags || []).join(', ')

  return [
    `${index + 1}. [${result.type}] ${result.name} (score=${Number(result.score || 0).toFixed(3)})`,
    `relatedTags: ${result.relatedTags?.join(', ') || '—'}`,
    `relatedTagsDetailed: ${tags || '—'}`,
    result.content
  ].join('\n')
}

async function main() {
  const moduleTagCatalogPath = path.join(process.cwd(), 'data', 'modules', `${MODULE_ID}_rag`, 'tag_catalog.json')
  const tagCatalogPayload = fs.existsSync(moduleTagCatalogPath)
    ? JSON.parse(await fsp.readFile(moduleTagCatalogPath, 'utf-8'))
    : null

  const level1Base = await rag.queryModule(MODULE_ID, QUERY, RAG_TOP_K)
  const level1Seeds = level1Base.slice(0, Math.min(RAG_CASCADE_TOP_K_L1, level1Base.length))

  const directMatched = getMatchedCatalogTags(QUERY, tagCatalogPayload)
  const directQueryTags = new Set(directMatched.map(tag => tag.canonical))
  const directQueryTypes = new Set(directMatched.map(tag => tag.type).filter(Boolean))

  const tagStats = new Map()
  for (let idx = 0; idx < level1Base.length; idx++) {
    const result = level1Base[idx]
    const detailed = Array.isArray(result.relatedTagsDetailed) ? result.relatedTagsDetailed : []
    const tags = detailed.length
      ? detailed
      : (result.relatedTags || []).map(canonical => ({ canonical, type: '' }))

    for (const tag of tags) {
      const canonical = String(tag.canonical || '').trim()
      if (!canonical) continue
      if (directQueryTags.has(canonical)) continue

      if (!tagStats.has(canonical)) {
        tagStats.set(canonical, {
          canonical,
          type: String(tag.type || '').trim(),
          count: 0,
          firstPos: idx,
          inSeed: idx < Math.min(RAG_CASCADE_TOP_K_L1, level1Base.length)
        })
      }

      const entry = tagStats.get(canonical)
      entry.count += 1
      entry.firstPos = Math.min(entry.firstPos, idx)
      entry.inSeed = entry.inSeed || idx < Math.min(RAG_CASCADE_TOP_K_L1, level1Base.length)
      if (!entry.type && tag.type) entry.type = String(tag.type || '').trim()
    }
  }

  const rankedTagStats = [...tagStats.values()]
    .sort((a, b) =>
      b.count - a.count ||
      Number((directQueryTypes.size > 0 && directQueryTypes.has(b.type)) || b.inSeed) -
      Number((directQueryTypes.size > 0 && directQueryTypes.has(a.type)) || a.inSeed) ||
      a.firstPos - b.firstPos ||
      a.canonical.localeCompare(b.canonical, 'it')
    )

  const limitedSeedTags = rankedTagStats
    .slice(0, RAG_CASCADE_MAX_TAGS)
    .map(entry => entry.canonical)
  const level2ByTag = []
  const level2Collected = []
  for (const tag of limitedSeedTags) {
    const partial = await rag.queryModule(MODULE_ID, tag, RAG_CASCADE_TOP_K_L2)
    const adjusted = partial.map(result => ({ ...result, score: (result.score || 0) - 0.03 }))
    level2ByTag.push({ tag, results: adjusted })
    level2Collected.push(...adjusted)
  }

  const level1Boosted = level1Base.map(result => ({ ...result, score: (result.score || 0) + 0.15 }))
  const dedupedL1 = dedupeScoredResults(level1Boosted)
  const seen = new Set(dedupedL1.map(result => [
    result.type || '',
    result.name || '',
    result.chapter || '',
    result.sessionNumber || '',
    result.content || ''
  ].join('::')))
  const dedupedL2 = dedupeScoredResults(level2Collected).filter(result => {
    const key = [
      result.type || '',
      result.name || '',
      result.chapter || '',
      result.sessionNumber || '',
      result.content || ''
    ].join('::')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const finalResults = [...dedupedL1, ...dedupedL2]

  const sections = []
  sections.push(`QUERY: ${QUERY}`)
  sections.push(`MODULE_ID: ${MODULE_ID}`)
  sections.push(`RAG_TOP_K=${RAG_TOP_K}`)
  sections.push(`RAG_CASCADE_TOP_K_L1=${RAG_CASCADE_TOP_K_L1}`)
  sections.push(`RAG_CASCADE_TOP_K_L2=${RAG_CASCADE_TOP_K_L2}`)
  sections.push(`RAG_CASCADE_MAX_TAGS=${RAG_CASCADE_MAX_TAGS}`)

  sections.push('\n' + '='.repeat(80))
  sections.push('L1 BASE — chunk scelti da queryModule(query, RAG_TOP_K)')
  sections.push(level1Base.map(formatChunk).join('\n\n---\n\n') || '(nessun chunk)')

  sections.push('\n' + '='.repeat(80))
  sections.push('L1 SEEDS — chunk usati per estrarre i relatedTags')
  sections.push(level1Seeds.map(formatChunk).join('\n\n---\n\n') || '(nessun seed)')

  sections.push('\n' + '='.repeat(80))
  sections.push(`DIRECT QUERY TAGS — esclusi dal cascade: ${[...directQueryTags].join(', ') || 'nessuno'}`)
  sections.push('RELATED TAGS CANDIDATI (ordinati):')
  sections.push(rankedTagStats.map((entry, idx) =>
    `${idx + 1}. ${entry.canonical} | type=${entry.type || '-'} | count=${entry.count} | firstPos=${entry.firstPos} | inSeed=${entry.inSeed}`
  ).join('\n') || '(nessun relatedTag candidato)')
  sections.push(`RELATED TAGS SELEZIONATI PER L2: ${limitedSeedTags.join(', ') || 'nessuno'}`)

  sections.push('\n' + '='.repeat(80))
  sections.push('L2 — queryModule(tag, RAG_CASCADE_TOP_K_L2) per ogni relatedTag')
  if (!level2ByTag.length) {
    sections.push('(nessun relatedTag espanso)')
  } else {
    for (const entry of level2ByTag) {
      sections.push(`\nTAG: ${entry.tag}`)
      sections.push(entry.results.map(formatChunk).join('\n\n---\n\n') || '(nessun chunk)')
    }
  }

  sections.push('\n' + '='.repeat(80))
  sections.push('RISULTATO FINALE CASCADE — L1 + L2 deduplicato')
  sections.push(finalResults.map(formatChunk).join('\n\n---\n\n') || '(nessun risultato)')

  await fsp.mkdir(OUTPUT_DIR, { recursive: true })
  await fsp.writeFile(OUTPUT_FILE, sections.join('\n'), 'utf-8')
  console.log(OUTPUT_FILE)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
