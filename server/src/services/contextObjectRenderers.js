const fs = require('fs')
const path = require('path')

function normalizeText(value) {
  return String(value || '').trim()
}

function normalizeLooseIdList(values) {
  const rawValues = Array.isArray(values) ? values : [values]
  return rawValues
    .flatMap(value => String(value || '').split(','))
    .map(value => normalizeText(value).replace(/^"+|"+$/g, ''))
    .filter(Boolean)
}

function sentence(text) {
  const value = normalizeText(text)
  if (!value) return ''
  return /[.!?]$/.test(value) ? value : `${value}.`
}

function joinNarrative(parts) {
  return parts.map(sentence).filter(Boolean).join(' ')
}

const RULES_SKILLS_PATH = path.join(__dirname, '../../../rules/abilita.json')
const RULES_CHARACTERISTICS_PATH = path.join(__dirname, '../../../rules/caratteristiche_e_derivat.json')
let cachedSkillsRules = null
let cachedCharacteristicsRules = null

function loadSkillsRules() {
  if (cachedSkillsRules) return cachedSkillsRules
  try {
    const payload = JSON.parse(fs.readFileSync(RULES_SKILLS_PATH, 'utf8'))
    cachedSkillsRules = Array.isArray(payload?.abilita) ? payload.abilita : []
  } catch {
    cachedSkillsRules = []
  }
  return cachedSkillsRules
}

function loadCharacteristicsRules() {
  if (cachedCharacteristicsRules) return cachedCharacteristicsRules
  try {
    const payload = JSON.parse(fs.readFileSync(RULES_CHARACTERISTICS_PATH, 'utf8'))
    cachedCharacteristicsRules = Array.isArray(payload?.caratteristiche_e_derivati)
      ? payload.caratteristiche_e_derivati
      : []
  } catch {
    cachedCharacteristicsRules = []
  }
  return cachedCharacteristicsRules
}

