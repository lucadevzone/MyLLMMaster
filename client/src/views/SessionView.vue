<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useSessionStore } from '../stores/session'
import { api } from '../utils/api'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const sess = useSessionStore()
const tableId = route.params.tableId

// ── Dati locali ───────────────────────────────────────────────────────────────
const myChar = ref(null)
const playerNames = ref({})     // email → name
const activeTab = ref('stats')  // stats | diary | session
const messageInput = ref('')
const myNotes = ref('')
const chatEl = ref(null)
const whisperTarget = ref(null)
const timerDisplay = ref('')
let timerInterval = null

// ── Stato sessione: label e colori ────────────────────────────────────────────
const SESSION_LABELS = {
  'custode-pronto':   { text: 'In attesa del primo giocatore…',              color: '#92400e' },
  'primo-giocatore':  { text: 'Primo giocatore collegato – Aspettiamo 5 minuti', color: '#d97706' },
  'sessione-iniziata':{ text: 'Sessione in corso',                           color: '#16a34a' },
  'in-pausa':         { text: 'Sessione in pausa',                           color: '#6b7280' },
  'in-chiusura':      { text: 'Si è fatto tardi – Sessione in chiusura',     color: '#dc2626' },
  'terminata':        { text: 'Sessione terminata',                          color: '#6b7280' }
}

const statusLabel = computed(() => SESSION_LABELS[sess.sessionState] || { text: '', color: '#374151' })

// ── Stato giocatore: label e stili ────────────────────────────────────────────
const PLAYER_STATE_STYLE = {
  'turno-custode':    { bg: '#f3f4f6', text: 'Il Custode sta parlando' },
  'gioco-libero':     { bg: '#e0f2fe', text: 'Gioco libero' },
  'mio-turno-libero': { bg: '#dcfce7', text: 'È il tuo turno di dichiarare' },
  'mio-turno-prova':  { bg: '#dcfce7', text: null },  // testo dinamico
  'fuori-turno':      { bg: '#fef9c3', text: null },   // testo dinamico
  'fuori-scena':      { bg: '#f3f4f6', text: 'Sei fuori scena – Attendi…' }
}

const playerStatusStyle = computed(() => {
  const s = sess.myState?.playerState || 'turno-custode'
  const style = PLAYER_STATE_STYLE[s] || PLAYER_STATE_STYLE['turno-custode']
  const text = style.text || dynamicStateText(s)
  return { bg: style.bg, text }
})

function dynamicStateText(state) {
  if (state === 'mio-turno-prova') {
    // Il custode metterà la caratteristica nel pianoAzione; per ora generico
    return 'Devi affrontare una prova – Tira il dado!'
  }
  if (state === 'fuori-turno') {
    const active = sess.session?.players?.find(p =>
      p.playerState === 'mio-turno-libero' || p.playerState === 'mio-turno-prova'
    )
    return active ? `Turno di ${playerNames.value[active.email] || active.email}` : 'Attendi il tuo turno'
  }
  return ''
}

// ── Input abilitato/disabilitato ──────────────────────────────────────────────
const canType = computed(() => {
  const s = sess.myState?.playerState
  return s === 'gioco-libero' || s === 'mio-turno-libero'
})

const canDeclare = computed(() => canType.value)

const canRoll = computed(() => sess.myState?.playerState === 'mio-turno-prova')

// ── onMounted ─────────────────────────────────────────────────────────────────
onMounted(async () => {
  try {
    const [char, names] = await Promise.all([
      api.get(`/tables/${tableId}/characters/mine`),
      api.get('/users/names')
    ])
    myChar.value = char
    myNotes.value = char.notes || ''
    playerNames.value = Object.fromEntries(names.map(n => [n.email, n.name]))
  } catch (e) {
    console.warn('Caricamento dati:', e.message)
  }
  sess.connect(tableId)
})

onUnmounted(() => {
  if (timerInterval) clearInterval(timerInterval)
  sess.disconnect()
})

// ── Timer countdown ───────────────────────────────────────────────────────────
watch(() => sess.timerMs, (ms) => {
  if (!ms) return
  if (timerInterval) clearInterval(timerInterval)
  let remaining = ms
  timerInterval = setInterval(() => {
    remaining -= 1000
    if (remaining <= 0) {
      clearInterval(timerInterval)
      timerDisplay.value = ''
    } else {
      const m = Math.floor(remaining / 60000)
      const s = Math.floor((remaining % 60000) / 1000)
      timerDisplay.value = `${m}:${s.toString().padStart(2, '0')}`
    }
  }, 1000)
})

