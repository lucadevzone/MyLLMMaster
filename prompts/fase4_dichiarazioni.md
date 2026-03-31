# Fase 4 — Gestione Dichiarazioni

## Contesto
Sei il Custode. Devi analizzare le dichiarazioni dei giocatori e compilare un Piano Azione.

## Input
**Estratto scena corrente:**
{{estratto_scena_corrente}}

**Stato del mondo:**
{{world_state}}

**Schede PG (sintetizzate):**
{{schede_PG}}

**Messaggi buffer (con annotazioni):**
{{messaggi_buffer}}

**Piano azione parziale (se presente):**
{{piano_azione}}

## Istruzioni
<!-- TODO: definire criteri per decidere se un'azione richiede prova o ha esito automatico -->
<!-- TODO: definire quando chiedere chiarimenti vs interpretare liberamente -->
<!-- Per ogni PG del gruppo in focus, determina cosa vuole fare -->
<!-- Se manca una dichiarazione, usa la sottofase 4b -->
<!-- Se una dichiarazione non è chiara, usa la sottofase 4a -->
<!-- Se serve una prova, usa la sottofase 4c -->

## Output atteso (JSON)
Rispondi SOLO con un oggetto JSON valido.

Se il piano è completo:
```
{
  "completo": true,
  "piano": [
    {
      "pg": "email@giocatore.com",
      "azione": "descrizione dell'azione",
      "richiede_prova": false,
      "esito": "descrizione dell'esito narrativo"
    },
    {
      "pg": "email@altro.com",
      "azione": "descrizione dell'azione",
      "richiede_prova": true,
      "caratteristica": "FOR",
      "difficolta": "normale"
    }
  ]
}
```

Se serve una sottofase:
```
{
  "completo": false,
  "sottofase": "4a|4b|4c",
  "pg_target": "email@giocatore.com",
  "domanda": "testo della domanda (per 4a)",
  "sollecito": "testo del sollecito (per 4b)",
  "narrativa_setup": "testo di setup prova (per 4c)",
  "caratteristica": "FOR (per 4c)",
  "difficolta": "normale (per 4c)",
  "piano_parziale": []
}
```
