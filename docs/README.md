# Documentazione Campi Prompt e Runtime

Questa cartella raccoglie la documentazione aggiornata del ciclo prompt/engine del Custode.

## Documenti disponibili

- [input_field.md](/Users/luca/Documents/gamedev/MyLLMMaster/docs/input_field.md)
  Mappa completa dei campi di input usati nei prompt:
  - placeholder `{{campo}}`
  - direttive `{{rag:...}}`
  - origine dati
  - stato di funzionamento

- [output_field.md](/Users/luca/Documents/gamedev/MyLLMMaster/docs/output_field.md)
  Mappa completa degli output JSON attesi dai prompt:
  - campi prodotti dalla LLM
  - schema associato
  - punti di consumo nell'engine

- [runtime_field.md](/Users/luca/Documents/gamedev/MyLLMMaster/docs/runtime_field.md)
  Campi tecnici gestiti dal motore ma non richiesti alla LLM:
  - `id_scena`
  - `sessionNumber`
  - `sequenceNumber`
  - `summary`
  - `closingSequenceNumber`
  - stato interno della sessione

## Nota

Il vecchio file `descrizione_campi.txt` è stato rimosso perché non più allineato con il ciclo nuovo del Custode e con il redesign del RAG modulo/tavolo.
