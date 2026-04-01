<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { api } from '../utils/api'
import { rollCharacteristics, calcDerivedAttributes, buildAbilita } from '../utils/coc'
import AppHeader from '../components/AppHeader.vue'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const tableId = route.params.tableId

const professions = ref([])
const existingChar = ref(null)
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const saveMsg = ref('')

// Form fields
const charName = ref('')
const eta = ref(35)
const selectedProfession = ref('')
const background = ref('')

// CoC stats
const characteristics = ref({})
const fortuna = ref(0)
const derived = ref({})
const abilita = ref({ comuni: {}, specialistiche: [] })

const readOnly = computed(() => !!existingChar.value)

const currentProfession = computed(() =>
  professions.value.find(p => p.nome === selectedProfession.value)
)

const STAT_LABELS = {
  FOR: 'Forza', COS: 'Costituzione', DES: 'Destrezza', TAG: 'Taglia',
  INT: 'Intelligenza', POT: 'Potere', APP: 'Apparenza', EDU: 'Educazione'
}

const ABILIA_COMUNI_LABELS = {
  schivare: 'Schivare', rissa: 'Rissa', ascoltare: 'Ascoltare',
  charme: 'Charme', intimidire: 'Intimidire', persuadere: 'Persuadere',
  raggirare: 'Raggirare', osservare: 'Osservare', psicologia: 'Psicologia',
  credito: 'Nota di Credito'
}

