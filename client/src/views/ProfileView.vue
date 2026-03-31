<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { api } from '../utils/api'
import AppHeader from '../components/AppHeader.vue'

const auth = useAuthStore()
const router = useRouter()

const newName = ref(auth.user?.name || '')
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')

const nameMsg = ref('')
const nameError = ref('')
const pwMsg = ref('')
const pwError = ref('')
const deleteError = ref('')

const ACCOUNT_STATE_LABELS = {
  invited: { label: 'Invitato', css: 'badge-yellow' },
  attivo: { label: 'Attivo', css: 'badge-green' },
  disabilitato: { label: 'Disabilitato', css: 'badge-gray' },
  eliminato: { label: 'Eliminato', css: 'badge-red' }
}

async function saveName() {
  nameMsg.value = ''
  nameError.value = ''
  try {
    await api.patch('/users/me/name', { name: newName.value })
    auth.updateUser({ name: newName.value })
    nameMsg.value = 'Nome aggiornato'
  } catch (e) {
    nameError.value = e.message
  }
}

async function updatePassword() {
  pwMsg.value = ''
  pwError.value = ''
  if (newPassword.value !== confirmPassword.value) {
    pwError.value = 'Le password non coincidono'
    return
  }
  try {
    const data = await api.post('/auth/change-password', {
      currentPassword: currentPassword.value,
      newPassword: newPassword.value
    })
    auth.setAuth(data.token, auth.user)
    pwMsg.value = 'Password aggiornata'
    currentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
  } catch (e) {
    pwError.value = e.message
  }
}

async function deleteAccount() {
  if (!confirm('Sei sicuro di voler eliminare il tuo account? Questa azione è irreversibile.')) return
  deleteError.value = ''
  try {
    await api.delete('/users/me')
    auth.logout()
    router.push({ name: 'login' })
  } catch (e) {
    deleteError.value = e.message
  }
}

const state = ACCOUNT_STATE_LABELS[auth.user?.accountState] || { label: auth.user?.accountState, css: 'badge-gray' }
</script>

<template>
  <div class="page">
    <AppHeader />
    <main class="main-content">
      <div class="container" style="max-width:640px">
        <h1 style="font-size:1.5rem;font-weight:700;margin-bottom:1.5rem">Il mio Profilo</h1>

        <!-- Info -->
        <div class="card" style="margin-bottom:1.5rem">
          <div style="display:flex;flex-direction:column;gap:0.5rem">
            <div><strong>Nome:</strong> {{ auth.user?.name }}</div>
            <div><strong>Email:</strong> {{ auth.user?.email }}</div>
            <div style="display:flex;align-items:center;gap:0.5rem">
              <strong>Ruolo:</strong>
              <span :class="['badge', auth.user?.role === 'admin' ? 'badge-blue' : 'badge-green']">
                {{ auth.user?.role === 'admin' ? 'Admin' : 'Player' }}
              </span>
            </div>
            <div style="display:flex;align-items:center;gap:0.5rem">
              <strong>Stato:</strong>
              <span :class="['badge', state.css]">{{ state.label }}</span>
            </div>
          </div>
        </div>

        <!-- Cambia Nome -->
        <div class="card" style="margin-bottom:1.5rem">
          <h2 style="font-size:1rem;font-weight:600;margin-bottom:1rem">Cambia Nome</h2>
          <div v-if="nameMsg" class="alert alert-success">{{ nameMsg }}</div>
          <div v-if="nameError" class="alert alert-error">{{ nameError }}</div>
          <div class="form-group">
            <label>Nome visualizzato</label>
            <input v-model="newName" type="text" class="form-control" />
          </div>
          <button class="btn btn-primary" @click="saveName">Salva</button>
        </div>

        <!-- Cambia Password -->
        <div class="card" style="margin-bottom:1.5rem">
          <h2 style="font-size:1rem;font-weight:600;margin-bottom:1rem">Cambia Password</h2>
          <div v-if="pwMsg" class="alert alert-success">{{ pwMsg }}</div>
          <div v-if="pwError" class="alert alert-error">{{ pwError }}</div>
          <div class="form-group">
            <label>Password attuale</label>
            <input v-model="currentPassword" type="password" class="form-control" />
          </div>
          <div class="form-group">
            <label>Nuova password</label>
            <input v-model="newPassword" type="password" class="form-control" />
          </div>
          <div class="form-group">
            <label>Conferma nuova password</label>
            <input v-model="confirmPassword" type="password" class="form-control" />
          </div>
          <button class="btn btn-primary" @click="updatePassword">Aggiorna Password</button>
        </div>

        <!-- Elimina Account (solo player) -->
        <div v-if="auth.user?.role !== 'admin'" class="card">
          <h2 style="font-size:1rem;font-weight:600;margin-bottom:0.75rem;color:#991b1b">Elimina Account</h2>
          <p style="font-size:0.875rem;color:var(--color-text-light);margin-bottom:1rem">
            Eliminando il tuo account non potrai più accedere alla piattaforma. Questa azione è irreversibile.
          </p>
          <div v-if="deleteError" class="alert alert-error">{{ deleteError }}</div>
          <button class="btn btn-danger" @click="deleteAccount">Elimina Account</button>
        </div>

      </div>
    </main>
  </div>
</template>
