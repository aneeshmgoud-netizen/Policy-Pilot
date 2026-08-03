import { z } from 'zod';

// Strict output contract for the recommendation LLM. Every model response is
// validated against this before it is trusted or persisted; anything that
// doesn't parse triggers a retry (see AgentService).

// The model selects an authoritative policy evidence segment by id. It never
// writes document metadata or excerpt text. RecommendationGroundingService
// resolves the selected id against the segments built from the chunks that
// were retrieved for this exact attempt, then copies the authoritative
// document/section/excerpt into the persisted citation.
export const PolicyCitationReferenceSchema = z.object({
  source_id: z.string().min(1),
});

export const PrecedentCitationSchema = z.object({
  precedent_id: z.string().min(1),
  relevance_reason: z.string().min(1),
});

// One entry per precedent shown in PRECEDENT EXCERPTS — REQUIRED to cover
// every retrieved precedent, not just ones the model chooses to cite (see
// RecommendationGroundingService's completeness check). This exists because
// precedent_citations alone lets the model silently say nothing about a
// precedent it was shown, including one that materially conflicts with its
// decision — proven in practice (a directly contradicting, top-ranked
// retrieved precedent produced zero citations and conflict_detected: false).
// "applies" is the only judgment asked of the model here; whether an
// applicable precedent's outcome actually conflicts with the decision is
// computed independently and deterministically from precedent.outcome, never
// trusted from the model's own say-so.
export const PrecedentReviewEntrySchema = z.object({
  precedent_id: z.string().min(1),
  applies: z.boolean(),
});

// One entry per operating rule shown, for the same reason precedent_review
// exists: a measured 25% precedent-review completeness (see
// docs/evaluation-report.md) established that this model routinely says
// nothing at all about retrieved evidence it was shown. Governance-approved
// guidance is not safer from that failure than precedent is — if anything it
// matters more, since a rule is an explicit human instruction.
//
// Unlike a precedent, a rule has no recorded outcome to compare a decision
// against, so "applies" is the only judgment asked and the only deterministic
// checks possible are completeness, genuineness, and non-duplication. Whether
// the model actually FOLLOWED applicable guidance is not machine-checkable
// here and remains a matter for the human reviewer.
export const OperatingRuleReviewEntrySchema = z.object({
  rule_id: z.string().min(1),
  applies: z.boolean(),
});

export const RecommendationSchema = z.object({
  decision: z.enum(['APPROVE', 'DENY', 'ESCALATE']),
  justification: z.string().min(1),
  policy_citation_refs: z.array(PolicyCitationReferenceSchema),
  precedent_citations: z.array(PrecedentCitationSchema).default([]),
  precedent_review: z.array(PrecedentReviewEntrySchema).default([]),
  operating_rule_review: z.array(OperatingRuleReviewEntrySchema).default([]),
  // Model self-reported confidence in [0, 1].
  confidence: z.number().min(0).max(1),
  conflict_detected: z.boolean().default(false),
  conflict_explanation: z.string().default(''),
});

export type PolicyCitationReference = z.infer<
  typeof PolicyCitationReferenceSchema
>;
export type PrecedentCitation = z.infer<typeof PrecedentCitationSchema>;
export type PrecedentReviewEntry = z.infer<typeof PrecedentReviewEntrySchema>;
export type OperatingRuleReviewEntry = z.infer<
  typeof OperatingRuleReviewEntrySchema
>;
export type Recommendation = z.infer<typeof RecommendationSchema>;

// What the grounding layer exposes to persistence and the reviewer API. This
// preserves the assignment-required policy_citations shape, but every field
// is copied from retrieved authoritative data rather than model-authored text.
export interface PolicyCitation {
  document_name: string;
  section: string;
  excerpt: string;
}

export type GroundedRecommendation = Omit<
  Recommendation,
  'policy_citation_refs'
> & {
  policy_citations: PolicyCitation[];
};

// --- Inputs the agent reasons over -----------------------------------------

export interface AgentAccessRequest {
  requestId: string;
  employeeId: string;
  requestType: string;
  targetSystem: string;
  entitlementKey: string;
  justification: string;
  requesterDepartment: string;
  requesterCostCenter: string;
}

export interface AgentEntitlementSnapshot {
  currentActiveEntitlements: Array<{
    systemName: string;
    entitlementKey: string;
  }>;
  alreadyHasRequestedEntitlement: boolean;
  sodConflicts: Array<{
    ruleId: string;
    conflictingEntitlementKey: string;
    description: string;
  }>;
}

export interface AgentRetrievedChunk {
  id: string;
  documentName: string;
  section: string | null;
  content: string;
}

// The precedent facts the model is allowed to reason over. department,
// costCenter, and recordedAt are carried explicitly rather than left buried
// in the prose summary: the prompt asks the model to judge whether a
// precedent covers the "same eligible department/cost-center category" and
// whether it predates current practice, so withholding those fields would be
// asking for a judgment on evidence we deliberately never supplied. Nullable
// because the underlying columns are (a precedent from a request with no
// recorded department is still a real precedent) — the renderer omits a line
// rather than inventing a value.
export interface AgentRetrievedPrecedent {
  id: string;
  summary: string;
  outcome: string;
  targetSystem: string;
  entitlementKey: string;
  department?: string | null;
  costCenter?: string | null;
  /** ISO-8601 timestamp of when this precedent was recorded, if known. */
  recordedAt?: string | null;
  similarity: number;
}

// Governance-approved operating guidance for this request's exact scope.
// Distinct from both policy (formal, authored outside this system) and
// precedent (evidence from one prior case): a rule is a deliberate,
// human-authored instruction a governance approver attached when accepting a
// discovered pattern. Like precedent, it is supporting context and can never
// substitute for a policy citation.
export interface AgentOperatingRule {
  id: string;
  guidance: string;
  /** ISO-8601 timestamp of governance approval. */
  approvedAt: string;
}

export interface RecommendationInput {
  accessRequest: AgentAccessRequest;
  entitlementSnapshot: AgentEntitlementSnapshot;
  retrievedChunks: AgentRetrievedChunk[];
  retrievedPrecedents: AgentRetrievedPrecedent[];
  operatingRules?: AgentOperatingRule[];
}

// --- What the agent returns to the worker ----------------------------------

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  /** Wall-clock time of the underlying chat completion call, in milliseconds. */
  latencyMs: number;
}

export interface RecommendationResult {
  recommendation: Recommendation;
  modelName: string;
  promptVersion: string;
  /** The raw JSON object the model returned (already parsed). */
  rawResponse: unknown;
  /** 1-based attempt number that produced the valid result. */
  attemptNumber: number;
  usage: TokenUsage;
}
