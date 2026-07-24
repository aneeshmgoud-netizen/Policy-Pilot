// Shapes returned by GET /api/v1/access-requests. Dates arrive as ISO strings.

export type AiDecision = 'APPROVE' | 'DENY' | 'ESCALATE';
export type HumanDecisionType = 'APPROVE' | 'DENY' | 'OVERRIDE';
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

export interface AiRecommendation {
  id: string;
  decision: AiDecision;
  justification: string;
  confidence: number;
  modelName: string;
  promptVersion: string;
  attemptNumber: number;
  createdAt: string;
  citations: PolicyCitation[];
}

export interface HumanDecisionRecord {
  id: string;
  decision: HumanDecisionType;
  rationale: string | null;
  reviewerId: string;
  createdAt: string;
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
  decisionType: HumanDecisionType;
  rationale?: string;
}
