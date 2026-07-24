import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingsService } from './embeddings.service';
import {
  RagService,
  buildFilterConditions,
  toVectorLiteral,
} from './rag.service';

describe('toVectorLiteral', () => {
  it('formats a number array as a pgvector literal', () => {
    expect(toVectorLiteral([0.1, 0.2, -0.3])).toBe('[0.1,0.2,-0.3]');
  });
});

describe('buildFilterConditions', () => {
  it('returns an empty fragment when no filters are given', () => {
    const sql = buildFilterConditions({});
    expect(sql.values).toEqual([]);
    expect(sql.strings.join('')).toBe('');
  });

  it('binds each supplied filter as a parameter, not string interpolation', () => {
    const sql = buildFilterConditions({
      policyDomain: 'DATA',
      targetSystem: 'DATA_WAREHOUSE',
    });
    expect(sql.values).toEqual(['DATA', 'DATA_WAREHOUSE']);
    const text = sql.strings.join(' ');
    expect(text).toContain('policy_domain');
    expect(text).toContain('target_system');
    // costCenter was not supplied, so it must not appear.
    expect(text).not.toContain('cost_center');
  });
});

describe('RagService.retrieveRelevantChunks', () => {
  function makeService(rows: unknown[]) {
    const embeddings = {
      embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    } as unknown as EmbeddingsService;
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue(rows),
    } as unknown as PrismaService & { $queryRaw: jest.Mock };
    return {
      service: new RagService(prisma, embeddings),
      embeddings,
      prisma,
    };
  }

  it('embeds the query and maps rows, coercing similarity to a number', async () => {
    const { service, embeddings, prisma } = makeService([
      {
        id: 'chunk-1',
        documentName: 'POL-DATA-001',
        section: '3.2 Elevated Write',
        content: 'FIN_DATASET_EDIT requires secondary approval.',
        similarity: '0.87', // raw driver may hand back a string
      },
    ]);

    const result = await service.retrieveRelevantChunks(
      'can I get FIN_DATASET_EDIT?',
    );

    expect(embeddings.embed).toHaveBeenCalledWith('can I get FIN_DATASET_EDIT?');
    expect((prisma as unknown as { $queryRaw: jest.Mock }).$queryRaw).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        id: 'chunk-1',
        documentName: 'POL-DATA-001',
        section: '3.2 Elevated Write',
        content: 'FIN_DATASET_EDIT requires secondary approval.',
        similarity: 0.87,
      },
    ]);
  });

  it('passes the embedded vector and limit through as bound parameters', async () => {
    const { service, prisma } = makeService([]);
    const queryRaw = (prisma as unknown as { $queryRaw: jest.Mock }).$queryRaw;

    await service.retrieveRelevantChunks('any query', { limit: 3 });

    const sqlArg = queryRaw.mock.calls[0][0] as Prisma.Sql;
    // The vector literal is bound twice (SELECT similarity + ORDER BY), and the
    // limit is the final bound parameter — never interpolated into the string.
    expect(sqlArg.values).toContain('[0.1,0.2,0.3]');
    expect(sqlArg.values).toContain(3);
  });

  it('defaults to a limit of 5 when none is supplied', async () => {
    const { service, prisma } = makeService([]);
    const queryRaw = (prisma as unknown as { $queryRaw: jest.Mock }).$queryRaw;

    await service.retrieveRelevantChunks('any query');

    const sqlArg = queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(sqlArg.values).toContain(5);
  });
});
