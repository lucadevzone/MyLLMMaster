# Input Fields dei Prompt

Questo documento riepiloga tutti i campi di input usati nei prompt del ciclo del Custode, da dove arrivano, come vengono risolti e lo stato attuale del loro funzionamento.

## Convenzioni supportate

### Variabili semplici

Sintassi:

```text
{{nome_variabile}}
```

Vengono sostituite direttamente dall'engine con il valore passato a `this.llm(...)`.

### Retrieval RAG semplice

Sintassi:

```text
{{rag:module:"query"}}
{{rag:table:"query"}}
```

Esegue una query sul RAG del modulo o del tavolo.

### Retrieval RAG con cascade

Sintassi:

```text
{{rag:module:"query":cascade}}
```

Usa il cascade del RAG modulo.

### Retrieval RAG con iterate

Sintassi:

```text
{{rag:module:"{{PNG}}":iterate}}
{{rag:table:"A, B, C":iterate}}
```

La query viene prima interpolata con le variabili runtime, poi spezzata in elementi singoli.

Separatore supportati:
- virgola
- punto e virgola
- newline
- array JSON

Per ogni elemento viene eseguita una query separata; i risultati finali vengono deduplicati.

## Origini dati principali

Le variabili arrivano soprattutto da queste sorgenti:

- `buildContext()` in [custodeEngine.js](/Users/luca/Documents/gamedev/MyLLMMaster/server/src/services/custodeEngine.js): `worldState`, `diary`, `schede_PG`, `focusScene`, `mod`
- buffer messaggi della sessione
- scena corrente o scene attive
- piano azione calcolato in fase 4
- file diretti come `diary.txt`
- RAG modulo
- RAG tavolo

## Mappa per fase

### Fase 1a

Prompt: [fase1a_prima_sessione.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase1a_prima_sessione.md)

| Campo | Tipo | Origine | Stato |
|---|---|---|---|
| `schede_PG` | variabile | `buildContext().schede_PG` | OK |
| `{{rag:module:"ambientazione atmosfera setting"}}` | RAG modulo | indice modulo | OK |

Nota: `fase1a` usa solo RAG modulo, non RAG tavolo.

### Fase 1b

Prompt: [fase1b_sessioni_successive.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase1b_sessioni_successive.md)

| Campo | Tipo | Origine | Stato |
|---|---|---|---|
| `diary` | variabile | `buildContext().diary` | OK |
| `scena_in_focus` | variabile | `focusScene` serializzata in JSON | OK |

Nota: `prevSession` è ancora passato dall'engine ma non è più usato dal prompt.

### Fase 2b

Prompt: [fase2b_prepara_scena.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase2b_prepara_scena.md)

| Campo | Tipo | Origine | Stato |
|---|---|---|---|
| `suggerimento_scena` | variabile | parametro runtime di `fase2()` | OK |
| `{{rag:module:"{{suggerimento_scena}}":cascade}}` | RAG modulo cascade | query sul modulo | OK |

Nota: il campo `location` è stato rimosso dallo schema e dal prompt.

### Fase 3a

Prompt: [fase3a_scelta_focus.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase3a_scelta_focus.md)

| Campo | Tipo | Origine | Stato |
|---|---|---|---|
| `scene_attive` | variabile | scene attive serializzate in JSON | OK |
| `narrative_groups` | variabile | `buildNarrativeGroups(...)` | OK |
| `engagement` | variabile | `engagementForLlm(...)` | OK |

### Fase 3b

Prompt: [fase3b_narrazione.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase3b_narrazione.md)

| Campo | Tipo | Origine | Stato |
|---|---|---|---|
| `schede_PG` | variabile | `buildContext().schede_PG` | OK |
| `diary` | variabile | `buildContext().diary` | OK |
| `contesto_dove` | variabile | `focusScene.contesto_dove` | OK |
| `PNG` | variabile | `focusScene.PNG` (array di stringhe) | OK |
| `opportunita` | variabile | `focusScene.opportunita` (array di stringhe) | OK |
| `minacce` | variabile | `focusScene.minacce` (array di stringhe) | OK |
| `indizi` | variabile | `focusScene.indizi` (array di stringhe) | OK |
| `scena_focus_ID` | variabile | `focusScene.id_scena` | OK |
| `{{rag:module:"{{contesto_dove}}"}}` | RAG modulo | query singola | OK |
| `{{rag:module:"{{PNG}}":iterate}}` | RAG modulo iterate | query per ogni PNG | OK |
| `{{rag:module:"{{opportunita}}":iterate}}` | RAG modulo iterate | query per ogni opportunità | OK |
| `{{rag:module:"{{minacce}}":iterate}}` | RAG modulo iterate | query per ogni minaccia | OK |
| `{{rag:module:"{{indizi}}":iterate}}` | RAG modulo iterate | query per ogni indizio | OK |
| `{{rag:table:"scene {{scena_focus_ID}}"}}` | RAG tavolo | query scena corrente | OK |

Nota: il diario non è più nel RAG tavolo; viene passato direttamente dal file `diary.txt`.

### Fase 4

Prompt: [fase4_dichiarazioni.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase4_dichiarazioni.md)

| Campo | Tipo | Origine | Stato |
|---|---|---|---|
| `messaggi_buffer` | variabile | buffer messaggi annotati | OK |
| `piano_azione` | variabile | piano parziale o `nessuno` | OK |
| `scena_focus_ID` | variabile | `focusScene.id_scena` | OK |
| `schede_PG` | variabile | `buildContext().schede_PG` | OK |
| `world_state` | variabile | `buildContext().worldState` serializzato | OK |
| `{{rag:table:"scene {{scena_focus_ID}}"}}` | RAG tavolo | query scena corrente | OK |

