import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingsService } from '../rag/embeddings.service';
import {
  MIN_PRECEDENT_SIMILARITY,
  PrecedentRetrievalService,
  RetrievedPrecedent,
  buildPrecedentFilterConditions,
  toAgentPrecedent,
} from './precedent-retrieval.service';

const CASE_FACTS = {
  requestType: 'GRANT_ENTITLEMENT',
  targetSystem: 'DATA_WAREHOUSE',
  entitlementKey: 'FIN_DATASET_READ',
  requesterTitle: 'Finance Analyst',
  requesterDepartment: 'Finance',
  requesterCostCenter: 'CC-FIN-12',
  justification: 'Need read access for monthly reporting.',
};

describe('buildPrecedentFilterConditions', () => {
  it('always requires active, current-version, exact-scope precedent', () => {
    const sql = buildPrecedentFilterConditions(CASE_FACTS);

    expect(sql.values).toEqual([2, 'DATA_WAREHOUSE', 'FIN_DATASET_READ']);
    expect(sql.strings.join(' ')).toContain("pr.status = 'ACTIVE'");
    expect(sql.strings.join(' ')).toContain('pr.embedding_version');
  });

  it('binds scope values rather than interpolating them', () => {
    const sql = buildPrecedentFilterConditions(CASE_FACTS);

    expect(sql.values).toEqual([2, 'DATA_WAREHOUSE', 'FIN_DATASET_READ']);
    const text = sql.strings.join(' ');
    expect(text).toContain("pr.status = 'ACTIVE'");
    expect(text).toContain('pr.target_system');
    expect(text).toContain('pr.entitlement_key');
    expect(text).not.toContain('DATA_WAREHOUSE');
    expect(text).not.toContain('FIN_DATASET_READ');
  });
});

describe('toAgentPrecedent', () => {
  const RETRIEVED: RetrievedPrecedent = {
    id: 'precedent-1',
    summary: 'A related reviewed case.',
    outcome: 'GRANT',
    targetSystem: 'DATA_WAREHOUSE',
    entitlementKey: 'FIN_DATASET_READ',
    department: 'Finance Analytics',
    costCenter: 'CC-FIN-07',
    policyVersionSnapshot: [{ documentName: 'POL-DATA-001', version: '3.4.1' }],
    createdAt: new Date('2026-07-30T12:00:00.000Z'),
    similarity: 0.91,
  };

  it('forwards the applicability facts the prompt asks the model to weigh', () => {
    // Regression guard for a real defect: retrieval returned department,
    // costCenter and createdAt, and the worker's inline mapping silently
    // dropped all three — so the model was asked whether a precedent covered
    // the "same eligible department/cost-center category" using data it had
    // never been shown.
    expect(toAgentPrecedent(RETRIEVED)).toEqual({
      id: 'precedent-1',
      summary: 'A related reviewed case.',
      outcome: 'GRANT',
      targetSystem: 'DATA_WAREHOUSE',
      entitlementKey: 'FIN_DATASET_READ',
      department: 'Finance Analytics',
      costCenter: 'CC-FIN-07',
      recordedAt: '2026-07-30T12:00:00.000Z',
      similarity: 0.91,
    });
  });

  it('never forwards the policy version snapshot — staleness is already settled in code', () => {
    expect(toAgentPrecedent(RETRIEVED)).not.toHaveProperty(
      'policyVersionSnapshot',
    );
  });

  it('accepts a createdAt that arrived as a JSON string rather than a Date', () => {
    const fromFixture = {
      ...RETRIEVED,
      createdAt: '2026-07-30T12:00:00.000Z' as unknown as Date,
    };
    expect(toAgentPrecedent(fromFixture).recordedAt).toBe(
      '2026-07-30T12:00:00.000Z',
    );
  });
});

