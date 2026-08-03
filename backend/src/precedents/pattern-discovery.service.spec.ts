import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PatternDiscoveryService } from './pattern-discovery.service';

const CREATED_AT = new Date('2026-07-30T12:00:00.000Z');

function suggestionRow() {
  return {
    id: 'suggestion-1',
    patternType: 'RECURRING_EXCEPTION' as const,
    targetSystem: 'DATA_WAREHOUSE',
    entitlementKey: 'FIN_DATASET_READ',
    description: '1 of 2 decisions overrode the recommendation.',
    supportingDecisionIds: ['hd-1'],
    status: 'PROPOSED' as const,
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: CREATED_AT,
  };
}

function makeHarness(
  decisions: Array<{
    id: string;
    outcome: 'GRANT' | 'DENY';
    overridesRecommendation: boolean;
    accessRequest: { targetSystem: string; entitlementKey: string };
  }> = [],
) {
  const prisma = {
    humanDecision: { findMany: jest.fn().mockResolvedValue(decisions) },
    precedentRecord: { findMany: jest.fn().mockResolvedValue([]) },
    policyDocument: { findMany: jest.fn().mockResolvedValue([]) },
    ruleSuggestion: {
      create: jest.fn().mockResolvedValue(suggestionRow()),
    },
  } as unknown as PrismaService & {
    humanDecision: { findMany: jest.Mock };
    precedentRecord: { findMany: jest.Mock };
    policyDocument: { findMany: jest.Mock };
    ruleSuggestion: { create: jest.Mock };
  };
  return { service: new PatternDiscoveryService(prisma), prisma };
}

const QUALIFYING_DECISIONS = [
  {
    id: 'hd-1',
    outcome: 'GRANT' as const,
    overridesRecommendation: true,
    accessRequest: {
      targetSystem: 'DATA_WAREHOUSE',
      entitlementKey: 'FIN_DATASET_READ',
    },
  },
  {
    id: 'hd-2',
    outcome: 'GRANT' as const,
    overridesRecommendation: false,
    accessRequest: {
      targetSystem: 'DATA_WAREHOUSE',
      entitlementKey: 'FIN_DATASET_READ',
    },
  },
];

describe('PatternDiscoveryService.discoverPatterns', () => {
  it('creates and returns a fresh qualifying candidate', async () => {
    const { service, prisma } = makeHarness(QUALIFYING_DECISIONS);

    await expect(service.discoverPatterns()).resolves.toEqual([
      suggestionRow(),
    ]);
    expect(prisma.ruleSuggestion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        patternType: 'RECURRING_EXCEPTION',
        targetSystem: 'DATA_WAREHOUSE',
        entitlementKey: 'FIN_DATASET_READ',
        supportingDecisionIds: ['hd-1'],
        status: 'PROPOSED',
      }),
    });
  });

  it('skips a P2002 unique conflict on a repeated run instead of duplicating', async () => {
    const { service, prisma } = makeHarness(QUALIFYING_DECISIONS);
    prisma.ruleSuggestion.create
      .mockResolvedValueOnce(suggestionRow())
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: '5.22.0',
        }),
      );

    await expect(service.discoverPatterns()).resolves.toHaveLength(1);
    await expect(service.discoverPatterns()).resolves.toEqual([]);
    expect(prisma.ruleSuggestion.create).toHaveBeenCalledTimes(2);
  });

  it('allows two concurrent discovery calls to race while the unique constraint admits only one row', async () => {
    const { service, prisma } = makeHarness(QUALIFYING_DECISIONS);
    let inserted = false;
    prisma.ruleSuggestion.create.mockImplementation(async () => {
      if (inserted) {
        throw new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: '5.22.0',
        });
      }
      inserted = true;
      // Yield once so both discoverPatterns calls reach the create path
      // during the same turn, modeling the interval/manual endpoint race.
      await Promise.resolve();
      return suggestionRow();
    });

    const [scheduledSide, manualSide] = await Promise.all([
      service.discoverPatterns(),
      service.discoverPatterns(),
    ]);

    expect([...scheduledSide, ...manualSide]).toEqual([suggestionRow()]);
    expect(prisma.ruleSuggestion.create).toHaveBeenCalledTimes(2);
  });

  it('returns an empty list when no group qualifies', async () => {
    const { service, prisma } = makeHarness([
      {
        ...QUALIFYING_DECISIONS[0],
        overridesRecommendation: false,
      },
    ]);

    await expect(service.discoverPatterns()).resolves.toEqual([]);
    expect(prisma.ruleSuggestion.create).not.toHaveBeenCalled();
  });
});

describe('PatternDiscoveryService.scheduledDiscoverPatterns', () => {
  it('swallows discovery failures at the content-free scheduler boundary', async () => {
    const { service } = makeHarness();
    jest
      .spyOn(service, 'discoverPatterns')
      .mockRejectedValue(new Error('database password and internal hostname'));
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await expect(service.scheduledDiscoverPatterns()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'Scheduled pattern discovery failed: PATTERN_DISCOVERY_FAILED.',
    );
    expect(String(warn.mock.calls[0][0])).not.toContain('password');
    warn.mockRestore();
  });
});
