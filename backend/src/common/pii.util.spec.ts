import {
  maskCostCenter,
  maskEmployeeId,
  maskIdentifier,
  maskPii,
  redactPiiInText,
} from './pii.util';

describe('maskIdentifier', () => {
  it('masks the body of an employee ID while keeping the prefix and last two chars', () => {
    expect(maskEmployeeId('EMP-52190')).toBe('EMP-***90');
  });

  it('masks the body of a multi-segment cost center', () => {
    expect(maskCostCenter('CC-FIN-07')).toBe('CC-****07');
  });

  it('never leaks the full identifier', () => {
    const original = 'EMP-52190';
    expect(maskIdentifier(original)).not.toContain('5219');
  });

  it('masks everything when the body is at or below the visible-suffix length', () => {
    expect(maskIdentifier('EMP-7')).toBe('EMP-*');
    expect(maskIdentifier('EMP-42')).toBe('EMP-**');
  });

  it('masks a value with no hyphen prefix by treating the whole string as the body', () => {
    expect(maskIdentifier('123456')).toBe('****56');
  });

  it('passes null and undefined through unchanged', () => {
    expect(maskIdentifier(null)).toBeNull();
    expect(maskIdentifier(undefined)).toBeUndefined();
  });

  it('passes an empty string through unchanged', () => {
    expect(maskIdentifier('')).toBe('');
  });
});

describe('redactPiiInText', () => {
  it('masks an employee id embedded in a free-text error message', () => {
    const text = 'lookup failed for EMP-52190 in cost center CC-FIN-07';
    const redacted = redactPiiInText(text);
    expect(redacted).toBe('lookup failed for EMP-***90 in cost center CC-****07');
    expect(redacted).not.toContain('52190');
    expect(redacted).not.toContain('FIN-07');
  });

  it('masks multiple identifiers of the same type in one string', () => {
    const redacted = redactPiiInText('EMP-11111 requested access for EMP-22222');
    expect(redacted).toBe('EMP-***11 requested access for EMP-***22');
  });

  it('returns harmless text unchanged when no identifiers are present', () => {
    const text = 'connection timed out after 30s';
    expect(redactPiiInText(text)).toBe(text);
  });
});

describe('maskPii', () => {
  it('masks an employee id nested inside an object', () => {
    const input = { message: 'access denied', employeeId: 'EMP-52190' };
    expect(maskPii(input)).toEqual({
      message: 'access denied',
      employeeId: 'EMP-***90',
    });
  });

  it('masks identifiers embedded in nested objects and arrays', () => {
    const input = {
      error: 'failed for EMP-52190',
      context: {
        costCenters: ['CC-FIN-07', 'CC-ENG-03'],
        note: 'reviewed by CC-GOV-01',
      },
    };
    expect(maskPii(input)).toEqual({
      error: 'failed for EMP-***90',
      context: {
        costCenters: ['CC-****07', 'CC-****03'],
        note: 'reviewed by CC-****01',
      },
    });
  });

  it('returns harmless data completely unmodified', () => {
    const input = {
      requestId: 'req-1',
      status: 'PENDING',
      count: 3,
      active: true,
      tags: ['a', 'b'],
    };
    expect(maskPii(input)).toEqual(input);
  });

  it('passes non-object primitives and null through unchanged', () => {
    expect(maskPii(42)).toBe(42);
    expect(maskPii(true)).toBe(true);
    expect(maskPii(null)).toBeNull();
    expect(maskPii(undefined)).toBeUndefined();
  });

  it('does not descend into Date instances', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    expect(maskPii(date)).toBe(date);
  });
});
