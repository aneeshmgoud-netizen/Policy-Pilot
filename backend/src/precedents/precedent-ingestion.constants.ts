import { JobsOptions } from 'bullmq';

export const PRECEDENT_INGESTION_QUEUE = 'precedent-ingestion';
export const PRECEDENT_INGESTION_JOB_NAME = 'ingest-precedent';

// PostgreSQL (the PrecedentRecord row) is the durable state, not Redis — same
// reasoning as DECISION_EXECUTION_DEFAULT_JOB_OPTIONS. Unlike execution, a
// failed or lost precedent-ingestion job has no sweeper recovery in this phase
// (see PrecedentIngestionService's docblock) — that's an accepted, documented
// gap for this non-safety-critical path, not an oversight.
export const PRECEDENT_INGESTION_DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000, jitter: 0.5 },
  removeOnComplete: true,
  removeOnFail: true,
};
