-- Repairs data that predates (or was created between) the decision/execution
-- model migrations:
--   1. Every human_decisions row must have exactly one decision_executions
--      row (the outbox invariant DecisionsService and the execution
--      processor now assume). Rows missing one are backfilled with the
--      honest UNKNOWN_LEGACY status — never SUCCEEDED, since we cannot know
--      whether the old synchronous ExecutionAdapter call actually completed
--      before this table existed.
--   2. overrides_recommendation is recomputed from the linked
--      ai_recommendations.decision, which is authoritative and doesn't
--      depend on how the old decisionType/OVERRIDE column happened to be
--      set: AI APPROVE implies GRANT, AI DENY implies DENY: agreement is
--      overrides_recommendation = FALSE, anything else (a mismatch, an
--      ESCALATE recommendation, or no linked recommendation at all) is
--      TRUE.
--
-- Duplicate legacy human decisions per access request: not handled here by
-- choice, because they cannot exist by the time this migration runs. Migration
-- 20260729120000_decision_execution_model added a UNIQUE constraint on
-- human_decisions.access_request_id, and it was verified against this exact
-- database (zero duplicate access_request_id rows) before that constraint was
-- added — so Postgres has been structurally rejecting a second decision per
-- request ever since. Nothing between that migration and this one can have
-- introduced a duplicate.
--
-- This migration is safe and deterministic both on a fresh database (zero
-- human_decisions rows -> every query below is a no-op) and on a database
-- with decisions that predate decision_executions entirely (the LEFT JOIN
-- backfill below catches them regardless of *why* the row is missing).

-- Precondition: refuse to silently either fabricate a reviewer rationale or
-- violate the existing override-requires-rationale CHECK constraint. If
-- recomputing overrides_recommendation from the AI recommendation would flip
-- any row to TRUE while it has no rationale on file, stop with a clear,
-- actionable error instead of a raw constraint-violation trace. As of writing
-- this is a verified no-op against the live database (zero such rows).
DO $$
DECLARE
  problem_count INTEGER;
BEGIN
  SELECT count(*) INTO problem_count
  FROM "human_decisions" hd
  LEFT JOIN "ai_recommendations" ar ON ar.id = hd.ai_recommendation_id
  WHERE NOT (
    (ar.decision = 'APPROVE' AND hd.outcome = 'GRANT') OR
    (ar.decision = 'DENY' AND hd.outcome = 'DENY')
  )
  AND (hd.rationale IS NULL OR length(trim(hd.rationale)) = 0);

  IF problem_count > 0 THEN
    RAISE EXCEPTION 'decision_execution_backfill: % human_decisions recompute to overrides_recommendation=TRUE under the AI-recommendation mapping but have no rationale on file. Refusing to fabricate a reviewer rationale or silently violate human_decisions_override_requires_rationale. Resolve manually (attach a documented rationale such as ''backfilled: legacy decision predates override auditing, disagreement confirmed from audit_log'') and re-run, or exclude the specific row(s) after manual review.', problem_count;
  END IF;
END $$;

-- Recompute overrides_recommendation from the linked AI recommendation.
UPDATE "human_decisions" hd
SET "overrides_recommendation" = NOT (
  (ar.decision = 'APPROVE' AND hd.outcome = 'GRANT') OR
  (ar.decision = 'DENY' AND hd.outcome = 'DENY')
)
FROM "ai_recommendations" ar
WHERE hd."ai_recommendation_id" = ar.id;

-- A decision with no linked recommendation at all has nothing to agree
-- with, so it counts as an override too.
UPDATE "human_decisions"
SET "overrides_recommendation" = TRUE
WHERE "ai_recommendation_id" IS NULL;

-- Backfill exactly one decision_executions row for every human_decisions row
-- that doesn't already have one.
INSERT INTO "decision_executions"
  (id, human_decision_id, outcome, status, attempts, last_error, error_code, executed_at, created_at, updated_at)
SELECT
  gen_random_uuid(), hd.id, hd.outcome, 'UNKNOWN_LEGACY', 0, NULL, NULL, NULL, hd.created_at, hd.created_at
FROM "human_decisions" hd
LEFT JOIN "decision_executions" de ON de."human_decision_id" = hd.id
WHERE de.id IS NULL;
