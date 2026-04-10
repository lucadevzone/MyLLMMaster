const fs = require('fs')
const path = require('path')

function normalizeText(value) {
  return String(value || '').trim()
}

function toPosixRelative(baseDir, filePath) {
  return path.relative(baseDir, filePath).split(path.sep).join('/')
}

function detectFileKind(filename, payload) {
  if (/^png_/i.test(filename)) return 'npc'
  if (/^scena_/i.test(filename)) return 'scene'
  if (Array.isArray(payload?.oggetti)) return 'objects'
  if (Array.isArray(payload?.indizi)) return 'clues'
  if (Array.isArray(payload?.relazioni)) return 'relations'
  if (Array.isArray(payload?.eventi)) return 'timeline'
  return 'unknown'
}

function summarizeScene(payload, file) {
  return {
    type: 'scene',
    id: normalizeText(payload.id_scena),
    name: normalizeText(payload.titolo),
    locationName: normalizeText(payload.preparazione?.location?.nome),
    file,
    references: {
      npcs: (payload.preparazione?.png_presenti || []).map(normalizeText).filter(Boolean),
      clues: (payload.preparazione?.indizi_disponibili || []).map(normalizeText).filter(Boolean),
      connections: (payload.preparazione?.connessioni || [])
        .map(entry => normalizeText(entry?.destinazione))
        .filter(Boolean)
    }
  }
}

function summarizeNpc(payload, file) {
  return {
    type: 'npc',
    id: normalizeText(payload.id_png),
    name: normalizeText(payload.nome),
    file
  }
}

function summarizeObjects(payload, file) {
  return (payload.oggetti || []).map(item => ({
    type: 'object',
    id: normalizeText(item.id_oggetto),
    name: normalizeText(item.nome),
    file,
    references: {
      position: item.posizione || null
    }
  }))
}

function summarizeClues(payload, file) {
  return (payload.indizi || []).map(item => ({
    type: 'clue',
    id: normalizeText(item.id_indizio),
    name: normalizeText(item.nome),
    file,
    references: {
      leadsTo: (item.conduce_a || []).map(normalizeText).filter(Boolean),
      owner: normalizeText(item.in_possesso_di)
    }
  }))
}

function summarizeRelations(payload, file) {
  return (payload.relazioni || []).map((item, index) => ({
    type: 'relation',
    id: `relation_${index + 1}`,
    name: `${normalizeText(item.da)} -> ${normalizeText(item.a)}`,
    file,
    relation: {
      from: normalizeText(item.da),
      to: normalizeText(item.a),
      quality: normalizeText(item.qualita),
      level: item.livello ?? null
    }
  }))
}