function normalizeSkillKey(value) {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function resolveSkillRule(skillName = '') {
  const wanted = normalizeSkillKey(skillName)
  if (!wanted) return null
  const all = loadSkillsRules()
  const direct = all.find(entry => normalizeSkillKey(entry?.nome) === wanted)
  if (direct) return direct

  const aliases = new Map([
    ['biblioteca', 'biblioteconomia'],
    ['osservare', 'individuare'],
    ['rissa', 'combattere'],
    ['charme', 'ammaliare'],
    ['credito', 'valore di credito']
  ])
  const canonical = aliases.get(wanted)
  if (!canonical) return null
  return all.find(entry => normalizeSkillKey(entry?.nome) === canonical) || null
}

function resolveCharacteristicRule(name = '') {
  const wanted = normalizeSkillKey(name)
  if (!wanted) return null
  const all = loadCharacteristicsRules()
  return all.find(entry => {
    const byName = normalizeSkillKey(entry?.nome) === wanted
    const byAcronym = normalizeSkillKey(entry?.acronimo) === wanted
    return byName || byAcronym
  }) || null
}

function loadRulesVocabulary() {
  const skillTerms = new Set()
  const skillActionTerms = new Set()
  const addActionTerm = (value) => {
    const term = normalizeText(value)
    if (!term) return
    skillActionTerms.add(term)
  }
  for (const entry of loadSkillsRules()) {
    const nome = normalizeText(entry?.nome)
    if (nome) skillTerms.add(nome)
    const baseToken = nome
      .split(/[(/]/)[0]
      .trim()
      .split(/\s+/)[0]
      .trim()
    if (/(are|ere|ire)$/i.test(baseToken)) addActionTerm(baseToken)
  }

  const skillSynonyms = {
    Ammaliare: ['sedurre', 'affascinare', 'adescare'],
    Ascoltare: ['origliare'],
    Biblioteconomia: ['consultare', 'ricercare'],
    Camuffare: ['travestire', 'travestirsi'],
    Combattere: ['attaccare', 'colpire', 'menare'],
    Furtivita: ['nascondersi', 'mi nascondo', 'sgattaiolare', 'sgattaiolo', 'intrufolarsi', 'mi intrufolo'],
    Individuare: ['notare', 'scorgere'],
    Intimidire: ['minacciare', 'spaventare', 'impaurire'],
    Persuadere: ['convincere', 'convinco'],
    Psicologia: ['scrutare', 'intuire'],
    Raggirare: ['ingannare', 'inganno', 'mentire', 'imbrogliare'],
    Rapidita: ['borseggiare', 'occultare'],
    Scalare: ['arrampicarsi', 'mi arrampico'],
    Scassinare: ['forzare', 'forzo'],
    Seguire: ['pedinare'],
    Valutare: ['stimare']
  }
  for (const [skillName, synonyms] of Object.entries(skillSynonyms)) {
    const wanted = normalizeSkillKey(skillName)
    const exists = loadSkillsRules().some(entry => normalizeSkillKey(entry?.nome).startsWith(wanted))
    if (!exists) continue
    synonyms.forEach(addActionTerm)
  }

  const characteristicTerms = new Set()
  for (const entry of loadCharacteristicsRules()) {
    const nome = normalizeText(entry?.nome)
    const acronimo = normalizeText(entry?.acronimo)
    if (nome) characteristicTerms.add(nome)
    if (acronimo) characteristicTerms.add(acronimo)
  }

  return {
    skillNames: Array.from(skillTerms),
    characteristicNames: Array.from(characteristicTerms),
    skillActionTerms: Array.from(skillActionTerms)
  }
}

function normalizePosition(position) {
  if (!position) return null
  if (typeof position === 'object' && !Array.isArray(position)) {
    const tipo = normalizeText(position.tipo)
    const id = normalizeText(position.id)
    const label = normalizeText(position.label)
    if (tipo || id || label) {
      return {
        tipo: tipo || 'libera',
        id: id || null,
        label: label || id || null
      }
    }
  }

  const raw = normalizeText(position)
  if (!raw) return null
  if (/^png_/i.test(raw)) return { tipo: 'png', id: raw, label: raw }
  if (/^pg_/i.test(raw)) return { tipo: 'pg', id: raw, label: raw }
  if (/^scena_/i.test(raw)) return { tipo: 'scena', id: raw, label: raw }
  return { tipo: 'libera', id: null, label: raw }
}

function normalizeRuntimeStatus(value, allowed = [], fallback = 'sconosciuto') {
  const normalized = normalizeText(value).toLowerCase()
  if (!normalized) return fallback
  return allowed.length && !allowed.includes(normalized) ? fallback : normalized
}

function normalizeScene(scene = {}) {
  const preparation = scene.preparazione || {}
  const runtime = scene.runtime || {}
  return {
    id_scena: normalizeText(scene.id_scena),
    titolo: normalizeText(scene.titolo),
    preparazione: {
      location: {
        nome: normalizeText(preparation.location?.nome),
        descrizione_atmosfera: normalizeText(preparation.location?.descrizione_atmosfera),
        dettagli_sensoriali: (preparation.location?.dettagli_sensoriali || []).map(normalizeText).filter(Boolean)
      },
      connessioni: (preparation.connessioni || []).map(entry => ({
        destinazione: normalizeText(entry?.destinazione),
        come: normalizeText(entry?.come)
      })).filter(entry => entry.destinazione || entry.come),
      png_presenti: normalizeLooseIdList(preparation.png_presenti),
      png_aggiuntivi: normalizeLooseIdList(preparation.png_aggiuntivi),
      indizi_disponibili: normalizeLooseIdList(preparation.indizi_disponibili),
      minacce: (preparation.minacce || []).map(normalizeText).filter(Boolean),
      trigger: (preparation.trigger || []).map(entry => ({
        id: normalizeText(entry?.id),
        condizione: normalizeText(entry?.condizione),
        effetto: normalizeText(entry?.effetto),
        attivato: Boolean(entry?.attivato)
      })).filter(entry => entry.id || entry.condizione || entry.effetto),
      condizioni_uscita: {
        naturale: normalizeText(preparation.condizioni_uscita?.naturale),
        forzata: normalizeText(preparation.condizioni_uscita?.forzata),
        fallimento: normalizeText(preparation.condizioni_uscita?.fallimento)
      }
    },
    runtime: {
      stato: normalizeRuntimeStatus(runtime.stato, ['non_iniziata', 'in_corso', 'completata', 'abbandonata'], 'non_iniziata'),
      tempo_inizio: normalizeText(runtime.tempo_inizio),
      tempo_corrente: normalizeText(runtime.tempo_corrente),
      eventi_accaduti: (runtime.eventi_accaduti || []).map(normalizeText).filter(Boolean),
      trigger_attivati: normalizeLooseIdList(runtime.trigger_attivati),
      indizi_trovati: normalizeLooseIdList(runtime.indizi_trovati),
      note_scene_master: normalizeText(runtime.note_scene_master)
    }
  }
}

function normalizeNpc(npc = {}) {
  const profile = npc.profilo || {}
  const runtime = npc.runtime || {}
  return {
    id_png: normalizeText(npc.id_png),
    nome: normalizeText(npc.nome),
    profilo: {
      descrizione: normalizeText(profile.descrizione),
      occupazione: normalizeText(profile.occupazione),
      personalita: (profile.personalita || []).map(normalizeText).filter(Boolean),
      segreto: normalizeText(profile.segreto),
      obiettivo_primario: normalizeText(profile.obiettivo_primario),
      obiettivi_secondari: (profile.obiettivi_secondari || []).map(normalizeText).filter(Boolean),
      agenda: (profile.agenda || []).map(entry => ({
        condizione: normalizeText(entry?.condizione),
        azione: normalizeText(entry?.azione)
      })).filter(entry => entry.condizione || entry.azione),
      conoscenze: {
        rivela_liberamente: (profile.conoscenze?.rivela_liberamente || []).map(normalizeText).filter(Boolean),
        rivela_se_fiducia: (profile.conoscenze?.rivela_se_fiducia || []).map(normalizeText).filter(Boolean),
        non_rivela_mai: (profile.conoscenze?.non_rivela_mai || []).map(normalizeText).filter(Boolean)
      },
      stile_dialogo: normalizeText(profile.stile_dialogo),
      arco_narrativo: normalizeText(profile.arco_narrativo)
    },
    runtime: {
      stato: normalizeRuntimeStatus(runtime.stato, ['vivo', 'viva', 'ferito', 'ferita', 'scomparso', 'scomparsa', 'morto', 'morta'], 'sconosciuto'),
      posizione: normalizePosition(runtime.posizione),
      atteggiamento_verso_pg: normalizeText(runtime.atteggiamento_verso_pg),
      informazioni_rivelate: (runtime.informazioni_rivelate || []).map(normalizeText).filter(Boolean),
      note_npc_master: normalizeText(runtime.note_npc_master)
    }
  }
}

function normalizeObjectItem(item = {}) {
  return {
    id_oggetto: normalizeText(item.id_oggetto),
    nome: normalizeText(item.nome),
    descrizione: normalizeText(item.descrizione),
    posizione: normalizePosition(item.posizione),
    condizione_ottenimento: normalizeText(item.condizione_ottenimento),
    effetto: normalizeText(item.effetto)
  }
}

function normalizeClueItem(item = {}) {
  return {
    id_indizio: normalizeText(item.id_indizio),
    nome: normalizeText(item.nome),
    descrizione: normalizeText(item.descrizione),
    posizione_originale: normalizeText(item.posizione_originale),
    prova_richiesta: normalizeText(item.prova_richiesta),
    stato: normalizeRuntimeStatus(item.stato, ['non_trovato', 'trovato', 'perso'], 'non_trovato'),
    trovato_da: normalizeText(item.trovato_da),
    timestamp_scoperta: normalizeText(item.timestamp_scoperta),
    in_possesso_di: normalizeText(item.in_possesso_di),
    effetto_meccanico: normalizeText(item.effetto_meccanico)
  }
}

function renderSceneSummary(scene, options = {}) {
  const item = normalizeScene(scene)
  const resolveEntityLabel = typeof options.resolveEntityLabel === 'function'
    ? options.resolveEntityLabel
    : (value => value)
  const sensory = item.preparazione.location.dettagli_sensoriali.slice(0, 3).join(', ')
  const presentNpcs = item.preparazione.png_presenti.map(resolveEntityLabel).join(', ')
  const activatedTriggers = item.preparazione.trigger
    .filter(trigger => item.runtime.trigger_attivati.includes(trigger.id) || trigger.attivato)
    .map(trigger => trigger.effetto)
    .slice(0, 2)
    .join(' ')
  const discoveredClues = item.runtime.indizi_trovati.map(resolveEntityLabel).join(', ')
  const stateText = item.runtime.stato && item.runtime.stato !== 'non_iniziata'
    ? `Lo stato corrente della scena e ${item.runtime.stato}`
    : ''
  return joinNarrative([
    item.titolo ? `${item.titolo} si svolge in ${item.preparazione.location.nome || 'una location non specificata'}` : item.preparazione.location.nome,
    item.preparazione.location.descrizione_atmosfera,
    sensory ? `I dettagli piu rilevanti della scena sono ${sensory}` : '',
    presentNpcs ? `In scena sono presenti ${presentNpcs}` : '',
    stateText,
    item.runtime.eventi_accaduti.length ? `Finora e accaduto quanto segue: ${item.runtime.eventi_accaduti.join('; ')}` : '',
    activatedTriggers ? `Tra gli sviluppi gia emersi nella scena ci sono questi elementi: ${activatedTriggers}` : '',
    discoveredClues ? `Gli indizi gia trovati sono ${discoveredClues}` : '',
    item.runtime.note_scene_master
  ])
}

function renderNpcSummary(npc, options = {}) {
  const item = normalizeNpc(npc)
  const resolveEntityLabel = typeof options.resolveEntityLabel === 'function'
    ? options.resolveEntityLabel
    : (value => value)
  const positionLabel = item.runtime.posizione?.id
    ? resolveEntityLabel(item.runtime.posizione.id)
    : item.runtime.posizione?.label
  const statusText = item.runtime.stato && !['vivo', 'viva'].includes(item.runtime.stato)
    ? `Il suo stato attuale e ${item.runtime.stato}`
    : ''
  return joinNarrative([
    item.nome ? `${item.nome} e ${item.profilo.occupazione || 'un personaggio non giocante'}` : '',
    item.profilo.descrizione,
    item.profilo.personalita.length ? `I suoi tratti dominanti sono ${item.profilo.personalita.join(', ')}` : '',
    item.profilo.obiettivo_primario ? `Il suo obiettivo principale e ${item.profilo.obiettivo_primario}` : '',
    statusText,
    item.runtime.atteggiamento_verso_pg ? `Al momento il suo atteggiamento verso i PG e ${item.runtime.atteggiamento_verso_pg}` : '',
    positionLabel ? `Si trova attualmente in ${positionLabel}` : '',
    item.profilo.conoscenze.rivela_liberamente.length ? `Rivela liberamente soprattutto questo: ${item.profilo.conoscenze.rivela_liberamente.join('; ')}` : '',
    item.profilo.conoscenze.rivela_se_fiducia.length ? `Se si fida, puo anche rivelare: ${item.profilo.conoscenze.rivela_se_fiducia.join('; ')}` : '',
    item.runtime.informazioni_rivelate.length ? `Finora ha gia rivelato: ${item.runtime.informazioni_rivelate.join('; ')}` : '',
    item.profilo.stile_dialogo,
    item.runtime.note_npc_master
  ])
}

function renderObjectSummary(item, options = {}) {
  const object = normalizeObjectItem(item)
  const resolveEntityLabel = typeof options.resolveEntityLabel === 'function'
    ? options.resolveEntityLabel
    : (value => value)
  const positionLabel = object.posizione?.id
    ? resolveEntityLabel(object.posizione.id)
    : (object.posizione?.label ? object.posizione.label : object.posizione?.tipo)
  return joinNarrative([
    object.nome ? `${object.nome} e un oggetto rilevante della storia` : '',
    object.descrizione,
    positionLabel ? `Al momento la sua posizione e ${positionLabel}` : '',
    object.condizione_ottenimento ? `Per ottenerlo occorre ${object.condizione_ottenimento}` : '',
    object.effetto ? `Il suo effetto o valore narrativo e questo: ${object.effetto}` : ''
  ])
}

function renderClueSummary(item, options = {}) {
  const clue = normalizeClueItem(item)
  const resolveEntityLabel = typeof options.resolveEntityLabel === 'function'
    ? options.resolveEntityLabel
    : (value => value)
  const ownerLabel = clue.in_possesso_di ? resolveEntityLabel(clue.in_possesso_di) : ''
  return joinNarrative([
    clue.nome ? `${clue.nome} e un indizio disponibile nell'avventura` : '',
    clue.descrizione,
    clue.posizione_originale ? `In origine si trova qui: ${clue.posizione_originale}` : '',
    clue.prova_richiesta ? `Per ottenerlo o interpretarlo vale questa nota: ${clue.prova_richiesta}` : '',
    clue.stato !== 'non_trovato' ? `Il suo stato attuale e ${clue.stato}` : 'Non e ancora stato trovato',
    clue.trovato_da ? `Lo ha scoperto ${clue.trovato_da}` : '',
    ownerLabel ? `Ora e in possesso di ${ownerLabel}` : '',
    clue.effetto_meccanico
  ])
}

function renderLocationSummary(scene, options = {}) {
  const item = normalizeScene(scene)
  const sensory = item.preparazione.location.dettagli_sensoriali.slice(0, 3).join(', ')
  return joinNarrative([
    item.preparazione.location.nome ? `${item.preparazione.location.nome} e il luogo rilevante a cui si riferisce la domanda` : '',
    item.preparazione.location.descrizione_atmosfera,
    sensory ? `I dettagli sensoriali piu utili sono ${sensory}` : ''
  ])
}

function describeAppearanceScore(value) {
  const score = Number(value)
  if (!Number.isFinite(score)) return ''
  if (score <= 19) return 'Il suo aspetto e sgradevole e tende a lasciare un’impressione negativa.'
  if (score <= 39) return 'Il suo aspetto e dimesso e difficilmente attira attenzione positiva.'
  if (score <= 59) return 'Il suo aspetto e ordinario e non colpisce particolarmente.'
  if (score <= 79) return 'Il suo aspetto e gradevole e tende a fare una buona impressione.'
  if (score <= 89) return 'Il suo aspetto e notevole e difficilmente passa inosservato.'
  return 'Il suo aspetto e straordinario e lascia un’impressione fortissima.'
}

function describeCreditRating(value) {
  const score = Number(value)
  if (!Number.isFinite(score)) return ''
  if (score <= 0) return 'Dall\'aspetto e dai modi traspare una condizione da squattrinato, senza mezzi reali.'
  if (score <= 9) return 'Abiti, portamento e piccoli dettagli lasciano intuire una condizione povera, appena sopra il minimo sostentamento.'
  if (score <= 49) return 'Abbigliamento e modi di fare suggeriscono uno stile di vita modesto, da ceto medio.'
  if (score <= 89) return 'L\'abbigliamento curato e la sicurezza nei modi fanno pensare a una persona benestante.'
  if (score <= 98) return 'Tessuti, accessori e disinvoltura sociale fanno intuire una notevole ricchezza.'
  return 'Ogni dettaglio visibile, dagli abiti ai modi, comunica la ricchezza quasi smisurata di un vero nababbo.'
}

function describeHpState(hp) {
  const current = Number(hp?.current)
  const max = Number(hp?.max)
  if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) return ''
  const ratio = current / max
  if (ratio >= 1) return 'E in perfette condizioni fisiche.'
  if (ratio >= 0.75) return 'Ha qualche segno di affaticamento o di urti recenti, ma resta in buona forma.'
  if (ratio >= 0.45) return 'Mostra ferite o stanchezza evidenti.'
  if (ratio > 0) return 'E in cattive condizioni fisiche e appare visibilmente provato.'
  return 'E al collasso fisico.'
}

function describeSanityState(sanita) {
  const current = Number(sanita?.current)
  const max = Number(sanita?.max)
  if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) return ''
  const ratio = current / max
  if (ratio >= 0.8) return 'Appare mentalmente lucido e ben centrato.'
  if (ratio >= 0.55) return 'Appare sotto pressione, ma ancora abbastanza saldo.'
  if (ratio >= 0.3) return 'Mostra segni evidenti di stress e logoramento mentale.'
  return 'Appare profondamente scosso e mentalmente instabile.'
}