onMounted(async () => {
  try {
    professions.value = await api.get('/professions')
    try {
      existingChar.value = await api.get(`/tables/${tableId}/characters/mine`)
      loadFromChar(existingChar.value)
    } catch {
      // No existing character - generate fresh
      rollStats()
    }
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})

function loadFromChar(char) {
  charName.value = char.name
  eta.value = char.eta
  selectedProfession.value = char.profession
  background.value = char.background || ''
  characteristics.value = { ...char.characteristics }
  fortuna.value = char.Fortuna
  derived.value = { ...char.derivedAttributes }
  abilita.value = { ...char.abilita }
}

function rollStats() {
  const result = rollCharacteristics()
  characteristics.value = result.characteristics
  fortuna.value = result.fortuna
  updateDerived()
}

function updateDerived() {
  if (!Object.keys(characteristics.value).length) return
  derived.value = calcDerivedAttributes(characteristics.value)
  if (selectedProfession.value) {
    abilita.value = buildAbilita(characteristics.value, currentProfession.value)
  }
}

function onProfessionChange() {
  if (Object.keys(characteristics.value).length) {
    abilita.value = buildAbilita(characteristics.value, currentProfession.value)
  }
}

async function save() {
  error.value = ''
  saveMsg.value = ''
  if (!charName.value.trim()) { error.value = 'Il nome è obbligatorio'; return }
  if (!selectedProfession.value) { error.value = 'Scegli una professione'; return }
  if (!Object.keys(characteristics.value).length) { error.value = 'Genera le caratteristiche'; return }

  saving.value = true
  try {
    const payload = {
      name: charName.value.trim(),
      eta: Number(eta.value),
      profession: selectedProfession.value,
      background: background.value,
      Fortuna: fortuna.value,
      characteristics: characteristics.value,
      derivedAttributes: derived.value,
      abilita: abilita.value
    }
    await api.post(`/tables/${tableId}/characters`, payload)
    saveMsg.value = 'Personaggio salvato!'
    setTimeout(() => router.push({ name: 'lobby' }), 1200)
  } catch (e) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="page">
    <AppHeader />
    <main class="main-content">
      <div class="container" style="max-width:800px">

        <div class="sub-header">
          <h2>{{ readOnly ? 'Scheda Personaggio' : 'Crea il tuo Personaggio' }}</h2>
          <button class="btn btn-secondary" @click="router.push({ name: 'lobby' })">← Lobby</button>
        </div>

        <div v-if="loading" class="loading">Caricamento...</div>

        <template v-else>
          <div v-if="error" class="alert alert-error">{{ error }}</div>
          <div v-if="saveMsg" class="alert alert-success">{{ saveMsg }}</div>

          <!-- Info base -->
          <div class="card" style="margin-bottom:1rem">
            <h3 class="section-title">Informazioni Base</h3>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
              <div class="form-group" style="margin-bottom:0">
                <label>Nome Personaggio *</label>
                <input v-model="charName" type="text" class="form-control" :disabled="readOnly" placeholder="Nome del PG" />
              </div>
              <div class="form-group" style="margin-bottom:0">
                <label>Età</label>
                <input v-model.number="eta" type="number" class="form-control" :disabled="readOnly" min="20" max="60" />
              </div>
            </div>
            <div class="form-group" style="margin-top:1rem;margin-bottom:0">
              <label>Professione *</label>
              <select v-model="selectedProfession" class="form-control" :disabled="readOnly" @change="onProfessionChange">
                <option value="">Seleziona professione...</option>
                <option v-for="p in professions" :key="p.nome" :value="p.nome">{{ p.nome }}</option>
              </select>
            </div>
          </div>

          <!-- Caratteristiche -->
          <div class="card" style="margin-bottom:1rem">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
              <h3 class="section-title" style="margin-bottom:0">Caratteristiche</h3>
              <button v-if="!readOnly" class="btn btn-secondary btn-sm" @click="rollStats()">
                🎲 Rigenera
              </button>
            </div>

            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:0.75rem;margin-bottom:1rem">
              <div v-for="(val, key) in characteristics" :key="key"
                style="text-align:center;padding:0.75rem;background:var(--color-bg);border-radius:var(--radius);border:1px solid var(--color-border)">
                <div style="font-size:0.75rem;color:var(--color-text-light);font-weight:600;text-transform:uppercase">{{ key }}</div>
                <div style="font-size:1.5rem;font-weight:700;color:var(--color-text)">{{ val }}</div>
                <div style="font-size:0.7rem;color:var(--color-text-light)">{{ STAT_LABELS[key] }}</div>
              </div>
              <div style="text-align:center;padding:0.75rem;background:#fef9c3;border-radius:var(--radius);border:1px solid var(--color-warning)">
                <div style="font-size:0.75rem;color:#92400e;font-weight:600;text-transform:uppercase">FORTUNA</div>
                <div style="font-size:1.5rem;font-weight:700;color:var(--color-text)">{{ fortuna }}</div>
              </div>
            </div>

            <div v-if="Object.keys(derived).length" style="display:grid;grid-template-columns:repeat(4,1fr);gap:0.75rem">
              <div class="derived-box">
                <span class="derived-label">Punti Ferita</span>
                <span class="derived-val">{{ derived.hp?.max }}</span>
              </div>
              <div class="derived-box">
                <span class="derived-label">Punti Magia</span>
                <span class="derived-val">{{ derived.mp?.max }}</span>
              </div>
              <div class="derived-box">
                <span class="derived-label">Sanità</span>
                <span class="derived-val">{{ derived.sanita?.startingValue }}</span>
              </div>
              <div class="derived-box">
                <span class="derived-label">Bonus Danno</span>
                <span class="derived-val">{{ derived.bonusDanno }}</span>
              </div>
              <div class="derived-box">
                <span class="derived-label">Corporatura</span>
                <span class="derived-val">{{ derived.build }}</span>
              </div>
              <div class="derived-box">
                <span class="derived-label">Movimento</span>
                <span class="derived-val">{{ derived.movimento }}</span>
              </div>
            </div>
          </div>

          <!-- Abilità -->
          <div v-if="selectedProfession && Object.keys(abilita.comuni).length" class="card" style="margin-bottom:1rem">
            <h3 class="section-title">Abilità</h3>

            <div style="margin-bottom:0.75rem">
              <div style="font-size:0.8rem;font-weight:600;color:var(--color-text-light);text-transform:uppercase;margin-bottom:0.5rem">Comuni</div>
              <div style="display:flex;flex-wrap:wrap;gap:0.4rem">
                <span v-for="(val, key) in abilita.comuni" :key="key"
                  style="font-size:0.825rem;padding:0.25rem 0.6rem;background:var(--color-bg);border:1px solid var(--color-border);border-radius:99px">
                  {{ ABILIA_COMUNI_LABELS[key] }} <strong>{{ val }}%</strong>
                </span>
              </div>
            </div>

            <div>
              <div style="font-size:0.8rem;font-weight:600;color:var(--color-text-light);text-transform:uppercase;margin-bottom:0.5rem">Professionali ({{ selectedProfession }})</div>
              <div style="display:flex;flex-wrap:wrap;gap:0.4rem">
                <span v-for="ab in abilita.specialistiche" :key="ab.nome"
                  style="font-size:0.825rem;padding:0.25rem 0.6rem;background:rgba(96,165,250,0.1);border:1px solid var(--color-primary);border-radius:99px">
                  {{ ab.nome }} <strong>{{ ab.valore }}%</strong>
                </span>
              </div>
            </div>
          </div>

          <!-- Background -->
          <div class="card" style="margin-bottom:1.5rem">
            <h3 class="section-title">Background</h3>
            <div class="form-group" style="margin-bottom:0">
              <label>Storia personale <span style="color:var(--color-text-light)">(opzionale, max 500 caratteri)</span></label>
              <textarea v-model="background" class="form-control" rows="4" :disabled="readOnly"
                maxlength="500" placeholder="Chi sei? Da dove vieni? Cosa ti ha portato qui?"></textarea>
              <div v-if="!readOnly" style="font-size:0.75rem;color:var(--color-text-light);text-align:right">{{ background.length }}/500</div>
            </div>
          </div>

          <!-- Footer -->
          <div v-if="!readOnly" style="display:flex;gap:0.75rem;justify-content:flex-end">
            <button class="btn btn-secondary" @click="router.push({ name: 'lobby' })">Annulla</button>
            <button class="btn btn-success" :disabled="saving" @click="save">
              {{ saving ? 'Salvataggio...' : 'Entra al Tavolo' }}
            </button>
          </div>
        </template>

      </div>
    </main>
  </div>
</template>

<style scoped>
.section-title {
  font-size: 0.9rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-light);
  margin-bottom: 0.75rem;
}
.derived-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0.5rem;
  background: var(--color-bg);
  border-radius: var(--radius);
  border: 1px solid var(--color-border);
  text-align: center;
}
.derived-label {
  font-size: 0.7rem;
  color: var(--color-text-light);
  font-weight: 600;
}
.derived-val {
  font-size: 1.1rem;
  font-weight: 700;
}
</style>
