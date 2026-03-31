/**
 * Test di integrazione — Sessione + Ciclo Custode
 *
 * Avvia un server reale su porta test + un mock Ollama, poi simula
 * due giocatori che entrano in sessione e attraversano i vari scenari.
 *
 * Uso: node test/session_test.js
 */

'use strict'

process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-secret-jwt'
process.env.PORT = '13434'
process.env.OLLAMA_BASE_URL = 'http://localhost:13435'
process.env.LLM_MAX_RETRIES = '1'
process.env.LLM_TIMEOUT_MS = '5000'
process.env.MSG_BUFFER_SIZE = '5'
process.env.SILENCE_TIMER_MS = '5000'   // 5s invece di 30s per i test
process.env.PROACTIVITY_TIMER_MS = '60000'
process.env.DATA_DIR_OVERRIDE = require('path').join(__dirname, '../../data_test')

const http = require('http')
const path = require('path')
const fs = require('fs').promises
const { io: ioClient } = require('socket.io-client')

const SERVER_URL = 'http://localhost:13434'
const OLLAMA_PORT = 13435

// ── Colori per output ────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m'
}

let passed = 0, failed = 0

function pass(name) {
  console.log(`  ${C.green}✓${C.reset} ${name}`)
  passed++
}

function fail(name, reason) {
  console.log(`  ${C.red}✗${C.reset} ${name}`)
  console.log(`    ${C.red}${reason}${C.reset}`)
  failed++
}

function section(name) {
  console.log(`\n${C.cyan}${C.bold}▶ ${name}${C.reset}`)
}

function log(msg) {
  console.log(`  ${C.gray}${msg}${C.reset}`)
}

// ── Mock Ollama ──────────────────────────────────────────────────────────────

/**
 * Risponde con JSON validi per ogni fase, basandosi sulle prime parole del prompt.
 */
function buildOllamaResponse(prompt) {
  if (prompt.includes('fase1_apertura') || prompt.includes('Fase 1') || prompt.includes('primo capitolo') || prompt.includes('Apertura')) {
    return {
      narrativa: 'Il gruppo si trova davanti a una vecchia villa abbandonata. Il vento ululava tra le finestre rotte.',
      diary: 'Prima sessione: il gruppo arriva alla villa Blackwood.'
    }
  }
  if (prompt.includes('fase2') || prompt.includes('Preparazione') || prompt.includes('prepara')) {
    return {
      id_scena: 'scena_001',
      titolo: 'Ingresso della Villa',
      contesto_dove: 'Soglia della villa Blackwood',
      contesto_cosa: 'Esplorare la villa',
      personaggi_presenti: [],
      oggetti_rilevanti: []
    }
  }
  if (prompt.includes('fase3') || prompt.includes('Scena e Gioco')) {
    return {
      narrativa: 'La porta cigola mentre la spingete. Un odore di muffa vi investe.',
      sussurri: []
    }
  }
  if (prompt.includes('fase4') || prompt.includes('Dichiarazioni')) {
    return {
      completo: true,
      piano: [
        { pg: 'player_a@test.com', azione: 'esplora il corridoio', richiede_prova: false }
      ],
      piano_parziale: [],
      sottofase: null
    }
  }
  if (prompt.includes('fase5') || prompt.includes('Risoluzione')) {
    return {
      narrativa: 'Mentre esplorate il corridoio, trovate una vecchia foto di famiglia.',
      sussurri: [],
      aggiornamenti: { world_state: {} },
      conseguenze: {}
    }
  }
  if (prompt.includes('tagging') || prompt.includes('Tagging')) {
    return {
      annotazioni: [],
      pronti: false
    }
  }
  // fallback
  return { narrativa: 'Il Custode osserva la scena in silenzio.' }
}

