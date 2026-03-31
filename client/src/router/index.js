import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/login', name: 'login', component: () => import('../views/LoginView.vue'), meta: { public: true } },
    { path: '/', redirect: '/lobby' },
    { path: '/lobby', name: 'lobby', component: () => import('../views/LobbyView.vue'), meta: { roles: ['player'] } },
    { path: '/session/:tableId', name: 'session', component: () => import('../views/SessionView.vue'), meta: { roles: ['player'] } },
    { path: '/table/:tableId/character', name: 'character', component: () => import('../views/CharacterView.vue'), meta: { roles: ['player'] } },
    { path: '/profile', name: 'profile', component: () => import('../views/ProfileView.vue'), meta: { roles: ['player', 'admin'] } },
    { path: '/admin/players', name: 'manage-players', component: () => import('../views/admin/ManagePlayersView.vue'), meta: { roles: ['admin'] } },
    { path: '/admin/modules', name: 'manage-modules', component: () => import('../views/admin/ManageModulesView.vue'), meta: { roles: ['admin'] } },
    { path: '/admin/tables', name: 'manage-tables', component: () => import('../views/admin/ManageTablesView.vue'), meta: { roles: ['admin'] } }
  ]
})

router.beforeEach((to) => {
  const auth = useAuthStore()
  if (!to.meta.public && !auth.isLoggedIn) return { name: 'login' }
  if (to.meta.roles && !to.meta.roles.includes(auth.user?.role)) {
    return auth.user?.role === 'admin' ? { name: 'manage-players' } : { name: 'lobby' }
  }
})

export default router
