import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PrecedentGovernanceService } from './precedent-governance.service';
import { RuleSuggestionGovernanceService } from './rule-suggestion-governance.service';

const CREATED_AT = new Date('2026-07-30T12:00:00.000Z');
const REVIEWED_AT = new Date('2026-07-30T13:00:00.000Z');

function suggestionRow(
  status: 'PROPOSED' | 'ACCEPTED' | 'DISMISSED',
  supportingDecisionIds: string[] = ['hd-1'],
  patternType:
    | 'RECURRING_EXCEPTION'
    | 'INCONSISTENT_DECISIONS'
    | 'OUTDATED_POLICY' = 'RECURRING_EXCEPTION',
) {
  return {
    id: 'suggestion-1',
    patternType,
    targetSystem: 'DATA_WAREHOUSE',
    entitlementKey: 'FIN_DATASET_READ',
    description: 'Reviewers repeatedly override the recommendation.',
    supportingDecisionIds,
    status,
    reviewedBy: status === 'PROPOSED' ? null : 'governance:priya',
    reviewedAt: status === 'PROPOSED' ? null : REVIEWED_AT,
    reviewNote: status === 'PROPOSED' ? null : 'Reviewed.',
    createdAt: CREATED_AT,
  };
}

function makeHarness(
  existing: ReturnType<typeof suggestionRow> | null = suggestionRow('PROPOSED'),
  updated: ReturnType<typeof suggestionRow> = suggestionRow('ACCEPTED'),
) {
  const tx = {
    ruleSuggestion: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(updated),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    operatingRule: {
      create: jest.fn().mockResolvedValue({ id: 'rule-1' }),
    },
  };
  const prisma = {
    ruleSuggestion: {
      findUnique: jest.fn().mockResolvedValue(existing),
      findMany: jest.fn().mockResolvedValue(existing ? [existing] : []),
    },
    decisionFeedback: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest
      .fn()
      .mockImplementation((callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
      ),
    __tx: tx,
  } as unknown as PrismaService & {
    ruleSuggestion: { findUnique: jest.Mock; findMany: jest.Mock };
    decisionFeedback: { findUnique: jest.Mock };
    $transaction: jest.Mock;
    __tx: typeof tx;
  };
  const precedentGovernance = {
    approve: jest.fn().mockResolvedValue({ id: 'precedent-1', status: 'ACTIVE' }),
  } as unknown as PrecedentGovernanceService & { approve: jest.Mock };
  return {
    service: new RuleSuggestionGovernanceService(prisma, precedentGovernance),
    prisma,
    precedentGovernance,
  };
}

describe('RuleSuggestionGovernanceService.list', () => {
  it('filters valid statuses and rejects invalid ones', async () => {
    const { service, prisma } = makeHarness();
    await service.list('PROPOSED');
    expect(prisma.ruleSuggestion.findMany).toHaveBeenCalledWith({
      where: { status: 'PROPOSED' },
      orderBy: { createdAt: 'desc' },
    });

    await expect(service.list('ACTIVE')).rejects.toThrow(BadRequestException);
  });
});

describe('RuleSuggestionGovernanceService.accept', () => {
  it('accepts with zero eligible precedents and returns an empty activation list', async () => {
    const accepted = suggestionRow('ACCEPTED');
    const { service, prisma, precedentGovernance } = makeHarness(
      suggestionRow('PROPOSED'),
      accepted,
    );

    await expect(
      service.accept('suggestion-1', 'governance:priya', 'Reviewed.'),
    ).resolves.toEqual({
      ...accepted,
      activatedPrecedentIds: [],
      // No guidance supplied, so nothing retrievable was created — the caller
      // is told that explicitly rather than left to infer it.
      operatingRuleId: null,
    });
    expect(precedentGovernance.approve).not.toHaveBeenCalled();
    expect(prisma.__tx.ruleSuggestion.updateMany).toHaveBeenCalledWith({
      where: { id: 'suggestion-1', status: 'PROPOSED' },
      data: {
        status: 'ACCEPTED',
        reviewedBy: 'governance:priya',
        reviewedAt: expect.any(Date),
        reviewNote: 'Reviewed.',
      },
    });
    expect(prisma.__tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'RULE_SUGGESTION_ACCEPTED' }),
      }),
    );
  });

  it('activates an already-nominated PROPOSED precedent', async () => {
    const { service, prisma, precedentGovernance } = makeHarness();
    prisma.decisionFeedback.findUnique.mockResolvedValue({
      precedent: { id: 'precedent-1', status: 'PROPOSED' },
    });

    const result = await service.accept(
      'suggestion-1',
      'governance:priya',
    );

    expect(prisma.decisionFeedback.findUnique).toHaveBeenCalledWith({
      where: { humanDecisionId: 'hd-1' },
      include: { precedent: true },
    });
    expect(precedentGovernance.approve).toHaveBeenCalledWith(
      'precedent-1',
      'governance:priya',
    );
    expect(result.activatedPrecedentIds).toEqual(['precedent-1']);
  });

  it('continues after one individual activation fails', async () => {
    const supporting = ['hd-1', 'hd-2'];
    const { service, prisma, precedentGovernance } = makeHarness(
      suggestionRow('PROPOSED', supporting),
      suggestionRow('ACCEPTED', supporting),
    );
    prisma.decisionFeedback.findUnique
      .mockResolvedValueOnce({
        precedent: { id: 'precedent-1', status: 'PROPOSED' },
      })
      .mockResolvedValueOnce({
        precedent: { id: 'precedent-2', status: 'PROPOSED' },
      });
    precedentGovernance.approve
      .mockRejectedValueOnce(new Error('concurrent governance change'))
      .mockResolvedValueOnce({ id: 'precedent-2', status: 'ACTIVE' });
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const result = await service.accept(
      'suggestion-1',
      'governance:priya',
    );

    expect(precedentGovernance.approve).toHaveBeenCalledTimes(2);
    expect(result.activatedPrecedentIds).toEqual(['precedent-2']);
    expect(String(warn.mock.calls[0][0])).not.toContain('concurrent governance change');
    warn.mockRestore();
  });

  it('returns 404 when the suggestion does not exist', async () => {
    const { service, prisma } = makeHarness(null);
    await expect(
      service.accept('missing', 'governance:priya'),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 409 when the suggestion is no longer PROPOSED', async () => {
    const { service, prisma } = makeHarness(suggestionRow('ACCEPTED'));
    prisma.__tx.ruleSuggestion.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.accept('suggestion-1', 'governance:priya'),
    ).rejects.toThrow(ConflictException);
    expect(prisma.__tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('allows only one side of a double-accept race to transition or audit', async () => {
    const accepted = suggestionRow('ACCEPTED');
    const { service, prisma } = makeHarness(
      suggestionRow('PROPOSED'),
      accepted,
    );
    prisma.__tx.ruleSuggestion.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(
      service.accept('suggestion-1', 'governance:priya'),
    ).resolves.toEqual({
      ...accepted,
      activatedPrecedentIds: [],
      // No guidance supplied, so nothing retrievable was created — the caller
      // is told that explicitly rather than left to infer it.
      operatingRuleId: null,
    });
    await expect(
      service.accept('suggestion-1', 'governance:priya'),
    ).rejects.toThrow(ConflictException);
    expect(prisma.__tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('silently skips supporting decisions with no nomination or a non-PROPOSED precedent', async () => {
    const supporting = ['hd-none', 'hd-active', 'hd-revoked'];
    const accepted = suggestionRow('ACCEPTED', supporting);
    const { service, prisma, precedentGovernance } = makeHarness(
      suggestionRow('PROPOSED', supporting),
      accepted,
    );
    prisma.decisionFeedback.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        precedent: { id: 'precedent-active', status: 'ACTIVE' },
      })
      .mockResolvedValueOnce({
        precedent: { id: 'precedent-revoked', status: 'REVOKED' },
      });

    await expect(
      service.accept('suggestion-1', 'governance:priya'),
    ).resolves.toEqual({
      ...accepted,
      activatedPrecedentIds: [],
      // No guidance supplied, so nothing retrievable was created — the caller
      // is told that explicitly rather than left to infer it.
      operatingRuleId: null,
    });
    expect(precedentGovernance.approve).not.toHaveBeenCalled();
  });
});

describe('RuleSuggestionGovernanceService.dismiss', () => {
  it('dismisses through a PROPOSED-only CAS and writes its audit atomically', async () => {
    const dismissed = suggestionRow('DISMISSED');
    const { service, prisma } = makeHarness(
      suggestionRow('PROPOSED'),
      dismissed,
    );

    await expect(
      service.dismiss('suggestion-1', 'governance:priya', 'Not actionable.'),
    ).resolves.toEqual(dismissed);
    expect(prisma.__tx.ruleSuggestion.updateMany).toHaveBeenCalledWith({
      where: { id: 'suggestion-1', status: 'PROPOSED' },
      data: {
        status: 'DISMISSED',
        reviewedBy: 'governance:priya',
        reviewedAt: expect.any(Date),
        reviewNote: 'Not actionable.',
      },
    });
    expect(prisma.__tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'RULE_SUGGESTION_DISMISSED' }),
      }),
    );
  });

  it('returns 404 when missing and 409 when already reviewed', async () => {
    const missing = makeHarness(null);
    await expect(
      missing.service.dismiss('missing', 'governance:priya'),
    ).rejects.toThrow(NotFoundException);

    const reviewed = makeHarness(suggestionRow('DISMISSED'));
    reviewed.prisma.__tx.ruleSuggestion.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      reviewed.service.dismiss('suggestion-1', 'governance:priya'),
    ).rejects.toThrow(ConflictException);
  });

  it('allows only one side of a double-dismiss race to transition or audit', async () => {
    const dismissed = suggestionRow('DISMISSED');
    const { service, prisma } = makeHarness(
      suggestionRow('PROPOSED'),
      dismissed,
    );
    prisma.__tx.ruleSuggestion.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(
      service.dismiss('suggestion-1', 'governance:priya'),
    ).resolves.toEqual(dismissed);
    await expect(
      service.dismiss('suggestion-1', 'governance:priya'),
    ).rejects.toThrow(ConflictException);
    expect(prisma.__tx.auditLog.create).toHaveBeenCalledTimes(1);
  });
});

