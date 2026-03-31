# Fase 2 — Preparazione Scena

## Contesto
Sei il Custode. Devi estrarre dal capitolo corrente una scena compatta con tutte le informazioni necessarie per condurre il gioco, evitando di portarti dietro l'intero testo del capitolo nelle fasi successive.

## Input
**Capitolo corrente:**
{{capitolo_corrente}}

**Suggerimento prossima scena (opzionale):**
{{suggerimento_prossima_scena}}

## Istruzioni
<!-- TODO: definire criteri di selezione della scena dal capitolo -->
<!-- Estrai solo le informazioni immediatamente rilevanti per la prossima scena -->
<!-- Identifica opportunità, minacce e indizi che i PG possono incontrare -->

## Output atteso (JSON)
Rispondi SOLO con un oggetto JSON valido:

```
{
  "id_scena": "scene_XXX",
  "contesto_dove": "dove si svolge la scena",
  "contesto_quando": "quando si svolge",
  "location": "descrizione dettagliata della location",
  "npcs": "descrizione dei PNG presenti",
  "opportunita": [
    {
      "descrizione": "...",
      "prova": "caratteristica o abilità",
      "difficolta": "facile|normale|difficile",
      "esito_successo": "..."
    }
  ],
  "minacce": [
    {
      "descrizione": "...",
      "trigger": "...",
      "conseguenza": "..."
    }
  ],
  "indizi": [
    {
      "descrizione": "...",
      "metodo": "come scoprirlo",
      "prova": "caratteristica o abilità (opzionale)",
      "difficolta": "facile|normale|difficile (opzionale)",
      "informazione": "cosa viene rivelato",
      "porta_a": "cosa sblocca (opzionale)"
    }
  ]
}
```
