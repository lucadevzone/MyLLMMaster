# Campi Runtime Interni

Questo documento elenca i campi gestiti dal motore applicativo ma non richiesti alla LLM come output dei prompt.

Servono a:

- identificare scene e sessioni
- mantenere l'ordine degli eventi
- salvare stato tecnico o derivato
- arricchire il RAG senza complicare i prompt

## Sessione

### `sessionNumber`

- sorgente: [sessionService.js](/Users/luca/Documents/gamedev/MyLLMMaster/server/src/services/sessionService.js)
- significato: numero progressivo della sessione per uno specifico tavolo
- uso:
  - tagging dei chunk RAG tavolo con `[Sessione N]`
  - append al diario
  - metadato sulle scene

Nota: non viene prodotto dalla LLM.

### `ragSequenceNumber`

- sorgente: [sessionService.js](/Users/luca/Documents/gamedev/MyLLMMaster/server/src/services/sessionService.js)
- significato: contatore progressivo interno alla sessione per ordinare gli eventi che entrano nel RAG tavolo
- uso:
  - genera `sequenceNumber`
  - consente di distinguere l'ordine degli avvenimenti dentro la stessa sessione

Nota: si azzera all'inizio di una nuova sessione.

### `sequenceNumber`

- sorgente: assegnato da `nextRagSequenceNumber(tableId)`
- significato: ordine progressivo dell'evento dentro la sessione
- uso:
  - metadato sulle scene
  - header embedding `[Sequenza N]`

Nota: non viene chiesto alla LLM.

## Scena

### `id_scena`

- sorgente: [custodeEngine.js](/Users/luca/Documents/gamedev/MyLLMMaster/server/src/services/custodeEngine.js) con `nextSceneId(...)`
- significato: identificatore univoco della scena
- uso:
  - salvataggio su file
  - focus scena
  - retrieval tavolo del tipo `scene {{scena_focus_ID}}`

Nota: viene aggiunto dal runtime dopo `fase2b`.

### `progressione`

- sorgente:
  - inizializzata a stringa vuota dal runtime quando nasce una scena
  - poi alimentata con l'output `progressione` di `fase5`
- significato: memoria progressiva di quanto accaduto nella scena
- uso:
  - chunk principale del RAG tavolo (`scene_progressione`)
  - input per le fasi successive

### `summary`

- sorgente: impostato dal runtime in chiusura scena a partire da `riepilogo_scena`
- significato: riepilogo operativo della scena chiusa
- uso:
  - chunk `scene_conclusione` del RAG tavolo

Nota: il nome del campo nel file scena è `summary`, ma il prompt produce `riepilogo_scena`.

### `suggerimento_prossima_scena`

- sorgente: output di `fase5c`
- significato: hint per la prossima scena
- uso:
  - salvato nella scena chiusa
  - rilanciato come suggerimento verso la prossima `fase2`

### `closingSequenceNumber`

- sorgente: assegnato dal runtime quando una scena viene chiusa
- significato: posizione della chiusura scena nell'ordine degli eventi della sessione
- uso:
  - ordinamento del chunk `scene_conclusione`

## Sessione applicativa

### `focusScene`

- sorgente: `world_state`
- significato: scena attualmente in focus
- uso:
  - guida le fasi 3, 4 e 5

### `focusGroupId`

- sorgente: sessione / world state
- significato: gruppo di PG attualmente associato al focus
- uso:
  - fase 2 per associare una nuova scena al gruppo in focus

### `pianoAzione`

- sorgente: sessione corrente
- significato: piano strutturato ricavato da `fase4`
- uso:
  - continuità tra `fase4`, sottofasi e `fase5`

Nota: è uno stato interno del motore, non un campo di prompt.

## RAG Tavolo

### `sceneId`

- sorgente: derivato da `id_scena` durante la costruzione dei chunk
- significato: metadato esplicito del chunk per retrieval e labeling
- uso:
  - header embedding `[Scena scene_XXX]`

### `relatedTags`

- sorgente: derivato deterministicamente dai campi scena
- significato: tag associati al chunk
- uso:
  - arricchimento del retrieval

Nota: nel RAG tavolo derivano dai dati scena, non da una LLM semantica.

## Regola pratica

Se un campo:

- è tecnico
- serve a identificare o ordinare
- viene calcolato dal motore
- non è contenuto creativo

allora deve stare tra i campi runtime interni e non tra gli output richiesti alla LLM.
