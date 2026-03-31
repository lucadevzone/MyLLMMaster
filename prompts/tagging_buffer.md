# Tagging Buffer Messaggi

## Contesto
Sei un assistente che analizza messaggi di gioco di ruolo e li classifica.

## Input
**Messaggi da classificare:**
{{messaggi}}

## Istruzioni
<!-- TODO: definire criteri precisi per distinguere le etichette -->
<!-- TODO: definire quando un messaggio può avere più etichette -->
<!-- TODO: definire la logica "i giocatori hanno finito di dichiarare" -->

Classifica ogni messaggio con UNA delle seguenti etichette:
- `dichiarazione`: il giocatore dichiara un'azione in-game
- `domanda al custode`: il giocatore chiede qualcosa al master
- `discutendo tra PG`: i giocatori si parlano tra loro in-character o out-of-character
- `fuori ruolo`: messaggio OOC non rilevante per il gioco

## Output atteso (JSON)
```
{
  "annotazioni": [
    { "id": "message-id", "tag": "dichiarazione" },
    { "id": "message-id", "tag": "domanda al custode" }
  ],
  "pronti": false
}
```

Il campo `pronti` indica se, secondo le annotazioni, i giocatori hanno terminato di dichiarare.
<!-- TODO: definire la logica del campo "pronti" -->
