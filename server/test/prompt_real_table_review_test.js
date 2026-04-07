'use strict'

const path = require('path')
const fs = require('fs').promises

const ollama = require('../src/services/ollamaService')
const { buildRagResolver } = require('../src/services/custodeEngine')

const TABLE_ID = process.argv[2] || 'tbl_52d9fa21'
const MODEL_OVERRIDE = process.argv[3] || ''
const OLLAMA_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
const TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '120000', 10)
const ARTIFACTS_DIR = path.join(__dirname, `artifacts_prompt_review_${TABLE_ID}`)

function tdir(...parts) {
  return path.join(__dirname, '..', '..', 'data', 'tables', TABLE_ID, ...parts)
}

function formatCharacter(char) {
  const comuni = Object.entries(char.abilita?.comuni || {})
    .map(([k, v]) => `${capitalize(k)} ${v}%`)
    .join(', ')
  const speciali = (char.abilita?.specialistiche || [])
    .map(item => `${item.nome} ${item.valore}%`)
    .join(', ')

  const abilityParts = [comuni, speciali].filter(Boolean).join(', ')
  return [
    `${char.name} — ${char.profession || 'personaggio'}, ${char.eta || '?'} anni.`,
    `${char.descrizionePersonale || ''}`.trim(),
    abilityParts ? `Abilità principali: ${abilityParts}.` : ''
  ].filter(Boolean).join('\n')
}

function capitalize(value) {
  const text = String(value || '')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

async function readJSON(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function save(name, content) {
  await fs.mkdir(ARTIFACTS_DIR, { recursive: true })
  await fs.writeFile(path.join(ARTIFACTS_DIR, name), content, 'utf8')
}

function extractJSON(text) {
  try { return JSON.parse(text) } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) { try { return JSON.parse(fenced[1].trim()) } catch {} }
  const start = text.search(/[{[]/)
  if (start === -1) return null
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let end = -1
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++
    else if (text[i] === close) {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end === -1) return null
  try { return JSON.parse(text.slice(start, end + 1)) } catch { return null }
}

async function callRaw(model, prompt, useLight = false) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const body = { model, prompt, stream: false, format: 'json' }
    if (!useLight) body.options = { num_ctx: ollama.HEAVY_LLM_NUM_CTX }

    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(body)
    })
    clearTimeout(timer)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const raw = (data.response || '').trim()
    return [raw, extractJSON(raw)]
  } catch (err) {
    clearTimeout(timer)
    throw err
  }
}

async function runPhase({ label, promptFile, vars, model, useLight = false }) {
  const slug = promptFile.replace('.md', '')
  process.stdout.write(`  ${label}... `)
  const t0 = Date.now()

  const ragResolver = buildRagResolver(context.moduleId, TABLE_ID)
  const prompt = await ollama.loadPrompt(promptFile, vars, ragResolver)
  await save(`${slug}_prompt.txt`, prompt)

  const [raw, parsed] = await callRaw(model, prompt, useLight)
  await save(`${slug}_response.txt`, raw)
  if (parsed) await save(`${slug}_result.json`, JSON.stringify(parsed, null, 2))

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`✓ (${elapsed}s)`)
}

let context = null