// ── Auto-scroll chat ───────────────────────────────────────────────────────────
watch(() => sess.messages.length, async () => {
  await nextTick()
  if (chatEl.value) chatEl.value.scrollTop = chatEl.value.scrollHeight
})

watch(() => sess.custodeTyping, async () => {
  await nextTick()
  if (chatEl.value) chatEl.value.scrollTop = chatEl.value.scrollHeight
})

// ── Azioni UI ─────────────────────────────────────────────────────────────────
function sendMessage() {
  const text = messageInput.value.trim()
  if (!text) return
  if (whisperTarget.value) {
    sess.sendMessage(text, 'whisper', whisperTarget.value)
    whisperTarget.value = null
  } else {
    sess.sendMessage(text, 'normal')
  }
  messageInput.value = ''
}

function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
}

function rollDice() {
  const prova = sess.session?.pianoAzione?.piano?.find(
    p => p.pg === auth.user.email && p.richiede_prova && !p.risultato_prova
  )
  const caratteristica = prova?.caratteristica || 'Caratteristica'
  const soglia = myChar.value?.characteristics?.[caratteristica] ||
                 myChar.value?.abilita?.comuni?.[caratteristica.toLowerCase()] || 50
  sess.rollDice(caratteristica, soglia)
}

async function saveNotes() {
  try {
    await api.patch(`/session/${tableId}/character/notes`, { notes: myNotes.value })
  } catch (e) {
    console.warn('Salvataggio note:', e.message)
  }
}

function setBubbleColor(color) {
  sess.setColor(color)
}

function leaveSession() {
  router.push({ name: 'lobby' })
}

// ── Colori bolle ──────────────────────────────────────────────────────────────
const BUBBLE_COLORS = ['#bfdbfe','#bbf7d0','#fde68a','#fecaca','#e9d5ff','#fbcfe8','#a7f3d0','#fed7aa']

function bubbleColor(email) {
  const myColor = sess.session?.players?.find(p => p.email === email)?.bubbleColor
  if (myColor) return myColor
  // Fallback deterministico
  let hash = 0
  for (const c of email) hash = (hash * 31 + c.charCodeAt(0)) & 0xffff
  return BUBBLE_COLORS[hash % BUBBLE_COLORS.length]
}

function isMe(email) { return email === auth.user?.email }

function msgBadge(msg) {
  if (msg.type === 'whisper') return { text: 'sussurro', css: 'badge-info' }
  if (msg.toRecover) return { text: 'da recuperare', css: 'badge-yellow' }
  return null
}
</script>

