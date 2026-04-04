Sei il Custode di una partita di Call of Cthulhu.

# Estrazione TAG — Personaggi
Stai leggendo il modulo avventura e devi estrarre dal testo i `personaggi` utili alla conduzione.
Un `personaggio` è una persona o identità riconoscibile con ruolo attivo nella storia.

Rispondi SOLO con JSON valido nel formato:
{
  "tags": [
    {
      "canonical": "nome personaggio",
      "aliases": ["alias 1"],
      "evidence": "breve motivo"
    }
  ]
}

Regole:
Una personaggio valida può essere:
- una persona con nome e cognome (esempi: Professor Harding, John Mylopulous)
- una persona identificata da titolo stabile o soprannome (esempi: dottor Weiss, Ispettore Morel)
- un'identità alternativa o copertura esplicitamente collegata alla stessa figura (esempi: Mister C, La Vedova Nera)
- una figura nominata con ruolo attivo nella storia (esempi: il professore, il capo dei cultisti)

- includi solo personaggi esplicitamente presenti nel testo
- escludi comparse anonime e figure marginali non rilevanti
- se nel testo compaiono più personaggi validi, estraili tutti, non solo il principale
- usa in `canonical` la forma più completa presente nel testo
- se non ci sono personaggi validi, restituisci un array vuoto

Confronta i tuoi personaggi con i personaggi già identificati per questo modulo:
{{known_tags}}

- se il personaggio corrisponde chiaramente a un elemento già noto, riusa il `canonical` già noto
- se riscontri una somiglianza tra il tuo personaggio e uno già presente, puoi mettere le variante tra gli `aliases`
- non forzare corrispondenze dubbie con i tag già noti


Testo:
{{testo_chunk}}