async function buildContext() {
  const table = await readJSON(tdir('table.json'))
  const worldState = await readJSON(tdir('world_state.json'))
  const diary = await fs.readFile(tdir('diary.txt'), 'utf8').catch(() => '')
  const charsDir = tdir('characters')
  const charFiles = (await fs.readdir(charsDir)).filter(f => f.endsWith('.json')).sort()
  const chars = []
  for (const file of charFiles) chars.push(await readJSON(path.join(charsDir, file)))

  const activeScenesDir = tdir('active_scenes')
  const activeSceneFiles = await fs.readdir(activeScenesDir).catch(() => [])
  const activeScenes = []
  for (const file of activeSceneFiles.filter(f => f.endsWith('.json')).sort()) {
    activeScenes.push(await readJSON(path.join(activeScenesDir, file)))
  }

  const sessionDir = tdir('sessions')
  const sessionFiles = await fs.readdir(sessionDir).catch(() => [])
  const sessionFile = sessionFiles.find(f => /^session_.*\.json$/.test(f))
  const chatFile = sessionFiles.find(f => /^chat_.*\.json$/.test(f))
  const session = sessionFile ? await readJSON(path.join(sessionDir, sessionFile)) : null
  const chat = chatFile ? await readJSON(path.join(sessionDir, chatFile)) : []

  const focusScene = activeScenes.find(s => s.id_scena === worldState.focusScene) || activeScenes[0] || null
  const schede_PG = chars.map(formatCharacter).join('\n\n')

  const statoPgsInventato = [
    'Emil: vicino al bordo della folla, tiene d’occhio Kerner e il podio.',
    'Luk: si è fatto strada fino a Sophia Hapgood e le sta parlando a bassa voce.'
  ].join('\n')

  const statoPngsInventato = [
    'Sophia Hapgood: in piedi a lato della sala, pallida e tesa. Sta parlando con Luk. Non ancora incontrata formalmente dal party.',
    'Kerner: poco oltre il podio, fissa la tavoletta con attenzione innaturale. Non ancora incontrato dal party.',
    'Marcel Dumont: vicino al podio e al banditore, controlla il ritmo dell’asta. Non ancora incontrato dal party.'
  ].join('\n')

  const conoscenzeParty = [
    diary.trim(),
    'Il professor Henri Belloq è scomparso da tre mesi.',
    'La tavoletta di pietra scura è un lotto anomalo dell’asta.',
    'Sophia Hapgood ha riconosciuto alcuni simboli come collegati a culti proibiti.'
  ].filter(Boolean).join('\n')

  const phase4bMessages = chat
    .filter(m => m.type === 'normal')
    .slice(0, 2)
    .map(m => `[${m.tag || '?'}] ${m.fromName}: ${m.text}`)
    .join('\n')

  const pianoAzione = [
    {
      pg: 'Luk',
      stato: 'dichiarazione',
      azione: 'Si fa strada tra la folla per raggiungere Sophia Hapgood e parlarle con discrezione',
      abilita_o_caratteristica: null,
      difficolta: null,
      risultato_prova: null
    },
    {
      pg: 'Emil',
      stato: 'dichiarazione',
      azione: 'Osserva l’uomo misterioso vicino al podio e cerca di capire cosa stia annotando',
      abilita_o_caratteristica: null,
      difficolta: null,
      risultato_prova: null
    }
  ]

  const orchestratorScenes = activeScenes.length >= 2
    ? activeScenes
    : [
        ...(activeScenes.length ? activeScenes : []),
        {
          id_scena: 'scene_invented_magazzini',
          contesto_dove: 'Magazzini e corridoi di servizio sul retro del Grand Palais',
          progressione: 'Dalla sala principale arrivano echi ovattati dell’asta; un usciere nervoso controlla una porta riservata.'
        }
      ]

  const narrativeGroups = activeScenes.length >= 2
    ? worldState.groups.map(g => {
        const names = (g.participants || []).map(email => chars.find(c => c.playerID === email)?.name || email).join(', ')
        const scene = orchestratorScenes.find(s => s.id_scena === g.sceneId)
        return `${g.groupId} (${names}): ${scene?.contesto_dove || 'in movimento'}`
      }).join('\n')
    : 'group01 (Emil, Luk): sala delle aste di Dumont\ngroup02 (ipotetico): corridoi e magazzini sul retro del Grand Palais'

  return {
    table,
    moduleId: table.moduleId,
    heavyModel: MODEL_OVERRIDE || table['heavy-llmModel'] || 'mistral-nemo:latest',
    lightModel: table['light-llmModel'] || 'phi3:mini',
    diary: diary.trim() || '(nessun diario disponibile)',
    schede_PG,
    worldState,
    focusScene,
    orchestratorScenes,
    narrativeGroups,
    phase4bMessages,
    pianoAzione,
    stato_pgs: statoPgsInventato,
    stato_pngs: statoPngsInventato,
    conoscenze_party: conoscenzeParty,
    notes: {
      fase2_suggerimento_scena: 'magazzini sul retro del Grand Palais, durante l’asta',
      fase3_scene_invented: activeScenes.length < 2,
      stato_pgs_inventato: true,
      stato_pngs_inventato: true,
      piano_azione_inventato: true
    }
  }
}

