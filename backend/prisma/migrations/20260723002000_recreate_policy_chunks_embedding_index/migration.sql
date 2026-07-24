-- Recreate the HNSW vector index on policy_chunks.embedding.
--
-- The previous migration (20260723001703_add_entitlement_snapshot) dropped
-- "policy_chunks_embedding_idx" as an unintended artifact: Prisma cannot model
-- the Unsupported("vector(1536)") column or its index, so when it regenerated
-- the migration for an unrelated column change it emitted a DROP INDEX with no
-- corresponding recreate. This restores the index so RAG similarity search
-- (Phase 4) retains its ANN index instead of falling back to a sequential scan.
--
-- Guarded with IF NOT EXISTS so this is safe to apply on a database where the
-- index was never dropped (e.g. one provisioned from a squashed baseline).
CREATE INDEX IF NOT EXISTS "policy_chunks_embedding_idx"
  ON "policy_chunks" USING hnsw ("embedding" vector_cosine_ops);
