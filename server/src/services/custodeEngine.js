/**
 * Custode Engine — macchina a stati procedurale del Game Master LLM
 *
 * Fasi: 1 → 2 → 3 → 4[a/b/c] → 5[a/b/c] → torna a 3 o 2
 */

const path = require('path')
const fs = require('fs').promises
const { v4: uuidv4 } = require('uuid')
const { readJSON, writeJSON, fileExists, ensureDir } = require('../utils/fileStore')
const { DATA_DIR } = require('../utils/dataInit')
const svc = require('./sessionService')
const ollama = require('./ollamaService')

const MSG_BUFFER_SIZE = parseInt(process.env.MSG_BUFFER_SIZE || '20')
const SILENCE_TIMER_MS = parseInt(process.env.SILENCE_TIMER_MS || String(30 * 1000))
const PROACTIVITY_TIMER_MS = parseInt(process.env.PROACTIVITY_TIMER_MS || String(5 * 60 * 1000))

// ── Helpers filesystem ────────────────────────────────────────────────────────

function tDir(tableId) { return path.join(DATA_DIR, 'tables', tableId) }

async function getTable(tableId) {
  return readJSON(path.join(tDir(tableId), 'table.json'))
}

async function getModule(moduleId) {
  return readJSON(path.join(DATA_DIR, 'modules', `${moduleId}.json`))
}

async function getWorldState(tableId) {
  const p = path.join(tDir(tableId), 'world_state.json')
  if (!await fileExists(p)) {
    const ws = { currentChapter: 1, focusScene: null, groups: [], npcs: [], items: [] }
    await writeJSON(p, ws)
    return ws
  }
  return readJSON(p)
}

async function saveWorldState(tableId, ws) {
  await writeJSON(path.join(tDir(tableId), 'world_state.json'), ws)
}

async function getDiary(tableId) {
  const p = path.join(tDir(tableId), 'diary.txt')
  try { return await fs.readFile(p, 'utf-8') } catch { return '' }
}

async function appendDiary(tableId, entry) {
  const p = path.join(tDir(tableId), 'diary.txt')
  await fs.appendFile(p, '\n\n' + entry)
}

async function getCharacters(tableId) {
  const dir = path.join(tDir(tableId), 'characters')
  try {
    const files = await fs.readdir(dir)
    return Promise.all(
      files.filter(f => f.endsWith('.json')).map(f => readJSON(path.join(dir, f)))
    )
  } catch { return [] }
}

function synthChar(char) {
  // Sintetizza la scheda in una riga per ridurre il contesto
  const c = char.characteristics
  const desc = char.descrizionePersonale ? ` — ${char.descrizionePersonale}` : ''
  return `${char.name} (${char.profession}, ${char.eta}a)${desc}: ` +
    `FOR${c.FOR} COS${c.COS} DES${c.DES} TAG${c.TAG} INT${c.INT} POT${c.POT} APP${c.APP} EDU${c.EDU} ` +
    `PF${char.derivedAttributes?.hp?.current}/${char.derivedAttributes?.hp?.max} ` +
    `SAN${char.derivedAttributes?.sanita?.current}`
}

async function getScene(tableId, sceneId) {
  const active = path.join(tDir(tableId), 'active_scenes', `${sceneId}.json`)
  if (await fileExists(active)) return readJSON(active)
  const closed = path.join(tDir(tableId), 'closed_scenes', `${sceneId}.json`)
  if (await fileExists(closed)) return readJSON(closed)
  return null
}

async function nextSceneId(tableId) {
  let count = 0
  for (const dir of ['active_scenes', 'closed_scenes']) {
    const p = path.join(tDir(tableId), dir)
    try {
      const files = await fs.readdir(p)
      count += files.filter(f => f.endsWith('.json')).length
    } catch { /* cartella assente */ }
  }
  return `scene_${String(count).padStart(3, '0')}`
}

function buildPgLookup(chars) {
  return {
    toName:  Object.fromEntries(chars.map(c => [c.playerID, c.name])),
    toEmail: Object.fromEntries(chars.map(c => [c.name.toLowerCase(), c.playerID]))
  }
}

