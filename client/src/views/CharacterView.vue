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
const table = ref(null)
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const saveMsg = ref('')
const infoMsg = ref('')

// Form fields
const charName = ref('')
const eta = ref(35)
const selectedProfession = ref('')
const background = ref('')
const descrizionePersonale = ref('')
const armiECombattimento = ref([])
const equipaggiamento = ref([])

// CoC stats
const characteristics = ref({})
const fortuna = ref(0)
const derived = ref({})
const abilita = ref({ comuni: {}, specialistiche: [] })

const canCreate = computed(() => table.value?.state === 'active' && !existingChar.value)
const readOnly = computed(() => !!existingChar.value || !canCreate.value)
const pageTitle = computed(() => (readOnly.value ? 'Scheda Personaggio' : 'Crea il tuo Personaggio'))

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
    const [profList, tableData] = await Promise.all([
      api.get('/professions'),
      api.get(`/tables/${tableId}`)
    ])
    professions.value = profList
    table.value = tableData
    try {
      existingChar.value = await api.get(`/tables/${tableId}/characters/mine`)
      loadFromChar(existingChar.value)
    } catch {
      if (table.value?.state === 'active') {
        rollStats()
      } else {
        infoMsg.value = 'La creazione del personaggio è disponibile solo quando il tavolo è in stato attivo.'
      }
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
  descrizionePersonale.value = char.descrizionePersonale || ''
  characteristics.value = { ...char.characteristics }
  fortuna.value = char.Fortuna
  derived.value = { ...char.derivedAttributes }
  abilita.value = { ...char.abilita }
  armiECombattimento.value = (char.armiECombattimento || []).map(arma => ({ ...arma }))
  equipaggiamento.value = (char.equipaggiamento || []).map(item => ({ ...item }))
}

function addWeapon() {
  armiECombattimento.value.push({
    nome: '',
    abilita: '',
    danno: '',
    gittata: '',
    colpi: null,
    malfunzionamento: ''
  })
}

function removeWeapon(index) {
  armiECombattimento.value.splice(index, 1)
}

function addEquipment() {
  equipaggiamento.value.push({
    nome: '',
    quantita: 1,
    descrizione: ''
  })
}

