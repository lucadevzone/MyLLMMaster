<script setup>
import { ref, onMounted } from 'vue'
import { api } from '../../utils/api'
import AppHeader from '../../components/AppHeader.vue'

const players = ref([])
const loading = ref(true)
const error = ref('')
const showInviteForm = ref(false)
const inviteEmail = ref('')
const inviteCode = ref('')
const inviteMsg = ref('')
const inviteError = ref('')

const STATE_LABELS = {
  invited: 'Invitato',
  attivo: 'Attivo',
  disabilitato: 'Disabilitato',
  eliminato: 'Eliminato'
}
const STATE_BADGE = {
  invited: 'badge-yellow',
  attivo: 'badge-green',
  disabilitato: 'badge-gray',
  eliminato: 'badge-red'
}

async function loadPlayers() {
  try {
    players.value = await api.get('/users')
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

onMounted(loadPlayers)

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

function openInvite() {
  inviteEmail.value = ''
  inviteCode.value = generateCode()
  inviteMsg.value = ''
  inviteError.value = ''
  showInviteForm.value = true
}

async function invitePlayer() {
  inviteMsg.value = ''
  inviteError.value = ''
  try {
    await api.post('/users/invite', { email: inviteEmail.value, inviteCode: inviteCode.value })
    inviteMsg.value = `Giocatore invitato. Codice: ${inviteCode.value}`
    await loadPlayers()
  } catch (e) {
    inviteError.value = e.message
  }
}

async function deletePlayer(email) {
  if (!confirm(`Eliminare il giocatore ${email}?`)) return
  try {
    await api.delete(`/users/${encodeURIComponent(email)}`)
    await loadPlayers()
  } catch (e) {
    error.value = e.message
  }
}

function formatDate(iso) {
  return iso ? new Date(iso).toLocaleDateString('it-IT') : '—'
}
</script>

<template>
  <div class="page">
    <AppHeader />
    <main class="main-content">
      <div class="container">
        <div class="sub-header">
          <h2>Gestione Giocatori</h2>
          <button class="btn btn-primary" @click="openInvite">Invita Giocatore</button>
        </div>

        <!-- Invite form -->
        <div v-if="showInviteForm" class="card" style="margin-bottom:1.5rem">
          <h3 style="font-size:1rem;font-weight:600;margin-bottom:1rem">Invita nuovo Giocatore</h3>
          <div v-if="inviteMsg" class="alert alert-success">{{ inviteMsg }}</div>
          <div v-if="inviteError" class="alert alert-error">{{ inviteError }}</div>
          <div class="form-group">
            <label>Email</label>
            <input v-model="inviteEmail" type="email" class="form-control" placeholder="giocatore@email.com" />
          </div>
          <div class="form-group">
            <label>Codice di invito</label>
            <input v-model="inviteCode" type="text" class="form-control" readonly style="font-family:monospace;letter-spacing:0.1em" />
          </div>
          <div style="display:flex;gap:0.5rem">
            <button class="btn btn-primary" @click="invitePlayer">Invita</button>
            <button class="btn btn-secondary" @click="showInviteForm = false">Annulla</button>
          </div>
        </div>

        <div v-if="loading" class="loading">Caricamento...</div>
        <div v-else-if="error" class="alert alert-error">{{ error }}</div>
        <div v-else class="card">
          <table class="table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Nome</th>
                <th>Iscritto il</th>
                <th>Stato</th>
                <th>Azioni</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in players" :key="p.email">
                <td>{{ p.email }}</td>
                <td>{{ p.name }}</td>
                <td>{{ formatDate(p.registrationDate) }}</td>
                <td><span :class="['badge', STATE_BADGE[p.accountState]]">{{ STATE_LABELS[p.accountState] }}</span></td>
                <td>
                  <button
                    v-if="p.accountState !== 'eliminato'"
                    class="btn btn-danger btn-sm"
                    @click="deletePlayer(p.email)"
                  >Elimina</button>
                </td>
              </tr>
              <tr v-if="players.length === 0">
                <td colspan="5" style="text-align:center;color:var(--color-text-light)">Nessun giocatore</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </main>
  </div>
</template>
