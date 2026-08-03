import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EmbeddingsService } from '../../rag/embeddings.service';
import { reindexPrecedentEmbeddings } from '../precedent-embedding-reindex';
import { CURRENT_PRECEDENT_EMBEDDING_VERSION } from '../precedent-embedding-version';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const embeddings = new EmbeddingsService({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_EMBEDDING_MODEL,
  });

  try {
    const updated = await reindexPrecedentEmbeddings(
      prisma as unknown as PrismaService,
      embeddings,
    );
    console.log(
      `Reindexed ${updated} precedent embedding(s) to canonical version ` +
        `${CURRENT_PRECEDENT_EMBEDDING_VERSION}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(
    `Precedent reindex failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
