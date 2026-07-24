import { z } from 'zod';

// Strict output contract for the recommendation LLM. Every model response is
// validated against this before it is trusted or persisted; anything that
// doesn't parse triggers a retry (see AgentService).

export const PolicyCitationSchema = z.object({
  document_name: z.string().min(1),
  section: z.string(),
  excerpt: z.string().min(1),
});

export const RecommendationSchema = z.object({
  decision: z.enum(['APPROVE', 'DENY', 'ESCALATE']),
  justification: z.string().min(1),
  policy_citations: z.array(PolicyCitationSchema),
  // Model self-reported confidence in [0, 1].
  confidence: z.number().min(0).max(1),
});

export type PolicyCitation = z.infer<typeof PolicyCitationSchema>;
export type Recommendation = z.infer<typeof RecommendationSchema>;

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
  documentName: string;
  section: string | null;
  content: string;
}

export interface RecommendationInput {
  accessRequest: AgentAccessRequest;
  entitlementSnapshot: AgentEntitlementSnapshot;
  retrievedChunks: AgentRetrievedChunk[];
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