Nota: `priorita` non esiste più. L'ordine del piano è quello naturale della lista.

### Fase 4a

Prompt: [fase4a_chiarimenti.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase4a_chiarimenti.md)

| Campo | Tipo | Origine | Stato |
|---|---|---|---|
| `scena_focus_ID` | variabile | scena corrente o dato passato dalla fase 4 | OK |
| `schede_PG` | variabile | `buildContext().schede_PG` | OK |
| `dichiarazione` | variabile | `azione` del piano azione | OK |
| `world_state` | variabile | `buildContext().worldState` serializzato | OK |
| `{{rag:table:"scene {{scena_focus_ID}}"}}` | RAG tavolo | query scena corrente | OK |

### Fase 4b

Prompt: [fase4b_dichiarazione_assente.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase4b_dichiarazione_assente.md)

| Campo | Tipo | Origine | Stato |
|---|---|---|---|
| `richiesta_dichiarazione` | variabile | entry del piano azione serializzata | OK |
| `scena_focus` | variabile | scena corrente serializzata in JSON | OK |
| `world_state` | variabile | `buildContext().worldState` serializzato | OK |

### Fase 4c

Prompt: [fase4c_necessita_prova.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase4c_necessita_prova.md)

| Campo | Tipo | Origine | Stato |
|---|---|---|---|
| `scena_focus_ID` | variabile | scena corrente o dato passato dalla fase 4 | OK |
| `schede_PG` | variabile | `buildContext().schede_PG` | OK |
| `dichiarazione_con_richiesta_prova` | variabile | oggetto con `azione`, `abilita_o_caratteristica`, `difficolta` | OK |
| `world_state` | variabile | `buildContext().worldState` serializzato | OK |
| `{{rag:table:"scene {{scena_focus_ID}}"}}` | RAG tavolo | query scena corrente | OK |

### Fase 5

Prompt: [fase5_risoluzione.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase5_risoluzione.md)

| Campo | Tipo | Origine | Stato |
|---|---|---|---|
| `scena_focus` | variabile | scena corrente serializzata | OK |
| `progressione` | variabile | `focusScene.progressione` | OK |
| `piano_azione` | variabile | piano completato serializzato | OK |
| `world_state` | variabile | `buildContext().worldState` serializzato | OK |
| `schede_PG` | variabile | `buildContext().schede_PG` | OK |

Nota: l'output usa `progressione` top-level e non più `narrativa`.

### Fase 5a

Prompt: [fase5a_divisione_gruppi.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase5a_divisione_gruppi.md)

| Campo | Tipo | Origine | Stato |
|---|---|---|---|
| `scena_focus` | variabile | scena corrente serializzata | OK |
| `world_state` | variabile | stato del mondo serializzato | OK |
| `messaggi_recenti` | variabile | ultimi messaggi sessione | OK |
| `dettagli_divisione` | variabile | dati prodotti da fase 5 | OK |

### Fase 5b

Prompt: [fase5b_ricongiungimento.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase5b_ricongiungimento.md)

| Campo | Tipo | Origine | Stato |
|---|---|---|---|
| `estratti_scene_attive` | variabile | scene attive serializzate | OK |
| `world_state` | variabile | stato del mondo serializzato | OK |
| `dettagli_ricongiungimento` | variabile | dati prodotti da fase 5 | OK |

### Fase 5c

Prompt: [fase5c_chiusura_scena.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/fase5c_chiusura_scena.md)

| Campo | Tipo | Origine | Stato |
|---|---|---|---|
| `scena_focus` | variabile | scena corrente serializzata | OK |
| `world_state` | variabile | stato del mondo serializzato | OK |
| `dettagli_chiusura` | variabile | dati prodotti da fase 5 | OK |

## Prompt di supporto

### Preparazione modulo

| Prompt | Campo | Origine | Stato |
|---|---|---|---|
| [prepara_ambientazione.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/prepara_ambientazione.md) | `primo_capitolo` | primo capitolo del modulo | OK |
| [prepara_avviare_la_sessione.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/prepara_avviare_la_sessione.md) | `primo_capitolo` | primo capitolo del modulo | OK |

### Buffer tagging

| Prompt | Campo | Origine | Stato |
|---|---|---|---|
| [tagging_buffer.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/tagging_buffer.md) | `messaggio_corrente` | messaggio player | OK |
| [tagging_buffer.md](/Users/luca/Documents/gamedev/MyLLMMaster/prompts/tagging_buffer.md) | `contesto_recente` | ultimi messaggi | OK |

## Stato complessivo

Ad oggi i campi input dei prompt del ciclo nuovo risultano allineati con l'engine.

Punti importanti già recepiti:

- `:iterate` è supportato dal resolver RAG
- il diario non è più nel RAG tavolo e viene passato direttamente come variabile
- `priorita` è stata rimossa e l'ordine è quello naturale della lista
- `fase5` usa `progressione` al posto di `narrativa`
- il RAG tavolo usa scene indicizzate, interrogabili anche con query del tipo `scene {{scena_focus_ID}}`

## Note di manutenzione

- Se un prompt aggiunge un nuovo `{{campo}}`, va aggiornato anche il payload della relativa chiamata `this.llm(...)`
- Se un prompt aggiunge un nuovo `{{rag:...}}`, va verificato che il resolver supporti la direttiva usata
- Il diario del tavolo va considerato una sorgente diretta da file, non una sorgente RAG
