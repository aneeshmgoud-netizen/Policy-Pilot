-- AlterTable
ALTER TABLE "rule_suggestions"
ADD COLUMN "entitlement_key" TEXT NOT NULL,
ADD COLUMN "review_note" TEXT,
ADD COLUMN "target_system" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "rule_suggestions_pattern_type_target_system_entitlement_key_key"
ON "rule_suggestions"("pattern_type", "target_system", "entitlement_key");
