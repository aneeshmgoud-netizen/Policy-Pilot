import { PrismaService } from '../prisma/prisma.service';
import {
  OperatingRuleRetrievalService,
  RetrievedOperatingRule,
  toAgentOperatingRule,
} from './operating-rule-retrieval.service';

const RULE: RetrievedOperatingRule = {
  id: 'rule-1',
  targetSystem: 'DATA_WAREHOUSE',
  entitlementKey: 'FIN_DATASET_READ',
  patternType: 'RECURRING_EXCEPTION',
  guidance: 'Escalate these to Data Governance until Q3 recertification closes.',
  approvedAt: new Date('2026-07-28T09:00:00.000Z'),
};

function makeService(rows: RetrievedOperatingRule[]) {
  const prisma = {
    operatingRule: { findMany: jest.fn().mockResolvedValue(rows) },
  } as unknown as PrismaService & {
    operatingRule: { findMany: jest.Mock };
  };
  return { service: new OperatingRuleRetrievalService(prisma), prisma };
}

describe('OperatingRuleRetrievalService', () => {
  it('reads only ACTIVE rules for the request scope, so revocation takes effect on the next request', async () => {
    const { service, prisma } = makeService([RULE]);

    await service.retrieveApplicableRules('DATA_WAREHOUSE', 'FIN_DATASET_READ');

    expect(prisma.operatingRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          targetSystem: 'DATA_WAREHOUSE',
          entitlementKey: 'FIN_DATASET_READ',
          status: 'ACTIVE',
        },
      }),
    );
  });

  it('orders oldest-first so prompts stay reproducible across runs', async () => {
    const { service, prisma } = makeService([]);

    await service.retrieveApplicableRules('DATA_WAREHOUSE', 'FIN_DATASET_READ');

    expect(prisma.operatingRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { approvedAt: 'asc' } }),
    );
  });

  it('returns nothing for a scope with no approved rules — the ordinary case', async () => {
    const { service } = makeService([]);

    expect(
      await service.retrieveApplicableRules('DATA_WAREHOUSE', 'OTHER_KEY'),
    ).toEqual([]);
  });
});

describe('toAgentOperatingRule', () => {
  it('forwards the guidance and approval date the model may reason over', () => {
    expect(toAgentOperatingRule(RULE)).toEqual({
      id: 'rule-1',
      guidance: 'Escalate these to Data Governance until Q3 recertification closes.',
      approvedAt: '2026-07-28T09:00:00.000Z',
    });
  });

  it('never forwards the approver — who signed a rule is an audit fact, not a decision input', () => {
    // Deliberate: a recommendation must not shift because of *which* approver
    // signed the guidance.
    expect(toAgentOperatingRule(RULE)).not.toHaveProperty('approvedBy');
  });

  it('accepts an approvedAt that arrived as a JSON string rather than a Date', () => {
    const fromFixture = {
      ...RULE,
      approvedAt: '2026-07-28T09:00:00.000Z' as unknown as Date,
    };
    expect(toAgentOperatingRule(fromFixture).approvedAt).toBe(
      '2026-07-28T09:00:00.000Z',
    );
  });
});
