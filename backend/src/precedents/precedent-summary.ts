export interface PrecedentSummaryInput {
  targetSystem: string;
  entitlementKey: string;
  requesterDepartment: string;
  requesterCostCenter: string;
  aiDecision: string | null;
  aiConfidence: number | null;
  aiJustification: string | null;
  humanOutcome: string;
  // Whether the reviewer agreed with what the MODEL proposed. Null when there
  // was no model proposal to compare against. Deliberately NOT
  // overridesRecommendation, which compares against the post-gate decision:
  // using that here wrote "overriding the AI recommendation" into precedents
  // where the reviewer had in fact agreed with the AI and only deviated from a
  // deterministic escalation.
  agreedWithAi: boolean | null;
  // Set only when automated verification replaced the model's decision, so the
  // summary can say so rather than silently attributing the result to the AI.
  systemDecision: string | null;
  rationale: string | null;
  reasonCode: string;
  missingContext: string | null;
}

function withTerminalPunctuation(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Build deterministic, auditable reviewer/model context. This text is never
 * embedded for similarity; see buildPrecedentCaseFactsText.
 */
export function buildPrecedentSummary(input: PrecedentSummaryInput): string {
  const sentences = [
    `A requester in ${input.requesterDepartment} (cost center ${input.requesterCostCenter}) ` +
      `requested ${input.entitlementKey} access in ${input.targetSystem}.`,
  ];

  if (input.aiDecision === null) {
    sentences.push('There was no AI recommendation for this request.');
  } else {
    const confidence =
      input.aiConfidence === null
        ? 'with no confidence score recorded'
        : `with confidence ${input.aiConfidence}`;
    const justification = input.aiJustification?.trim()
      ? ` The AI justification was: ${withTerminalPunctuation(input.aiJustification)}`
      : '';
    sentences.push(
      `The AI recommended ${input.aiDecision} ${confidence}.${justification}`,
    );
  }

  if (input.systemDecision !== null) {
    sentences.push(
      `Automated verification did not accept that recommendation and replaced it with ${input.systemDecision}.`,
    );
  }

  if (input.agreedWithAi === null) {
    sentences.push(
      `The human reviewer decided ${input.humanOutcome}; there was no AI recommendation to compare against.`,
    );
  } else {
    sentences.push(
      `The human reviewer decided ${input.humanOutcome}, ` +
        (input.agreedWithAi
          ? 'agreeing with the AI recommendation.'
          : 'overriding the AI recommendation.'),
    );
  }

  sentences.push(`The structured review reason was ${input.reasonCode}.`);
  if (input.rationale?.trim()) {
    sentences.push(
      `The reviewer rationale was: ${withTerminalPunctuation(input.rationale)}`,
    );
  }
  if (input.missingContext?.trim()) {
    sentences.push(
      `The reviewer identified missing or incorrect context: ${withTerminalPunctuation(input.missingContext)}`,
    );
  }

  return sentences.join(' ');
}