<template>
  <div class="session-page">

    <!-- Toast overlay -->
    <div class="toast-container">
      <transition-group name="toast">
        <div v-for="t in sess.toasts" :key="t.id"
          :class="['toast', `toast-${t.type}`]">
          {{ t.text }}
        </div>
      </transition-group>
    </div>

    <!-- Barra superiore -->
    <div class="session-topbar">
      <div style="flex:1" />
      <div class="session-status-label" :style="{ color: statusLabel.color }">
        {{ statusLabel.text }}
        <span v-if="timerDisplay" style="margin-left:0.5rem;font-variant-numeric:tabular-nums">
          ({{ timerDisplay }})
        </span>
      </div>
      <div style="flex:1;display:flex;justify-content:flex-end">
        <button class="btn btn-secondary btn-sm" @click="leaveSession">← Lobby</button>
      </div>
    </div>

    <!-- Container principale -->
    <div class="session-body">

      <!-- Area sinistra: chat -->
      <div class="session-left">

        <!-- Chat -->
        <div class="chat-area" ref="chatEl">
          <div v-if="sess.messages.length === 0" class="chat-empty">
            La sessione non è ancora iniziata…
          </div>
          <!-- Indicatore di scrittura del Custode -->
          <div v-if="sess.custodeTyping" class="bubble bubble-other bubble-typing">
            <div class="bubble-header">
              <span class="bubble-author">Custode</span>
            </div>
            <div class="typing-dots"><span /><span /><span /></div>
          </div>

          <div v-for="msg in sess.messages" :key="msg.id"
            :class="['bubble', isMe(msg.from) ? 'bubble-me' : 'bubble-other',
                     msg.type === 'whisper' ? 'bubble-whisper' : '']"
            :style="{ '--bubble-color': bubbleColor(msg.from) }">
            <div class="bubble-header">
              <span class="bubble-author">
                {{ msg.from === 'custode' ? 'Custode' : (playerNames[msg.from] || msg.from) }}
              </span>
              <span v-if="msgBadge(msg)" :class="['badge', msgBadge(msg).css]" style="font-size:0.65rem">
                {{ msgBadge(msg).text }}
              </span>
            </div>
            <div class="bubble-text" :style="msg.type === 'whisper' ? 'font-style:italic' : ''">
              {{ msg.text }}
            </div>
          </div>
        </div>

        <!-- Stato giocatore -->
        <div class="player-status-bar" :style="{ background: playerStatusStyle.bg }">
          {{ playerStatusStyle.text }}
        </div>

        <!-- Input area -->
        <div class="input-area">
          <div v-if="whisperTarget" class="whisper-indicator">
            Sussurro a: <strong>{{ playerNames[whisperTarget] || whisperTarget }}</strong>
            <button @click="whisperTarget = null" style="margin-left:0.5rem;cursor:pointer;border:none;background:none;font-size:0.8rem">✕</button>
          </div>
          <textarea
            v-model="messageInput"
            class="chat-input"
            :disabled="!canType"
            placeholder="Cosa fai?"
            rows="2"
            @keydown="onKeydown"
          />
          <div class="input-buttons">
            <button class="btn btn-success" :disabled="!canDeclare" @click="sendMessage">
              Dichiara
            </button>
            <button v-if="canRoll" class="btn btn-primary" @click="rollDice">
              🎲 Tira Dado
            </button>
          </div>
        </div>
      </div>

      <!-- Area destra: tab -->
      <div class="session-right">
        <div class="tab-bar">
          <button :class="['tab-btn', activeTab === 'stats' && 'active']" @click="activeTab = 'stats'">Statistiche</button>
          <button :class="['tab-btn', activeTab === 'diary' && 'active']" @click="activeTab = 'diary'">Diario</button>
          <button :class="['tab-btn', activeTab === 'session' && 'active']" @click="activeTab = 'session'">Sessione</button>
        </div>

        <div class="tab-content">

          <!-- Tab Statistiche -->
          <div v-if="activeTab === 'stats'" class="tab-panel">
            <div v-if="!myChar" style="color:var(--color-text-light);text-align:center;padding:2rem">
              Personaggio non trovato
            </div>
            <template v-else>
              <div style="font-weight:600;margin-bottom:0.75rem">{{ myChar.name }}</div>
              <div style="font-size:0.8rem;color:var(--color-text-light);margin-bottom:1rem">
                {{ myChar.profession }} · {{ myChar.eta }} anni
              </div>

              <div class="stats-grid">
                <div v-for="(val, key) in myChar.characteristics" :key="key" class="stat-cell">
                  <span class="stat-key">{{ key }}</span>
                  <span class="stat-val">{{ val }}</span>
                </div>
                <div class="stat-cell" style="border-color:#fde68a">
                  <span class="stat-key">FORT</span>
                  <span class="stat-val">{{ myChar.Fortuna }}</span>
                </div>
              </div>

              <div class="derived-row">
                <div class="derived-cell"><span>PF</span><strong>{{ myChar.derivedAttributes?.hp?.current }}/{{ myChar.derivedAttributes?.hp?.max }}</strong></div>
                <div class="derived-cell"><span>PM</span><strong>{{ myChar.derivedAttributes?.mp?.current }}/{{ myChar.derivedAttributes?.mp?.max }}</strong></div>
                <div class="derived-cell"><span>SAN</span><strong>{{ myChar.derivedAttributes?.sanita?.current }}</strong></div>
                <div class="derived-cell"><span>MOV</span><strong>{{ myChar.derivedAttributes?.movimento }}</strong></div>
              </div>

              <hr class="divider" />
              <div style="font-size:0.75rem;font-weight:600;color:var(--color-text-light);margin-bottom:0.5rem">ABILITÀ COMUNI</div>
              <div style="display:flex;flex-wrap:wrap;gap:0.3rem;margin-bottom:0.75rem">
                <span v-for="(val, key) in myChar.abilita?.comuni" :key="key"
                  style="font-size:0.75rem;padding:0.15rem 0.5rem;background:var(--color-bg);border:1px solid var(--color-border);border-radius:99px">
                  {{ key }} {{ val }}%
                </span>
              </div>
              <div style="font-size:0.75rem;font-weight:600;color:var(--color-text-light);margin-bottom:0.5rem">ABILITÀ PROFESSIONALI</div>
              <div style="display:flex;flex-wrap:wrap;gap:0.3rem">
                <span v-for="ab in myChar.abilita?.specialistiche" :key="ab.nome"
                  style="font-size:0.75rem;padding:0.15rem 0.5rem;background:rgba(96,165,250,0.1);border:1px solid var(--color-primary);border-radius:99px">
                  {{ ab.nome }} {{ ab.valore }}%
                </span>
              </div>
            </template>
          </div>

          <!-- Tab Diario -->
          <div v-if="activeTab === 'diary'" class="tab-panel" style="display:flex;flex-direction:column;gap:0.75rem;height:100%">
            <div>
              <div style="font-size:0.75rem;font-weight:600;color:var(--color-text-light);margin-bottom:0.4rem">DIARIO DI SESSIONE</div>
              <div class="diary-content">{{ sess.diary || 'Il diario è ancora vuoto.' }}</div>
            </div>
            <div style="flex:1;display:flex;flex-direction:column">
              <div style="font-size:0.75rem;font-weight:600;color:var(--color-text-light);margin-bottom:0.4rem">LE MIE NOTE</div>
              <textarea v-model="myNotes" class="form-control" style="flex:1;resize:none;font-size:0.85rem"
                placeholder="I tuoi appunti personali…" @blur="saveNotes" />
            </div>
          </div>

          <!-- Tab Sessione -->
          <div v-if="activeTab === 'session'" class="tab-panel">
            <div style="font-size:0.75rem;font-weight:600;color:var(--color-text-light);margin-bottom:0.75rem">PRESENTI</div>
            <div style="display:flex;flex-direction:column;gap:0.5rem;margin-bottom:1.5rem">
              <div v-for="p in sess.session?.players" :key="p.email"
                style="display:flex;align-items:center;gap:0.5rem;font-size:0.875rem">
                <span :style="{
                  width:'8px', height:'8px', borderRadius:'50%', display:'inline-block',
                  background: p.connected ? '#4ade80' : '#fca5a5'
                }" />
                <span>{{ playerNames[p.email] || p.email }}</span>
                <span v-if="p.voteTardi" title="Ha votato È tardi" style="font-size:0.7rem">🕐</span>
              </div>
            </div>

            <div style="font-size:0.75rem;font-weight:600;color:var(--color-text-light);margin-bottom:0.75rem">COLORE BOLLE</div>
            <div style="display:flex;flex-wrap:wrap;gap:0.5rem;margin-bottom:1.5rem">
              <button v-for="color in BUBBLE_COLORS" :key="color"
                @click="setBubbleColor(color)"
                :style="{
                  width:'28px', height:'28px', borderRadius:'50%', background: color,
                  border: bubbleColor(auth.user?.email) === color ? '2px solid #374151' : '2px solid transparent',
                  cursor:'pointer'
                }" />
            </div>

            <!-- Controlli admin Custode -->
            <template v-if="auth.user?.role === 'admin'">
              <div style="font-size:0.75rem;font-weight:600;color:var(--color-text-light);margin-bottom:0.5rem;margin-top:1rem">
                CUSTODE
              </div>
              <div v-if="sess.custodePhase" style="font-size:0.8rem;color:var(--color-text-light);margin-bottom:0.5rem">
                Fase: {{ sess.custodePhase }}
              </div>
              <button class="btn btn-primary" style="width:100%;margin-bottom:0.5rem"
                :disabled="sess.sessionState !== 'sessione-iniziata'"
                @click="sess.avviaCustode()">
                Avvia Custode
              </button>
              <button class="btn btn-secondary" style="width:100%;margin-bottom:1rem"
                :disabled="sess.sessionState !== 'in-pausa'"
                @click="sess.riprendiCustode()">
                Riprendi Custode
              </button>
            </template>

            <button class="btn btn-danger" style="width:100%"
              :disabled="sess.myState?.voteTardi"
              @click="sess.voteTardi()">
              {{ sess.myState?.voteTardi ? 'Hai già votato "È tardi"' : '🕐 È Tardi' }}
            </button>
          </div>

        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.session-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-bg);
}