function removeEquipment(index) {
  equipaggiamento.value.splice(index, 1)
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
  if (!canCreate.value) {
    error.value = 'Non puoi creare un personaggio in questo stato del tavolo'
    return
  }
  if (!charName.value.trim()) { error.value = 'Il nome è obbligatorio'; return }
  if (!selectedProfession.value) { error.value = 'Scegli una professione'; return }
  if (!Object.keys(characteristics.value).length) { error.value = 'Genera le caratteristiche'; return }

  saving.value = true
  try {
    const payload = {
      name: charName.value.trim(),
      eta: Number(eta.value),
      profession: selectedProfession.value,
      descrizionePersonale: descrizionePersonale.value,
      background: background.value,
      Fortuna: fortuna.value,
      characteristics: characteristics.value,
      derivedAttributes: derived.value,
      abilita: abilita.value,
      armiECombattimento: armiECombattimento.value
        .filter(arma => arma.nome?.trim() && arma.abilita?.trim() && arma.danno?.trim())
        .map(arma => ({
          nome: arma.nome.trim(),
          abilita: arma.abilita.trim(),
          danno: arma.danno.trim(),
          gittata: arma.gittata?.trim() || '',
          colpi: arma.colpi ? Number(arma.colpi) : null,
          malfunzionamento: arma.malfunzionamento?.trim() || ''
        })),
      equipaggiamento: equipaggiamento.value
        .filter(item => item.nome?.trim())
        .map(item => ({
          nome: item.nome.trim(),
          quantita: Number(item.quantita) || 1,
          descrizione: item.descrizione?.trim() || ''
        }))
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
          <h2>{{ pageTitle }}</h2>
          <button class="btn btn-secondary" @click="router.push({ name: 'lobby' })">← Lobby</button>
        </div>

        <div v-if="loading" class="loading">Caricamento...</div>

        <template v-else>
          <div v-if="error" class="alert alert-error">{{ error }}</div>
          <div v-if="saveMsg" class="alert alert-success">{{ saveMsg }}</div>
          <div v-if="infoMsg" class="alert alert-success">{{ infoMsg }}</div>

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
              <button v-if="canCreate" class="btn btn-secondary btn-sm" @click="rollStats()">
                🎲 Rigenera
              </button>
            </div>

            <div v-if="Object.keys(characteristics).length" style="display:grid;grid-template-columns:repeat(3,1fr);gap:0.75rem;margin-bottom:1rem">
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
            <div v-else style="color:var(--color-text-light);font-size:0.9rem">
              Nessuna scheda disponibile da mostrare in questo momento.
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

          <!-- Armi e combattimento -->
          <div class="card" style="margin-bottom:1rem">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
              <h3 class="section-title" style="margin-bottom:0">Armi e Combattimento</h3>
              <button v-if="canCreate" class="btn btn-secondary btn-sm" @click="addWeapon">+ Aggiungi Arma</button>
            </div>

            <div v-if="armiECombattimento.length === 0" style="color:var(--color-text-light);font-size:0.9rem">
              Nessuna arma inserita.
            </div>

            <div v-for="(arma, index) in armiECombattimento" :key="index" class="card" style="margin-bottom:0.75rem;background:var(--color-bg)">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem">
                <div style="font-size:0.8rem;font-weight:600;color:var(--color-text-light)">Arma {{ index + 1 }}</div>
                <button v-if="canCreate" class="btn btn-danger btn-sm" @click="removeWeapon(index)">Rimuovi</button>
              </div>

              <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.75rem;margin-bottom:0.75rem">
                <input v-model="arma.nome" class="form-control" :disabled="readOnly" placeholder="Nome arma" />
                <input v-model="arma.abilita" class="form-control" :disabled="readOnly" placeholder="Abilità associata" />
                <input v-model="arma.danno" class="form-control" :disabled="readOnly" placeholder="Danno" />
              </div>

              <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.75rem">
                <input v-model="arma.gittata" class="form-control" :disabled="readOnly" placeholder="Gittata" />
                <input v-model.number="arma.colpi" type="number" class="form-control" :disabled="readOnly" min="0" placeholder="Colpi" />
                <input v-model="arma.malfunzionamento" class="form-control" :disabled="readOnly" placeholder="Malfunzionamento" />
              </div>
            </div>
          </div>

          <!-- Equipaggiamento -->
          <div class="card" style="margin-bottom:1rem">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
              <h3 class="section-title" style="margin-bottom:0">Equipaggiamento</h3>
              <button v-if="canCreate" class="btn btn-secondary btn-sm" @click="addEquipment">+ Aggiungi Oggetto</button>
            </div>

            <div v-if="equipaggiamento.length === 0" style="color:var(--color-text-light);font-size:0.9rem">
              Nessun oggetto inserito.
            </div>

            <div v-for="(item, index) in equipaggiamento" :key="index" class="card" style="margin-bottom:0.75rem;background:var(--color-bg)">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem">
                <div style="font-size:0.8rem;font-weight:600;color:var(--color-text-light)">Oggetto {{ index + 1 }}</div>
                <button v-if="canCreate" class="btn btn-danger btn-sm" @click="removeEquipment(index)">Rimuovi</button>
              </div>

              <div style="display:grid;grid-template-columns:2fr 1fr;gap:0.75rem;margin-bottom:0.75rem">
                <input v-model="item.nome" class="form-control" :disabled="readOnly" placeholder="Nome oggetto" />
                <input v-model.number="item.quantita" type="number" class="form-control" :disabled="readOnly" min="1" placeholder="Quantità" />
              </div>

              <textarea
                v-model="item.descrizione"
                class="form-control"
                rows="2"
                :disabled="readOnly"
                placeholder="Descrizione opzionale"
              />
            </div>
          </div>

          <!-- Descrizione Personale -->
          <div class="card" style="margin-bottom:1rem">
            <h3 class="section-title">Aspetto Fisico</h3>
            <div class="form-group" style="margin-bottom:0">
              <label>Descrizione fisica <span style="color:var(--color-text-light)">(opzionale, max 300 caratteri)</span></label>
              <textarea v-model="descrizionePersonale" class="form-control" rows="3" :disabled="readOnly"
                maxlength="300" placeholder="Età apparente, corporatura, capelli, abbigliamento…"></textarea>
              <div v-if="canCreate" style="font-size:0.75rem;color:var(--color-text-light);text-align:right">{{ descrizionePersonale.length }}/300</div>
            </div>
          </div>

          <!-- Background -->
          <div class="card" style="margin-bottom:1.5rem">
            <h3 class="section-title">Background</h3>
            <div class="form-group" style="margin-bottom:0">
              <label>Storia personale <span style="color:var(--color-text-light)">(opzionale, max 500 caratteri)</span></label>
              <textarea v-model="background" class="form-control" rows="4" :disabled="readOnly"
                maxlength="500" placeholder="Chi sei? Da dove vieni? Cosa ti ha portato qui?"></textarea>
              <div v-if="canCreate" style="font-size:0.75rem;color:var(--color-text-light);text-align:right">{{ background.length }}/500</div>
            </div>
          </div>

          <!-- Footer -->
          <div v-if="canCreate" style="display:flex;gap:0.75rem;justify-content:flex-end">
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
