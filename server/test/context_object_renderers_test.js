const assert = require('assert')
const {
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
  renderTimelineEventSummary
} = require('../src/services/contextObjectRenderers')

function main() {
  const scene = normalizeScene({
    id_scena: 'scena_asta_grand_palais',
    titolo: "L'asta al Grand Palais",
    preparazione: {
      location: {
        nome: 'Sala delle Antichita, Grand Palais',
        descrizione_atmosfera: "Un'asta privata elegante e vagamente clandestina.",
        dettagli_sensoriali: ['luce calda', 'brusio sommesso']
      },
      png_presenti: ['png_sophia_hapgood'],
      png_aggiuntivi: ['png_commissaire_renard, png_ernst'],
      indizi_disponibili: ['indizio_tavoletta_asta'],
      trigger: [
        {
          id: 'trigger_sophia_impallidisce',
          condizione: 'La tavoletta viene mostrata sul podio',
          effetto: 'Sophia impallidisce visibilmente alla vista della tavoletta.',
          attivato: false
        }
      ]
    },
    runtime: {
      stato: 'in_corso',
      eventi_accaduti: ['I PG sono entrati nella sala'],
      indizi_trovati: ['indizio_tavoletta_asta']
    }
  })

  assert.deepStrictEqual(scene.preparazione.png_aggiuntivi, ['png_commissaire_renard', 'png_ernst'])
  assert.strictEqual(scene.runtime.stato, 'in_corso')
  const renderedScene = renderSceneSummary(scene, {
    resolveEntityLabel: value => ({
      png_sophia_hapgood: 'Sophia Hapgood',
      indizio_tavoletta_asta: "La tavoletta dell'asta"
    }[value] || value)
  })
  assert.ok(renderedScene.includes('L\'asta al Grand Palais'))
  assert.ok(renderedScene.includes('Sophia Hapgood'))
  assert.ok(!renderedScene.includes('png_sophia_hapgood'))
  assert.ok(!renderedScene.includes('Gli indizi preparati'))

  const npc = normalizeNpc({
    id_png: 'png_klaus_kerner',
    nome: 'Klaus Kerner',
    profilo: {
      descrizione: 'Uomo elegante e austero.',
      occupazione: 'Operativo Ahnenerbe / SS',
      personalita: ['freddo', 'osservatore'],
      obiettivo_primario: 'Ottenere le informazioni di Belloq',
      conoscenze: {
        rivela_liberamente: [],
        rivela_se_fiducia: ['Sa qualcosa sull\'amuleto'],
        non_rivela_mai: ['Dove si trova Belloq']
      },
      stile_dialogo: 'Parla poco e con precisione chirurgica.'
    },
    runtime: {
      stato: 'vivo',
      posizione: 'scena_asta_grand_palais',
      atteggiamento_verso_pg: 'ostile'
    }
  })
  assert.strictEqual(npc.runtime.posizione.tipo, 'scena')
  const renderedNpc = renderNpcSummary(npc, {
    resolveEntityLabel: value => value === 'scena_asta_grand_palais' ? "L'asta al Grand Palais" : value
  })
  assert.ok(renderedNpc.includes("L'asta al Grand Palais"))
  assert.ok(!renderedNpc.includes('Il suo stato attuale e vivo'))

  const object = normalizeObjectItem({
    id_oggetto: 'obj_amuleto_nur_ab_sal',
    nome: 'Amuleto di Nur-Ab-Sal',
    descrizione: 'Reperto antico di fattura sconosciuta.',
    posizione: 'png_sophia_hapgood',
    condizione_ottenimento: 'Solo se viene rubato a Sophia',
    effetto: 'Produce sogni e visioni.'
  })
  assert.strictEqual(object.posizione.tipo, 'png')
  assert.ok(renderObjectSummary(object, {
    resolveEntityLabel: value => value === 'png_sophia_hapgood' ? 'Sophia Hapgood' : value
  }).includes('Sophia Hapgood'))

  const clue = normalizeClueItem({
    id_indizio: 'indizio_sophia_reazione',
    nome: 'La reazione di Sophia alla tavoletta',
    descrizione: 'Sophia impallidisce alla vista della tavoletta.',
    posizione_originale: "Osservabile all'asta",
    prova_richiesta: 'Osservazione attenta o Psicologia',
    stato: 'trovato',
    trovato_da: 'Emil'
  })
  assert.strictEqual(clue.stato, 'trovato')
  assert.ok(renderClueSummary(clue).includes('Emil'))

  const locationText = renderLocationSummary(scene)
  assert.ok(locationText.includes('Sala delle Antichita'))

  const pgText = renderPgSummary({
    name: 'Luk',
    profession: 'Giornalista',
    descrizionePersonale: 'Magro, alto, barbuto',
    derivedAttributes: {
      hp: { current: 9, max: 9 },
      sanita: { current: 60, max: 99 }
    },
    abilita: {
      comuni: { osservare: 50, psicologia: 40 },
      specialistiche: [{ nome: 'Biblioteca', valore: 60 }]
    }
  })
  assert.ok(pgText.includes('Luk'))
  assert.ok(pgText.includes('Biblioteca 60'))

  const rulesText = renderRulesExcerpt('Psicologia')
  assert.ok(rulesText.includes('Psicologia'))
  assert.ok(rulesText.includes('Comprendere comportamento e motivazioni altrui'))

  const characteristicRulesText = renderRulesExcerpt('FOR')
  assert.ok(characteristicRulesText.includes('Forza'))
  assert.ok(characteristicRulesText.includes("L'acronimo usato in gioco e FOR"))

  const timelineText = renderTimelineEventSummary({
    timestamp: '1936-07-14T00:00',
    descrizione: 'Brandt e Kerner arrivano a Parigi.',
    attori: ['png_helene_brandt', 'png_klaus_kerner'],
    scena: 'scena_hotel_lutetia'
  })
  assert.ok(timelineText.includes('1936-07-14T00:00'))
  assert.ok(timelineText.includes('png_klaus_kerner'))

  console.log('context_object_renderers_test: ok')
}

main()
