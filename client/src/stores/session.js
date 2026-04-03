import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { io } from 'socket.io-client'
import { useAuthStore } from './auth'

export const useSessionStore = defineStore('session', () => {
  const auth = useAuthStore()

  let socket = null

  const connected = ref(false)
  const session = ref(null)        // { state, players, registroPresenti, ... }
  const messages = ref([])
  const toasts = ref([])           // { id, type, text }
  const diceResult = ref(null)     // ultimo risultato dado
  const diary = ref('')
  const timerMs = ref(null)        // timer avvio sessione
  const custodeTyping = ref(false)        // indicatore di scrittura del Custode
  const custodeThinking = ref(null)       // messaggio "il custode sta pensando..."
  const custodePhase = ref(null)          // fase corrente del Custode

  const myState = computed(() => {
    if (!session.value || !auth.user) return null
    return session.value.players.find(p => p.email === auth.user.email)
  })

  const sessionState = computed(() => session.value?.state || null)

  // ── Connessione ────────────────────────────────────────────────────────────
  function connect(tableId) {
    if (socket) disconnect()

    socket = io(import.meta.env.VITE_SERVER_URL || 'http://localhost:3000', {
      auth: { token: auth.token }
    })

    socket.on('connect', () => {
      connected.value = true
      socket.emit('session:join', tableId)
    })

    socket.on('disconnect', () => {
      connected.value = false
    })

    socket.on('session:state', ({ session: s, messages: msgs, timerMs: ms }) => {
      session.value = s
      messages.value = msgs || []
      if (ms !== undefined) timerMs.value = ms
    })

    socket.on('session:message', (msg) => {
      messages.value.push(msg)
    })

    socket.on('session:player-update', ({ email, connected: isConnected, playerState, voteTardi, bubbleColor }) => {
      if (!session.value) return
      const player = session.value.players.find(p => p.email === email)
      if (!player) return
      if (isConnected !== undefined) player.connected = isConnected
      if (playerState !== undefined) player.playerState = playerState
      if (voteTardi !== undefined) player.voteTardi = voteTardi
      if (bubbleColor !== undefined) player.bubbleColor = bubbleColor
    })

    socket.on('session:status-update', ({ state, timerMs: ms }) => {
      if (session.value) session.value.state = state
      if (ms !== undefined) timerMs.value = ms
      if (state === 'sessione-iniziata') timerMs.value = null
    })

    socket.on('session:dice-result', (result) => {
      diceResult.value = result
      addToast('dice', `${result.rollerName}: ${result.caratteristica} → ${result.valore}/${result.soglia} (${result.esito})`, 4000)
    })

    socket.on('session:toast', ({ type, text }) => {
      addToast(type, text, 3000)
    })

    socket.on('session:diary', (content) => {
      diary.value = content
    })

    socket.on('session:error', (msg) => {
      addToast('error', msg, 5000)
    })

    socket.on('session:custode-typing', (isTyping) => {
      custodeTyping.value = isTyping
      if (!isTyping) custodeThinking.value = null
    })

    socket.on('custode:thinking', ({ message }) => {
      custodeThinking.value = message
      custodeTyping.value = true
    })

    socket.on('session:phase-update', ({ phase }) => {
      custodePhase.value = phase
      if (session.value) session.value.custodePhase = phase
    })
  }

  function disconnect() {
    if (socket) {
      socket.emit('session:leave')
      socket.disconnect()
      socket = null
    }
    connected.value = false
    session.value = null
    messages.value = []
    toasts.value = []
    timerMs.value = null
    custodeTyping.value = false
    custodePhase.value = null
  }

  // ── Azioni ─────────────────────────────────────────────────────────────────
  function sendMessage(text, type = 'normal', to = null) {
    socket?.emit('session:message', { text, type, to })
  }

  function startTyping() {
    socket?.emit('session:typing-start')
  }

  function stopTyping() {
    socket?.emit('session:typing-stop')
  }

  function rollDice(caratteristica, soglia) {
    socket?.emit('session:dice-roll', { caratteristica, soglia })
  }

  function voteTardi() {
    socket?.emit('session:vote-tardi')
  }

  function setColor(color) {
    socket?.emit('session:set-color', color)
  }

  function riprendiCustode() {
    socket?.emit('session:riprendi-custode')
  }

  // ── Toast ──────────────────────────────────────────────────────────────────
  let toastId = 0
  function addToast(type, text, duration = 3000) {
    const id = ++toastId
    toasts.value.push({ id, type, text })
    setTimeout(() => {
      toasts.value = toasts.value.filter(t => t.id !== id)
    }, duration)
  }

  return {
    connected, session, messages, toasts, diceResult, diary, timerMs,
    custodeTyping, custodeThinking, custodePhase,
    myState, sessionState,
    connect, disconnect, sendMessage, rollDice, voteTardi, setColor,
    riprendiCustode, startTyping, stopTyping, addToast
  }
})
