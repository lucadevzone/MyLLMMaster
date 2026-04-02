<script setup>
import { ref, onMounted } from 'vue'
import { api } from '../../utils/api'
import AppHeader from '../../components/AppHeader.vue'

const tables = ref([])
const modules = ref([])
const players = ref([])
const playerNames = ref({})  // email → name
const ollamaModels = ref([])
const loading = ref(true)
const error = ref('')
const actionMsg = ref('')

const showCreateForm = ref(false)
const createModuleId = ref('')
const createPlayers = ref([])
const createHeavyModel = ref('')
const createLightModel = ref('')
const createError = ref('')

const showSessionPlan = ref(null)  // tableId
const planDate = ref('')
const planTime = ref('')
const planDuration = ref(180)

const STATE_LABELS = {
  active: 'In attesa PG',
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
const SESSION_STATE_LABELS = {
  'custode-pronto': 'Custode pronto',
  'primo-giocatore': 'Primo giocatore',
  'sessione-iniziata': 'Sessione in corso',
  'player-paused': 'Pausa player',
  'technical-pause': 'Pausa tecnica',
  'in-chiusura': 'In chiusura',
  'terminata': 'Terminata'
}
const SESSION_STATE_BADGE = {
  'custode-pronto': 'badge-gray',
  'primo-giocatore': 'badge-yellow',
  'sessione-iniziata': 'badge-green',
  'player-paused': 'badge-gray',
  'technical-pause': 'badge-red',
  'in-chiusura': 'badge-yellow',
  'terminata': 'badge-gray'
}
const PLAYER_BADGE = {
  invited: 'badge-yellow',
  attivo: 'badge-green',
  disabilitato: 'badge-red',
  eliminato: 'badge-red'
}

onMounted(async () => {
  try {
    const [t, m, p, names, om] = await Promise.all([
      api.get('/tables'),
      api.get('/modules'),
      api.get('/users'),
      api.get('/users/names'),
      api.get('/tables/ollama-models').catch(() => [])
    ])
    tables.value = t.filter(t => t.state !== 'archived')
    modules.value = m
    players.value = p.filter(p => p.accountState === 'attivo')
    playerNames.value = Object.fromEntries(names.map(n => [n.email, n.name]))
    ollamaModels.value = om
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})

function getModule(moduleId) {
  return modules.value.find(m => m.id === moduleId)
}

function getPlayerState(email) {
  return players.value.find(p => p.email === email)?.accountState || 'invited'
}

async function createTable() {
  createError.value = ''
  if (!createModuleId.value || !createPlayers.value.length || !createHeavyModel.value) {
    createError.value = 'Modulo, giocatori e modello LLM sono obbligatori'
    return
  }
  try {
    const t = await api.post('/tables', {
      moduleId: createModuleId.value,
      invitedPlayers: createPlayers.value,
      heavyLlmModel: createHeavyModel.value,
      lightLlmModel: createLightModel.value || undefined
    })
    tables.value.push(t)
    showCreateForm.value = false
    createModuleId.value = ''
    createPlayers.value = []
    createHeavyModel.value = ''
    createLightModel.value = ''
  } catch (e) {
    createError.value = e.message
  }
}

async function resetTable(tableId) {
  if (!confirm('Reset tavolo? Verranno cancellate sessione, scene e diario. I personaggi vengono mantenuti.')) return
  try {
    const updated = await api.post(`/tables/${tableId}/reset`, {})
    const idx = tables.value.findIndex(t => t.id === tableId)
    if (idx !== -1) tables.value[idx] = updated.table
    actionMsg.value = 'Tavolo resettato'
  } catch (e) {
    error.value = e.message
  }
}

async function archiveTable(tableId) {
  if (!confirm('Archiviare il tavolo?')) return
  try {
    await api.delete(`/tables/${tableId}`)
    tables.value = tables.value.filter(t => t.id !== tableId)
  } catch (e) {
    error.value = e.message
  }
}

async function resumeCustode(tableId) {
  try {
    const result = await api.post(`/tables/${tableId}/resume-custode`, {})
    const idx = tables.value.findIndex(t => t.id === tableId)
    if (idx !== -1) tables.value[idx] = result.table
    actionMsg.value = 'Custode ripreso'
  } catch (e) {
    error.value = e.message
  }
}

async function clearAllTables() {
  if (!confirm('ATTENZIONE: Eliminare TUTTI i tavoli? (funzione playtest)')) return
  try {
    await api.delete('/tables')
    tables.value = []
    actionMsg.value = 'Tutti i tavoli eliminati'
  } catch (e) {
    error.value = e.message
  }
}

function openPlanSession(tableId) {
  showSessionPlan.value = tableId
  planDate.value = ''
  planTime.value = ''
  planDuration.value = 180
}

async function savePlanSession(tableId) {
  try {
    const updated = await api.patch(`/tables/${tableId}`, {
      plannedSession: { date: planDate.value, time: planTime.value, duration: planDuration.value }
    })
    const idx = tables.value.findIndex(t => t.id === tableId)
    if (idx !== -1) tables.value[idx] = updated
    showSessionPlan.value = null
  } catch (e) {
    error.value = e.message
  }
}

function togglePlayer(email) {
  const idx = createPlayers.value.indexOf(email)
  if (idx === -1) createPlayers.value.push(email)
  else createPlayers.value.splice(idx, 1)
}
</script>

<template>
  <div class="page">
    <AppHeader />
    <main class="main-content">
      <div class="container">
        <div class="sub-header">
          <h2>Gestione Tavoli</h2>
          <div style="display:flex;gap:0.5rem">
            <button class="btn btn-primary" @click="showCreateForm = !showCreateForm">Crea Tavolo</button>
            <button class="btn btn-danger btn-sm" @click="clearAllTables">Clear All Tables</button>
          </div>
        </div>

        <div v-if="actionMsg" class="alert alert-success" style="margin-bottom:1rem">{{ actionMsg }}</div>
        <div v-if="error" class="alert alert-error" style="margin-bottom:1rem">{{ error }}</div>

        <!-- Create form -->
        <div v-if="showCreateForm" class="card" style="margin-bottom:1.5rem">
          <h3 style="font-size:1rem;font-weight:600;margin-bottom:1rem">Crea Nuovo Tavolo</h3>
          <div v-if="createError" class="alert alert-error">{{ createError }}</div>

          <div class="form-group">
            <label>Modulo Avventura</label>
            <select v-model="createModuleId" class="form-control">
              <option value="">Seleziona modulo...</option>
              <option v-for="m in modules" :key="m.id" :value="m.id">{{ m.title }}</option>
            </select>
          </div>

          <div class="form-group">
            <label>Giocatori (solo account attivi)</label>
            <div style="display:flex;flex-wrap:wrap;gap:0.5rem;padding:0.5rem 0">
              <label v-for="p in players" :key="p.email"
                style="display:flex;align-items:center;gap:0.4rem;cursor:pointer;font-size:0.875rem;padding:0.3rem 0.6rem;border:1px solid var(--color-border);border-radius:var(--radius);background:var(--color-bg)"
                :style="createPlayers.includes(p.email) ? 'border-color:var(--color-primary);background:rgba(96,165,250,0.1)' : ''">
                <input type="checkbox" :checked="createPlayers.includes(p.email)" @change="togglePlayer(p.email)" />
                {{ p.name }} ({{ p.email }})
              </label>
            </div>
          </div>

          <div class="form-group">
            <label>Modello LLM (pesante)</label>
            <select v-model="createHeavyModel" class="form-control">
              <option value="">Seleziona modello...</option>
              <option v-for="m in ollamaModels" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>

          <div class="form-group">
            <label>Modello LLM (leggero, opzionale)</label>
            <select v-model="createLightModel" class="form-control">
              <option value="">Nessuno</option>
              <option v-for="m in ollamaModels" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>

          <div style="display:flex;gap:0.5rem;justify-content:flex-end">
            <button class="btn btn-secondary" @click="showCreateForm = false">Annulla</button>
            <button class="btn btn-primary" @click="createTable">Crea Tavolo</button>
          </div>
        </div>

        <div v-if="loading" class="loading">Caricamento...</div>
        <div v-else-if="tables.length === 0 && !showCreateForm" class="card">
          <p style="text-align:center;color:var(--color-text-light)">Nessun tavolo attivo</p>
        </div>

        <div style="display:flex;flex-direction:column;gap:1rem">
          <div v-for="table in tables" :key="table.id" class="card">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap">
              <div style="flex:1">
                <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.5rem;flex-wrap:wrap">
                  <span style="font-weight:600">{{ getModule(table.moduleId)?.title || table.moduleId }}</span>
                  <span :class="['badge', STATE_BADGE[table.state]]">{{ STATE_LABELS[table.state] }}</span>
                  <span v-if="table.sessionState" :class="['badge', SESSION_STATE_BADGE[table.sessionState] || 'badge-gray']">
                    {{ SESSION_STATE_LABELS[table.sessionState] || table.sessionState }}
                  </span>
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:0.4rem;margin-bottom:0.5rem">
                  <span v-for="email in table.invitedPlayers" :key="email"
                    :class="['badge', 'badge-sm', PLAYER_BADGE[getPlayerState(email)] || 'badge-yellow']"
                    style="font-size:0.7rem" :title="email">
                    {{ playerNames[email] || email }}
                  </span>
                </div>
                <div v-if="table.plannedSession" style="font-size:0.8rem;color:var(--color-text-light)">
                  Prossima sessione: {{ table.plannedSession.date }} {{ table.plannedSession.time }}
                  ({{ table.plannedSession.duration }} min)
                </div>
                <div v-if="table.custodePhase" style="font-size:0.8rem;color:var(--color-text-light);margin-top:0.25rem">
                  Fase Custode: {{ table.custodePhase }}
                </div>
              </div>
              <div style="display:flex;flex-direction:column;gap:0.4rem;align-items:flex-end">
                <button v-if="table.state === 'ready'" class="btn btn-primary btn-sm" @click="openPlanSession(table.id)">
                  Pianifica Sessione
                </button>
                <button v-if="table.sessionState === 'technical-pause'" class="btn btn-secondary btn-sm" @click="resumeCustode(table.id)">
                  Riprendi Custode
                </button>
                <button class="btn btn-warning btn-sm" @click="resetTable(table.id)" title="Cancella sessione e scene, mantieni i PG">Reset</button>
                <button class="btn btn-danger btn-sm" @click="archiveTable(table.id)">Archivia</button>
              </div>
            </div>

            <!-- Session planner inline -->
            <div v-if="showSessionPlan === table.id" style="margin-top:1rem;padding-top:1rem;border-top:1px solid var(--color-border)">
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem;margin-bottom:0.75rem">
                <div class="form-group" style="margin-bottom:0">
                  <label>Data</label>
                  <input v-model="planDate" type="date" class="form-control" />
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label>Orario</label>
                  <input v-model="planTime" type="time" class="form-control" />
                </div>
                <div class="form-group" style="margin-bottom:0">
                  <label>Durata (min)</label>
                  <input v-model.number="planDuration" type="number" class="form-control" min="30" />
                </div>
              </div>
              <div style="display:flex;gap:0.5rem">
                <button class="btn btn-primary btn-sm" @click="savePlanSession(table.id)">Salva</button>
                <button class="btn btn-secondary btn-sm" @click="showSessionPlan = null">Annulla</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>
