import { Injectable, Logger } from '@nestjs/common';
import {
  AgentOperatingRule,
  GroundedRecommendation,
  Recommendation,
  RecommendationResult,
} from '../agent/agent.types';
import { SodConflictFinding } from '../entitlements/entitlement-lookup.service';
import { RetrievedPrecedent } from '../precedents/precedent-retrieval.service';
import { RagService, RetrievedChunk } from '../rag/rag.service';
import {
  PolicyEvidenceSelectionRejectionReason,
  PolicyEvidenceSelectionSummary,
  sectionsMatch,
  toPolicyCitation,
  ValidatedCitation,
  validatePolicyEvidenceSelections,
} from './policy-evidence-selection.util';
import {
  PrecedentCitationRejectionReason,
  PrecedentCitationValidationSummary,
  ValidatedPrecedentCitation,
  validatePrecedentCitations,
} from './precedent-citation-validation.util';

const SOD_GROUNDING_RETRIEVAL_LIMIT = 3;

// Stable, content-free code for "the evidence needed to ground this couldn't
// be retrieved at all". See the catch block in groundSodDenial.
const SOD_EVIDENCE_RETRIEVAL_FAILED_CODE = 'SOD_EVIDENCE_RETRIEVAL_FAILED';

const UNGROUNDED_ESCALATION_JUSTIFICATION =
  'Escalated automatically: the AI recommendation could not be grounded in ' +
  'verified policy evidence. One or more selected policy source IDs were not ' +
  'available in the evidence retrieved for this request, so this ' +
  'requires human review rather than an automated approval or denial.';

const PRECEDENT_CONFLICT_ESCALATION_JUSTIFICATION =
  'Escalated automatically: the AI detected a material conflict involving ' +
  'retrieved precedent that requires human review.';

function precedentConflictJustification(explanation: string): string {
  const trimmed = explanation.trim();
  return trimmed.length > 0
    ? `${PRECEDENT_CONFLICT_ESCALATION_JUSTIFICATION} ${trimmed}`
    : PRECEDENT_CONFLICT_ESCALATION_JUSTIFICATION;
}

// impliedOutcome maps a decision to the outcome it would grant/deny, so it
// can be compared against a precedent's actual recorded outcome. ESCALATE
// has no implied outcome — there is nothing to compare against for a
// decision the model already declined to make.
function impliedOutcome(decision: string): 'GRANT' | 'DENY' | null {
  if (decision === 'APPROVE') return 'GRANT';
  if (decision === 'DENY') return 'DENY';
  return null;
}

export type PrecedentReviewIssueReason =
  // A precedent was retrieved for this attempt but the model's
  // precedent_review said nothing about it at all.
  | 'MISSING_REVIEW'
  // precedent_review referenced a precedent id that was never retrieved for
  // this attempt — the same fabrication concern citation validation guards
  // against, applied to this new field.
  | 'UNKNOWN_PRECEDENT_ID'
  // The model marked a precedent as applying to this request, but that
  // precedent's actual recorded outcome disagrees with the decision — computed
  // here from data already available, never trusted from the model's own say-so.
  | 'CONFLICTING_OUTCOME'
  // The same precedent was reviewed more than once. The prompt requires
  // exactly one entry each; duplicates can contradict one another.
  | 'DUPLICATE_REVIEW';

export interface PrecedentReviewIssue {
  precedentId: string;
  reason: PrecedentReviewIssueReason;
}

type EvidenceReviewRecommendation = Pick<
  Recommendation,
  'decision' | 'precedent_review' | 'operating_rule_review'
>;

/**
 * Independently verifies precedent_review against the precedents actually
 * retrieved for this attempt: every retrieved precedent must be accounted
 * for (MISSING_REVIEW), every reviewed id must be genuine (UNKNOWN_PRECEDENT_ID),
 * and any precedent marked "applies" must not disagree with what the decision
 * implies (CONFLICTING_OUTCOME) — that comparison is deterministic, not a
 * second opinion asked of the model. Skipped entirely when the decision is
 * already ESCALATE: there is no implied outcome to conflict with, and nothing
 * more restrictive to downgrade to.
 */
