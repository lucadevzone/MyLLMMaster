<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../utils/api'
import AppHeader from '../components/AppHeader.vue'

const router = useRouter()
const tables = ref([])
const playerNames = ref({})  // email → name
const diaryByTable = ref({})
const openDiaryTableId = ref(null)
const loading = ref(true)
const error = ref('')
let pollInterval = null

const STATE_LABELS = {
  active: 'In attesa dei PG',
  ready: 'Pronto',
  open: 'Aperto',
  playing: 'In gioco',
  disabled: 'Disabilitato',
  archived: 'Archiviato'
}

const STATE_BADGE = {
  active: 'badge-yellow',
  ready: 'badge-blue',
  open: 'badge-green',
  playing: 'badge-green',
  disabled: 'badge-gray',
  archived: 'badge-gray'
}

onMounted(async () => {
  try {
    const [allTables, allModules, names] = await Promise.all([
      api.get('/tables'),
      api.get('/modules'),
      api.get('/users/names')
    ])
    const modMap = Object.fromEntries(allModules.map(m => [m.id, m]))
    tables.value = allTables.map(t => ({ ...t, module: modMap[t.moduleId] }))
    playerNames.value = Object.fromEntries(names.map(n => [n.email, n.name]))

    const diaries = await Promise.all(
      tables.value.map(async (table) => {
        try {
          const result = await api.get(`/session/${table.id}/diary`)
          return [table.id, result.content || '']
        } catch {
          return [table.id, '']
        }
      })
    )
    diaryByTable.value = Object.fromEntries(diaries)
    startPollingIfNeeded()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})

onUnmounted(() => {
  if (pollInterval) clearInterval(pollInterval)
})

function startPollingIfNeeded() {
  if (pollInterval) return
  if (!tables.value.some(t => t.state === 'ready')) return
  pollInterval = setInterval(async () => {
    try {
      const fresh = await api.get('/tables')
      fresh.forEach(ft => {
        const t = tables.value.find(t => t.id === ft.id)
        if (t) t.state = ft.state
      })
      if (!tables.value.some(t => t.state === 'ready')) {
        clearInterval(pollInterval)
        pollInterval = null
      }
    } catch { /* ignora errori di rete */ }
  }, 5000)
}

function goToCharacter(tableId) {
  router.push({ name: 'character', params: { tableId } })
}

function enterSession(tableId) {
  router.push({ name: 'session', params: { tableId } })
}

function hasDiary(tableId) {
  return Boolean(diaryByTable.value[tableId]?.trim())
}

function toggleDiary(tableId) {
  openDiaryTableId.value = openDiaryTableId.value === tableId ? null : tableId
}
</script>

<template>
  <div class="page">
    <AppHeader />
    <main class="main-content">
      <div class="container">
        <div class="sub-header">
          <h2>Lobby</h2>
        </div>

        <div v-if="loading" class="loading">Caricamento...</div>
        <div v-else-if="error" class="alert alert-error">{{ error }}</div>
        <div v-else-if="tables.length === 0" class="card">
          <p style="color:var(--color-text-light);text-align:center">Non sei stato invitato ad alcun tavolo.</p>
        </div>

        <div v-else style="display:flex;flex-direction:column;gap:1rem">
          <div v-for="table in tables" :key="table.id" class="card">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap">
              <div>
                <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.5rem">
                  <h3 style="font-size:1rem;font-weight:600">{{ table.module?.title || table.moduleId }}</h3>
                  <span :class="['badge', STATE_BADGE[table.state]]">{{ STATE_LABELS[table.state] }}</span>
                </div>
                <p style="font-size:0.875rem;color:var(--color-text-light)">
                  Giocatori: {{ table.invitedPlayers.map(e => playerNames[e] || e).join(', ') }}
                </p>
                <p v-if="table.plannedSession" style="font-size:0.875rem;color:var(--color-text-light);margin-top:0.25rem">
                  Prossima sessione: {{ table.plannedSession.date }} {{ table.plannedSession.time }}
                  ({{ table.plannedSession.duration }} min)
                </p>
              </div>
              <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
                <button class="btn btn-secondary btn-sm" @click="goToCharacter(table.id)">
                  Personaggio
                </button>
                <button
                  v-if="hasDiary(table.id)"
                  class="btn btn-secondary btn-sm"
                  @click="toggleDiary(table.id)"
                >
                  {{ openDiaryTableId === table.id ? 'Nascondi Diario' : 'Leggi Diario' }}
                </button>
                <span
                  v-if="table.state === 'ready'"
                  style="font-size:0.8rem;color:var(--color-text-light);font-style:italic"
                >
                  Il Custode sta lavorando all'avventura…
                </span>
                <button
                  v-if="table.state === 'open' || table.state === 'playing'"
                  class="btn btn-success btn-sm"
                  @click="enterSession(table.id)"
                >
                  Entra in Sessione
                </button>
              </div>
            </div>

            <div v-if="openDiaryTableId === table.id" style="margin-top:1rem;padding-top:1rem;border-top:1px solid var(--color-border)">
              <div style="font-size:0.8rem;font-weight:600;color:var(--color-text-light);margin-bottom:0.5rem">Diario</div>
              <div style="white-space:pre-wrap;font-size:0.9rem;line-height:1.5;color:var(--color-text)">
                {{ diaryByTable[table.id] }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>
