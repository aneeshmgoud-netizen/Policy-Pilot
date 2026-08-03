import {
  DecisionGroup,
  detectInconsistentDecisions,
  detectOutdatedPolicy,
  detectRecurringException,
  groupDecisionsByEntitlement,
} from './pattern-detection';

function decision(
  humanDecisionId: string,
  outcome: 'GRANT' | 'DENY',
  overridesRecommendation = false,
) {
  return {
    humanDecisionId,
    targetSystem: 'DATA_WAREHOUSE',
    entitlementKey: 'FIN_DATASET_READ',
    outcome,
    overridesRecommendation,
  };
}

describe('groupDecisionsByEntitlement', () => {
  it('groups decisions by the exact system and entitlement pair', () => {
    const groups = groupDecisionsByEntitlement([
      decision('hd-1', 'GRANT'),
      decision('hd-2', 'DENY'),
      {
        ...decision('hd-3', 'GRANT'),
        entitlementKey: 'FIN_DATASET_EDIT',
      },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].decisions.map((item) => item.humanDecisionId)).toEqual([
      'hd-1',
      'hd-2',
    ]);
    expect(groups[1].entitlementKey).toBe('FIN_DATASET_EDIT');
  });
});

describe('detectInconsistentDecisions', () => {
  it('returns null below the minimum group size', () => {
    const group: DecisionGroup = {
      targetSystem: 'DATA_WAREHOUSE',
      entitlementKey: 'FIN_DATASET_READ',
      decisions: [decision('hd-1', 'GRANT')],
    };
    expect(detectInconsistentDecisions(group)).toBeNull();
  });

  it('returns null when every reviewer reached the same outcome', () => {
    const group: DecisionGroup = {
      targetSystem: 'DATA_WAREHOUSE',
      entitlementKey: 'FIN_DATASET_READ',
      decisions: [decision('hd-1', 'GRANT'), decision('hd-2', 'GRANT')],
    };
    expect(detectInconsistentDecisions(group)).toBeNull();
  });

  it('returns all decisions as evidence for a GRANT/DENY split', () => {
    const group: DecisionGroup = {
      targetSystem: 'DATA_WAREHOUSE',
      entitlementKey: 'FIN_DATASET_READ',
      decisions: [decision('hd-1', 'GRANT'), decision('hd-2', 'DENY')],
    };
    const candidate = detectInconsistentDecisions(group);

    expect(candidate).toEqual(
      expect.objectContaining({
        patternType: 'INCONSISTENT_DECISIONS',
        supportingDecisionIds: ['hd-1', 'hd-2'],
      }),
    );
    expect(candidate?.description).toContain('1 resulted in GRANT and 1 in DENY');
  });
});

describe('detectRecurringException', () => {
  it('returns null below the minimum group size', () => {
    const group: DecisionGroup = {
      targetSystem: 'DATA_WAREHOUSE',
      entitlementKey: 'FIN_DATASET_READ',
      decisions: [decision('hd-1', 'GRANT', true)],
    };
    expect(detectRecurringException(group)).toBeNull();
  });

  it('returns null below the override-rate threshold', () => {
    const group: DecisionGroup = {
      targetSystem: 'DATA_WAREHOUSE',
      entitlementKey: 'FIN_DATASET_READ',
      decisions: [
        decision('hd-1', 'GRANT', true),
        decision('hd-2', 'GRANT'),
        decision('hd-3', 'GRANT'),
      ],
    };
    expect(detectRecurringException(group)).toBeNull();
  });

  it('includes only overridden decisions at the threshold', () => {
    const group: DecisionGroup = {
      targetSystem: 'DATA_WAREHOUSE',
      entitlementKey: 'FIN_DATASET_READ',
      decisions: [
        decision('hd-1', 'GRANT', true),
        decision('hd-2', 'GRANT'),
      ],
    };
    const candidate = detectRecurringException(group);

    expect(candidate).toEqual(
      expect.objectContaining({
        patternType: 'RECURRING_EXCEPTION',
        supportingDecisionIds: ['hd-1'],
      }),
    );
    expect(candidate?.description).toContain('(50%)');
  });
});

describe('detectOutdatedPolicy', () => {
  it('returns null when every ACTIVE precedent snapshot is fresh', () => {
    const group: DecisionGroup = {
      targetSystem: 'DATA_WAREHOUSE',
      entitlementKey: 'FIN_DATASET_READ',
      decisions: [],
    };
    expect(
      detectOutdatedPolicy(
        group,
        [
          {
            humanDecisionId: 'hd-fresh',
            policyVersionSnapshot: [
              { documentName: 'POL-DATA-001', version: '3.4.1' },
            ],
          },
        ],
        [{ documentName: 'POL-DATA-001', version: '3.4.1' }],
      ),
    ).toBeNull();
  });

  it('includes only stale ACTIVE precedents and has no group-size gate', () => {
    const group: DecisionGroup = {
      targetSystem: 'DATA_WAREHOUSE',
      entitlementKey: 'FIN_DATASET_READ',
      decisions: [decision('hd-stale', 'GRANT')],
    };
    const candidate = detectOutdatedPolicy(
      group,
      [
        {
          humanDecisionId: 'hd-stale',
          policyVersionSnapshot: [
            { documentName: 'POL-DATA-001', version: '3.3.0' },
          ],
        },
        {
          humanDecisionId: 'hd-fresh',
          policyVersionSnapshot: [
            { documentName: 'POL-DATA-001', version: '3.4.1' },
          ],
        },
      ],
      [{ documentName: 'POL-DATA-001', version: '3.4.1' }],
    );

    expect(candidate).toEqual(
      expect.objectContaining({
        patternType: 'OUTDATED_POLICY',
        supportingDecisionIds: ['hd-stale'],
      }),
    );
  });
});
