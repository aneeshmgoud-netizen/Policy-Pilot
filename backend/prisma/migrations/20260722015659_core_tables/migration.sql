-- Ensure pgvector is available. Local dev already creates this via
-- docker/init/01-extensions.sql, but the migration must be self-sufficient
-- for CI or any fresh Postgres instance that doesn't run that init script.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "request_status" AS ENUM ('PENDING', 'ENTITLEMENTS_LOADED', 'RECOMMENDED', 'DECIDED', 'FAILED');

-- CreateEnum
CREATE TYPE "decision" AS ENUM ('APPROVE', 'DENY', 'ESCALATE');

-- CreateEnum
CREATE TYPE "human_decision_type" AS ENUM ('APPROVE', 'DENY', 'OVERRIDE');

-- CreateTable
CREATE TABLE "access_requests" (
    "id" UUID NOT NULL,
    "request_id" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "employee_id" TEXT NOT NULL,
    "request_type" TEXT NOT NULL,
    "target_system" TEXT NOT NULL,
    "entitlement_key" TEXT NOT NULL,
    "justification" TEXT NOT NULL,
    "requester_title" TEXT NOT NULL,
    "requester_department" TEXT NOT NULL,
    "requester_cost_center" TEXT NOT NULL,
    "status" "request_status" NOT NULL DEFAULT 'PENDING',
    "submitted_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_recommendations" (
    "id" UUID NOT NULL,
    "access_request_id" UUID NOT NULL,
    "decision" "decision" NOT NULL,
    "justification" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "model_name" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "raw_response" JSONB NOT NULL,
    "attempt_number" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_recommendation_citations" (
    "id" UUID NOT NULL,
    "ai_recommendation_id" UUID NOT NULL,
    "policy_chunk_id" UUID NOT NULL,
    "document_name" TEXT NOT NULL,
    "section" TEXT,
    "excerpt" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_recommendation_citations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "human_decisions" (
    "id" UUID NOT NULL,
    "access_request_id" UUID NOT NULL,
    "ai_recommendation_id" UUID,
    "reviewer_id" TEXT NOT NULL,
    "decision" "human_decision_type" NOT NULL,
    "rationale" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "human_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "access_request_id" UUID,
    "event_type" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "key" TEXT NOT NULL,
    "access_request_id" UUID NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "policy_documents" (
    "id" UUID NOT NULL,
    "document_name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "effective_date" TIMESTAMP(3) NOT NULL,
    "source_path" TEXT NOT NULL,
    "ingested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_chunks" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "section" TEXT,
    "policy_domain" TEXT,
    "department" TEXT,
    "cost_center" TEXT,
    "target_system" TEXT,
    "entitlement_type" TEXT,
    "content" TEXT NOT NULL,
    "embedding" vector(1536),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluation_results" (
    "id" UUID NOT NULL,
    "run_id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "expected_decision" TEXT,
    "actual_decision" TEXT,
    "passed" BOOLEAN NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "estimated_cost_usd" DOUBLE PRECISION NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evaluation_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "access_requests_request_id_key" ON "access_requests"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "access_requests_idempotency_key_key" ON "access_requests"("idempotency_key");

-- CreateIndex
CREATE INDEX "access_requests_employee_id_idx" ON "access_requests"("employee_id");

-- CreateIndex
CREATE INDEX "access_requests_status_idx" ON "access_requests"("status");

-- CreateIndex
CREATE INDEX "ai_recommendations_access_request_id_idx" ON "ai_recommendations"("access_request_id");

-- CreateIndex
CREATE INDEX "ai_recommendation_citations_ai_recommendation_id_idx" ON "ai_recommendation_citations"("ai_recommendation_id");

-- CreateIndex
CREATE INDEX "ai_recommendation_citations_policy_chunk_id_idx" ON "ai_recommendation_citations"("policy_chunk_id");

-- CreateIndex
CREATE INDEX "human_decisions_access_request_id_idx" ON "human_decisions"("access_request_id");

-- CreateIndex
CREATE INDEX "audit_log_access_request_id_idx" ON "audit_log"("access_request_id");

-- CreateIndex
CREATE INDEX "policy_chunks_document_id_idx" ON "policy_chunks"("document_id");

-- CreateIndex
CREATE INDEX "evaluation_results_run_id_idx" ON "evaluation_results"("run_id");

-- AddForeignKey
ALTER TABLE "ai_recommendations" ADD CONSTRAINT "ai_recommendations_access_request_id_fkey" FOREIGN KEY ("access_request_id") REFERENCES "access_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_recommendation_citations" ADD CONSTRAINT "ai_recommendation_citations_ai_recommendation_id_fkey" FOREIGN KEY ("ai_recommendation_id") REFERENCES "ai_recommendations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_recommendation_citations" ADD CONSTRAINT "ai_recommendation_citations_policy_chunk_id_fkey" FOREIGN KEY ("policy_chunk_id") REFERENCES "policy_chunks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_decisions" ADD CONSTRAINT "human_decisions_access_request_id_fkey" FOREIGN KEY ("access_request_id") REFERENCES "access_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_decisions" ADD CONSTRAINT "human_decisions_ai_recommendation_id_fkey" FOREIGN KEY ("ai_recommendation_id") REFERENCES "ai_recommendations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_access_request_id_fkey" FOREIGN KEY ("access_request_id") REFERENCES "access_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_access_request_id_fkey" FOREIGN KEY ("access_request_id") REFERENCES "access_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_chunks" ADD CONSTRAINT "policy_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "policy_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Vector similarity index (HNSW, cosine distance) for RAG retrieval.
-- Queried via $queryRaw since Prisma cannot express vector operators natively.
CREATE INDEX "policy_chunks_embedding_idx" ON "policy_chunks" USING hnsw ("embedding" vector_cosine_ops);

-- Overrides must carry a non-empty reviewer rationale. Enforced at the DB
-- layer so this holds even if application-level validation is bypassed.
ALTER TABLE "human_decisions" ADD CONSTRAINT "human_decisions_override_requires_rationale"
  CHECK (decision != 'OVERRIDE' OR (rationale IS NOT NULL AND length(trim(rationale)) > 0));

-- audit_log is append-only: no UPDATE or DELETE is ever permitted, enforced
-- structurally rather than only by convention in application code.
CREATE OR REPLACE FUNCTION audit_log_prevent_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_mutation();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_mutation();
