 # Output Fields dei Prompt

Questo documento riepiloga gli output JSON attesi dai prompt del ciclo del Custode, come vengono validati e dove vengono usati dall'engine.

## Convenzioni

Per ogni fase sono riportati:

- il prompt sorgente
- lo schema JSON associato
- i campi che la LLM deve produrre
- il punto in cui l'engine li consuma
- eventuali campi aggiunti successivamente dal runtime

## Mappa per fase

### Fase 1a

Prompt: [fase1a_prima_sessione.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase1a_prima_sessione.md)  
Schema: [fase1a_prima_sessione.schema.json](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/schemas/fase1a_prima_sessione.schema.json)

| Campo output | Tipo | Uso nell'engine | Stato |
|---|---|---|---|
| `narrativa` | string | inviato in chat con `emitNarrative()` | OK |
| `diary` | string | aggiunto a `diary.txt` con `appendDiary()` | OK |

Nota: `narrativa` viene anche indicizzata come `prima_sessione` nel RAG tavolo quando viene generata e cachata.

### Fase 1b

Prompt: [fase1b_sessioni_successive.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase1b_sessioni_successive.md)  
Schema: [fase1b_sessioni_successive.schema.json](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/schemas/fase1b_sessioni_successive.schema.json)

| Campo output | Tipo | Uso nell'engine | Stato |
|---|---|---|---|
| `narrativa` | string | inviato in chat con `emitNarrative()` | OK |

Nota: non viene più letto nessun `diary` in questa fase.

### Fase 2b

Prompt: [fase2_opening_new_scene.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase2_opening_new_scene.md)  
Schema: [fase2_opening_new_scene.schema.json](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/schemas/fase2_opening_new_scene.schema.json)

| Campo output | Tipo | Uso nell'engine | Stato |
|---|---|---|---|
| `contesto_dove` | string | salvato nel file scena | OK |
| `contesto_quando` | string | salvato nel file scena | OK |
| `PNG` | array di stringhe | salvato nel file scena | OK |
| `opportunita` | array di stringhe | salvato nel file scena | OK |
| `minacce` | array di stringhe | salvato nel file scena | OK |
| `indizi` | array di stringhe | salvato nel file scena | OK |

Campi aggiunti dal runtime dopo la risposta:

- `id_scena`
- `progressione` inizializzata a stringa vuota
- `sessionNumber`
- `sequenceNumber`

Questi campi non devono essere prodotti dalla LLM.

### Fase 3

Prompt: [fase3_scene_orchestrator.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase3_scene_orchestrator.md)  
Schema: [fase3_scene_orchestrator.schema.json](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/schemas/fase3_scene_orchestrator.schema.json)

| Campo output | Tipo | Uso nell'engine | Stato |
|---|---|---|---|
| `focus_scene` | string | aggiornamento di `worldState.focusScene` | OK |

### Fase 4a

Prompt: [fase4a_scene_progress.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase4a_scene_progress.md)  
Schema: [fase4a_scene_progress.schema.json](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/schemas/fase4a_scene_progress.schema.json)

| Campo output | Tipo | Uso nell'engine | Stato |
|---|---|---|---|
| `narrativa` | string | inviato in chat con `emitNarrative()` | OK |
| `sussurri` | array | ogni whisper viene inviato al PG target | OK |

Schema atteso per ogni elemento di `sussurri`:

```json
{ "target": "Nome PG", "testo": "messaggio privato" }
```

Nota: questa fase non sceglie il focus; riceve la scena già scelta dall'orchestratore.

### Fase 4b

Prompt: [fase4b_analisi_dichiarazioni.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase4b_analisi_dichiarazioni.md)  
Schema: [fase4b_analisi_dichiarazioni.schema.json](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/schemas/fase4b_analisi_dichiarazioni.schema.json)

| Campo output | Tipo | Uso nell'engine | Stato |
|---|---|---|---|
| `piano` | array | convertito con `pianoToEmails()` e salvato in sessione | OK |

Ogni entry del piano ha questi campi:

- `pg`
- `stato`
- `azione`
- `abilita_o_caratteristica`
- `difficolta`
- `risultato_prova`

Valori ammessi per `stato`:

- `dichiarazione`
- `domanda`
- `prova`
- `incompleta`
- `assente`

Uso dell'engine:

- controlla se il piano è completo
- se non è completo avvia una delle sottofasi `fase4b_sub_*`
- se è completo passa a `fase5`

Nota: l'engine accetta anche un array nudo come fallback, ma il formato corretto è `{ "piano": [...] }`.

### Fase 4b sub chiarimenti

Prompt: [fase4b_sub_chiarimenti.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase4b_sub_chiarimenti.md)  
Schema: [fase4b_sub_chiarimenti.schema.json](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/schemas/fase4b_sub_chiarimenti.schema.json)

| Campo output | Tipo | Uso nell'engine | Stato |
|---|---|---|---|
| `narrativa` | string | inviato in chat per chiedere chiarimenti | OK |