function engagementForLlm(engagement, lookup) {
  return Object.fromEntries(
    Object.entries(engagement).map(([email, count]) => [lookup.toName[email] || email, count])
  )
}

function pianoToEmails(piano, lookup) {
  return (piano || []).map(a => ({
    ...a,
    pg: lookup.toEmail[a.pg?.toLowerCase()] || a.pg
  }))
}

async function buildNarrativeGroups(tableId, worldState, lookup = {}) {
  if (!worldState.groups?.length) return 'Nessun gruppo attivo.'
  const parts = await Promise.all(worldState.groups.map(async (g, i) => {
    const scene = g.sceneId ? await getScene(tableId, g.sceneId) : null
    const location = scene?.contesto_dove || scene?.location || g.sceneId || 'posizione sconosciuta'
    const players = g.participants?.map(e => lookup.toName?.[e] || e).join(', ') || '—'
    const activity = g.activity ? ` (${g.activity})` : ''
    const ordinal = worldState.groups.length === 1 ? 'L\'unico gruppo' : `Il gruppo ${i + 1} (${g.groupId})`
    return `${ordinal} si trova in ${location} [${g.sceneId || 'nessuna scena'}]${activity}. Partecipanti: ${players}.`
  }))
  const intro = worldState.groups.length === 1
    ? 'C\'è 1 gruppo di PG.'
    : `Ci sono ${worldState.groups.length} gruppi di PG.`
  return `${intro} ${parts.join(' ')}`
}

async function saveScene(tableId, scene, closed = false) {
  const dir = closed ? 'closed_scenes' : 'active_scenes'
  await ensureDir(path.join(tDir(tableId), dir))
  await writeJSON(path.join(tDir(tableId), dir, `${scene.id_scena}.json`), scene)
}

async function closeScene(tableId, sceneId, riepilogo) {
  const scene = await getScene(tableId, sceneId)
  if (!scene) return
  scene.summary = riepilogo
  // Sposta in closed_scenes
  const src = path.join(tDir(tableId), 'active_scenes', `${sceneId}.json`)
  const dst = path.join(tDir(tableId), 'closed_scenes', `${sceneId}.json`)
  await ensureDir(path.join(tDir(tableId), 'closed_scenes'))
  await writeJSON(dst, scene)
  try { await fs.unlink(src) } catch {}
}

// ── Placeholder trigger annotazioni ──────────────────────────────────────────

/**
 * TODO: definire la logica che valuta le annotazioni della light LLM
 * e decide se i giocatori hanno finito di dichiarare.
 *
 * @param {Array} annotatedMessages - messaggi con tag
 * @returns {boolean}
 */
function shouldProcessByAnnotations(annotatedMessages) {
  // PLACEHOLDER — implementa la logica basandoti sui tag
  return false
}

// ── Custode per tavolo ────────────────────────────────────────────────────────

class CustodeEngine {
  constructor(tableId, io) {
    this.tableId = tableId
    this.io = io
    this.buffer = []         // messaggi gioco-libero in attesa
    this.running = false
    this.paused = false
  }

  get room() { return `table:${this.tableId}` }

  // ── Emit helpers ─────────────────────────────────────────────────────────

  async emitNarrative(text, options = {}) {
    const tableId = this.tableId

    // Typing indicator
    this.io.to(this.room).emit('session:custode-typing', true)
    await sleep(Math.min(text.length * 20, 2000))   // simula latenza

    const msg = await svc.addMessage(tableId, {
      type: options.type || 'custode',
      from: 'custode',
      fromName: 'Custode',
      to: options.to || null,
      text
    })

    this.io.to(this.room).emit('session:custode-typing', false)

    if (options.whisper && options.to) {
      // Consegna solo al destinatario
      const target = [...this.io.sockets.sockets.values()]
        .find(s => s.user?.email === options.to && s.tableId === tableId)
      if (target) target.emit('session:message', msg)
      // Anche al custode/altri connessi come log interno? No: è un sussurro privato
    } else {
      this.io.to(this.room).emit('session:message', msg)
    }
  }

  async emitPhaseChange(phase) {
    const ctx = svc.getSession(this.tableId)
    if (ctx) {
      ctx.session.custodePhase = phase
      await svc.saveSession(this.tableId, ctx.session)
    }
    this.io.to(this.room).emit('session:phase-update', { phase })
  }

