import {
  isPrecedentStale,
  PolicyVersionEntry,
} from './precedent-staleness';

export const MIN_GROUP_SIZE = 2;
export const OVERRIDE_RATE_THRESHOLD = 0.5;

// Deliberately low thresholds for a demo-scale dataset where most
// (system, entitlement) groups will only ever accumulate a handful of
// decisions. A real deployment with meaningfully more volume would raise
// both.

export interface DecisionRecord {
  humanDecisionId: string;
  targetSystem: string;
  entitlementKey: string;
  outcome: string;
  overridesRecommendation: boolean;
}

export interface DecisionGroup {
  targetSystem: string;
  entitlementKey: string;
  decisions: DecisionRecord[];
}

export function groupDecisionsByEntitlement(
  decisions: DecisionRecord[],
): DecisionGroup[] {
  const groups = new Map<string, DecisionGroup>();
  for (const decision of decisions) {
    const key = `${decision.targetSystem}\u0000${decision.entitlementKey}`;
    const existing = groups.get(key);
    if (existing) {
      existing.decisions.push(decision);
    } else {
      groups.set(key, {
        targetSystem: decision.targetSystem,
        entitlementKey: decision.entitlementKey,
        decisions: [decision],
      });
    }
  }
  return [...groups.values()];
}

export type PatternType =
  | 'INCONSISTENT_DECISIONS'
  | 'RECURRING_EXCEPTION'
  | 'OUTDATED_POLICY';

export interface PatternCandidate {
  patternType: PatternType;
  targetSystem: string;
  entitlementKey: string;
  description: string;
  supportingDecisionIds: string[];
}

/**
 * Pattern types where accepting the suggestion genuinely ENDORSES the
 * supporting decisions, and may therefore promote their nominated precedents
 * to ACTIVE.
 *
 * Only RECURRING_EXCEPTION qualifies. It reports "reviewers keep overriding
 * the AI the same way here", and its supportingDecisionIds are exactly those
 * consistent overrides — so "yes, this is the right call" is a coherent thing
 * for governance to mean by accepting it.
 *
 * The other two report a PROBLEM, and accepting them means "acknowledged",
 * not "make this authoritative":
 *
 * - INCONSISTENT_DECISIONS lists every decision in the group, on BOTH sides
 *   of the disagreement. Activating those precedents would push mutually
 *   contradictory guidance into retrieval and manufacture the very
 *   conflicting-evidence case the system then has to escalate — accepting an
 *   alert about inconsistency would *create* inconsistency.
 * - OUTDATED_POLICY lists precedents decided under superseded policy. They
 *   are already excluded from retrieval by isPrecedentStale, and promoting
 *   them is the opposite of the corrective action the pattern calls for.
 *
 * Acceptance is still recorded and audited for these; it simply does not
 * carry an implicit promotion. See RuleSuggestionGovernanceService.accept.
 */
export const PATTERN_TYPES_THAT_MAY_ACTIVATE_PRECEDENTS: readonly PatternType[] =
  ['RECURRING_EXCEPTION'];

export function mayActivatePrecedents(patternType: string): boolean {
  return PATTERN_TYPES_THAT_MAY_ACTIVATE_PRECEDENTS.includes(
    patternType as PatternType,
  );
}

export function detectInconsistentDecisions(
  group: DecisionGroup,
): PatternCandidate | null {
  if (group.decisions.length < MIN_GROUP_SIZE) {
    return null;
  }

  const grantCount = group.decisions.filter(
    (decision) => decision.outcome === 'GRANT',
  ).length;
  const denyCount = group.decisions.filter(
    (decision) => decision.outcome === 'DENY',
  ).length;
  if (grantCount === 0 || denyCount === 0) {
    return null;
  }

  return {
    patternType: 'INCONSISTENT_DECISIONS',
    targetSystem: group.targetSystem,
    entitlementKey: group.entitlementKey,
    description:
      `Of ${group.decisions.length} reviewed decisions, ${grantCount} resulted in GRANT ` +
      `and ${denyCount} in DENY — reviewers are not applying a consistent outcome ` +
      'for materially similar requests.',
    supportingDecisionIds: group.decisions.map(
      (decision) => decision.humanDecisionId,
    ),
  };
}

export function detectRecurringException(
  group: DecisionGroup,
): PatternCandidate | null {
  if (group.decisions.length < MIN_GROUP_SIZE) {
    return null;
  }

  const overridden = group.decisions.filter(
    (decision) => decision.overridesRecommendation,
  );
  const overrideRate = overridden.length / group.decisions.length;
  if (overrideRate < OVERRIDE_RATE_THRESHOLD) {
    return null;
  }

  return {
    patternType: 'RECURRING_EXCEPTION',
    targetSystem: group.targetSystem,
    entitlementKey: group.entitlementKey,
    description:
      `${overridden.length} of ${group.decisions.length} reviewed decisions ` +
      `(${Math.round(overrideRate * 100)}%) overrode the AI recommendation — ` +
      'human reviewers are repeatedly applying an exception for this entitlement.',
    supportingDecisionIds: overridden.map(
      (decision) => decision.humanDecisionId,
    ),
  };
}

export interface GroupPrecedent {
  humanDecisionId: string;
  policyVersionSnapshot: unknown;
}

export function detectOutdatedPolicy(
  group: DecisionGroup,
  precedents: GroupPrecedent[],
  currentVersions: PolicyVersionEntry[],
): PatternCandidate | null {
  const stale = precedents.filter((precedent) =>
    isPrecedentStale(precedent.policyVersionSnapshot, currentVersions),
  );
  if (stale.length === 0) {
    return null;
  }

  return {
    patternType: 'OUTDATED_POLICY',
    targetSystem: group.targetSystem,
    entitlementKey: group.entitlementKey,
    description: `${stale.length} ACTIVE precedent(s) for this entitlement were decided under a policy version that has since changed and may no longer reflect current rules.`,
    supportingDecisionIds: stale.map(
      (precedent) => precedent.humanDecisionId,
    ),
  };
}