describe('PrecedentRetrievalService.retrieveRelevantPrecedents', () => {
  function makeService(rows: unknown[]) {
    const embeddings = {
      embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    } as unknown as EmbeddingsService;
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue(rows),
      policyDocument: {
        findMany: jest.fn().mockResolvedValue([
          { documentName: 'POL-DATA-001', version: '3.4.1' },
        ]),
      },
    } as unknown as PrismaService & { $queryRaw: jest.Mock };
    return {
      service: new PrecedentRetrievalService(prisma, embeddings),
      embeddings,
      prisma,
    };
  }

  it('embeds the query and maps rows, coercing similarity to a number', async () => {
    const createdAt = new Date('2026-07-30T12:00:00.000Z');
    const { service, embeddings } = makeService([
      {
        id: 'precedent-1',
        summary: 'A related reviewed case.',
        outcome: 'GRANT',
        targetSystem: 'DATA_WAREHOUSE',
        entitlementKey: 'FIN_DATASET_READ',
        department: 'Finance',
        costCenter: 'CC-FIN-12',
        policyVersionSnapshot: [{ documentName: 'POL-DATA-001', version: '3.4.1' }],
        createdAt,
        similarity: '0.89',
      },
    ]);

    const result = await service.retrieveRelevantPrecedents(CASE_FACTS);

    expect(embeddings.embed).toHaveBeenCalledWith(
      [
        'Request type: GRANT_ENTITLEMENT',
        'Target system: DATA_WAREHOUSE',
        'Entitlement: FIN_DATASET_READ',
        'Requester title: Finance Analyst',
        'Requester department: Finance',
        'Requester cost center: CC-FIN-12',
        'Business justification: Need read access for monthly reporting.',
      ].join('\n'),
    );
    expect(result).toEqual([
      {
        id: 'precedent-1',
        summary: 'A related reviewed case.',
        outcome: 'GRANT',
        targetSystem: 'DATA_WAREHOUSE',
        entitlementKey: 'FIN_DATASET_READ',
        department: 'Finance',
        costCenter: 'CC-FIN-12',
        policyVersionSnapshot: [
          { documentName: 'POL-DATA-001', version: '3.4.1' },
        ],
        createdAt,
        similarity: 0.89,
      },
    ]);
  });

  it('binds the vector, optional filters, and limit without interpolation', async () => {
    const { service, prisma } = makeService([]);
    const queryRaw = (prisma as unknown as { $queryRaw: jest.Mock }).$queryRaw;

    await service.retrieveRelevantPrecedents(CASE_FACTS, { limit: 3 });

    const sqlArg = queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(sqlArg.values).toEqual(
      expect.arrayContaining([
        '[0.1,0.2,0.3]',
        2,
        'DATA_WAREHOUSE',
        'FIN_DATASET_READ',
        9,
      ]),
    );
    const text = sqlArg.strings.join(' ');
    expect(text).toContain("pr.status = 'ACTIVE'");
    expect(text).not.toContain('DATA_WAREHOUSE');
    expect(text).not.toContain('FIN_DATASET_READ');
  });

  it('defaults to a limit of 5 and still requires ACTIVE status', async () => {
    const { service, prisma } = makeService([]);
    const queryRaw = (prisma as unknown as { $queryRaw: jest.Mock }).$queryRaw;

    await service.retrieveRelevantPrecedents(CASE_FACTS);

    const sqlArg = queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(sqlArg.values).toContain(15);
    expect(sqlArg.strings.join(' ')).toContain("pr.status = 'ACTIVE'");
  });

  it('excludes stale rows without letting them count against the requested fresh limit', async () => {
    const createdAt = new Date('2026-07-30T12:00:00.000Z');
    const base = {
      summary: 'A related reviewed case.',
      outcome: 'GRANT',
      targetSystem: 'DATA_WAREHOUSE',
      entitlementKey: 'FIN_DATASET_READ',
      department: 'Finance',
      costCenter: 'CC-FIN-12',
      createdAt,
    };
    const { service } = makeService([
      {
        ...base,
        id: 'stale-highest-similarity',
        policyVersionSnapshot: [
          { documentName: 'POL-DATA-001', version: '3.4.0' },
        ],
        similarity: '0.99',
      },
      {
        ...base,
        id: 'fresh-1',
        policyVersionSnapshot: [
          { documentName: 'POL-DATA-001', version: '3.4.1' },
        ],
        similarity: '0.91',
      },
      {
        ...base,
        id: 'fresh-2',
        outcome: 'DENY',
        policyVersionSnapshot: [
          { documentName: 'POL-DATA-001', version: '3.4.1' },
        ],
        similarity: '0.87',
      },
    ]);

    const result = await service.retrieveRelevantPrecedents(CASE_FACTS, {
      limit: 2,
    });

    expect(result.map((precedent) => precedent.id)).toEqual([
      'fresh-1',
      'fresh-2',
    ]);
    expect(result.map((precedent) => precedent.outcome)).toEqual([
      'GRANT',
      'DENY',
    ]);
  });

  it('drops rows below the similarity floor — vector search always returns the nearest N, however far away they are', async () => {
    // Without a floor, the least-unrelated case in the corpus is presented as
    // "relevant precedent" purely because nothing closer exists. The brief
    // requires avoiding precedents that "do not sufficiently match the
    // current case".
    const createdAt = new Date('2026-07-30T12:00:00.000Z');
    const base = {
      summary: 'A related reviewed case.',
      outcome: 'GRANT',
      targetSystem: 'DATA_WAREHOUSE',
      entitlementKey: 'FIN_DATASET_READ',
      department: 'Finance',
      costCenter: 'CC-FIN-12',
      createdAt,
      policyVersionSnapshot: [{ documentName: 'POL-DATA-001', version: '3.4.1' }],
    };
    const { service } = makeService([
      { ...base, id: 'close-enough', similarity: String(MIN_PRECEDENT_SIMILARITY) },
      { ...base, id: 'too-distant', similarity: String(MIN_PRECEDENT_SIMILARITY - 0.01) },
    ]);

    const result = await service.retrieveRelevantPrecedents(CASE_FACTS);

    // The floor is inclusive: a row exactly at the threshold is kept.
    expect(result.map((precedent) => precedent.id)).toEqual(['close-enough']);
  });

  it('returns nothing rather than the best of a bad set when every candidate is too distant', async () => {
    const { service } = makeService([
      {
        id: 'distant',
        summary: 'An unrelated reviewed case.',
        outcome: 'GRANT',
        targetSystem: 'DATA_WAREHOUSE',
        entitlementKey: 'FIN_DATASET_READ',
        department: 'Marketing',
        costCenter: 'CC-MKT-01',
        createdAt: new Date('2026-07-30T12:00:00.000Z'),
        policyVersionSnapshot: [
          { documentName: 'POL-DATA-001', version: '3.4.1' },
        ],
        similarity: '0.41',
      },
    ]);

    expect(await service.retrieveRelevantPrecedents(CASE_FACTS)).toEqual([]);
  });

  it('joins through feedback and human decisions to select the outcome', async () => {
    const { service, prisma } = makeService([]);
    await service.retrieveRelevantPrecedents(CASE_FACTS);

    const sqlArg = (prisma as unknown as { $queryRaw: jest.Mock }).$queryRaw
      .mock.calls[0][0] as Prisma.Sql;
    const text = sqlArg.strings.join(' ');
    expect(text).toContain('JOIN decision_feedback df');
    expect(text).toContain('JOIN human_decisions hd');
    expect(text).toContain('hd.outcome AS "outcome"');
  });
});