  async emitError(text) {
    this.io.to(this.room).emit('session:toast', { type: 'error', text })
  }

  // ── LLM call con gestione errori ──────────────────────────────────────────

  async llm(promptFile, vars, useLight = false) {
    const table = await getTable(this.tableId)
    const model = useLight
      ? (table['light-llmModel'] || table['heavy-llmModel'])
      : table['heavy-llmModel']

    if (!model) {
      const err = Object.assign(
        new Error('Modello LLM non configurato sul tavolo'),
        { isLlmError: true }
      )
      await svc.updateSessionState(this.tableId, 'in-pausa')
      this.io.to(this.room).emit('session:status-update', { state: 'in-pausa' })
      await this.emitError('Modello LLM non configurato – vai in Gestione Tavoli e seleziona un modello')
      this.paused = true
      throw err
    }

    try {
      return await ollama.runPhase(model, promptFile, vars)
    } catch (err) {
      if (err.isLlmError) {
        await svc.updateSessionState(this.tableId, 'in-pausa')
        this.io.to(this.room).emit('session:status-update', { state: 'in-pausa' })
        await this.emitError(`Errore LLM (${model}): ${err.message} – sessione in pausa`)
        this.paused = true
      }
      throw err
    }
  }

  // ── Contesto comune ───────────────────────────────────────────────────────

  async buildContext() {
    const [table, worldState, diary, chars] = await Promise.all([
      getTable(this.tableId),
      getWorldState(this.tableId),
      getDiary(this.tableId),
      getCharacters(this.tableId)
    ])
    const mod = await getModule(table.moduleId)
    const schede_PG = chars.map(synthChar).join('\n')
    const pgLookup = buildPgLookup(chars)
    const focusScene = worldState.focusScene
      ? await getScene(this.tableId, worldState.focusScene)
      : null

    return { table, worldState, diary, chars, mod, schede_PG, pgLookup, focusScene }
  }

  // ── FASE 1: Apertura ──────────────────────────────────────────────────────

  async fase1() {
    const { worldState, diary, chars, mod, schede_PG, focusScene } = await this.buildContext()
    const sessionNumber = svc.getSession(this.tableId)?.session?.sessionNumber ?? 1
    const isFirstSession = sessionNumber === 1

    if (isFirstSession) {
      await this.emitPhaseChange('fase-1a')
      const vars = { primo_capitolo: mod.chapters[0]?.content || '', schede_PG }
      const result = await this.llm('fase1a_prima_sessione.md', vars)
      await this.emitNarrative(result.narrativa)
      if (result.diary) await appendDiary(this.tableId, result.diary)

      // Inizializza world_state: tutti i PG in un unico gruppo
      worldState.groups = [{
        groupId: 'group01',
        sceneId: null,
        participants: chars.map(c => c.playerID),
        subLocation: null,
        activity: null
      }]
      await saveWorldState(this.tableId, worldState)
    } else {
      await this.emitPhaseChange('fase-1b')
      const vars = {
        diary,
        scena_in_focus: focusScene ? JSON.stringify(focusScene) : ''
      }
      const result = await this.llm('fase1b_sessioni_successive.md', vars)
      await this.emitNarrative(result.narrativa)
      if (result.diary) await appendDiary(this.tableId, result.diary)
    }

    // Prossima fase
    const hasActiveScene = worldState.focusScene &&
      await fileExists(path.join(tDir(this.tableId), 'active_scenes', `${worldState.focusScene}.json`))

    return hasActiveScene ? 'fase-3' : 'fase-2'
  }

  // ── FASE 2: Preparazione Scena ────────────────────────────────────────────

