import {
  DECISION_EXECUTION_DEFAULT_JOB_OPTIONS,
  PROCESSING_LEASE_DURATION_MS,
  RECOVERY_LEASE_DURATION_MS,
  STALE_PENDING_THRESHOLD_MS,
  SWEEP_INTERVAL_MS,
} from './decision-execution.constants';

describe('DECISION_EXECUTION_DEFAULT_JOB_OPTIONS', () => {
  it('removes terminal jobs immediately so they never permanently reserve a deterministic jobId', () => {
    expect(DECISION_EXECUTION_DEFAULT_JOB_OPTIONS.removeOnComplete).toBe(true);
    expect(DECISION_EXECUTION_DEFAULT_JOB_OPTIONS.removeOnFail).toBe(true);
  });

  it('gives the recovery lease a shorter life than the processing lease', () => {
    // A sweeper's recovery is a few Redis calls plus one insert, so a dead
    // owner should be replaceable well before a dead worker's claim lapses.
    expect(RECOVERY_LEASE_DURATION_MS).toBeLessThan(PROCESSING_LEASE_DURATION_MS);
    expect(RECOVERY_LEASE_DURATION_MS).toBeGreaterThan(0);
  });

  it('lets a sweep interval elapse well within a processing lease, so leases are not missed', () => {
    expect(SWEEP_INTERVAL_MS).toBeLessThan(PROCESSING_LEASE_DURATION_MS);
    expect(SWEEP_INTERVAL_MS).toBeLessThanOrEqual(STALE_PENDING_THRESHOLD_MS);
  });

  it('preserves the existing retry policy', () => {
    expect(DECISION_EXECUTION_DEFAULT_JOB_OPTIONS.attempts).toBe(3);
    expect(DECISION_EXECUTION_DEFAULT_JOB_OPTIONS.backoff).toEqual({
      type: 'exponential',
      delay: 1000,
      jitter: 0.5,
    });
  });
});
