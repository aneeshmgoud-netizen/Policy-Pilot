-- Governed operating rules.
--
-- Accepting a RuleSuggestion previously changed nothing any future request
-- could read: nothing in the recommendation path queried rule_suggestions, so
-- an accepted rule influenced later requests only indirectly, by promoting
-- precedents nominated behind it. operating_rules is the first-class row that
-- retrieval actually reads, so an approved change influences a later request
-- on its own terms — with no code or prompt deployment.
--
-- No PROPOSED state: the rule does not exist until a governance approver
-- writes one, so creation is the approval.

CREATE TYPE "operating_rule_status" AS ENUM ('ACTIVE', 'REVOKED');

CREATE TABLE "operating_rules" (
  "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
  "rule_suggestion_id" UUID NOT NULL,
  "target_system"      TEXT NOT NULL,
  "entitlement_key"    TEXT NOT NULL,
  "pattern_type"       "rule_suggestion_pattern_type" NOT NULL,
  "guidance"           TEXT NOT NULL,
  "status"             "operating_rule_status" NOT NULL DEFAULT 'ACTIVE',
  "approved_by"        TEXT NOT NULL,
  "approved_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_by"         TEXT,
  "revoked_reason"     TEXT,
  "revoked_at"         TIMESTAMP(3),
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "operating_rules_pkey" PRIMARY KEY ("id")
);

-- One rule per accepted suggestion: acceptance is a single governance act and
-- cannot silently produce competing guidance for the same pattern.
CREATE UNIQUE INDEX "operating_rules_rule_suggestion_id_key"
  ON "operating_rules"("rule_suggestion_id");

-- Supports the recommendation-time lookup: ACTIVE rules for one scope.
CREATE INDEX "operating_rules_target_system_entitlement_key_status_idx"
  ON "operating_rules"("target_system", "entitlement_key", "status");

ALTER TABLE "operating_rules"
  ADD CONSTRAINT "operating_rules_rule_suggestion_id_fkey"
  FOREIGN KEY ("rule_suggestion_id") REFERENCES "rule_suggestions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Which rules were in scope when a recommendation was generated. Defaults to
-- empty rather than NULL: "no rules applied" is the honest description of
-- every row written before operating rules existed, and is also the ordinary
-- steady state.
ALTER TABLE "ai_recommendations"
  ADD COLUMN "applied_operating_rule_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