  async fase2(suggerimento = null) {
    await this.emitPhaseChange('fase-2')
    const { worldState, mod } = await this.buildContext()
    const capitolo = mod.chapters[(worldState.currentChapter - 1)]?.content || ''

    const result = await this.llm('fase2_prepara_scena.md', {
      capitolo_corrente: capitolo,
      suggerimento_scena: suggerimento || 'scena introduttiva'
    })

    // Assegna ID progressivo e inizializza progressione
    result.id_scena = await nextSceneId(this.tableId)
    result.progressione = ''

    // Salva scena in active_scenes
    await saveScene(this.tableId, result)

    // Aggiorna world_state: sceneId del gruppo in focus
    const focusGroup = worldState.groups.find(g => g.groupId === (worldState.focusGroupId || 'group01'))
    if (focusGroup) focusGroup.sceneId = result.id_scena

    // focusScene: diventa la nuova scena solo se è l'unica scena attiva,
    // altrimenti "tbd" (custode deve scegliere il prossimo focus)
    const activeScenes = await fs.readdir(path.join(tDir(this.tableId), 'active_scenes')).catch(() => [])
    worldState.focusScene = activeScenes.filter(f => f.endsWith('.json')).length === 1
      ? result.id_scena
      : 'tbd'

    await saveWorldState(this.tableId, worldState)

    return { next: 'fase-3' }
  }

  // ── FASE 3: Scena e Gioco Libero ──────────────────────────────────────────

  async fase3() {
    const { worldState, schede_PG, pgLookup } = await this.buildContext()
    const ctx = svc.getSession(this.tableId)
    const engagement = engagementForLlm(ctx?.session?.engagement || {}, pgLookup)

    // ── 3a (opzionale): scelta focus scena ──
    const activeSceneFiles = await fs.readdir(path.join(tDir(this.tableId), 'active_scenes')).catch(() => [])
    const needsFocusChoice = worldState.focusScene === 'tbd' ||
      activeSceneFiles.filter(f => f.endsWith('.json')).length > 1

    if (needsFocusChoice) {
      await this.emitPhaseChange('fase-3a')
      const activeScenes = await Promise.all(
        activeSceneFiles.filter(f => f.endsWith('.json'))
          .map(f => readJSON(path.join(tDir(this.tableId), 'active_scenes', f)))
      )
      const narrativeGroups = await buildNarrativeGroups(this.tableId, worldState, pgLookup)
      const result3a = await this.llm('fase3a_scelta_focus.md', {
        narrative_groups: narrativeGroups,
        engagement: JSON.stringify(engagement),
        scene_attive: JSON.stringify(activeScenes)
      }, true)  // light LLM

      worldState.focusScene = result3a.focus_scene
      await saveWorldState(this.tableId, worldState)
    }

    // ── 3b (sempre): narrazione scena ──
    await this.emitPhaseChange('fase-3b')
    const focusScene = await getScene(this.tableId, worldState.focusScene)
    const recentMsgs = ctx?.messages.slice(-10)
      .map(m => `${m.fromName}: ${m.text}`).join('\n') || ''

    const result = await this.llm('fase3b_narrazione.md', {
      scena_focus: JSON.stringify(focusScene),
      progressione: focusScene?.progressione || '(nessuna progressione ancora)',
      schede_PG,
      engagement: JSON.stringify(engagement),
      storia_recente: recentMsgs
    })

    // Aggiorna focusScene se la LLM l'ha confermata/cambiata
    if (result.focus_scene && result.focus_scene !== worldState.focusScene) {
      worldState.focusScene = result.focus_scene
      await saveWorldState(this.tableId, worldState)
    }

    await this.emitNarrative(result.narrativa)

    // Sussurri: target è nome PG → converti in email
    for (const s of result.sussurri || []) {
      const targetEmail = pgLookup.toEmail[s.target?.toLowerCase()] || s.target
      await this.emitNarrative(s.testo, { whisper: true, to: targetEmail, type: 'whisper' })
    }

    // Imposta tutti i PG del gruppo in focus a gioco-libero
    await this.setGroupState(worldState.focusScene, worldState, 'gioco-libero')

    // Avvia timer proattività
    svc.setTimer(this.tableId, 'proattivita', PROACTIVITY_TIMER_MS, async () => {
      if (!this.paused) await this.fase3()
    })

    // Avvia raccolta buffer
    this.startBuffer()

    return null  // attende messaggi
  }

  // ── FASE 4: Gestione Dichiarazioni ────────────────────────────────────────