export function checkPrecedentReviewCompleteness(
  recommendation: EvidenceReviewRecommendation,
  precedents: RetrievedPrecedent[],
): PrecedentReviewIssue[] {
  const issues: PrecedentReviewIssue[] = [];
  const precedentsById = new Map(precedents.map((p) => [p.id, p]));
  const reviewedIds = new Set<string>();
  const implied = impliedOutcome(recommendation.decision);

  for (const entry of recommendation.precedent_review) {
    const precedent = precedentsById.get(entry.precedent_id);
    if (!precedent) {
      issues.push({ precedentId: entry.precedent_id, reason: 'UNKNOWN_PRECEDENT_ID' });
      continue;
    }
    if (reviewedIds.has(entry.precedent_id)) {
      // The prompt requires exactly one entry per precedent. Two entries can
      // disagree with each other, which makes "what did the model actually
      // judge" unanswerable — treated as a defective review rather than
      // silently taking the first or last.
      issues.push({ precedentId: entry.precedent_id, reason: 'DUPLICATE_REVIEW' });
      continue;
    }
    reviewedIds.add(entry.precedent_id);
    if (entry.applies && implied !== null && precedent.outcome !== implied) {
      issues.push({ precedentId: entry.precedent_id, reason: 'CONFLICTING_OUTCOME' });
    }
  }

  for (const precedent of precedents) {
    if (!reviewedIds.has(precedent.id)) {
      issues.push({ precedentId: precedent.id, reason: 'MISSING_REVIEW' });
    }
  }

  return issues;
}

export type OperatingRuleReviewIssueReason =
  // A governance-approved rule was shown for this request but the model's
  // operating_rule_review said nothing about it.
  | 'MISSING_REVIEW'
  // operating_rule_review referenced a rule id that was never shown.
  | 'UNKNOWN_RULE_ID'
  // The same rule was reviewed more than once.
  | 'DUPLICATE_REVIEW';

export interface OperatingRuleReviewIssue {
  ruleId: string;
  reason: OperatingRuleReviewIssueReason;
}

/**
 * The operating-rule analogue of checkPrecedentReviewCompleteness, and it
 * exists for a measured reason: precedent-review completeness came back at
 * 25% on a live evaluation run — this model routinely ignores retrieved
 * evidence entirely. Governance-approved guidance is an explicit human
 * instruction, so silently ignoring one is worse than ignoring a precedent,
 * and prompt wording alone was never going to be sufficient.
 *
 * IMPORTANT LIMIT, deliberately not papered over: unlike a precedent, a rule
 * has no recorded outcome, so there is no CONFLICTING_OUTCOME analogue. This
 * verifies that every rule was ACCOUNTED FOR, not that applicable guidance was
 * actually FOLLOWED — the guidance is free text, and judging compliance with
 * it is exactly the semantic question that belongs to the human reviewer. What
 * this guarantees is that the model can never pretend a rule was not there.
 */
export function checkOperatingRuleReviewCompleteness(
  recommendation: EvidenceReviewRecommendation,
  rules: AgentOperatingRule[],
): OperatingRuleReviewIssue[] {
  const issues: OperatingRuleReviewIssue[] = [];
  const ruleIds = new Set(rules.map((rule) => rule.id));
  const reviewedIds = new Set<string>();

  for (const entry of recommendation.operating_rule_review) {
    if (!ruleIds.has(entry.rule_id)) {
      issues.push({ ruleId: entry.rule_id, reason: 'UNKNOWN_RULE_ID' });
      continue;
    }
    if (reviewedIds.has(entry.rule_id)) {
      issues.push({ ruleId: entry.rule_id, reason: 'DUPLICATE_REVIEW' });
      continue;
    }
    reviewedIds.add(entry.rule_id);
  }

  for (const rule of rules) {
    if (!reviewedIds.has(rule.id)) {
      issues.push({ ruleId: rule.id, reason: 'MISSING_REVIEW' });
    }
  }

  return issues;
}

function describeOperatingRuleReviewIssue(
  issue: OperatingRuleReviewIssue,
): string {
  switch (issue.reason) {
    case 'UNKNOWN_RULE_ID':
      return `referenced operating rule "${issue.ruleId}", which was not approved for this request's scope`;
    case 'DUPLICATE_REVIEW':
      return `operating rule ${issue.ruleId} was reviewed more than once, so its judgment is ambiguous`;
    default:
      return `operating rule ${issue.ruleId} was in force for this request but was not addressed`;
  }
}

