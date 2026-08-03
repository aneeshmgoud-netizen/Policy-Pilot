-- Provenance for AI recommendations.
--
-- ai_recommendations.decision/justification/confidence hold the EFFECTIVE
-- recommendation (post-grounding). Until now, when RecommendationGroundingService
-- overrode a model decision, the row still carried the model's name and the
-- model's confidence, so a deterministic escalation was indistinguishable from
-- the model's own judgment in both the API and the dashboard.
--
-- All three columns are nullable with no default and no backfill: existing rows
-- genuinely do not know their own provenance, and defaulting them to 'MODEL'
-- would assert something untrue about history. Readers must treat NULL as
-- "recorded before provenance tracking existed", the same way
-- execution_status.UNKNOWN_LEGACY is treated.

CREATE TYPE "decision_source" AS ENUM ('MODEL', 'SOD_RULE', 'GROUNDING_GATE');

ALTER TABLE "ai_recommendations"
  ADD COLUMN "model_decision" "decision",
  ADD COLUMN "model_confidence" DOUBLE PRECISION,
  ADD COLUMN "decision_source" "decision_source";