  async fase4(pianoParziale = null) {
    await this.emitPhaseChange('fase-4')
    svc.clearTimer(this.tableId, 'proattivita')
    svc.clearTimer(this.tableId, 'silenzio')

    const msgs = this.buffer.map(m => `[${m.tag || '?'}] ${m.fromName || m.from}: ${m.text}`).join('\n')
    const { worldState, schede_PG, pgLookup } = await this.buildContext()
    const focusScene = await getScene(this.tableId, worldState.focusScene)

    const result = await this.llm('fase4_dichiarazioni.md', {
      estratto_scena_corrente: JSON.stringify(focusScene),
      schede_PG,
      messaggi_buffer: msgs,
      piano_azione: pianoParziale ? JSON.stringify(pianoParziale) : 'nessuno'
    })

    // result è l'array piano — conversione nomi → email
    const piano = pianoToEmails(Array.isArray(result) ? result : (result.piano || []), pgLookup)

    // Salva piano in sessione
    const ctx = svc.getSession(this.tableId)
    if (ctx) {
      ctx.session.pianoAzione = piano
      await svc.saveSession(this.tableId, ctx.session)
    }

    // Controlla completezza
    const isCompleto = piano.every(e =>
      e.stato === 'dichiarazione' ||
      (e.stato === 'prova' && e.risultato_prova != null)
    )

    if (isCompleto) {
      this.buffer = []
      return { next: 'fase-5', piano }
    }

    // Trova prossima entry pendente per priorità
    const pending = piano
      .filter(e => e.stato === 'incompleta' || e.stato === 'assente' ||
                   (e.stato === 'prova' && e.risultato_prova == null))
      .sort((a, b) => (a.priorita || 99) - (b.priorita || 99))[0]

    if (pending.stato === 'incompleta')
      return { next: 'sottofase-4a', data: { pg_target: pending.pg, azione_parziale: pending.azione, piano } }
    if (pending.stato === 'assente')
      return { next: 'sottofase-4b', data: { pg_target: pending.pg, piano } }
    if (pending.stato === 'prova')
      return { next: 'sottofase-4c', data: { pg_target: pending.pg, azione: pending.azione, abilita_o_caratteristica: pending.abilita_o_caratteristica, difficolta: pending.difficolta, piano } }
  }

  async fase4a(data) {
    await this.emitPhaseChange('fase-4a')
    const { pgLookup } = await this.buildContext()
    const pgNome = pgLookup.toName[data.pg_target] || data.pg_target
    const result = await this.llm('fase4a_chiarimenti.md', {
      pg_target: pgNome,
      azione_parziale: data.azione_parziale || ''
    })
    await this.emitNarrative(result.narrativa)
    await this.setPlayerTurn(data.pg_target, 'mio-turno-libero')
    return null
  }

  async fase4b(data) {
    await this.emitPhaseChange('fase-4b')
    const { pgLookup } = await this.buildContext()
    const pgNome = pgLookup.toName[data.pg_target] || data.pg_target
    const result = await this.llm('fase4b_dichiarazione_assente.md', {
      pg_target: pgNome
    })
    await this.emitNarrative(result.narrativa)
    await this.setPlayerTurn(data.pg_target, 'mio-turno-libero')
    return null
  }

  async fase4c(data) {
    await this.emitPhaseChange('fase-4c')
    const { pgLookup } = await this.buildContext()
    const pgNome = pgLookup.toName[data.pg_target] || data.pg_target
    const result = await this.llm('fase4c_necessita_prova.md', {
      pg_target: pgNome,
      azione: data.azione || '',
      abilita_o_caratteristica: data.abilita_o_caratteristica || '',
      difficolta: data.difficolta || 'normale'
    })
    await this.emitNarrative(result.narrativa)
    await this.setPlayerTurn(data.pg_target, 'mio-turno-prova')
    return null
  }

  // ── FASE 5: Risoluzione ───────────────────────────────────────────────────

