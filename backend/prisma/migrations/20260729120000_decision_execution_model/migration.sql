-- Replace the ambiguous APPROVE/DENY/OVERRIDE decisionType with a final,
-- unambiguous execution outcome (GRANT/DENY) plus an explicit
-- overrides_recommendation flag, and add a durable, idempotent execution
-- record per decision.

-- CreateEnum
CREATE TYPE "execution_outcome" AS ENUM ('GRANT', 'DENY');

-- CreateEnum
CREATE TYPE "execution_status" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- Drop the old override-requires-rationale CHECK; a new one is added below
-- against the new column.
ALTER TABLE "human_decisions" DROP CONSTRAINT "human_decisions_override_requires_rationale";

-- AlterTable: add the new columns, backfill from the old `decision` column,
-- then drop it.
ALTER TABLE "human_decisions" ADD COLUMN "outcome" "execution_outcome";
ALTER TABLE "human_decisions" ADD COLUMN "overrides_recommendation" BOOLEAN;

-- Backfill: OVERRIDE previously always executed as a grant (see the old
-- ExecutionAdapter mapping) and is the only decisionType that was ever
-- treated as a disagreement with the AI recommendation.
UPDATE "human_decisions" SET
  "outcome" = CASE WHEN "decision" = 'DENY' THEN 'DENY' ELSE 'GRANT' END::"execution_outcome",
  "overrides_recommendation" = ("decision" = 'OVERRIDE');

ALTER TABLE "human_decisions" ALTER COLUMN "outcome" SET NOT NULL;
ALTER TABLE "human_decisions" ALTER COLUMN "overrides_recommendation" SET NOT NULL;

ALTER TABLE "human_decisions" DROP COLUMN "decision";
DROP TYPE "human_decision_type";

-- One terminal decision per access request, enforced at the DB level so a
-- race between two concurrent decision submissions can't both succeed.
DROP INDEX "human_decisions_access_request_id_idx";
ALTER TABLE "human_decisions" ADD CONSTRAINT "human_decisions_access_request_id_key" UNIQUE ("access_request_id");

ALTER TABLE "human_decisions" ADD CONSTRAINT "human_decisions_override_requires_rationale"
  CHECK ("overrides_recommendation" = FALSE OR ("rationale" IS NOT NULL AND length(trim("rationale")) > 0));

-- CreateTable
CREATE TABLE "decision_executions" (
    "id" UUID NOT NULL,
    "human_decision_id" UUID NOT NULL,
    "outcome" "execution_outcome" NOT NULL,
    "status" "execution_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "executed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "decision_executions_human_decision_id_key" ON "decision_executions"("human_decision_id");

-- AddForeignKey
ALTER TABLE "decision_executions" ADD CONSTRAINT "decision_executions_human_decision_id_fkey" FOREIGN KEY ("human_decision_id") REFERENCES "human_decisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
