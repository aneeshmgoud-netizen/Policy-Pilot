-- DropIndex
DROP INDEX "policy_chunks_embedding_idx";

-- AlterTable
ALTER TABLE "access_requests" ADD COLUMN     "entitlement_snapshot" JSONB;
