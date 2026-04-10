import { useAuthStore } from '../stores/auth'

const BASE_URL = import.meta.env.VITE_API_URL || '/api'

async function request(method, path, body) {
  const auth = useAuthStore()
  const headers = { 'Content-Type': 'application/json' }
  if (auth.token) headers['Authorization'] = `Bearer ${auth.token}`

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Errore ${res.status}`)
  return data
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  patch: (path, body) => request('PATCH', path, body),
  delete: (path) => request('DELETE', path)
}