### Fase 4b sub dichiarazione assente

Prompt: [fase4b_sub_dichiarazione_assente.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase4b_sub_dichiarazione_assente.md)  
Schema: [fase4b_sub_dichiarazione_assente.schema.json](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/schemas/fase4b_sub_dichiarazione_assente.schema.json)

| Campo output | Tipo | Uso nell'engine | Stato |
|---|---|---|---|
| `narrativa` | string | inviato in chat come sollecito | OK |

### Fase 4b sub necessita prova

Prompt: [fase4b_sub_necessita_prova.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase4b_sub_necessita_prova.md)  
Schema: [fase4b_sub_necessita_prova.schema.json](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/schemas/fase4b_sub_necessita_prova.schema.json)

| Campo output | Tipo | Uso nell'engine | Stato |
|---|---|---|---|
| `narrativa` | string | inviato in chat per richiedere il tiro | OK |

### Fase 5

Prompt: [fase5_risoluzione.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase5_risoluzione.md)  
Schema: [fase5_risoluzione.schema.json](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/schemas/fase5_risoluzione.schema.json)

| Campo output | Tipo | Uso nell'engine | Stato |
|---|---|---|---|
| `progressione` | string | appesa a `focusScene.progressione` e passata come `ultimo_avanzamento` a `fase4a_scene_progress` | OK |
| `divisione_gruppi` | boolean | decide il passaggio a `fase5a` | OK |
| `ricongiungimento_gruppi` | boolean | decide il passaggio a `fase5b` | OK |
| `chiusura_scena` | boolean | decide il passaggio a `fase5c` | OK |
| `aggiornamenti.diary` | string | append al diario se non vuoto | OK |
| `aggiornamenti.npcs` | array | merge dentro `worldState.npcs` | OK |
| `aggiornamenti.items` | array | merge dentro `worldState.items` | OK |

Nota importante: questa fase non scrive direttamente in chat; aggiorna solo lo stato della scena.

### Fase 5a

Prompt: [fase5a_divisione_gruppi.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase5a_divisione_gruppi.md)  
Schema: [fase5a_divisione_gruppi.schema.json](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/schemas/fase5a_divisione_gruppi.schema.json)

| Campo output | Tipo | Uso nell'engine | Stato |
|---|---|---|---|
| `narrativa` | string | inviato in chat | OK |

Nota: l'engine non aggiorna ancora i gruppi in `world_state`; c'è un `TODO` esplicito.

### Fase 5b

Prompt: [fase5b_ricongiungimento.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase5b_ricongiungimento.md)  
Schema: [fase5b_ricongiungimento.schema.json](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/schemas/fase5b_ricongiungimento.schema.json)

| Campo output | Tipo | Uso nell'engine | Stato |
|---|---|---|---|
| `narrativa` | string | inviato in chat | OK |

Nota: anche qui la modifica strutturale di `world_state` è ancora `TODO`.

### Fase 5c

Prompt: [fase5c_chiusura_scena.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase5c_chiusura_scena.md)  
Schema: [fase5c_chiusura_scena.schema.json](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/schemas/fase5c_chiusura_scena.schema.json)

| Campo output | Tipo | Uso nell'engine | Stato |
|---|---|---|---|
| `narrativa` | string | inviato in chat | OK |
| `riepilogo_scena` | string | salvato come `scene.summary` nella scena chiusa | OK |
| `suggerimento_prossima_scena` | string | usato come hint per la prossima `fase2` | OK |
| `aggiornamenti.diary` | string | append al diario | OK |
| `aggiornamenti.scena_chiusa` | string | id scena da chiudere | OK |

Campi aggiunti dal runtime durante la chiusura:

- `closingSequenceNumber` nella scena chiusa

Questo campo non viene prodotto dalla LLM.

## Prompt di supporto

### Tagging buffer

Prompt: [tagging_buffer.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/tagging_buffer.md)  
Schema: [tagging_buffer.schema.json](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/schemas/tagging_buffer.schema.json)

| Campo output | Tipo | Uso nell'engine | Stato |
|---|---|---|---|
| `annotazione` | string | assegnata a `msg.tag` | OK |

## Stato complessivo

Gli output del ciclo nuovo risultano allineati con prompt, schema ed engine.

Pulizie recepite durante il controllo:

- `fase3b` non usa più un campo output `focus_scene`
- `fase1b` non si aspetta più `diary` in output
- `fase5` usa coerentemente `progressione`
- `fase4` lavora con `piano` e non con una priorità esplicita

## Note di manutenzione

- Se un prompt aggiunge un nuovo campo output, va aggiornato anche lo schema JSON corrispondente
- Se il runtime aggiunge campi tecnici come `id_scena`, `sessionNumber` o `sequenceNumber`, questi non vanno richiesti alla LLM
- I `TODO` di `fase5a` e `fase5b` riguardano l'aggiornamento strutturale del `world_state`, non il formato output del prompt