async function main() {
  context = await buildContext()
  await fs.mkdir(ARTIFACTS_DIR, { recursive: true })
  await save('manifest.json', JSON.stringify({
    tableId: TABLE_ID,
    moduleId: context.moduleId,
    model: context.heavyModel,
    lightModel: context.lightModel,
    generatedAt: new Date().toISOString(),
    skipped: [
      'fase4b_sub_chiarimenti',
      'fase4b_sub_dichiarazione_assente',
      'fase4b_sub_necessita_prova',
      'fase5a_divisione_gruppi',
      'fase5b_ricongiungimento',
      'fase5c_chiusura_scena',
      'fase4a_scene_progress (prompt non presente nel codice corrente)'
    ],
    assumptions: context.notes
  }, null, 2))

  console.log(`\n=== Prompt Review Realistico — tavolo ${TABLE_ID} ===`)
  console.log(`Modulo: ${context.moduleId}`)
  console.log(`Output: ${ARTIFACTS_DIR}\n`)

  await runPhase({
    label: 'fase1a — prima sessione',
    promptFile: 'fase1a_prima_sessione.md',
    vars: { schede_PG: context.schede_PG },
    model: context.heavyModel
  })

  await runPhase({
    label: 'fase1b — sessione successiva',
    promptFile: 'fase1b_sessioni_successive.md',
    vars: {
      diary: context.diary,
      schede_PG: context.schede_PG,
      momento_corrente: context.focusScene?.contesto_quando || '',
      progressione: context.focusScene?.progressione || '(nessuna progressione)',
      stato_pgs: context.stato_pgs,
      stato_pngs: context.stato_pngs
    },
    model: context.heavyModel
  })

  await runPhase({
    label: 'fase2 — opening new scene',
    promptFile: 'fase2_opening_new_scene.md',
    vars: {
      suggerimento_scena: context.notes.fase2_suggerimento_scena,
      schede_PG: context.schede_PG,
      stato_pgs: context.stato_pgs,
      conoscenze_party: context.conoscenze_party,
      momento_corrente: context.focusScene?.contesto_quando || ''
    },
    model: context.heavyModel
  })

  await runPhase({
    label: 'fase3 — scene orchestrator',
    promptFile: 'fase3_scene_orchestrator.md',
    vars: {
      narrative_groups: context.narrativeGroups,
      scene_attive: JSON.stringify(context.orchestratorScenes),
      engagement: JSON.stringify({ Emil: 2, Luk: 2 })
    },
    model: context.lightModel,
    useLight: true
  })

  await runPhase({
    label: 'fase4a — scene opening',
    promptFile: 'fase4a_scene_opening.md',
    vars: {
      diary: context.diary,
      schede_PG: context.schede_PG,
      momento_corrente: context.focusScene?.contesto_quando || '',
      stato_pgs: context.stato_pgs,
      stato_pngs: context.stato_pngs,
      conoscenze_party: context.conoscenze_party,
      contesto_dove: context.focusScene?.contesto_dove || '',
      PNG: context.focusScene?.PNG || [],
      opportunita: context.focusScene?.opportunita || [],
      minacce: context.focusScene?.minacce || [],
      indizi: context.focusScene?.indizi || []
    },
    model: context.heavyModel
  })

  await runPhase({
    label: 'fase4b — analisi dichiarazioni',
    promptFile: 'fase4b_analisi_dichiarazioni.md',
    vars: {
      schede_PG: context.schede_PG,
      messaggi_buffer: context.phase4bMessages,
      piano_azione: 'nessuno',
      diary: context.diary,
      contesto_dove: context.focusScene?.contesto_dove || '',
      momento_corrente: context.focusScene?.contesto_quando || '',
      PNG: context.focusScene?.PNG || [],
      opportunita: context.focusScene?.opportunita || [],
      minacce: context.focusScene?.minacce || [],
      indizi: context.focusScene?.indizi || [],
      progressione: context.focusScene?.progressione || '(nessuna progressione)',
      stato_pgs: context.stato_pgs,
      stato_pngs: context.stato_pngs,
      conoscenze_party: context.conoscenze_party
    },
    model: context.heavyModel
  })

  await runPhase({
    label: 'fase5 — risoluzione',
    promptFile: 'fase5_risoluzione.md',
    vars: {
      piano_azione: JSON.stringify(context.pianoAzione),
      diary: context.diary,
      schede_PG: context.schede_PG,
      momento_corrente: context.focusScene?.contesto_quando || '',
      progressione: context.focusScene?.progressione || '(nessuna progressione)',
      stato_pgs: context.stato_pgs,
      stato_pngs: context.stato_pngs,
      conoscenze_party: context.conoscenze_party,
      contesto_dove: context.focusScene?.contesto_dove || '',
      PNG: context.focusScene?.PNG || [],
      opportunita: context.focusScene?.opportunita || [],
      minacce: context.focusScene?.minacce || [],
      indizi: context.focusScene?.indizi || []
    },
    model: context.heavyModel
  })

  console.log('\nReview completata.\n')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