function skillMasteryLabel(value) {
  const score = Number(value)
  if (!Number.isFinite(score)) return ''
  if (score <= 19) return 'Novizio'
  if (score <= 49) return 'Dilettante'
  if (score <= 74) return 'Professionista'
  if (score <= 89) return 'Esperto'
  return 'Maestro'
}

function renderPgSummary(character = {}) {
  const name = normalizeText(character.name)
  const profession = normalizeText(character.profession)
  const description = normalizeText(character.descrizionePersonale)
  const background = normalizeText(character.background)
  const runtimePosition = normalizeText(character.runtime?.position)
  const runtimeHandlers = Array.isArray(character.runtime?.handlers)
    ? character.runtime.handlers
      .map(handler => normalizeText(handler?.name || handler?.label))
      .filter(Boolean)
    : []
  const sanita = character.derivedAttributes?.sanita
  const hp = character.derivedAttributes?.hp
  const appText = describeAppearanceScore(character.characteristics?.APP)
  const commonSkills = character.abilita?.comuni || {}
  const creditRatingText = describeCreditRating(commonSkills.credito)
  const notableSkills = []
  for (const [skill, value] of Object.entries(commonSkills)) {
    if ((Number(value) || 0) >= 40) notableSkills.push(`${skill} (${skillMasteryLabel(value)})`)
  }
  const specialistSkills = (character.abilita?.specialistiche || [])
    .map(entry => ({ nome: normalizeText(entry?.nome), valore: Number(entry?.valore) || 0 }))
    .filter(entry => entry.nome && entry.valore >= 40)
    .slice(0, 4)
    .map(entry => `${entry.nome} (${skillMasteryLabel(entry.valore)})`)

  return joinNarrative([
    name ? `${name} e ${profession || 'un personaggio giocante'}` : '',
    description,
    appText,
    creditRatingText,
    background,
    runtimePosition ? `Al momento si trova ${runtimePosition}` : '',
    runtimeHandlers.length ? `Ha a portata di interazione: ${runtimeHandlers.join(', ')}` : '',
    describeHpState(hp),
    describeSanityState(sanita),
    notableSkills.length || specialistSkills.length
      ? `Le sue competenze piu rilevanti sono ${(notableSkills.concat(specialistSkills)).slice(0, 6).join('; ')}`
      : ''
  ])
}