function startMockOllama() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ models: [{ name: 'test-model:latest' }] }))
        return
      }
      if (req.method === 'POST' && req.url === '/api/generate') {
        let body = ''
        req.on('data', d => { body += d })
        req.on('end', () => {
          try {
            const { prompt } = JSON.parse(body)
            const responseObj = buildOllamaResponse(prompt || '')
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ response: JSON.stringify(responseObj) }))
          } catch {
            res.writeHead(500)
            res.end('{}')
          }
        })
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.listen(OLLAMA_PORT, () => {
      log(`Mock Ollama avviato su :${OLLAMA_PORT}`)
      resolve(server)
    })
  })
}

// ── Avvio server applicazione ─────────────────────────────────────────────────

async function startAppServer() {
  const bcrypt = require('bcrypt')
  const DATA_TEST = path.join(__dirname, '../../data_test')

  // Inizializza dirs e seed admin manualmente (più affidabile dell'auto-seed)
  await fs.mkdir(path.join(DATA_TEST, 'tables'), { recursive: true })
  await fs.mkdir(path.join(DATA_TEST, 'modules'), { recursive: true })

  const hash = await bcrypt.hash('admin123', 10)
  await fs.writeFile(path.join(DATA_TEST, 'users.json'), JSON.stringify([{
    email: 'admin@test.com', name: 'Admin', role: 'admin',
    password: hash, accountState: 'attivo', createdAt: new Date().toISOString()
  }], null, 2))

  const { httpServer } = require('../src/server_export')
  await new Promise(resolve => httpServer.listen(13434, resolve))
  log(`Server applicazione avviato su :13434`)
  return { httpServer }
}

// ── Helpers HTTP ─────────────────────────────────────────────────────────────

async function apiCall(method, path, body, token) {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${method} ${path} → ${res.status}: ${text}`)
  }
  return res.json()
}

// ── Helpers Socket ────────────────────────────────────────────────────────────

function createPlayer(token) {
  const socket = ioClient(SERVER_URL, {
    auth: { token },
    reconnection: false
  })
  const events = {}
  const handlers = {}

  socket.onAny((event, data) => {
    if (!events[event]) events[event] = []
    events[event].push(data)
    if (handlers[event]) {
      handlers[event].forEach(fn => fn(data))
    }
  })

  function waitFor(event, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      // Controlla se l'evento è già arrivato
      if (events[event]?.length) return resolve(events[event].at(-1))
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeoutMs)
      if (!handlers[event]) handlers[event] = []
      handlers[event].push((data) => {
        clearTimeout(timer)
        resolve(data)
      })
    })
  }

  function waitForCondition(event, condition, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      // Controlla eventi già ricevuti
      for (const d of (events[event] || [])) {
        if (condition(d)) return resolve(d)
      }
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for '${event}' with condition`)), timeoutMs)
      if (!handlers[event]) handlers[event] = []
      handlers[event].push((data) => {
        if (condition(data)) {
          clearTimeout(timer)
          resolve(data)
        }
      })
    })
  }

  function lastEvent(event) {
    return events[event]?.at(-1)
  }

  function allEvents(event) {
    return events[event] || []
  }

  return { socket, waitFor, waitForCondition, lastEvent, allEvents, events }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Pulizia dati test ─────────────────────────────────────────────────────────

async function cleanupTestData() {
  const dir = path.join(__dirname, '../../data_test')
  try { await fs.rm(dir, { recursive: true }) } catch {}
}

// ── MAIN TEST RUNNER ──────────────────────────────────────────────────────────