/* Topbar */
.session-topbar {
  display: flex;
  align-items: center;
  padding: 0.6rem 1.5rem;
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
  min-height: 48px;
  flex-shrink: 0;
}

.session-status-label {
  font-weight: 600;
  font-size: 0.9rem;
  text-align: center;
}

/* Body */
.session-body {
  flex: 1;
  display: flex;
  overflow: hidden;
}

/* Sinistra */
.session-left {
  flex: 3;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--color-border);
  overflow: hidden;
}

.chat-area {
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.chat-empty {
  text-align: center;
  color: var(--color-text-light);
  font-size: 0.875rem;
  margin-top: 2rem;
}

/* Bolle */
.bubble {
  max-width: 80%;
  padding: 0.5rem 0.75rem;
  border-radius: 12px;
  background: var(--bubble-color);
  align-self: flex-start;
}

.bubble-me { align-self: flex-end; }

.bubble-whisper { opacity: 0.85; border: 1px dashed #9ca3af; }

.bubble-header {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.2rem;
}

.bubble-author {
  font-size: 0.75rem;
  font-weight: 700;
  color: #374151;
}

.bubble-text { font-size: 0.9rem; color: #1f2937; }

/* Status bar */
.player-status-bar {
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  font-weight: 500;
  text-align: center;
  border-top: 1px solid var(--color-border);
  flex-shrink: 0;
}

/* Input */
.input-area {
  padding: 0.75rem 1rem;
  background: var(--color-surface);
  border-top: 1px solid var(--color-border);
  flex-shrink: 0;
}

.whisper-indicator {
  font-size: 0.8rem;
  color: #6b7280;
  margin-bottom: 0.4rem;
  padding: 0.25rem 0.5rem;
  background: var(--color-info);
  border-radius: var(--radius);
}

.chat-input {
  width: 100%;
  padding: 0.55rem 0.9rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  font-family: var(--font);
  font-size: 0.9rem;
  resize: none;
  background: var(--color-surface);
  color: var(--color-text);
  margin-bottom: 0.5rem;
}

.chat-input:focus { outline: none; border-color: var(--color-primary); }
.chat-input:disabled { background: var(--color-bg); opacity: 0.6; }

.input-buttons { display: flex; gap: 0.5rem; }

/* Destra */
.session-right {
  flex: 2;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tab-bar {
  display: flex;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
  flex-shrink: 0;
}

.tab-btn {
  flex: 1;
  padding: 0.6rem;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 0.85rem;
  color: var(--color-text-light);
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
  font-family: var(--font);
}

.tab-btn.active {
  color: var(--color-text);
  border-bottom-color: var(--color-primary);
  font-weight: 600;
}

.tab-content {
  flex: 1;
  overflow: hidden;
}

.tab-panel {
  height: 100%;
  overflow-y: auto;
  padding: 1rem;
}

/* Stats */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.4rem;
  margin-bottom: 0.75rem;
}

.stat-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0.4rem;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
}

.stat-key { font-size: 0.65rem; font-weight: 700; color: var(--color-text-light); text-transform: uppercase; }
.stat-val { font-size: 1.1rem; font-weight: 700; }

.derived-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.4rem;
  margin-bottom: 0.75rem;
}

.derived-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0.35rem;
  background: var(--color-bg);
  border-radius: var(--radius);
  border: 1px solid var(--color-border);
  font-size: 0.75rem;
  color: var(--color-text-light);
}

