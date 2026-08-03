// Shapes returned by GET /api/v1/access-requests. Dates arrive as ISO strings.

export type AiDecision = 'APPROVE' | 'DENY' | 'ESCALATE';
export type DecisionOutcome = 'GRANT' | 'DENY';
export type RequestStatus =
  | 'PENDING'
  | 'ENTITLEMENTS_LOADED'
  | 'RECOMMENDED'
  | 'DECIDED'
  | 'FAILED';

export interface PolicyCitation {
  documentName: string;
  section: string | null;
  excerpt: string;
}

export interface PrecedentCitationView {
  precedentRecordId: string;
  relevanceReason: string;
  outcomeSnapshot: string;
  summarySnapshot: string;
}

// Who authored the recommendation being displayed. GROUNDING_GATE means
// deterministic backend verification replaced what the model produced, so the
// decision and justification must not be attributed to the AI.
export type DecisionSource = 'MODEL' | 'SOD_RULE' | 'GROUNDING_GATE';

export interface AiRecommendation {
  id: string;
  // The effective recommendation, after grounding.
  decision: AiDecision;
  justification: string;
  confidence: number;
  modelName: string;
  promptVersion: string;
  attemptNumber: number;
  createdAt: string;
  citations: PolicyCitation[];
  precedentCitations: PrecedentCitationView[];
  // Provenance. Null on rows recorded before provenance tracking existed —
  // render as unknown, never assume MODEL.
  modelDecision: AiDecision | null;
  modelConfidence: number | null;
  decisionSource: DecisionSource | null;
}

// Never carries the raw downstream error — only a stable, generic code (see
// backend decisions.service.ts ExecutionView). The UI derives a human
// message from status/attempts/errorCode, not from any exception text.
export interface DecisionExecutionView {
  status: 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN_LEGACY';
  attempts: number;
  errorCode: string | null;
}

export interface FeedbackView {
  reasonCode: string;
  missingContext: string | null;
  precedentEligible: boolean;
  precedentStatus: string | null;
  precedentApprovedAt: string | null;
}

export interface HumanDecisionRecord {
  id: string;
  outcome: DecisionOutcome;
  overridesRecommendation: boolean;
  rationale: string | null;
  reviewerId: string;
  createdAt: string;
  execution: DecisionExecutionView | null;
  feedback: FeedbackView | null;
}

export interface ActiveEntitlement {
  systemName: string;
  entitlementKey: string;
  grantedDate?: string;
}

export interface SodConflict {
  ruleId: string;
  conflictingEntitlementKey: string;
  description: string;
}

export interface EntitlementSnapshot {
  currentActiveEntitlements: ActiveEntitlement[];
  alreadyHasRequestedEntitlement: boolean;
  sodConflicts: SodConflict[];
}

export interface AccessRequest {
  id: string;
  requestId: string;
  employeeId: string;
  requestType: string;
  targetSystem: string;
  entitlementKey: string;
  justification: string;
  requesterTitle: string;
  requesterDepartment: string;
  requesterCostCenter: string;
  status: RequestStatus;
  entitlementSnapshot: EntitlementSnapshot | null;
  submittedAt: string;
  createdAt: string;
  recommendations: AiRecommendation[];
  humanDecisions: HumanDecisionRecord[];
}

export interface DecisionPayload {
  outcome: DecisionOutcome;
  rationale?: string;
  // Required by the API: every decision must record why, agreement included.
  reasonCode: PrecedentReasonCode;
  missingContext?: string;
  precedentEligible?: boolean;
}

export const PRECEDENT_REASON_CODES = [
  'CONFIRMS_POLICY',
  'POLICY_MISAPPLIED',
  'MISSING_CONTEXT',
  'BUSINESS_EXCEPTION',
  'PRECEDENT_CONFLICT',
  'OTHER',
] as const;

export type PrecedentReasonCode = (typeof PRECEDENT_REASON_CODES)[number];

export type PrecedentStatus = 'PROPOSED' | 'ACTIVE' | 'REVOKED';

export interface PrecedentGovernanceRecord {
  id: string;
  status: PrecedentStatus;
  targetSystem: string;
  entitlementKey: string;
  department: string | null;
  costCenter: string | null;
  summary: string;
  policyVersionSnapshot: unknown;
  accessRequestId: string;
  decisionFeedbackId: string;
  approvedBy: string | null;
  approvedAt: string | null;
  revokedReason: string | null;
  createdAt: string;
}

export type RuleSuggestionStatus = 'PROPOSED' | 'ACCEPTED' | 'DISMISSED';

export interface RuleSuggestionRecord {
  id: string;
  patternType: string;
  targetSystem: string;
  entitlementKey: string;
  description: string;
  supportingDecisionIds: string[];
  status: RuleSuggestionStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
}

export interface RuleSuggestionAcceptResult extends RuleSuggestionRecord {
  activatedPrecedentIds: string[];
  // Null when the approver accepted without guidance — the acceptance is
  // recorded, but nothing retrievable was created.
  operatingRuleId: string | null;
}

export type OperatingRuleStatus = 'ACTIVE' | 'REVOKED';

// Governance-approved guidance for one (targetSystem, entitlementKey). Only
// ACTIVE rules are read at recommendation time, so revoking one takes effect
// on the very next request with no redeploy.
export interface OperatingRuleRecord {
  id: string;
  ruleSuggestionId: string;
  targetSystem: string;
  entitlementKey: string;
  patternType: string;
  guidance: string;
  status: OperatingRuleStatus;
  approvedBy: string;
  approvedAt: string;
  revokedBy: string | null;
  revokedReason: string | null;
  revokedAt: string | null;
}