  async fase5(piano) {
    await this.emitPhaseChange('fase-5')
    const { worldState, schede_PG, pgLookup } = await this.buildContext()
    const focusScene = await getScene(this.tableId, worldState.focusScene)

    const result = await this.llm('fase5_risoluzione.md', {
      piano_azione: JSON.stringify(piano),
      estratto_scena_corrente: JSON.stringify(focusScene),
      world_state: JSON.stringify(worldState),
      schede_PG
    })

    await this.emitNarrative(result.narrativa)

    for (const s of result.sussurri || []) {
      const targetEmail = pgLookup.toEmail[s.target?.toLowerCase()] || s.target
      await this.emitNarrative(s.testo, { whisper: true, to: targetEmail, type: 'whisper' })
    }

    // Aggiorna engagement: incrementa i PG presenti nel piano
    const ctx = svc.getSession(this.tableId)
    if (ctx) {
      if (!ctx.session.engagement) ctx.session.engagement = {}
      for (const azione of piano || []) {
        if (azione.pg) {
          ctx.session.engagement[azione.pg] = (ctx.session.engagement[azione.pg] || 0) + 1
        }
      }
      await svc.saveSession(this.tableId, ctx.session)
    }

    // Aggiorna progressione della scena con il riassunto delle conseguenze
    if (result.progressione && focusScene) {
      const prev = focusScene.progressione || ''
      focusScene.progressione = prev ? `${prev}\n${result.progressione}` : result.progressione
      await saveScene(this.tableId, focusScene)
    }

    // Aggiorna world state
    if (result.aggiornamenti?.world_state) {
      const ws = await getWorldState(this.tableId)
      const upd = result.aggiornamenti.world_state
      if (upd.npcs?.length) {
        upd.npcs.forEach(n => {
          const existing = ws.npcs.find(x => x.name === n.name)
          if (existing) Object.assign(existing, n)
          else ws.npcs.push(n)
        })
      }
      if (upd.items?.length) {
        upd.items.forEach(i => {
          const existing = ws.items.find(x => x.name === i.name)
          if (existing) Object.assign(existing, i)
          else ws.items.push(i)
        })
      }
      await saveWorldState(this.tableId, ws)
    }

    const cons = result.conseguenze || {}

    if (cons.divisione_gruppi) return { next: 'fase-5a', data: result.dettagli_divisione }
    if (cons.ricongiungimento_gruppi) return { next: 'fase-5b', data: result.dettagli_ricongiungimento }
    if (cons.chiusura_scena) return { next: 'fase-5c', data: result.dettagli_chiusura }

    return { next: 'fase-3' }
  }

  async fase5a(data) {
    await this.emitPhaseChange('fase-5a')
    const { worldState } = await this.buildContext()
    const focusScene = await getScene(this.tableId, worldState.focusScene)
    const recentMsgs = svc.getSession(this.tableId)?.messages.slice(-5)
      .map(m => `${m.fromName}: ${m.text}`).join('\n') || ''

    const result = await this.llm('fase5a_divisione_gruppi.md', {
      estratto_scena_corrente: JSON.stringify(focusScene),
      world_state: JSON.stringify(worldState),
      messaggi_recenti: recentMsgs,
      dettagli_divisione: JSON.stringify(data)
    })
    await this.emitNarrative(result.narrativa)
    // TODO: aggiorna world_state con nuovi gruppi/scene
    return { next: 'fase-3' }
  }

  async fase5b(data) {
    await this.emitPhaseChange('fase-5b')
    const { worldState } = await this.buildContext()
    const activeScenes = await this.getActiveScenes()

    const result = await this.llm('fase5b_ricongiungimento.md', {
      estratti_scene_attive: JSON.stringify(activeScenes),
      world_state: JSON.stringify(worldState),
      dettagli_ricongiungimento: JSON.stringify(data)
    })
    await this.emitNarrative(result.narrativa)
    // TODO: aggiorna world_state unendo i gruppi
    return { next: 'fase-3' }
  }

