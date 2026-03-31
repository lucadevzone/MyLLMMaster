<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { api } from '../utils/api'

const router = useRouter()
const auth = useAuthStore()

const email = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)
const needsPasswordChange = ref(false)
const newPassword = ref('')
const confirmPassword = ref('')

async function login() {
  error.value = ''
  loading.value = true
  try {
    const data = await api.post('/auth/login', { email: email.value, password: password.value })
    auth.setAuth(data.token, data.user)

    if (data.user.accountState === 'invited') {
      needsPasswordChange.value = true
    } else {
      redirect()
    }
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function changePassword() {
  error.value = ''
  if (newPassword.value !== confirmPassword.value) {
    error.value = 'Le password non coincidono'
    return
  }
  loading.value = true
  try {
    const data = await api.post('/auth/change-password', {
      currentPassword: password.value,
      newPassword: newPassword.value
    })
    auth.setAuth(data.token, { ...auth.user, accountState: data.accountState })
    redirect()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function redirect() {
  router.push(auth.user?.role === 'admin' ? { name: 'manage-players' } : { name: 'lobby' })
}
</script>

<template>
  <div class="page" style="align-items:center;justify-content:center;background:var(--color-bg)">
    <div class="card" style="width:100%;max-width:420px">

      <h1 style="font-size:1.5rem;font-weight:700;margin-bottom:0.25rem">LLM Master</h1>
      <p style="color:var(--color-text-light);font-size:0.875rem;margin-bottom:1.5rem">
        {{ needsPasswordChange ? 'Imposta la tua password' : 'Accedi al tuo account' }}
      </p>

      <div v-if="error" class="alert alert-error">{{ error }}</div>

      <form v-if="!needsPasswordChange" @submit.prevent="login">
        <div class="form-group">
          <label>Email</label>
          <input v-model="email" type="email" class="form-control" placeholder="la-tua@email.com" required />
        </div>
        <div class="form-group">
          <label>Password</label>
          <input v-model="password" type="password" class="form-control" placeholder="••••••••" required />
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%" :disabled="loading">
          {{ loading ? 'Accesso...' : 'Accedi' }}
        </button>
      </form>

      <form v-else @submit.prevent="changePassword">
        <div class="alert alert-info">Benvenuto! Imposta una nuova password per attivare il tuo account.</div>
        <div class="form-group">
          <label>Nuova Password</label>
          <input v-model="newPassword" type="password" class="form-control" placeholder="Min. 6 caratteri" required />
        </div>
        <div class="form-group">
          <label>Conferma Password</label>
          <input v-model="confirmPassword" type="password" class="form-control" placeholder="Ripeti la password" required />
        </div>
        <button type="submit" class="btn btn-primary" style="width:100%" :disabled="loading">
          {{ loading ? 'Salvataggio...' : 'Imposta Password' }}
        </button>
      </form>

    </div>
  </div>
</template>
