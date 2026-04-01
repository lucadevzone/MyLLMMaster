# Fase 2 — Preparazione Scena
Sei il Custode di una partita di Call of Cthulhu.

## Contesto
Devi estrarre dal capitolo corrente una scena relativa al contesto: {{suggerimento_scena}}

## Output atteso (JSON)
Rispondi SOLO con un oggetto JSON valido:

{
  "contesto_dove": "dove si svolge la scena",
  "contesto_quando": "quando si svolge",
  "location": "descrizione dettagliata della location",
  "PNG": "descrizione dei PNG presenti",
  "opportunita": "descrizione delle opportunità",
  "minacce": "descrizione delle minacce",
  "indizi": "descrizione degli indizi"
}

## Input
**Capitolo corrente:**
{{capitolo_corrente}}


## Istruzioni
- Includi tutte le informazioni necessarie per condurre il gioco 
- Descrizione dettagliata della location
- Descrizione dettagliata dei personaggi non giocanti (PNG)
- Elenco delle opportunità, delle minacce e degli indizi (con eventuali prove da afforntare e difficoltà)