  async fase5c(data) {
    await this.emitPhaseChange('fase-5c')
    const { worldState } = await this.buildContext()
    const focusScene = await getScene(this.tableId, worldState.focusScene)

    const result = await this.llm('fase5c_chiusura_scena.md', {
      estratto_scena_corrente: JSON.stringify(focusScene),
      world_state: JSON.stringify(worldState),
      dettagli_chiusura: JSON.stringify(data)
    })

    await this.emitNarrative(result.narrativa)

    if (result.aggiornamenti?.diary) await appendDiary(this.tableId, result.aggiornamenti.diary)
    if (result.aggiornamenti?.scena_chiusa) {
      await closeScene(this.tableId, result.aggiornamenti.scena_chiusa, result.riepilogo_scena)
      const ws = await getWorldState(this.tableId)
      ws.focusScene = null
      await saveWorldState(this.tableId, ws)
    }

    // Invia aggiornamento diario ai client
    this.io.to(this.room).emit('session:diary', await getDiary(this.tableId))

    // Ci sono altre scene attive?
    const active = await this.getActiveScenes()
    if (active.length > 0) {
      const ws = await getWorldState(this.tableId)
      ws.focusScene = active[0].id_scena
      await saveWorldState(this.tableId, ws)
      return { next: 'fase-3' }
    }

    return { next: 'fase-2', suggerimento: result.suggerimento_prossima_scena }
  }

  // ── Loop principale ───────────────────────────────────────────────────────

  async start() {
    if (this.running) return
    this.running = true
    this.paused = false
    console.log(`[Custode] Start — tavolo ${this.tableId}`)

    try {
      let next = await this.fase1()
      await this.runLoop(next)
    } catch (err) {
      this.running = false
      if (!this.paused) {
        console.error('[Custode] Errore fatale:', err)
        await this.emitError('Errore imprevisto del Custode')
      }
    }
  }

  async resume() {
    // Se il custode non era mai partito (es. errore in start), riparti da capo
    if (!this.running && !this.paused) {
      return this.start()
    }
    if (!this.paused) return
    this.paused = false
    this.running = true
    const ctx = svc.getSession(this.tableId)
    const phase = ctx?.session?.custodePhase || 'fase-3'
    const piano = ctx?.session?.pianoAzione
    try {
      await this.runLoop(phase, piano)
    } catch (err) {
      this.running = false
      console.error('[Custode] Errore in resume:', err)
      await this.emitError('Errore riprendendo il Custode')
    }
  }

  async runLoop(startPhase, extraData = null) {
    let current = startPhase
    let data = extraData

    while (current && !this.paused) {
      try {
        let result

        if (current === 'fase-2') result = await this.fase2(data?.suggerimento)
        else if (current === 'fase-3') result = await this.fase3()
        else if (current === 'fase-4') result = await this.fase4(data)
        else if (current === 'sottofase-4a') result = await this.fase4a(data)
        else if (current === 'sottofase-4b') result = await this.fase4b(data)
        else if (current === 'sottofase-4c') result = await this.fase4c(data)
        else if (current === 'fase-5') result = await this.fase5(data?.piano || data)
        else if (current === 'fase-5a') result = await this.fase5a(data?.data || data)
        else if (current === 'fase-5b') result = await this.fase5b(data?.data || data)
        else if (current === 'fase-5c') result = await this.fase5c(data?.data || data)
        else break  // fase-1 già eseguita, fase-3 attende input

        if (!result) break  // in attesa di input giocatori

        current = result.next
        data = result

      } catch (err) {
        if (this.paused) break
        console.error(`[Custode] Errore in ${current}:`, err.message)
        break
      }
    }
  }

  // ── Buffer messaggi ───────────────────────────────────────────────────────

  startBuffer() {
    this.bufferActive = true
  }

  async onPlayerMessage(message) {
    const ctx = svc.getSession(this.tableId)
    if (!ctx) return
    const phase = ctx.session.custodePhase

    // Dopo tiro dado: gestito interamente da onDiceRoll
    if (phase === 'fase-4c') return

    // Turno singolo (dopo 4a o 4b): accumula senza tagging, timer silenzio
    if (phase === 'fase-4a' || phase === 'fase-4b') {
      this.buffer.push({ ...message, tag: 'dichiarazione' })
      svc.setTimer(this.tableId, 'silenzio', SILENCE_TIMER_MS, () => {
        this.flushBuffer('turno-singolo')
      })
      return
    }

    // Gioco libero: accumula nel buffer
    if (!this.bufferActive) return
    this.buffer.push(message)
    this.tagMessageAsync(message)

    if (this.buffer.length >= MSG_BUFFER_SIZE) {
      this.flushBuffer('buffer-pieno')
      return
    }

    svc.setTimer(this.tableId, 'silenzio', SILENCE_TIMER_MS, () => {
      this.flushBuffer('timer-silenzio')
    })
  }

