<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../utils/api'
import AppHeader from '../components/AppHeader.vue'

const router = useRouter()
const tables = ref([])
const loading = ref(true)
const error = ref('')

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
    const [allTables, allModules] = await Promise.all([
      api.get('/tables'),
      api.get('/modules')
    ])
    const modMap = Object.fromEntries(allModules.map(m => [m.id, m]))
    tables.value = allTables.map(t => ({ ...t, module: modMap[t.moduleId] }))
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})

async function getMyCharacter(tableId) {
  try {
    return await api.get(`/tables/${tableId}/characters/mine`)
  } catch {
    return null
  }
}

async function goToCharacter(table) {
  const char = await getMyCharacter(table.id)
  router.push({ name: 'character', params: { tableId: table.id }, query: char ? { edit: '1' } : {} })
}

function enterSession(tableId) {
  router.push({ name: 'session', params: { tableId } })
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
                  Giocatori: {{ table.invitedPlayers.join(', ') }}
                </p>
                <p v-if="table.plannedSession" style="font-size:0.875rem;color:var(--color-text-light);margin-top:0.25rem">
                  Prossima sessione: {{ table.plannedSession.date }} {{ table.plannedSession.time }}
                  ({{ table.plannedSession.duration }} min)
                </p>
              </div>
              <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
                <button class="btn btn-secondary btn-sm" @click="goToCharacter(table)">
                  Personaggio
                </button>
                <button
                  v-if="table.state === 'open' || table.state === 'playing'"
                  class="btn btn-success btn-sm"
                  @click="enterSession(table.id)"
                >
                  Entra in Sessione
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>
