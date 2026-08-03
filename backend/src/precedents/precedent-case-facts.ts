export interface PrecedentCaseFacts {
  requestType: string;
  targetSystem: string;
  entitlementKey: string;
  requesterTitle: string;
  requesterDepartment: string;
  requesterCostCenter: string;
  justification: string;
}

function canonicalValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * The one representation used on both sides of precedent similarity:
 * historical request facts at ingestion and current request facts at lookup.
 * Reviewer commentary, AI reasoning, outcomes, ids, and timestamps are
 * deliberately excluded because they have no counterpart in a new request.
 */
export function buildPrecedentCaseFactsText(
  facts: PrecedentCaseFacts,
): string {
  return [
    `Request type: ${canonicalValue(facts.requestType)}`,
    `Target system: ${canonicalValue(facts.targetSystem)}`,
    `Entitlement: ${canonicalValue(facts.entitlementKey)}`,
    `Requester title: ${canonicalValue(facts.requesterTitle)}`,
    `Requester department: ${canonicalValue(facts.requesterDepartment)}`,
    `Requester cost center: ${canonicalValue(facts.requesterCostCenter)}`,
    `Business justification: ${canonicalValue(facts.justification)}`,
  ].join('\n');
}