// Named and specific, for the same reason the precedent version is: a
// reviewer told only "escalated, something about a rule" has nothing to act on.
function operatingRuleReviewEscalationJustification(
  issues: OperatingRuleReviewIssue[],
): string {
  const details = issues.map(describeOperatingRuleReviewIssue).join('; ');
  return (
    'Escalated automatically: the AI did not account for governance-approved ' +
    `operating guidance in force for this request — ${details}. Review the ` +
    'flagged rule(s) before deciding.'
  );
}

function describePrecedentReviewIssue(
  issue: PrecedentReviewIssue,
  precedentsById: Map<string, RetrievedPrecedent>,
): string {
  if (issue.reason === 'UNKNOWN_PRECEDENT_ID') {
    return `referenced precedent "${issue.precedentId}", which does not match any precedent retrieved for this request`;
  }
  if (issue.reason === 'DUPLICATE_REVIEW') {
    return `precedent ${issue.precedentId} was reviewed more than once, so its judgment is ambiguous`;
  }
  const outcome = precedentsById.get(issue.precedentId)?.outcome ?? 'unknown';
  return issue.reason === 'CONFLICTING_OUTCOME'
    ? `precedent ${issue.precedentId} (outcome: ${outcome}) was marked applicable but its outcome conflicts with this decision`
    : `precedent ${issue.precedentId} (outcome: ${outcome}) was retrieved but not addressed`;
}

// Named, specific — unlike the generic escalation justifications elsewhere in
// this file, this one exists precisely so a reviewer isn't told "escalated,
// something about precedent" and left to dig through logs or the database to
// find out which precedent is even in question (a real gap the generic
// version had: the check fired correctly, but pointed at nothing a reviewer
// could act on).
function precedentReviewEscalationJustification(
  issues: PrecedentReviewIssue[],
  precedents: RetrievedPrecedent[],
): string {
  const precedentsById = new Map(precedents.map((p) => [p.id, p]));
  const details = issues
    .map((issue) => describePrecedentReviewIssue(issue, precedentsById))
    .join('; ');
  return (
    'Escalated automatically: the AI did not fully account for retrieved ' +
    `precedent when forming its recommendation — ${details}. Review the ` +
    'flagged precedent(s) before deciding.'
  );
}

