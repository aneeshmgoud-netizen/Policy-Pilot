import {
  classifyExecutionError,
  EXECUTION_BOOKKEEPING_FAILED_CODE,
  EXECUTION_CLAIM_FAILED_CODE,
  EXECUTION_ERROR_CODES,
  executionErrorMessage,
  ExecutionErrorCode,
  NonRetryableExecutionError,
  OPERATIONAL_ERROR_CODES,
  runContentFree,
  SanitizedRetryableExecutionError,
} from './execution-error.util';

// Every sensitive shape a downstream/Prisma/Redis exception could carry.
const SENSITIVE_VALUES = [
  'EMP-52190',
  '52190',
  'CC-FIN-07',
  'FIN-07',
  'internal-provisioning.corp',
  'db-primary.internal',
  'hunter2',
  'sk-live-abcdefghijklmnopqrstuvwxyz123456',
  'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
];

const SENSITIVE_MESSAGE =
  'downstream call to internal-provisioning.corp failed for EMP-52190 in cost ' +
  'center CC-FIN-07: request to https://user:hunter2@db-primary.internal/api ' +
  'failed, Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz123456, ' +
  'token=zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';

function expectContentFree(surface: string) {
  for (const value of SENSITIVE_VALUES) {
    expect(surface).not.toContain(value);
  }
}

describe('classifyExecutionError', () => {
  it('returns only a code and that code’s fixed message — nothing from the exception body', () => {
    const err = new Error(SENSITIVE_MESSAGE);
    const { code, message } = classifyExecutionError(err);

    expectContentFree(message);
    expect(message).not.toContain(err.message);
    // The message is byte-identical to the code's table entry, so it cannot
    // carry anything exception-derived even incidentally.
    expect(message).toBe(executionErrorMessage(code));
  });

  it('does not even read err.message / err.stack / err.cause', () => {
    // A getter that throws if touched proves the exception body is never
    // inspected — a stronger guarantee than redacting whatever it contains.
    const err = new Error('placeholder');
    for (const prop of ['message', 'stack', 'cause']) {
      Object.defineProperty(err, prop, {
        get() {
          throw new Error(`classifyExecutionError must not read err.${prop}`);
        },
      });
    }

    expect(() => classifyExecutionError(err)).not.toThrow();
  });

  it('returns a stable code independent of message content', () => {
    const a = classifyExecutionError(new Error(SENSITIVE_MESSAGE));
    const b = classifyExecutionError(new Error('a completely different failure'));
    expect(a.code).toBe(b.code);
    expect(a.code).toBe('DOWNSTREAM_EXECUTION_FAILED');
    expect(a.message).toBe(b.message);
  });

  it('keeps DOWNSTREAM_REJECTED distinct from the retryable failure code', () => {
    const rejected = classifyExecutionError(
      new NonRetryableExecutionError(SENSITIVE_MESSAGE),
    );
    const retryable = classifyExecutionError(new Error(SENSITIVE_MESSAGE));

    expect(rejected.code).toBe('DOWNSTREAM_REJECTED');
    expect(retryable.code).toBe('DOWNSTREAM_EXECUTION_FAILED');
    expect(rejected.code).not.toBe(retryable.code);
    expect(rejected.message).not.toBe(retryable.message);
    expectContentFree(rejected.message);
  });

  it('handles non-Error thrown values without reading or echoing them', () => {
    const { message, code } = classifyExecutionError(
      `a bare string failure mentioning EMP-52190 at db-primary.internal`,
    );
    expect(code).toBe('DOWNSTREAM_EXECUTION_FAILED');
    expectContentFree(message);
  });

  it('every code has a bounded, non-empty fixed message', () => {
    for (const code of Object.values(EXECUTION_ERROR_CODES)) {
      const message = executionErrorMessage(code as ExecutionErrorCode);
      expect(message.length).toBeGreaterThan(0);
      expect(message.length).toBeLessThanOrEqual(500);
    }
  });
});

describe('runContentFree', () => {
  it('passes a successful value through unchanged', async () => {
    const result = await runContentFree(
      OPERATIONAL_ERROR_CODES.RECOVERY_CAS_FAILED,
      async () => ({ count: 1 }),
    );
    expect(result).toEqual({ ok: true, value: { count: 1 } });
  });

  it('reduces any thrown value to the caller’s stable code, with nothing exception-derived attached', async () => {
    const result = await runContentFree(
      OPERATIONAL_ERROR_CODES.RECOVERY_ENQUEUE_FAILED,
      async () => {
        throw new Error(SENSITIVE_MESSAGE);
      },
    );

    expect(result).toEqual({
      ok: false,
      code: OPERATIONAL_ERROR_CODES.RECOVERY_ENQUEUE_FAILED,
    });
    // The whole result object is content-free — there is no field anywhere on
    // it that could carry the exception forward.
    expectContentFree(JSON.stringify(result));
    expect(Object.keys(result).sort()).toEqual(['code', 'ok']);
  });

  it('absorbs non-Error thrown values (strings, objects) the same way', async () => {
    for (const thrown of [SENSITIVE_MESSAGE, { detail: SENSITIVE_MESSAGE }, 42, null]) {
      const result = await runContentFree(
        OPERATIONAL_ERROR_CODES.RECOVERY_SCAN_FAILED,
        async () => {
          throw thrown;
        },
      );
      expect(result.ok).toBe(false);
      expectContentFree(JSON.stringify(result));
    }
  });

  it('never rejects, so it cannot propagate a raw exception across a Nest/BullMQ boundary', async () => {
    await expect(
      runContentFree(OPERATIONAL_ERROR_CODES.RECOVERY_AUDIT_FAILED, async () => {
        throw new Error(SENSITIVE_MESSAGE);
      }),
    ).resolves.toBeDefined();
  });
});

describe('SanitizedRetryableExecutionError', () => {
  it('carries only the stable code — its message and stack are content-free', () => {
    const original = new Error(SENSITIVE_MESSAGE);
    const { code } = classifyExecutionError(original);
    const wrapped = new SanitizedRetryableExecutionError(code);

    for (const surface of [wrapped.message, wrapped.stack ?? '']) {
      expectContentFree(surface);
      expect(surface).not.toContain(original.message);
    }
    expect(wrapped.code).toBe(code);
    expect(wrapped.message).toContain(code);
  });

  it('does not attach the original exception as `cause` or any other enumerable/serializable field', () => {
    const wrapped = new SanitizedRetryableExecutionError(
      EXECUTION_CLAIM_FAILED_CODE,
    );
    expect('cause' in wrapped).toBe(false);
    expect(Object.keys(wrapped).sort()).toEqual(['code', 'name']);
    expect(JSON.stringify(wrapped)).not.toMatch(/EMP-|Bearer|sk-live|internal/);
  });

  it('exposes distinct stable codes for claim vs. bookkeeping boundary failures', () => {
    expect(EXECUTION_CLAIM_FAILED_CODE).not.toBe(EXECUTION_BOOKKEEPING_FAILED_CODE);
    expect(new SanitizedRetryableExecutionError(EXECUTION_CLAIM_FAILED_CODE).code).toBe(
      EXECUTION_CLAIM_FAILED_CODE,
    );
    expect(
      new SanitizedRetryableExecutionError(EXECUTION_BOOKKEEPING_FAILED_CODE).code,
    ).toBe(EXECUTION_BOOKKEEPING_FAILED_CODE);
  });
});