/* Diario */
.diary-content {
  font-size: 0.85rem;
  white-space: pre-wrap;
  line-height: 1.6;
  color: var(--color-text);
  background: var(--color-bg);
  padding: 0.75rem;
  border-radius: var(--radius);
  border: 1px solid var(--color-border);
  max-height: 200px;
  overflow-y: auto;
}

/* Toast */
.toast-container {
  position: fixed;
  top: 60px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  pointer-events: none;
}

.toast {
  padding: 0.5rem 1.25rem;
  border-radius: 99px;
  font-size: 0.85rem;
  font-weight: 500;
  background: #1f2937;
  color: white;
  box-shadow: 0 2px 8px rgba(0,0,0,0.2);
  white-space: nowrap;
}

.toast-connect    { background: #16a34a; }
.toast-disconnect { background: #9ca3af; }
.toast-dice       { background: #2563eb; }
.toast-error      { background: #dc2626; }

.toast-enter-active, .toast-leave-active { transition: all 0.3s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(-8px); }

/* Typing indicator */
.bubble-typing { background: #f3f4f6; padding: 0.5rem 0.75rem; }

.typing-dots {
  display: flex;
  gap: 4px;
  align-items: center;
  height: 16px;
}

.typing-dots span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #9ca3af;
  animation: typing-bounce 1.2s infinite ease-in-out;
}

.typing-dots span:nth-child(2) { animation-delay: 0.2s; }
.typing-dots span:nth-child(3) { animation-delay: 0.4s; }

@keyframes typing-bounce {
  0%, 60%, 100% { transform: translateY(0); }
  30% { transform: translateY(-5px); }
}
</style>
