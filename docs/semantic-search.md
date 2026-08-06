# Semantic search (optional)

agent-bridge retrieval is lexical by default (SQLite FTS5 + bm25, diacritic-folded).
You can optionally blend in **vector similarity** so memories that are related in
meaning surface even when they share no keywords with the query.

No embedding model is bundled — the tool installs and runs fully offline without
one. Semantic search activates only when you provide a local embedding provider.

## Enabling it

1. Create (or install) a module that exports `createEmbeddingProvider()` returning
   an object with an async `embed(text) => number[]`:

   ```js
   // my-embeddings.mjs
   export function createEmbeddingProvider() {
     // e.g. wrap fastembed, @xenova/transformers, or a local server.
     return {
       id: "my-model",
       async embed(text) {
         return await computeVector(text); // number[]
       }
     };
   }
   ```

2. Point agent-bridge at it:

   ```powershell
   $env:AGENT_BRIDGE_EMBEDDING_MODULE = "my-embeddings.mjs"
   ```

3. Backfill embeddings for existing memories, then search:

   ```powershell
   agent-bridge memory reindex
   agent-bridge memory search "user cannot stay signed in" --semantic
   ```

## How it blends

- Lexical candidates come from bm25; every embedded memory is also a candidate
  (so keyword-disjoint matches are not excluded).
- Final score = `alpha · lexical + beta · cosine` (defaults 0.5 / 0.5).
- With no provider, `--semantic` cleanly falls back to lexical search; `score`
  degenerates to bm25 only (`beta = 0`).

Embeddings are stored per memory as a float32 BLOB (schema v5) and are skipped for
superseded memories. New memories are not embedded automatically — run
`memory reindex` (cheap; it only embeds rows missing a vector).