function analyzeNotesDirectory(notesDir) {
  const dirEntries = fs.readdirSync(notesDir)
    .filter(name => name.endsWith('.json'))
    .filter(name => name !== 'module_notes_index.json')
    .sort()

  const files = []
  const entities = {
    npc: [],
    scene: [],
    object: [],
    clue: [],
    relation: []
  }

  for (const filename of dirEntries) {
    const absolutePath = path.join(notesDir, filename)
    const relativeFile = toPosixRelative(notesDir, absolutePath)
    const payload = JSON.parse(fs.readFileSync(absolutePath, 'utf8'))
    const kind = detectFileKind(filename, payload)

    let extracted = []
    if (kind === 'scene') extracted = [summarizeScene(payload, relativeFile)]
    else if (kind === 'npc') extracted = [summarizeNpc(payload, relativeFile)]
    else if (kind === 'objects') extracted = summarizeObjects(payload, relativeFile)
    else if (kind === 'clues') extracted = summarizeClues(payload, relativeFile)
    else if (kind === 'relations') extracted = summarizeRelations(payload, relativeFile)

    files.push({
      file: relativeFile,
      kind,
      entityCount: extracted.length
    })

    for (const entity of extracted) {
      if (entity.type === 'npc') entities.npc.push(entity)
      else if (entity.type === 'scene') entities.scene.push(entity)
      else if (entity.type === 'object') entities.object.push(entity)
      else if (entity.type === 'clue') entities.clue.push(entity)
      else if (entity.type === 'relation') entities.relation.push(entity)
    }
  }

  const byId = {}
  const byName = {
    npc: {},
    scene: {},
    object: {},
    clue: {}
  }
  for (const type of ['npc', 'scene', 'object', 'clue']) {
    for (const entity of entities[type]) {
      if (!entity.id) continue
      byId[entity.id] = {
        type: entity.type,
        id: entity.id,
        name: entity.name,
        locationName: entity.locationName || null,
        file: entity.file
      }
      const normalizedName = normalizeText(entity.name).toLowerCase()
      if (normalizedName) {
        byName[type][normalizedName] = {
          type: entity.type,
          id: entity.id,
          name: entity.name,
          file: entity.file
        }
      }
    }
  }

  for (const scene of entities.scene) {
    scene.appearsWith = {
      npcs: scene.references.npcs.map(id => byId[id]).filter(Boolean),
      clues: scene.references.clues.map(id => byId[id]).filter(Boolean),
      connections: scene.references.connections.map(id => byId[id]).filter(Boolean)
    }
  }

  for (const object of entities.object) {
    const position = object.references.position
    const ownerId = typeof position === 'string' ? position : position?.id
    object.linkedTo = ownerId && byId[ownerId] ? byId[ownerId] : null
  }

  for (const clue of entities.clue) {
    clue.linkedTo = {
      leadsTo: clue.references.leadsTo.map(id => byId[id]).filter(Boolean),
      owner: clue.references.owner && byId[clue.references.owner] ? byId[clue.references.owner] : null
    }
  }

  const outgoingRelations = {}
  const incomingRelations = {}
  for (const relation of entities.relation) {
    const from = relation.relation.from
    const to = relation.relation.to
    if (from) {
      if (!outgoingRelations[from]) outgoingRelations[from] = []
      outgoingRelations[from].push(relation)
    }
    if (to) {
      if (!incomingRelations[to]) incomingRelations[to] = []
      incomingRelations[to].push(relation)
    }
  }

  for (const npc of entities.npc) {
    npc.referencedBy = {
      scenes: entities.scene
        .filter(scene => scene.references.npcs.includes(npc.id))
        .map(scene => ({ id: scene.id, name: scene.name, file: scene.file })),
      objects: entities.object
        .filter(object => object.linkedTo?.id === npc.id)
        .map(object => ({ id: object.id, name: object.name, file: object.file })),
      outgoingRelations: (outgoingRelations[npc.id] || []).map(relation => relation.relation),
      incomingRelations: (incomingRelations[npc.id] || []).map(relation => relation.relation)
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    notesDir: notesDir.split(path.sep).join('/'),
    counts: {
      files: files.length,
      npc: entities.npc.length,
      scene: entities.scene.length,
      object: entities.object.length,
      clue: entities.clue.length,
      relation: entities.relation.length
    },
    files,
    entities,
    byId,
    byName
  }
}

function writeNotesIndex(notesDir, index = analyzeNotesDirectory(notesDir)) {
  const targetPath = path.join(notesDir, 'module_notes_index.json')
  fs.writeFileSync(targetPath, JSON.stringify(index, null, 2) + '\n', 'utf8')
  return targetPath
}

function loadNotesIndex(notesDir) {
  const targetPath = path.join(notesDir, 'module_notes_index.json')
  return JSON.parse(fs.readFileSync(targetPath, 'utf8'))
}

function buildQuestionCatalogFromNotesIndex(index = {}) {
  const npcNames = (index.entities?.npc || []).map(entity => normalizeText(entity.name)).filter(Boolean)
  const objectNames = (index.entities?.object || []).map(entity => normalizeText(entity.name)).filter(Boolean)
  const clueNames = (index.entities?.clue || []).map(entity => normalizeText(entity.name)).filter(Boolean)
  const sceneNames = (index.entities?.scene || []).map(entity => normalizeText(entity.name)).filter(Boolean)
  const locationNames = Array.from(new Set(
    (index.entities?.scene || [])
      .flatMap(entity => [normalizeText(entity.locationName), normalizeText(entity.name)])
      .filter(Boolean)
  ))
  const sceneById = Object.fromEntries(
    (index.entities?.scene || [])
      .filter(entity => entity.id)
      .map(entity => [entity.id, normalizeText(entity.name) || entity.id])
  )

  return {
    npcNames,
    objectNames,
    clueNames,
    sceneNames,
    locationNames,
    sceneById
  }
}

module.exports = {
  analyzeNotesDirectory,
  writeNotesIndex,
  loadNotesIndex,
  buildQuestionCatalogFromNotesIndex
}
