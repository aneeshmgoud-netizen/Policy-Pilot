// CLI: DLQ replay tool. There is no separate Redis dead-letter queue — a
// FAILED AccessRequest row in Postgres (plus its PROCESSING_FAILED audit
// trail, now including the masked stack trace) is already the durable,
// queryable record of what failed and why, so this reads from there rather
// than duplicating that tracking in Redis.
//
// For each targeted row: removes any existing (failed) BullMQ job with that
// id — necessary because BullMQ dedupes by jobId based on Redis key
// existence, and a failed job's key is never removed by default, so without
// this the re-add below would just resolve back to the old failed job
// instead of creating a fresh attempt — resets status to PENDING, records a
// REPLAY_ENQUEUED audit event, and re-enqueues with the same deterministic
// jobId (accessRequestId) the normal ingestion path uses.
//
// Run with:            npm run queue:replay-failed --workspace backend
// Replay a single row: npm run queue:replay-failed --workspace backend -- --request-id=<requestId>
//
// Requires DATABASE_URL and REDIS_URL in backend/.env (loaded via
// node --env-file; see the package.json script).
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { AccessRequestJobData } from '../access-request.processor';
import { ACCESS_REQUEST_QUEUE } from '../queue.constants';

const REPLAY_ACTOR = 'system:replay-cli';

function parseRequestIdArg(): string | null {
  const arg = process.argv.find((a) => a.startsWith('--request-id='));
  return arg ? arg.slice('--request-id='.length) : null;
}

async function main(): Promise<void> {
  const requestId = parseRequestIdArg();
  const prisma = new PrismaClient();
  const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  const queue = new Queue<AccessRequestJobData>(ACCESS_REQUEST_QUEUE, { connection });

  try {
    const failedRequests = await prisma.accessRequest.findMany({
      where: { status: 'FAILED', ...(requestId ? { requestId } : {}) },
      select: { id: true, requestId: true },
    });

    if (failedRequests.length === 0) {
      console.log(
        requestId
          ? `No FAILED request found with requestId=${requestId}.`
          : 'No FAILED requests found.',
      );
      return;
    }

    console.log(`Replaying ${failedRequests.length} FAILED request(s)...`);

    for (const request of failedRequests) {
      // Clear any existing (failed) job under this id first — see header
      // comment for why this is required for the re-add below to actually
      // create a new attempt rather than resolving back to the old one.
      await queue.remove(request.id);

      await prisma.$transaction([
        prisma.accessRequest.update({
          where: { id: request.id },
          data: { status: 'PENDING' },
        }),
        prisma.auditLog.create({
          data: {
            accessRequestId: request.id,
            eventType: 'REPLAY_ENQUEUED',
            actor: REPLAY_ACTOR,
            payload: { requestId: request.requestId },
          },
        }),
      ]);

      await queue.add(
        'process-access-request',
        { accessRequestId: request.id, requestId: request.requestId },
        { jobId: request.id },
      );

      console.log(`  replayed ${request.requestId} (accessRequestId=${request.id})`);
    }
  } finally {
    await queue.close();
    // queue.close() does not close a connection it didn't create itself —
    // since it was passed in explicitly here (so it can be quit cleanly
    // rather than left as an open handle keeping the process alive), it must
    // be closed separately.
    connection.disconnect();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Replay run failed:', err);
  process.exitCode = 1;
});
