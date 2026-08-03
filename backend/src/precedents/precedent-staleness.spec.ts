import { isPrecedentStale } from './precedent-staleness';

describe('isPrecedentStale', () => {
  const currentVersions = [
    { documentName: 'POL-DATA-001', version: '3.4.1' },
    { documentName: 'POL-FIN-003', version: '2.1.0' },
  ];

  it('keeps a snapshot whose documents all match the current corpus', () => {
    expect(isPrecedentStale(currentVersions, currentVersions)).toBe(false);
  });

  it('marks a snapshot stale when one document version has changed', () => {
    expect(
      isPrecedentStale(
        [
          { documentName: 'POL-DATA-001', version: '3.4.0' },
          { documentName: 'POL-FIN-003', version: '2.1.0' },
        ],
        currentVersions,
      ),
    ).toBe(true);
  });

  it('marks a snapshot stale when a snapshotted document was removed', () => {
    expect(
      isPrecedentStale(
        [{ documentName: 'POL-REMOVED-001', version: '1.0.0' }],
        currentVersions,
      ),
    ).toBe(true);
  });

  it.each([
    null,
    'not an array',
    {},
    [null],
    [{ documentName: 'POL-DATA-001' }],
  ])('fails closed for malformed snapshot data: %p', (snapshot) => {
    expect(isPrecedentStale(snapshot, currentVersions)).toBe(true);
  });

  it('treats an empty snapshot against an empty corpus as fresh', () => {
    expect(isPrecedentStale([], [])).toBe(false);
  });
});