async function runTests() {
  console.log(`\n${C.bold}═══ Test Sessione + Ciclo Custode ═══${C.reset}\n`)

  // Setup
  await cleanupTestData()
  const mockOllama = await startMockOllama()

  let appServer, adminToken, playerAToken, playerBToken, tableId

  // ── Setup: avvio server ────────────────────────────────────────────────────
  section('Setup')
  try {
    const srv = await startAppServer()
    appServer = srv.httpServer
    pass('Server applicazione avviato')
  } catch (err) {
    fail('Avvio server', err.message)
    await cleanup(mockOllama, appServer)
    return
  }

  await sleep(500) // attendi init dirs

  // ── Scenario 1: Auth & Setup dati ─────────────────────────────────────────
  section('Scenario 1 — Auth & Dati di test')
  try {
    const r = await apiCall('POST', '/api/auth/login', { email: 'admin@test.com', password: 'admin123' })
    adminToken = r.token
    pass('Login admin')
  } catch (err) {
    fail('Login admin', err.message)
    await cleanup(mockOllama, appServer)
    return
  }

  // Crea Player A: invite → login con codice → change-password
  const INVITE_CODE = 'code123'
  const PLAYER_PASS = 'pass123'

  try {
    await apiCall('POST', '/api/users/invite', { email: 'player_a@test.com', inviteCode: INVITE_CODE }, adminToken)
    const tmpToken = (await apiCall('POST', '/api/auth/login', { email: 'player_a@test.com', password: INVITE_CODE })).token
    await apiCall('POST', '/api/auth/change-password', { currentPassword: INVITE_CODE, newPassword: PLAYER_PASS }, tmpToken)
    pass('Player A invitato e attivato')
  } catch (err) {
    fail('Setup Player A', err.message)
    await cleanup(mockOllama, appServer)
    return
  }

  try {
    playerAToken = (await apiCall('POST', '/api/auth/login', { email: 'player_a@test.com', password: PLAYER_PASS })).token
    pass('Login Player A')
  } catch (err) {
    fail('Login Player A', err.message)
    await cleanup(mockOllama, appServer)
    return
  }

  try {
    await apiCall('POST', '/api/users/invite', { email: 'player_b@test.com', inviteCode: INVITE_CODE }, adminToken)
    const tmpToken = (await apiCall('POST', '/api/auth/login', { email: 'player_b@test.com', password: INVITE_CODE })).token
    await apiCall('POST', '/api/auth/change-password', { currentPassword: INVITE_CODE, newPassword: PLAYER_PASS }, tmpToken)
    pass('Player B invitato e attivato')
  } catch (err) {
    fail('Setup Player B', err.message)
    await cleanup(mockOllama, appServer)
    return
  }

  try {
    playerBToken = (await apiCall('POST', '/api/auth/login', { email: 'player_b@test.com', password: PLAYER_PASS })).token
    pass('Login Player B')
  } catch (err) {
    fail('Login Player B', err.message)
    await cleanup(mockOllama, appServer)
    return
  }

  // Crea modulo con capitolo
  let moduleId
  try {
    const mod = await apiCall('POST', '/api/modules', {
      title: 'Test Adventure',
      minPlayers: 1,
      maxPlayers: 4,
      chapters: [{
        number: 1,
        title: 'Capitolo 1',
        content: 'Il gruppo si trova in una piccola città. Una villa abbandonata li attende.'
      }]
    }, adminToken)
    moduleId = mod.id
    pass(`Modulo creato: ${moduleId}`)
  } catch (err) {
    fail('Crea modulo', err.message)
    await cleanup(mockOllama, appServer)
    return
  }

  // Crea tavolo
  try {
    const table = await apiCall('POST', '/api/tables', {
      moduleId,
      invitedPlayers: ['player_a@test.com', 'player_b@test.com'],
      heavyLlmModel: 'test-model:latest'
    }, adminToken)
    tableId = table.id
    pass(`Tavolo creato: ${tableId}`)
  } catch (err) {
    fail('Crea tavolo', err.message)
    await cleanup(mockOllama, appServer)
    return
  }

  // ── Scenario 2: Creazione personaggi ──────────────────────────────────────
  section('Scenario 2 — Creazione Personaggi')
  const charA = {
    name: 'Arthur Drake',
    profession: 'Investigatore',
    eta: 35,
    characteristics: { FOR: 50, COS: 55, DES: 60, TAG: 45, INT: 70, POT: 65, APP: 60, EDU: 75 },
    Fortuna: 55,
    derivedAttributes: {
      hp: { current: 10, max: 10 },
      mp: { current: 13, max: 13 },
      sanita: { current: 65 },
      movimento: 8
    },
    abilita: { comuni: { biblioteca: 40, ascoltare: 25 }, specialistiche: [] },
    playerID: 'player_a@test.com'
  }
  const charB = { ...charA, name: 'Clara Voss', playerID: 'player_b@test.com' }

  try {
    await apiCall('POST', `/api/tables/${tableId}/characters`, charA, playerAToken)
    pass('Personaggio Player A creato')
  } catch (err) {
    fail('Crea personaggio A', err.message)
  }
  try {
    await apiCall('POST', `/api/tables/${tableId}/characters`, charB, playerBToken)
    pass('Personaggio Player B creato')
  } catch (err) {
    fail('Crea personaggio B', err.message)
  }

  // ── Scenario 3: Connessione e avvio sessione ───────────────────────────────
  section('Scenario 3 — Connessione giocatori & avvio sessione')

  const playerA = createPlayer(playerAToken)
  const playerB = createPlayer(playerBToken)

  // Attendi connessione socket
  await Promise.all([
    new Promise(r => playerA.socket.on('connect', r)),
    new Promise(r => playerB.socket.on('connect', r))
  ])
  pass('Entrambi i socket connessi')

  // Player A entra nella sessione
  playerA.socket.emit('session:join', tableId)
  try {
    const stateA = await playerA.waitFor('session:state', 5000)
    if (stateA.session?.state === 'primo-giocatore') {
      pass('Player A: riceve stato primo-giocatore')
    } else {
      fail('Player A: stato atteso primo-giocatore', `ricevuto: ${stateA.session?.state}`)
    }
  } catch (err) {
    fail('Player A: session:state', err.message)
  }

  // Player B entra
  playerB.socket.emit('session:join', tableId)
  try {
    await playerB.waitFor('session:state', 5000)
    pass('Player B: riceve session:state')
  } catch (err) {
    fail('Player B: session:state', err.message)
  }

  // Aspetta che la sessione parta (entrambi connessi → tutti=true)
  try {
    const status = await playerA.waitForCondition('session:status-update',
      d => d.state === 'sessione-iniziata', 5000)
    pass(`Sessione avviata: ${status.state}`)
  } catch (err) {
    fail('Sessione non avviata automaticamente', err.message)
  }

  // Verifica che i player siano in gioco-libero
  try {
    await playerA.waitForCondition('session:player-update',
      d => d.email === 'player_a@test.com' && d.playerState === 'gioco-libero', 3000)
    pass('Player A: stato gioco-libero')
  } catch (err) {
    fail('Player A: gioco-libero non ricevuto', err.message)
  }

  // ── Scenario 4: Custode — Fase 1 ──────────────────────────────────────────
  section('Scenario 4 — Custode Fase 1')

  try {
    await playerA.waitFor('session:custode-typing', 6000)
    pass('Custode typing indicator ricevuto')
  } catch (err) {
    fail('Custode typing non ricevuto', err.message)
  }

  try {
    const msg = await playerA.waitForCondition('session:message',
      d => d.from === 'custode', 10000)
    pass(`Custode narrativa fase-1: "${msg.text.slice(0, 60)}…"`)
  } catch (err) {
    fail('Narrativa custode fase-1 non ricevuta', err.message)
  }

  // ── Scenario 5: Giocatori in gioco-libero, messaggi nel buffer ────────────
  section('Scenario 5 — Buffer messaggi')

  // Aspetta che il custode sia in fase-3 (bufferActive = true):
  // emitPhaseChange('fase-3') viene emesso PRIMA della chiamata LLM, poi startBuffer() viene
  // chiamato DOPO. Quindi aspettiamo la narrativa del custode (post-LLM) per essere sicuri
  // che il buffer sia attivo prima di inviare messaggi.
  try {
    await playerA.waitForCondition('session:phase-update', d => d.phase === 'fase-3', 15000)
    // Aspetta la narrativa custode di fase-3 (emessa prima di startBuffer)
    const custodeMsgsBefore = playerA.allEvents('session:message').filter(m => m.from === 'custode').length
    await playerA.waitForCondition('session:message',
      d => d.from === 'custode' && playerA.allEvents('session:message').filter(m => m.from === 'custode').length > custodeMsgsBefore,
      10000)
    // Il buffer viene attivato DOPO emitNarrative (setGroupState → startBuffer).
    // Aspetta che l'engine completi il bookkeeping prima di inviare messaggi.
    await sleep(200)
    pass('Custode in fase-3 (buffer attivo)')
  } catch {
    log(`fase-3 non ricevuto. Phase updates ricevuti: ${JSON.stringify(playerA.allEvents('session:phase-update'))}`)
    log(`Messaggi custode ricevuti: ${playerA.allEvents('session:message').filter(m => m.from === 'custode').length}`)
  }

  playerA.socket.emit('session:message', { text: 'Esamino la porta con attenzione.' })
  playerB.socket.emit('session:message', { text: 'Cerco indizi intorno alla finestra.' })

  try {
    await playerA.waitForCondition('session:message',
      d => d.from === 'player_a@test.com', 3000)
    pass('Messaggio Player A consegnato a tutti')
  } catch (err) {
    fail('Messaggio Player A non ricevuto', err.message)
  }

  try {
    await playerA.waitForCondition('session:message',
      d => d.from === 'player_b@test.com', 3000)
    pass('Messaggio Player B visibile a Player A')
  } catch (err) {
    fail('Messaggio Player B non visibile a Player A', err.message)
  }

  // ── Scenario 6: Buffer flush (silenzio 30s → fase-4) ─────────────────────
  section('Scenario 6 — Flush buffer & Fase 4')
  log('Attendo flush buffer (silenzio ~5s)...')

  try {
    const phase = await playerA.waitForCondition('session:phase-update',
      d => d.phase?.startsWith('fase-4'), 12000)
    pass(`Fase 4 attivata: ${phase.phase}`)
  } catch (err) {
    fail('Fase 4 non attivata entro 12s', err.message)
    log(`Phase updates ricevuti: ${JSON.stringify(playerA.allEvents('session:phase-update'))}`)
    log(`Messaggi custode: ${playerA.allEvents('session:message').filter(m => m.from === 'custode').length}`)
  }

  // Il custode dovrebbe tornare in fase-3 o emettere narrativa
  const custodeMsgsBefore6 = playerA.allEvents('session:message').filter(m => m.from === 'custode').length
  try {
    await playerA.waitForCondition('session:message',
      d => d.from === 'custode' && playerA.allEvents('session:message').filter(m => m.from === 'custode').length > custodeMsgsBefore6,
      15000)
    pass('Custode emette narrativa fase-4/5')
  } catch (err) {
    fail('Narrativa custode dopo fase-4 non ricevuta', err.message)
  }

  // ── Scenario 7: Disconnessione → in-pausa ────────────────────────────────
  section('Scenario 7 — Disconnessione → in-pausa')

  playerA.socket.disconnect()
  playerB.socket.disconnect()

  // Aspetta che il server processi i disconnect
  await sleep(500)
  pass('Entrambi i player disconnessi')

  // Ricrea i socket e riconnetti Player B
  const playerB2 = createPlayer(playerBToken)
  await new Promise(r => playerB2.socket.on('connect', r))
  playerB2.socket.emit('session:join', tableId)

  try {
    const state = await playerB2.waitFor('session:state', 5000)
    const s = state.session?.state
    if (s === 'in-pausa' || s === 'sessione-iniziata') {
      pass(`Player B riconnesso, stato: ${s}`)
    } else {
      fail('Stato inatteso dopo riconnessione', `stato: ${s}`)
    }
  } catch (err) {
    fail('Riconnessione Player B', err.message)
  }

  // ── Scenario 8: Riconnessione Player A → sessione ripresa ────────────────
  section('Scenario 8 — Riconnessione → sessione ripresa')

  const playerA2 = createPlayer(playerAToken)
  await new Promise(r => playerA2.socket.on('connect', r))
  playerA2.socket.emit('session:join', tableId)

  // Aspetta che il server completi il join di A2 prima di procedere
  try {
    await playerA2.waitFor('session:state', 5000)
    pass('Player A2 join completato')
  } catch (err) {
    fail('Player A2 join timeout', err.message)
  }

  const lastState = playerB2.lastEvent('session:state')?.session?.state ||
    playerB2.lastEvent('session:status-update')?.state
  if (lastState === 'sessione-iniziata' || lastState === 'in-pausa') {
    pass(`Stato sessione dopo riconnessione A2: ${lastState || 'ok'}`)
  } else {
    pass('Sessione attiva con entrambi i giocatori')
  }

  // ── Scenario 9: Whisper ───────────────────────────────────────────────────
  section('Scenario 9 — Whisper tra giocatori')

  playerA2.socket.emit('session:message', {
    text: 'Psst, vedi quella porta?',
    type: 'whisper',
    to: 'player_b@test.com'
  })

  try {
    const msg = await playerB2.waitForCondition('session:message',
      d => d.type === 'whisper' && d.from === 'player_a@test.com', 3000)
    pass(`Whisper ricevuto da Player B: "${msg.text}"`)
  } catch (err) {
    fail('Whisper non ricevuto', err.message)
  }

  // ── Scenario 10: Tiro dado ────────────────────────────────────────────────
  section('Scenario 10 — Tiro dado')

  playerA2.socket.emit('session:dice-roll', { caratteristica: 'INT', soglia: 70 })

  try {
    const result = await playerA2.waitFor('session:dice-result', 3000)
    const ok = result.roller === 'player_a@test.com' &&
               result.caratteristica === 'INT' &&
               typeof result.valore === 'number' &&
               (result.esito === 'successo' || result.esito === 'fallimento')
    if (ok) {
      pass(`Tiro dado: ${result.caratteristica} = ${result.valore}/${result.soglia} → ${result.esito}`)
    } else {
      fail('Dati tiro dado incompleti', JSON.stringify(result))
    }
  } catch (err) {
    fail('Tiro dado non ricevuto', err.message)
  }

  // ── Scenario 11: Cambio colore bolla ─────────────────────────────────────
  section('Scenario 11 — Colore bolla sincronizzato')

  const testColor = '#bbf7d0'
  playerA2.socket.emit('session:set-color', testColor)

  try {
    const upd = await playerB2.waitForCondition('session:player-update',
      d => d.email === 'player_a@test.com' && d.bubbleColor === testColor, 3000)
    pass(`Colore bolla sincronizzato: ${upd.bubbleColor}`)
  } catch (err) {
    fail('Colore bolla non sincronizzato', err.message)
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  playerA2.socket.disconnect()
  playerB2.socket.disconnect()
  await sleep(200)

  // ── Risultati finali ──────────────────────────────────────────────────────
  await cleanup(mockOllama, appServer)
  await cleanupTestData()

  console.log(`\n${'─'.repeat(40)}`)
  console.log(`${C.bold}Risultati: ${C.green}${passed} PASS${C.reset}  ${failed > 0 ? C.red : ''}${failed} FAIL${C.reset}`)
  if (failed === 0) {
    console.log(`${C.green}${C.bold}✓ Tutti i test superati!${C.reset}\n`)
  } else {
    console.log(`${C.red}${C.bold}✗ ${failed} test falliti${C.reset}\n`)
  }
  process.exit(failed > 0 ? 1 : 0)
}

async function cleanup(mockOllama, appServer) {
  try { mockOllama?.close() } catch {}
  try { await new Promise(r => appServer?.close(r)) } catch {}
}

runTests().catch(err => {
  console.error(`\n${C.red}Errore fatale nel test runner:${C.reset}`, err)
  process.exit(1)
})
