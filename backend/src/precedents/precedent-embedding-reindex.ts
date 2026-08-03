import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingsService } from '../rag/embeddings.service';
import { toVectorLiteral } from '../rag/rag.service';
import { buildPrecedentCaseFactsText } from './precedent-case-facts';
import { CURRENT_PRECEDENT_EMBEDDING_VERSION } from './precedent-embedding-version';

const REINDEX_BATCH_SIZE = 100;

/**
 * Replace every outdated precedent vector with the current canonical
 * request-facts representation. Version and vector move together in one
 * transaction, so retrieval never sees a current version paired with an old
 * vector. Safe to rerun: the version predicate makes completed rows no-ops.
 */
export async function reindexPrecedentEmbeddings(
  prisma: PrismaService,
  embeddings: EmbeddingsService,
): Promise<number> {
  let updated = 0;
  const findBatch = () =>
    prisma.precedentRecord.findMany({
      where: {
        embeddingVersion: { not: CURRENT_PRECEDENT_EMBEDDING_VERSION },
      },
      include: { accessRequest: true },
      orderBy: { createdAt: 'asc' },
      take: REINDEX_BATCH_SIZE,
    });

  let records = await findBatch();
  while (records.length > 0) {
    const vectors = await embeddings.embedBatch(
      records.map(({ accessRequest }) =>
        buildPrecedentCaseFactsText({
          requestType: accessRequest.requestType,
          targetSystem: accessRequest.targetSystem,
          entitlementKey: accessRequest.entitlementKey,
          requesterTitle: accessRequest.requesterTitle,
          requesterDepartment: accessRequest.requesterDepartment,
          requesterCostCenter: accessRequest.requesterCostCenter,
          justification: accessRequest.justification,
        }),
      ),
    );

    await prisma.$transaction(async (tx) => {
      for (let index = 0; index < records.length; index += 1) {
        const changed = await tx.$executeRaw`
          UPDATE precedent_records
          SET embedding = ${toVectorLiteral(vectors[index])}::vector,
              embedding_version = ${CURRENT_PRECEDENT_EMBEDDING_VERSION}
          WHERE id = ${records[index].id}::uuid
            AND embedding_version <> ${CURRENT_PRECEDENT_EMBEDDING_VERSION}
        `;
        updated += changed;
      }
    });

    records = await findBatch();
  }

  return updated;
}