  async onDiceRoll(email, valore, soglia, caratteristica) {
    const ctx = svc.getSession(this.tableId)
    if (!ctx || ctx.session.custodePhase !== 'fase-4c') return

    const esito = valore <= soglia ? 'successo' : 'fallimento'
    const piano = ctx.session.pianoAzione || []

    // Aggiorna risultato_prova nell'entry corrispondente
    const entry = piano.find(e => e.pg === email && e.stato === 'prova')
    if (entry) {
      entry.risultato_prova = { valore_tiro: valore, esito }
      ctx.session.pianoAzione = piano
      await svc.saveSession(this.tableId, ctx.session)
    }

    this.buffer.push({
      from: email,
      tag: 'dichiarazione',
      text: `[Tiro dado] ${caratteristica}: ${valore}/${soglia} → ${esito}`
    })

    await this.runLoop('fase-4', piano)
  }

  flushBuffer(reason) {
    if (!this.buffer.length) return
    svc.clearTimer(this.tableId, 'silenzio')
    console.log(`[Custode] Buffer flush: ${reason} (${this.buffer.length} msgs)`)
    this.bufferActive = false
    // In turno singolo passa il piano parziale corrente, altrimenti null (round fresco)
    const ctx = svc.getSession(this.tableId)
    const phase = ctx?.session?.custodePhase
    const piano = (phase === 'fase-4a' || phase === 'fase-4b')
      ? (ctx?.session?.pianoAzione || null)
      : null
    this.runLoop('fase-4', piano).catch(console.error)
  }

  async tagMessageAsync(message) {
    const table = await getTable(this.tableId)
    const lightModel = table['light-llmModel'] || table['heavy-llmModel']
    if (!lightModel) return

    try {
      const result = await ollama.runTagging(lightModel, 'tagging_buffer.md', {
        messaggi: JSON.stringify([{ id: message.id, testo: message.text }])
      })

      const ann = result.annotazioni?.find(a => a.id === message.id)
      if (ann) {
        const msg = this.buffer.find(m => m.id === message.id)
        if (msg) msg.tag = ann.tag
      }

      // Placeholder: controlla se le annotazioni indicano fine
      if (shouldProcessByAnnotations(this.buffer) && this.bufferActive) {
        this.flushBuffer('annotazioni')
      }
    } catch {
      // Il tagging è best-effort, non blocca il gioco
    }
  }

  // ── Utilità ───────────────────────────────────────────────────────────────

  async setGroupState(sceneId, worldState, playerState) {
    const group = worldState.groups.find(g => g.sceneId === sceneId)
    if (!group) return
    for (const email of group.participants) {
      await svc.updatePlayerState(this.tableId, email, playerState)
      this.io.to(this.room).emit('session:player-update', {
        email, connected: true, playerState
      })
    }
  }

  async setPlayerTurn(email, playerState) {
    const ctx = svc.getSession(this.tableId)
    if (!ctx) return
    // Tutti gli altri: fuori-turno
    for (const p of ctx.session.players) {
      const state = p.email === email ? playerState : 'fuori-turno'
      await svc.updatePlayerState(this.tableId, p.email, state)
      this.io.to(this.room).emit('session:player-update', {
        email: p.email, connected: p.connected, playerState: state
      })
    }
  }

  async getActiveScenes() {
    const dir = path.join(tDir(this.tableId), 'active_scenes')
    try {
      const files = await fs.readdir(dir)
      return Promise.all(
        files.filter(f => f.endsWith('.json')).map(f => readJSON(path.join(dir, f)))
      )
    } catch { return [] }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function shouldProcessByAnnotations(msgs) { return false }  // placeholder

// ── Registro engine attivi ────────────────────────────────────────────────────

const engines = new Map()

function getOrCreate(tableId, io) {
  if (!engines.has(tableId)) engines.set(tableId, new CustodeEngine(tableId, io))
  return engines.get(tableId)
}

function destroy(tableId) {
  const engine = engines.get(tableId)
  if (engine) {
    engine.paused = true   // interrompe il runLoop se in esecuzione
    engine.running = false
  }
  engines.delete(tableId)
}

module.exports = { getOrCreate, destroy }
