-- CreateEnum
CREATE TYPE "precedent_reason_code" AS ENUM ('CONFIRMS_POLICY', 'POLICY_MISAPPLIED', 'MISSING_CONTEXT', 'BUSINESS_EXCEPTION', 'PRECEDENT_CONFLICT', 'OTHER');

-- CreateEnum
CREATE TYPE "precedent_status" AS ENUM ('PROPOSED', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "rule_suggestion_pattern_type" AS ENUM ('MISSING_POLICY', 'OUTDATED_POLICY', 'RECURRING_EXCEPTION', 'INCONSISTENT_DECISIONS', 'NEW_ROUTING_RULE');

-- CreateEnum
CREATE TYPE "rule_suggestion_status" AS ENUM ('PROPOSED', 'ACCEPTED', 'DISMISSED');

-- CreateTable
CREATE TABLE "decision_feedback" (
    "id" UUID NOT NULL,
    "human_decision_id" UUID NOT NULL,
    "reason_code" "precedent_reason_code" NOT NULL,
    "missing_context" TEXT,
    "precedent_eligible" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "precedent_records" (
    "id" UUID NOT NULL,
    "decision_feedback_id" UUID NOT NULL,
    "access_request_id" UUID NOT NULL,
    "target_system" TEXT NOT NULL,
    "entitlement_key" TEXT NOT NULL,
    "department" TEXT,
    "cost_center" TEXT,
    "summary" TEXT NOT NULL,
    "embedding" vector(1536),
    "policy_version_snapshot" JSONB NOT NULL,
    "status" "precedent_status" NOT NULL DEFAULT 'PROPOSED',
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "revoked_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "precedent_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "precedent_records_embedding_idx" ON "precedent_records" USING hnsw ("embedding" vector_cosine_ops);

-- CreateTable
CREATE TABLE "precedent_citations" (
    "id" UUID NOT NULL,
    "ai_recommendation_id" UUID NOT NULL,
    "precedent_record_id" UUID NOT NULL,
    "relevance_reason" TEXT NOT NULL,
    "outcome_snapshot" TEXT NOT NULL,
    "summary_snapshot" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "precedent_citations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_suggestions" (
    "id" UUID NOT NULL,
    "pattern_type" "rule_suggestion_pattern_type" NOT NULL,
    "description" TEXT NOT NULL,
    "supporting_decision_ids" TEXT[],
    "status" "rule_suggestion_status" NOT NULL DEFAULT 'PROPOSED',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "decision_feedback_human_decision_id_key" ON "decision_feedback"("human_decision_id");

-- CreateIndex
CREATE UNIQUE INDEX "precedent_records_decision_feedback_id_key" ON "precedent_records"("decision_feedback_id");

-- CreateIndex
CREATE INDEX "precedent_records_target_system_entitlement_key_status_idx" ON "precedent_records"("target_system", "entitlement_key", "status");

-- CreateIndex
CREATE INDEX "precedent_citations_ai_recommendation_id_idx" ON "precedent_citations"("ai_recommendation_id");

-- CreateIndex
CREATE INDEX "precedent_citations_precedent_record_id_idx" ON "precedent_citations"("precedent_record_id");

-- AddForeignKey
ALTER TABLE "decision_feedback" ADD CONSTRAINT "decision_feedback_human_decision_id_fkey" FOREIGN KEY ("human_decision_id") REFERENCES "human_decisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "precedent_records" ADD CONSTRAINT "precedent_records_decision_feedback_id_fkey" FOREIGN KEY ("decision_feedback_id") REFERENCES "decision_feedback"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "precedent_records" ADD CONSTRAINT "precedent_records_access_request_id_fkey" FOREIGN KEY ("access_request_id") REFERENCES "access_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "precedent_citations" ADD CONSTRAINT "precedent_citations_ai_recommendation_id_fkey" FOREIGN KEY ("ai_recommendation_id") REFERENCES "ai_recommendations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "precedent_citations" ADD CONSTRAINT "precedent_citations_precedent_record_id_fkey" FOREIGN KEY ("precedent_record_id") REFERENCES "precedent_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