function renderRulesExcerpt(skillName = '') {
  const skill = normalizeText(skillName)
  if (!skill) return ''
  const rule = resolveSkillRule(skill)
  if (rule) {
    const basicText = Number.isFinite(Number(rule.basic))
      ? `Il valore base indicativo e ${rule.basic}.`
      : ''
    return joinNarrative([
      `${rule.nome} e l'abilita chiamata in causa dalla domanda`,
      rule.descrizione,
      basicText
    ])
  }
  const characteristic = resolveCharacteristicRule(skill)
  if (characteristic) {
    const acronymText = normalizeText(characteristic.acronimo)
      ? `L'acronimo usato in gioco e ${characteristic.acronimo}.`
      : ''
    return joinNarrative([
      `${characteristic.nome} e la caratteristica o valore derivato chiamato in causa dalla domanda`,
      characteristic.descrizione,
      acronymText
    ])
  }
  return joinNarrative([
    `La domanda riguarda l'abilita ${skill}`,
    'Nel file delle abilita non e stata trovata una corrispondenza esatta, quindi usa questa voce come promemoria generico e valuta il caso in base al contesto'
  ])
}

function renderSkillsCatalogSummary(options = {}) {
  const dialogueOnly = options.dialogueOnly === true
  const skills = loadSkillsRules().filter(entry => {
    if (!dialogueOnly) return true
    return entry?.['seleziona durante dialogo'] === true
  })
  if (!skills.length) return ''
  const lines = skills.map(entry => {
    const nome = normalizeText(entry?.nome)
    const basic = Number.isFinite(Number(entry?.basic)) ? `Base ${entry.basic}` : ''
    const descrizione = normalizeText(entry?.descrizione)
    const header = [nome, basic].filter(Boolean).join(' - ')
    if (!header && !descrizione) return ''
    return descrizione ? `${header}: ${descrizione}` : header
  }).filter(Boolean)
  if (!lines.length) return ''
  return `Quando serve suggerire una prova, scegli l'abilita piu adatta tra queste.\n${lines.join('\n')}`
}

function renderTimelineEventSummary(event = {}) {
  return joinNarrative([
    event.timestamp ? `Al tempo ${normalizeText(event.timestamp)}` : '',
    normalizeText(event.descrizione),
    Array.isArray(event.attori) && event.attori.length ? `Gli attori coinvolti sono ${event.attori.join(', ')}` : '',
    normalizeText(event.scena) ? `L'evento e collegato alla scena ${normalizeText(event.scena)}` : ''
  ])
}

module.exports = {
  normalizeLooseIdList,
  normalizePosition,
  normalizeRuntimeStatus,
  normalizeScene,
  normalizeNpc,
  normalizeObjectItem,
  normalizeClueItem,
  renderSceneSummary,
  renderNpcSummary,
  renderObjectSummary,
  renderClueSummary,
  renderLocationSummary,
  renderPgSummary,
  renderRulesExcerpt,
  renderSkillsCatalogSummary,
  loadRulesVocabulary,
  renderTimelineEventSummary
}
