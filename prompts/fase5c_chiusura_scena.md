# Fase 5c — Chiusura/Cambio Scena

## Input
**Estratto scena corrente:** {{estratto_scena_corrente}}
**Stato del mondo:** {{world_state}}
**Dettagli chiusura:** {{dettagli_chiusura}}

## Istruzioni
<!-- TODO: come chiudere una scena con senso di completamento narrativo -->
<!-- Riassumi cosa è successo e prepara la transizione alla prossima scena -->

## Output atteso (JSON)
```
{
  "narrativa": "testo di chiusura della scena",
  "riepilogo_scena": "riassunto conciso da salvare nel file scena",
  "suggerimento_prossima_scena": "hint per la prossima scena",
  "aggiornamenti": {
    "diary": "entry da aggiungere al diario",
    "scena_chiusa": "id_scena"
  }
}
```