// Surfaces the specific precedent(s) that triggered escalation in the same
// place (and the same authoritative-snapshot shape) the reviewer already
// looks at for genuinely-cited precedent — never the model's own text, since
// the model said nothing about these. UNKNOWN_PRECEDENT_ID is excluded: there
// is no real retrieved precedent behind a fabricated id to show.
function precedentReviewFlagCitations(
  issues: PrecedentReviewIssue[],
  precedents: RetrievedPrecedent[],
): ValidatedPrecedentCitation[] {
  const precedentsById = new Map(precedents.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const flagged: ValidatedPrecedentCitation[] = [];
  for (const issue of issues) {
    if (issue.reason === 'UNKNOWN_PRECEDENT_ID' || seen.has(issue.precedentId)) {
      continue;
    }
    const precedent = precedentsById.get(issue.precedentId);
    if (!precedent) {
      continue;
    }
    seen.add(issue.precedentId);
    flagged.push({
      precedentRecordId: precedent.id,
      relevanceReason:
        issue.reason === 'CONFLICTING_OUTCOME'
          ? `Flagged automatically: marked applicable, but its outcome (${precedent.outcome}) conflicts with this recommendation.`
          : "Flagged automatically: retrieved as potentially relevant but not addressed in the AI's recommendation.",
      summarySnapshot: precedent.summary,
      outcomeSnapshot: precedent.outcome,
    });
  }
  return flagged;
}

/**
 * Combine the precedent citations the model itself proposed (already
 * validated) with the ones this service flagged, preferring the model's own
 * where both refer to the same precedent — its relevance_reason is genuine
 * reviewer-facing reasoning, whereas a flag's is code-authored boilerplate.
 * A model can legitimately cite one precedent correctly while omitting
 * another; keeping only the flags would erase the half it got right.
 */
function mergePrecedentCitations(
  validated: ValidatedPrecedentCitation[],
  flagged: ValidatedPrecedentCitation[],
): ValidatedPrecedentCitation[] {
  const seen = new Set(validated.map((c) => c.precedentRecordId));
  return [
    ...validated,
    ...flagged.filter((c) => !seen.has(c.precedentRecordId)),
  ];
}

function sodEscalationJustification(conflicts: SodConflictFinding[]): string {
  const ruleIds = [...new Set(conflicts.map((c) => c.ruleId))].join(', ');
  return (
    `Escalated automatically: an active Separation-of-Duties conflict (${ruleIds}) ` +
    'was detected by the entitlement registry — that registry finding is not in ' +
    'question — but the applicable policy citation could not be retrieved or ' +
    'verified. Escalating for human review rather than persisting an uncited denial.'
  );
}

/**
 * Who actually authored the recommendation a reviewer ends up reading.
 *
 * This exists because the previous design was quietly dishonest: when this
 * service overrode a decision, the persisted row still carried the model's
 * name and the model's confidence, and the dashboard rendered the whole thing
 * under the heading "AI Recommendation" — so a deterministic escalation
 * appeared to the reviewer as the model's own considered judgment, at the
 * model's own confidence. The brief requires policy, precedent, AI reasoning
 * and the human decision to stay "clearly distinguishable"; a fourth actor
 * writing under the AI's byline defeats that.
 *
 * - MODEL          the LLM's own decision and justification stand as written
 * - SOD_RULE       the deterministic Separation-of-Duties short-circuit
 *                  decided this without an LLM call at all
 * - GROUNDING_GATE this service replaced the decision or the justification
 *                  it was given
 */
export type DecisionSource = 'MODEL' | 'SOD_RULE' | 'GROUNDING_GATE';

// Stable, non-sensitive audit summary — counts and reason codes only, never
// raw excerpt text, chunk content, or anything else that could leak PII or
// blow up the audit payload size.
export interface GroundingAudit {
  proposedCitationCount: number;
  validatedCitationCount: number;
  rejectionReasonCounts: Partial<
    Record<PolicyEvidenceSelectionRejectionReason, number>
  >;
  proposedPrecedentCitationCount: number;
  validatedPrecedentCitationCount: number;
  precedentRejectionReasonCounts: Partial<
    Record<PrecedentCitationRejectionReason, number>
  >;
  conflictDetected: boolean;
  convertedToEscalateForConflict: boolean;
  convertedToEscalateForPrecedentReview: boolean;
  convertedToEscalateForOperatingRuleReview: boolean;
  convertedToEscalate: boolean;
  sodConflictDetected: boolean;
  // True when a SoD rule couldn't be graded because retrieval itself threw
  // (RagService/embedding/DB failure), as opposed to simply finding no
  // matching chunk. A boolean, not the raw error — see groundSodDenial.
  evidenceRetrievalFailed: boolean;
}

export interface GroundedRecommendationOutcome {
  recommendation: GroundedRecommendation;
  citations: ValidatedCitation[];
  precedentCitations: ValidatedPrecedentCitation[];
  /** Attribution for `recommendation` — see DecisionSource. */
  decisionSource: DecisionSource;
  audit: GroundingAudit;
  // What to persist as AiRecommendation.rawResponse. Equal to the original
  // model/short-circuit rawResponse when nothing was rejected; replaced with
  // a sanitized summary whenever a selected source id failed validation, so
  // a fabricated source id does not survive persistence.
  rawResponse: unknown;
}

function countPrecedentRejectionReasons(
  rejected: Array<{ reason: PrecedentCitationRejectionReason }>,
): Partial<Record<PrecedentCitationRejectionReason, number>> {
  const counts: Partial<Record<PrecedentCitationRejectionReason, number>> = {};
  for (const { reason } of rejected) {
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

function countRejectionReasons(
  rejected: Array<{ reason: PolicyEvidenceSelectionRejectionReason }>,
): Partial<Record<PolicyEvidenceSelectionRejectionReason, number>> {
  const counts: Partial<Record<PolicyEvidenceSelectionRejectionReason, number>> = {};
  for (const { reason } of rejected) {
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

// Never persist the model's own rawResponse once any selected source id has
// failed validation. This retains only sanitized, useful-for-audit facts:
// what the model originally decided and why validation failed.
function sanitizedRawResponse(
  original: Recommendation,
  summary: PolicyEvidenceSelectionSummary,
  precedentSummary?: PrecedentCitationValidationSummary,
): Record<string, unknown> {
  return {
    note:
      'Original rawResponse withheld: it selected policy source id(s) that failed ' +
      'grounding validation. See the AI_RECOMMENDED audit entry for reason codes.',
    originalDecision: original.decision,
    proposedCitationCount: summary.proposedCount,
    validatedCitationCount: summary.validated.length,
    rejectionReasonCounts: countRejectionReasons(summary.rejected),
    proposedPrecedentCitationCount: precedentSummary?.proposedCount ?? 0,
    validatedPrecedentCitationCount:
      precedentSummary?.validated.length ?? 0,
    precedentRejectionReasonCounts: countPrecedentRejectionReasons(
      precedentSummary?.rejected ?? [],
    ),
  };
}

function parseSodDocumentSection(
  description: string,
): { documentCode: string; sectionNumber: string } | null {
  // SOD_CONFLICT_PAIRS descriptions are always authored as
  // "POL-XXX-000 §N.N — ...", never derived from untrusted input.
  const match = description.match(/^(POL-[A-Z0-9-]+)\s+§([\d.]+)/);
  if (!match) {
    return null;
  }
  return { documentCode: match[1], sectionNumber: match[2] };
}

/**
 * Enforces "every APPROVE/DENY must be grounded in verified policy evidence"
 * as a dedicated concern, separate from retrieval (RagService), generation
 * (AgentService), persistence, and audit (AccessRequestProcessor). Two
 * entry points:
 *
 * - groundLlmRecommendation: resolves the LLM's selected Source IDs against
 *   evidence segments built from the chunks retrieved for this attempt.
 * - groundSodDenial: the deterministic SoD short-circuit never asks the LLM
 *   for citations at all (see buildSodConflictRecommendation), so this does
 *   its own targeted retrieval to find the specific policy section backing
 *   each triggered rule before allowing the DENY to stand.
 *
 * Fail-closed policy (deliberate, not an oversight): ALL selected Source IDs
 * must resolve, not just at least one. A single unknown or duplicate ID
 * invalidates the whole selection set rather than being silently dropped.
 * Fail-closed also
 * extends to infrastructure failure: if the evidence needed to ground a
 * result can't even be retrieved (a RagService/embedding/DB error), that is
 * treated exactly like "no matching evidence found" — ESCALATE, not an
 * exception that would otherwise leave the caller retrying into a FAILED
 * request.
 */
@Injectable()
export class RecommendationGroundingService {
  private readonly logger = new Logger(RecommendationGroundingService.name);

  constructor(private readonly ragService: RagService) {}

  groundLlmRecommendation(
    result: RecommendationResult,
    chunks: RetrievedChunk[],
    precedents: RetrievedPrecedent[],
    // The rules shown to the model for this attempt. Defaulted so existing
    // callers keep compiling, but a caller that retrieves rules and does not
    // pass them here silently disables the completeness check for them.
    operatingRules: AgentOperatingRule[] = [],
  ): GroundedRecommendationOutcome {
    const recommendation = result.recommendation;
    const summary = validatePolicyEvidenceSelections(
      recommendation.policy_citation_refs,
      chunks,
    );
    const precedentSummary = validatePrecedentCitations(
      recommendation.precedent_citations,
      precedents,
    );
    const hasRejections = summary.rejected.length > 0;
    const hasPrecedentRejections = precedentSummary.rejected.length > 0;
    const allProposedValid = !hasRejections;
    const requiresEvidence =
      recommendation.decision === 'APPROVE' || recommendation.decision === 'DENY';
    const hasEvidence = allProposedValid && summary.validated.length > 0;

    let citations = allProposedValid ? summary.validated : [];
    const { policy_citation_refs: _selectedPolicySources, ...modelFields } =
      recommendation;
    let finalRecommendation: GroundedRecommendation = {
      ...modelFields,
      policy_citations: citations.map(toPolicyCitation),
    };
    let precedentCitations = hasPrecedentRejections
      ? []
      : precedentSummary.validated;
    let convertedToEscalate = false;
    let convertedToEscalateForConflict = false;
    let convertedToEscalateForPrecedentReview = false;
    let convertedToEscalateForOperatingRuleReview = false;

    if (requiresEvidence && !hasEvidence) {
      finalRecommendation = {
        ...finalRecommendation,
        decision: 'ESCALATE',
        justification: UNGROUNDED_ESCALATION_JUSTIFICATION,
        policy_citations: [],
      };
      citations = [];
      convertedToEscalate = true;
      this.logger.warn(
        `Recommendation for ${result.modelName} downgraded ${recommendation.decision} -> ESCALATE: ` +
          `${summary.rejected.length} of ${summary.proposedCount} selected policy source(s) failed validation ` +
          `(${Object.entries(countRejectionReasons(summary.rejected))
            .map(([reason, count]) => `${reason}=${count}`)
            .join(', ') || 'no citations proposed'}).`,
      );
    } else if (hasRejections) {
      // Only reachable when the model already chose ESCALATE itself but
      // still proposed citation(s) that failed validation. The decision
      // doesn't need to change (it's already the safe state), but the
      // justification can't be trusted as-is either — it may reference the
      // very evidence that just failed grounding — so it's replaced with the
      // same generic, sanitized explanation, not left as the model's own
      // (potentially unsupported) text.
      finalRecommendation = {
        ...finalRecommendation,
        justification: UNGROUNDED_ESCALATION_JUSTIFICATION,
        policy_citations: [],
      };
      citations = [];
    }

    if (hasPrecedentRejections) {
      finalRecommendation = {
        ...finalRecommendation,
        precedent_citations: [],
      };
      this.logger.warn(
        `All precedent citations dropped for ${result.modelName}: ` +
          `${precedentSummary.rejected.length} of ${precedentSummary.proposedCount} proposed citation(s) failed validation ` +
          `(${Object.entries(
            countPrecedentRejectionReasons(precedentSummary.rejected),
          )
            .map(([reason, count]) => `${reason}=${count}`)
            .join(', ')}).`,
      );
    }

    if (recommendation.conflict_detected) {
      // Only the decision and the justification change. Citations that already
      // passed validation are deliberately KEPT: this branch fires because the
      // model flagged a precedent conflict, which says nothing about whether
      // its policy evidence was genuine. Discarding verified policy text here
      // would hand the reviewer an escalation with no evidence attached at
      // exactly the moment they have to adjudicate the conflict themselves —
      // the opposite of what the escalation is for. Contrast the
      // ungrounded-evidence branch above, where clearing is correct precisely
      // because those citations failed to validate.
      finalRecommendation = {
        ...finalRecommendation,
        decision: 'ESCALATE',
        justification: precedentConflictJustification(
          recommendation.conflict_explanation,
        ),
      };
      convertedToEscalateForConflict = recommendation.decision !== 'ESCALATE';
      this.logger.warn(
        `Recommendation for ${result.modelName} forced to ESCALATE because the model detected a precedent conflict.`,
      );
    }

    {
      // Completeness applies even when the model already chose ESCALATE. An
      // escalation must not become a way to omit retrieved precedent without
      // surfacing it to the reviewer.
      const reviewIssues = checkPrecedentReviewCompleteness(
        recommendation,
        precedents,
      );
      if (reviewIssues.length > 0) {
        // As with the conflict branch: keep validated policy citations. An
        // incomplete precedent_review is a statement about the model's
        // handling of precedent, not evidence that its policy quotes were
        // fabricated — and the reviewer resolving this escalation needs the
        // policy text in front of them to judge the flagged precedent against.
        const reviewJustification = precedentReviewEscalationJustification(
          reviewIssues,
          precedents,
        );
        finalRecommendation = {
          ...finalRecommendation,
          decision: 'ESCALATE',
          justification:
            finalRecommendation.justification === recommendation.justification
              ? reviewJustification
              : `${finalRecommendation.justification} ${reviewJustification}`,
        };
        precedentCitations = mergePrecedentCitations(
          precedentCitations,
          precedentReviewFlagCitations(reviewIssues, precedents),
        );
        convertedToEscalateForPrecedentReview = true;
        this.logger.warn(
          `Recommendation for ${result.modelName} forced to ESCALATE: precedent_review ` +
            `did not fully account for retrieved precedent (${reviewIssues
              .map((i) => `${i.precedentId}:${i.reason}`)
              .join(', ')}).`,
        );
      }
    }

    {
      const ruleIssues = checkOperatingRuleReviewCompleteness(
        recommendation,
        operatingRules,
      );
      if (ruleIssues.length > 0) {
        // Validated citations are kept here too — an unaccounted-for rule says
        // nothing about whether the policy quote was genuine.
        const ruleJustification =
          operatingRuleReviewEscalationJustification(ruleIssues);
        finalRecommendation = {
          ...finalRecommendation,
          decision: 'ESCALATE',
          justification:
            finalRecommendation.justification === recommendation.justification
              ? ruleJustification
              : `${finalRecommendation.justification} ${ruleJustification}`,
        };
        convertedToEscalateForOperatingRuleReview = true;
        this.logger.warn(
          `Recommendation for ${result.modelName} forced to ESCALATE: operating_rule_review ` +
            `did not fully account for approved guidance (${ruleIssues
              .map((i) => `${i.ruleId}:${i.reason}`)
              .join(', ')}).`,
        );
      }
    }

    // Attribution is derived from what was actually rewritten, not from the
    // escalation flags: the `hasRejections`-only branch above leaves the
    // decision alone but still replaces the justification the reviewer reads,
    // which is just as much this service speaking rather than the model.
    const gateRewroteDecision =
      finalRecommendation.decision !== recommendation.decision;
    const gateRewroteJustification =
      finalRecommendation.justification !== recommendation.justification;

    return {
      recommendation: finalRecommendation,
      citations,
      precedentCitations,
      decisionSource:
        gateRewroteDecision || gateRewroteJustification
          ? 'GROUNDING_GATE'
          : 'MODEL',
      rawResponse: hasRejections || hasPrecedentRejections
        ? sanitizedRawResponse(recommendation, summary, precedentSummary)
        : result.rawResponse,
      audit: {
        proposedCitationCount: summary.proposedCount,
        validatedCitationCount: summary.validated.length,
        rejectionReasonCounts: countRejectionReasons(summary.rejected),
        proposedPrecedentCitationCount: precedentSummary.proposedCount,
        validatedPrecedentCitationCount: precedentSummary.validated.length,
        precedentRejectionReasonCounts: countPrecedentRejectionReasons(
          precedentSummary.rejected,
        ),
        conflictDetected: recommendation.conflict_detected,
        convertedToEscalateForConflict,
        convertedToEscalateForPrecedentReview,
        convertedToEscalateForOperatingRuleReview,
        convertedToEscalate,
        sodConflictDetected: false,
        evidenceRetrievalFailed: false,
      },
    };
  }

  /**
   * Grounds a deterministic SoD-conflict DENY. The registry conflict itself
   * (`conflicts`) is authoritative and already computed by
   * EntitlementLookupService — this only decides whether there is verified
   * policy text to cite for it. Every distinct triggered rule must resolve
   * to at least one retrieved-and-matched chunk (same fail-closed principle
   * as groundLlmRecommendation): if any rule can't be grounded — including
   * because retrieval itself failed — the whole result becomes ESCALATE
   * rather than a partially-cited or exception-propagating DENY.
   */
  async groundSodDenial(
    shortCircuited: RecommendationResult,
    conflicts: SodConflictFinding[],
  ): Promise<GroundedRecommendationOutcome> {
    const uniqueRuleIds = [...new Set(conflicts.map((c) => c.ruleId))];
    const validated: ValidatedCitation[] = [];
    const seenChunkIds = new Set<string>();
    let ungroundableRuleCount = 0;
    let evidenceRetrievalFailed = false;

    for (const ruleId of uniqueRuleIds) {
      const conflict = conflicts.find((c) => c.ruleId === ruleId)!;
      const parsed = parseSodDocumentSection(conflict.description);
      if (!parsed) {
        ungroundableRuleCount += 1;
        continue;
      }

      let retrieved: RetrievedChunk[];
      try {
        retrieved = await this.ragService.retrieveRelevantChunks(
          `${conflict.ruleId} ${conflict.description}`,
          { limit: SOD_GROUNDING_RETRIEVAL_LIMIT },
        );
      } catch {
        // Fail-closed: unavailable evidence is treated the same as evidence
        // that was retrieved but didn't match — ESCALATE, never an exception
        // that propagates up into AccessRequestProcessor's retry/FAILED path.
        //
        // Deliberately do NOT log any part of the exception body: a
        // RagService/embedding/DB failure's message can contain connection
        // strings, credentials, bearer tokens, or internal hostnames. Not even
        // the constructor name — that is attacker/library-controlled text, not
        // a value from a fixed enum. Only a stable code is logged; the full
        // exception belongs in a separately secured observability integration
        // that the underlying client reports to directly.
        ungroundableRuleCount += 1;
        evidenceRetrievalFailed = true;
        this.logger.warn(
          `Policy retrieval failed while grounding SoD rule ${ruleId}; treating as ` +
            `ungroundable (fail-closed -> ESCALATE). Code: ${SOD_EVIDENCE_RETRIEVAL_FAILED_CODE}.`,
        );
        continue;
      }

      const match = retrieved.find(
        (chunk) =>
          chunk.documentName.startsWith(parsed.documentCode) &&
          sectionsMatch(parsed.sectionNumber, chunk.section),
      );
      if (!match) {
        ungroundableRuleCount += 1;
        continue;
      }

      if (seenChunkIds.has(match.id)) {
        continue;
      }
      seenChunkIds.add(match.id);
      validated.push({
        policyChunkId: match.id,
        documentName: match.documentName,
        section: match.section,
        excerpt: match.content,
      });
    }

    const grounded = ungroundableRuleCount === 0 && validated.length > 0;
    const recommendation = shortCircuited.recommendation;
    const { policy_citation_refs: _selectedPolicySources, ...modelFields } =
      recommendation;
    let finalRecommendation: GroundedRecommendation = {
      ...modelFields,
      policy_citations: validated.map(toPolicyCitation),
    };
    let convertedToEscalate = false;

    if (!grounded) {
      finalRecommendation = {
        ...finalRecommendation,
        decision: 'ESCALATE',
        justification: sodEscalationJustification(conflicts),
        policy_citations: [],
      };
      convertedToEscalate = true;
      this.logger.warn(
        `SoD DENY for rule(s) ${uniqueRuleIds.join(', ')} downgraded to ESCALATE: ` +
          `${ungroundableRuleCount} of ${uniqueRuleIds.length} rule(s) had no retrievable/valid policy citation.`,
      );
    }

    return {
      recommendation: finalRecommendation,
      citations: grounded ? validated : [],
      precedentCitations: [],
      // The short-circuit path never involves an LLM, so "MODEL" is never
      // right here: either the deterministic SoD rule stands as authored, or
      // this service overrode it for want of citable policy text.
      decisionSource: convertedToEscalate ? 'GROUNDING_GATE' : 'SOD_RULE',
      // buildSodConflictRecommendation's rawResponse is always our own
      // deterministic text with policy_citations: [] — never model-supplied
      // — so unlike the LLM path there is nothing fabricated to sanitize.
      rawResponse: shortCircuited.rawResponse,
      audit: {
        proposedCitationCount: 0, // the SoD path never asks an LLM to propose citations
        validatedCitationCount: validated.length,
        rejectionReasonCounts: {},
        proposedPrecedentCitationCount: 0,
        validatedPrecedentCitationCount: 0,
        precedentRejectionReasonCounts: {},
        conflictDetected: false,
        convertedToEscalateForConflict: false,
        convertedToEscalateForPrecedentReview: false,
        convertedToEscalateForOperatingRuleReview: false,
        convertedToEscalate,
        sodConflictDetected: true,
        evidenceRetrievalFailed,
      },
    };
  }
}
