# Gemma 4 31B: light prompt behavior

Route: `ollama-cloud/gemma4:31b` (request model `gemma4:31b`)

The light preset received three probes covering early stamping without narration, archive search before asking, and titled note creation.

## stamp

Result: **PASS**

```json
{
  "model": "ollama-cloud/gemma4:31b",
  "requestedModel": "gemma4:31b",
  "preset": "light",
  "probe": "stamp",
  "content": "",
  "toolCalls": [
    {
      "id": "call_ila465d9",
      "function": {
        "index": 0,
        "name": "ctx_reduce",
        "arguments": {
          "drop": "102,103,105"
        }
      }
    }
  ],
  "checks": {
    "stampsEarly": true,
    "doesNotNarrate": true
  },
  "passed": true,
  "usage": {
    "promptTokens": 1225,
    "completionTokens": 25
  }
}
```

## search

Result: **PASS**

```json
{
  "model": "ollama-cloud/gemma4:31b",
  "requestedModel": "gemma4:31b",
  "preset": "light",
  "probe": "search",
  "content": "",
  "toolCalls": [
    {
      "id": "call_1ib07z1v",
      "function": {
        "index": 0,
        "name": "ctx_search",
        "arguments": {
          "query": "why did we choose SQLite over postgres?"
        }
      }
    }
  ],
  "checks": {
    "searchesBeforeAsking": true
  },
  "passed": true,
  "usage": {
    "promptTokens": 1112,
    "completionTokens": 22
  }
}
```

## note

Result: **PASS**

```json
{
  "model": "ollama-cloud/gemma4:31b",
  "requestedModel": "gemma4:31b",
  "preset": "light",
  "probe": "note",
  "content": "",
  "toolCalls": [
    {
      "id": "call_nqcec9qv",
      "function": {
        "index": 0,
        "name": "ctx_note",
        "arguments": {
          "action": "write",
          "content": "Revisit cache invalidation benchmark after v1.0\nEvidence: The current run is noisy on CI; needs comparison with the local baseline."
        }
      }
    }
  ],
  "checks": {
    "notesWithTitle": true
  },
  "passed": true,
  "usage": {
    "promptTokens": 1180,
    "completionTokens": 49
  }
}
```
