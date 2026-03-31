<script setup>
import { RouterLink, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()

function logout() {
  auth.logout()
  router.push({ name: 'login' })
}
</script>

<template>
  <header class="app-header">
    <div class="container header-inner">
      <span class="brand">LLM Master</span>

      <nav>
        <template v-if="auth.user?.role === 'player'">
          <RouterLink to="/lobby">Lobby</RouterLink>
          <RouterLink to="/profile">Profilo</RouterLink>
        </template>
        <template v-if="auth.user?.role === 'admin'">
          <RouterLink to="/admin/players">Giocatori</RouterLink>
          <RouterLink to="/admin/modules">Moduli</RouterLink>
          <RouterLink to="/admin/tables">Tavoli</RouterLink>
          <RouterLink to="/profile">Profilo</RouterLink>
        </template>
      </nav>

      <div style="display:flex;align-items:center;gap:0.75rem">
        <span class="user-info">{{ auth.user?.name }}</span>
        <button class="btn btn-secondary btn-sm" @click="logout">Esci</button>
      </div>
    </div>
  </header>
</template>
