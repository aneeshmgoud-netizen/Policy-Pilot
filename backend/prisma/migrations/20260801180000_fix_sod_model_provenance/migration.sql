-- A deterministic SoD short-circuit does not invoke an LLM. Earlier writes
-- copied the rule's DENY into model_decision/model_confidence, which caused
-- reviewer agreement to be recorded as agreement with AI even though no AI
-- recommendation existed.
--
-- Correct the relational provenance and derived feedback. Audit rows remain
-- append-only and continue to describe what the application recorded at the
-- time.

UPDATE "human_decisions" AS h
SET "agreed_with_ai" = NULL
FROM "ai_recommendations" AS a
WHERE h."ai_recommendation_id" = a."id"
  AND a."model_name" = 'system:sod-conflict-rule';

UPDATE "ai_recommendations"
SET
  "model_decision" = NULL,
  "model_confidence" = NULL
WHERE "model_name" = 'system:sod-conflict-rule';

