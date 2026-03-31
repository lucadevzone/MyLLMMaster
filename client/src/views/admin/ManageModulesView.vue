<script setup>
import { ref, onMounted } from 'vue'
import { api } from '../../utils/api'
import AppHeader from '../../components/AppHeader.vue'

const modules = ref([])
const loading = ref(true)
const error = ref('')

// Form state
const showForm = ref(false)
const editingModule = ref(null)
const formTitle = ref('')
const formMin = ref(1)
const formMax = ref(6)
const formChapters = ref([])
const editingChapterIdx = ref(null)
const chapterTitle = ref('')
const chapterContent = ref('')
const formMsg = ref('')
const formError = ref('')

onMounted(loadModules)

async function loadModules() {
  try {
    modules.value = await api.get('/modules')
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function openNew() {
  editingModule.value = null
  formTitle.value = ''
  formMin.value = 1
  formMax.value = 6
  formChapters.value = []
  editingChapterIdx.value = null
  formMsg.value = ''
  formError.value = ''
  showForm.value = true
}

function openEdit(mod) {
  editingModule.value = mod
  formTitle.value = mod.title
  formMin.value = mod.minPlayers
  formMax.value = mod.maxPlayers
  formChapters.value = mod.chapters.map(c => ({ ...c }))
  editingChapterIdx.value = null
  formMsg.value = ''
  formError.value = ''
  showForm.value = true
}

function addChapter() {
  editingChapterIdx.value = formChapters.value.length
  chapterTitle.value = ''
  chapterContent.value = ''
}

function editChapter(idx) {
  editingChapterIdx.value = idx
  chapterTitle.value = formChapters.value[idx].title
  chapterContent.value = formChapters.value[idx].content
}

function saveChapter() {
  const chapter = {
    chapterNumber: editingChapterIdx.value + 1,
    title: chapterTitle.value,
    content: chapterContent.value
  }
  if (editingChapterIdx.value < formChapters.value.length) {
    formChapters.value[editingChapterIdx.value] = chapter
  } else {
    formChapters.value.push(chapter)
  }
  editingChapterIdx.value = null
  // Renumber
  formChapters.value.forEach((c, i) => { c.chapterNumber = i + 1 })
}

function removeChapter(idx) {
  formChapters.value.splice(idx, 1)
  formChapters.value.forEach((c, i) => { c.chapterNumber = i + 1 })
}

async function saveModule() {
  formMsg.value = ''
  formError.value = ''
  if (!formTitle.value || !formChapters.value.length) {
    formError.value = 'Titolo e almeno un capitolo sono obbligatori'
    return
  }
  const payload = {
    title: formTitle.value,
    minPlayers: formMin.value,
    maxPlayers: formMax.value,
    chapters: formChapters.value
  }
  try {
    if (editingModule.value) {
      await api.put(`/modules/${editingModule.value.id}`, payload)
      formMsg.value = 'Modulo aggiornato'
    } else {
      await api.post('/modules', payload)
      formMsg.value = 'Modulo creato'
    }
    await loadModules()
    showForm.value = false
  } catch (e) {
    formError.value = e.message
  }
}

async function deleteModule(id) {
  if (!confirm('Eliminare il modulo?')) return
  try {
    await api.delete(`/modules/${id}`)
    await loadModules()
  } catch (e) {
    error.value = e.message
  }
}
</script>

<template>
  <div class="page">
    <AppHeader />
    <main class="main-content">
      <div class="container">
        <div class="sub-header">
          <h2>Gestione Moduli Avventura</h2>
          <button class="btn btn-primary" @click="openNew">Nuovo Modulo</button>
        </div>

        <!-- Module Form -->
        <div v-if="showForm" class="card" style="margin-bottom:1.5rem">
          <h3 style="font-size:1rem;font-weight:600;margin-bottom:1rem">
            {{ editingModule ? 'Modifica Modulo' : 'Nuovo Modulo' }}
          </h3>
          <div v-if="formMsg" class="alert alert-success">{{ formMsg }}</div>
          <div v-if="formError" class="alert alert-error">{{ formError }}</div>

          <div class="form-group">
            <label>Titolo</label>
            <input v-model="formTitle" type="text" class="form-control" placeholder="Titolo modulo" required />
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
            <div class="form-group">
              <label>Min Giocatori</label>
              <input v-model.number="formMin" type="number" class="form-control" min="1" max="10" />
            </div>
            <div class="form-group">
              <label>Max Giocatori</label>
              <input v-model.number="formMax" type="number" class="form-control" min="1" max="10" />
            </div>
          </div>

          <!-- Chapters list -->
          <div style="margin-bottom:1rem">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem">
              <label style="font-weight:500">Capitoli</label>
              <button class="btn btn-secondary btn-sm" @click="addChapter">+ Aggiungi Capitolo</button>
            </div>
            <div v-if="formChapters.length === 0" style="color:var(--color-text-light);font-size:0.875rem;padding:0.5rem 0">
              Nessun capitolo aggiunto
            </div>
            <div v-for="(ch, i) in formChapters" :key="i"
              style="display:flex;align-items:center;justify-content:space-between;padding:0.5rem 0.75rem;border:1px solid var(--color-border);border-radius:var(--radius);margin-bottom:0.5rem">
              <span style="font-size:0.875rem">{{ ch.chapterNumber }}. {{ ch.title }}</span>
              <div style="display:flex;gap:0.5rem">
                <button class="btn btn-secondary btn-sm" @click="editChapter(i)">Modifica</button>
                <button class="btn btn-danger btn-sm" @click="removeChapter(i)">Rimuovi</button>
              </div>
            </div>
          </div>

          <!-- Chapter editor -->
          <div v-if="editingChapterIdx !== null" class="card" style="margin-bottom:1rem;background:var(--color-bg)">
            <h4 style="font-size:0.9rem;font-weight:600;margin-bottom:0.75rem">
              {{ editingChapterIdx < formChapters.length ? 'Modifica Capitolo' : 'Nuovo Capitolo' }}
            </h4>
            <div class="form-group">
              <label>Titolo Capitolo</label>
              <input v-model="chapterTitle" type="text" class="form-control" />
            </div>
            <div class="form-group">
              <label>Contenuto (Markdown)</label>
              <textarea v-model="chapterContent" class="form-control" rows="8" style="resize:vertical;font-family:monospace"></textarea>
            </div>
            <div style="display:flex;gap:0.5rem">
              <button class="btn btn-primary btn-sm" @click="saveChapter">Salva Capitolo</button>
              <button class="btn btn-secondary btn-sm" @click="editingChapterIdx = null">Annulla</button>
            </div>
          </div>

          <hr class="divider" />
          <div style="display:flex;gap:0.5rem;justify-content:flex-end">
            <button class="btn btn-secondary" @click="showForm = false">Annulla</button>
            <button class="btn btn-primary" @click="saveModule">Salva</button>
          </div>
        </div>

        <!-- Modules list -->
        <div v-if="loading" class="loading">Caricamento...</div>
        <div v-else-if="error" class="alert alert-error">{{ error }}</div>
        <div v-else-if="modules.length === 0 && !showForm" class="card">
          <p style="color:var(--color-text-light);text-align:center">Nessun modulo avventura creato</p>
        </div>
        <div v-else style="display:flex;flex-direction:column;gap:0.75rem">
          <div v-for="mod in modules" :key="mod.id" class="card"
            style="display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap">
            <div>
              <div style="font-weight:600">{{ mod.title }}</div>
              <div style="font-size:0.8rem;color:var(--color-text-light)">
                {{ mod.minPlayers }}–{{ mod.maxPlayers }} giocatori &bull; {{ mod.chapters.length }} capitoli
              </div>
            </div>
            <div style="display:flex;gap:0.5rem">
              <button class="btn btn-secondary btn-sm" @click="openEdit(mod)">Modifica</button>
              <button class="btn btn-danger btn-sm" @click="deleteModule(mod.id)">Elimina</button>
            </div>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>
