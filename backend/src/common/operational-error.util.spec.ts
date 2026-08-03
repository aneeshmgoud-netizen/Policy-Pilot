import {
  runContentFree,
  SanitizedOperationalError,
} from './operational-error.util';

const SENTINELS = [
  'EMP-52190',
  '52190',
  'CC-FIN-07',
  'internal-redis.corp',
  'db-primary.internal',
  'redis://admin:secret@host',
  'admin:secret',
  'Bearer abc123',
];

const SENTINEL_MESSAGE =
  'failed for EMP-52190 (CC-FIN-07) via redis://admin:secret@host and ' +
  'db-primary.internal, Authorization: Bearer abc123, upstream internal-redis.corp';

function expectContentFree(surface: string) {
  for (const sentinel of SENTINELS) {
    expect(surface).not.toContain(sentinel);
  }
}

describe('runContentFree', () => {
  it('passes a successful value through unchanged', async () => {
    await expect(runContentFree('X_FAILED', async () => 42)).resolves.toEqual({
      ok: true,
      value: 42,
    });
  });

  it('reduces any thrown value to the caller’s stable code and nothing else', async () => {
    const result = await runContentFree('X_FAILED', async () => {
      throw new Error(SENTINEL_MESSAGE);
    });

    expect(result).toEqual({ ok: false, code: 'X_FAILED' });
    expect(Object.keys(result).sort()).toEqual(['code', 'ok']);
    expectContentFree(JSON.stringify(result));
  });

  it('never reads the exception body — not message, stack, cause, or name', async () => {
    // Getters that throw if touched prove the body is never inspected, which
    // is a stronger guarantee than any assertion about redaction output.
    const err = new Error('placeholder');
    for (const prop of ['message', 'stack', 'cause', 'name']) {
      Object.defineProperty(err, prop, {
        get() {
          throw new Error(`runContentFree must not read err.${prop}`);
        },
      });
    }

    await expect(
      runContentFree('X_FAILED', async () => {
        throw err;
      }),
    ).resolves.toEqual({ ok: false, code: 'X_FAILED' });
  });

  it('absorbs non-Error thrown values identically', async () => {
    for (const thrown of [SENTINEL_MESSAGE, { detail: SENTINEL_MESSAGE }, 0, null]) {
      const result = await runContentFree('X_FAILED', async () => {
        throw thrown;
      });
      expect(result.ok).toBe(false);
      expectContentFree(JSON.stringify(result));
    }
  });

  it('never rejects, so a raw exception cannot cross a Nest/BullMQ boundary through it', async () => {
    await expect(
      runContentFree('X_FAILED', async () => {
        throw new Error(SENTINEL_MESSAGE);
      }),
    ).resolves.toBeDefined();
  });
});

describe('SanitizedOperationalError', () => {
  it('carries only the code and the fixed message it was given, with an overridden stack and no cause', () => {
    const err = new SanitizedOperationalError(
      'TestError',
      'X_FAILED',
      'Something failed (X_FAILED).',
    );

    expect(err.code).toBe('X_FAILED');
    expect(err.name).toBe('TestError');
    expect(err.stack).toBe('TestError: Something failed (X_FAILED).');
    // No V8-captured frames, so no incidentally-embedded content.
    expect(err.stack).not.toContain('at ');
    expect('cause' in err).toBe(false);
    expect(Object.keys(err).sort()).toEqual(['code', 'name']);
  });

  it('is a real Error, so framework error handling still works', () => {
    const err = new SanitizedOperationalError('TestError', 'X_FAILED', 'msg');
    expect(err).toBeInstanceOf(Error);
  });
});
