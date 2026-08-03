import { buildPrecedentSummary } from './precedent-summary';

const BASE_INPUT = {
  targetSystem: 'DATA_WAREHOUSE',
  entitlementKey: 'FIN_DATASET_READ',
  requesterDepartment: 'Finance',
  requesterCostCenter: 'CC-FIN-12',
  aiDecision: 'APPROVE',
  aiConfidence: 0.91,
  aiJustification: 'The request matches the governing policy.',
  humanOutcome: 'GRANT',
  agreedWithAi: true,
  systemDecision: null,
  rationale: null,
  reasonCode: 'CONFIRMS_POLICY',
  missingContext: null,
};

describe('buildPrecedentSummary', () => {
  it('summarizes an agreement case deterministically', () => {
    expect(buildPrecedentSummary(BASE_INPUT)).toBe(
      'A requester in Finance (cost center CC-FIN-12) requested FIN_DATASET_READ access in DATA_WAREHOUSE. ' +
        'The AI recommended APPROVE with confidence 0.91. The AI justification was: The request matches the governing policy. ' +
        'The human reviewer decided GRANT, agreeing with the AI recommendation. ' +
        'The structured review reason was CONFIRMS_POLICY.',
    );
  });

  it('includes the reviewer rationale for an override', () => {
    const summary = buildPrecedentSummary({
      ...BASE_INPUT,
      humanOutcome: 'DENY',
      agreedWithAi: false,
      systemDecision: null,
      rationale: 'A separation-of-duties conflict applies',
      reasonCode: 'POLICY_MISAPPLIED',
    });

    expect(summary).toContain('overriding the AI recommendation');
    expect(summary).toContain(
      'The reviewer rationale was: A separation-of-duties conflict applies.',
    );
  });

  it('includes a missing or incorrect context note', () => {
    const summary = buildPrecedentSummary({
      ...BASE_INPUT,
      reasonCode: 'MISSING_CONTEXT',
      missingContext: 'The manager approval was absent',
    });

    expect(summary).toContain(
      'The reviewer identified missing or incorrect context: The manager approval was absent.',
    );
  });

  it('describes a case with no AI recommendation', () => {
    const summary = buildPrecedentSummary({
      ...BASE_INPUT,
      aiDecision: null,
      aiConfidence: null,
      aiJustification: null,
      // No proposal to compare against — not the same thing as disagreement.
      agreedWithAi: null,
      systemDecision: null,
    });

    expect(summary).toContain('There was no AI recommendation for this request.');
    expect(summary).toContain(
      'there was no AI recommendation to compare against',
    );
    expect(summary).not.toContain('overriding the AI recommendation');
  });

  it('says the reviewer AGREED with the AI when the gate overrode the model but the human matched its proposal', () => {
    // The exact case the old overridesRecommendation-based text got wrong: the
    // model said APPROVE, deterministic verification escalated, and the human
    // granted. That reviewer agreed with the AI; recording it as an override
    // wrote a false sentence into retrievable precedent.
    const summary = buildPrecedentSummary({
      ...BASE_INPUT,
      aiDecision: 'APPROVE',
      humanOutcome: 'GRANT',
      agreedWithAi: true,
      systemDecision: 'ESCALATE',
    });

    expect(summary).toContain('The AI recommended APPROVE');
    expect(summary).toContain(
      'Automated verification did not accept that recommendation and replaced it with ESCALATE.',
    );
    expect(summary).toContain('agreeing with the AI recommendation');
    expect(summary).not.toContain('overriding the AI recommendation');
  });
});
