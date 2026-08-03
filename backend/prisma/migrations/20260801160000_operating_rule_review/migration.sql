-- Rename applied_operating_rule_ids -> retrieved_operating_rule_ids.
--
-- The column was populated from the retrieval result, before the model had
-- even run, so "applied" asserted something the write could not know: it
-- recorded which rules were PRESENTED, not which the model acted on. Whether a
-- rule was judged applicable is now the model's own operating_rule_review
-- answer, verified deterministically by RecommendationGroundingService.
--
-- A rename preserves every existing row; no data is reinterpreted.
ALTER TABLE "ai_recommendations"
  RENAME COLUMN "applied_operating_rule_ids" TO "retrieved_operating_rule_ids";