describe('RuleSuggestionGovernanceService.accept — precedent activation scope', () => {
  it('does not activate precedents when accepting INCONSISTENT_DECISIONS', async () => {
    // supportingDecisionIds for this pattern spans BOTH sides of the
    // disagreement. Activating them would push mutually contradictory
    // guidance into retrieval — accepting an alert about inconsistency would
    // manufacture inconsistency.
    const accepted = suggestionRow('ACCEPTED', ['hd-1', 'hd-2'], 'INCONSISTENT_DECISIONS');
    const { service, prisma, precedentGovernance } = makeHarness(
      suggestionRow('PROPOSED', ['hd-1', 'hd-2'], 'INCONSISTENT_DECISIONS'),
      accepted,
    );
    prisma.decisionFeedback.findUnique.mockResolvedValue({
      precedent: { id: 'precedent-1', status: 'PROPOSED' },
    });

    const result = await service.accept('suggestion-1', 'governance:priya');

    expect(result.activatedPrecedentIds).toEqual([]);
    expect(precedentGovernance.approve).not.toHaveBeenCalled();
    // The acceptance itself is still recorded and audited.
    expect(prisma.__tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('does not activate precedents when accepting OUTDATED_POLICY', async () => {
    const accepted = suggestionRow('ACCEPTED', ['hd-1'], 'OUTDATED_POLICY');
    const { service, prisma, precedentGovernance } = makeHarness(
      suggestionRow('PROPOSED', ['hd-1'], 'OUTDATED_POLICY'),
      accepted,
    );
    prisma.decisionFeedback.findUnique.mockResolvedValue({
      precedent: { id: 'precedent-1', status: 'PROPOSED' },
    });

    const result = await service.accept('suggestion-1', 'governance:priya');

    expect(result.activatedPrecedentIds).toEqual([]);
    expect(precedentGovernance.approve).not.toHaveBeenCalled();
  });

  it('still activates precedents for RECURRING_EXCEPTION, which does endorse them', async () => {
    const { service, prisma, precedentGovernance } = makeHarness();
    prisma.decisionFeedback.findUnique.mockResolvedValue({
      precedent: { id: 'precedent-1', status: 'PROPOSED' },
    });

    const result = await service.accept('suggestion-1', 'governance:priya');

    expect(result.activatedPrecedentIds).toEqual(['precedent-1']);
    expect(precedentGovernance.approve).toHaveBeenCalledWith(
      'precedent-1',
      'governance:priya',
    );
  });
});

describe('RuleSuggestionGovernanceService.accept — operating rule creation', () => {
  it('writes an ACTIVE operating rule for the suggestion scope when guidance is supplied', async () => {
    // This is what makes an accepted pattern actually influence later
    // requests: the rule row is what retrieval reads. Before it existed,
    // acceptance changed nothing any future request could see.
    const { service, prisma } = makeHarness();

    const result = await service.accept(
      'suggestion-1',
      'governance:priya',
      'Reviewed.',
      '  Escalate these to Data Governance until Q3 recertification closes.  ',
    );

    expect(prisma.__tx.operatingRule.create).toHaveBeenCalledWith({
      data: {
        ruleSuggestionId: 'suggestion-1',
        targetSystem: 'DATA_WAREHOUSE',
        entitlementKey: 'FIN_DATASET_READ',
        patternType: 'RECURRING_EXCEPTION',
        guidance: 'Escalate these to Data Governance until Q3 recertification closes.',
        approvedBy: 'governance:priya',
      },
    });
    expect(result.operatingRuleId).toBe('rule-1');
  });

  it('creates no rule when guidance is absent or whitespace, and says so', async () => {
    const { service, prisma } = makeHarness();

    const result = await service.accept(
      'suggestion-1',
      'governance:priya',
      'Acknowledged.',
      '   ',
    );

    expect(prisma.__tx.operatingRule.create).not.toHaveBeenCalled();
    expect(result.operatingRuleId).toBeNull();
  });

  it('records in the audit trail whether the acceptance produced retrievable guidance', async () => {
    // "ACCEPTED" alone does not tell an auditor whether anything now
    // influences future requests.
    const { service, prisma } = makeHarness();

    await service.accept(
      'suggestion-1',
      'governance:priya',
      undefined,
      'Escalate these to Data Governance until Q3 recertification closes.',
    );

    expect(prisma.__tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'RULE_SUGGESTION_ACCEPTED',
        payload: expect.objectContaining({
          operatingRuleId: 'rule-1',
          guidanceProvided: true,
        }),
      }),
    });
  });

  it('writes the rule in the same transaction as the status change', async () => {
    // An ACCEPTED suggestion whose rule failed to write would claim
    // governance had acted while nothing readable existed.
    const { service, prisma } = makeHarness();

    await service.accept(
      'suggestion-1',
      'governance:priya',
      undefined,
      'Escalate these to Data Governance until Q3 recertification closes.',
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.__tx.operatingRule.create).toHaveBeenCalledTimes(1);
  });
});
