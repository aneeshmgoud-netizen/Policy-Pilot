import { apiClient } from './api-client';
import type {
  PrecedentGovernanceRecord,
  PrecedentStatus,
  OperatingRuleRecord,
  RuleSuggestionAcceptResult,
  RuleSuggestionRecord,
  RuleSuggestionStatus,
} from '../types';

export function fetchPrecedents(
  status?: PrecedentStatus,
): Promise<PrecedentGovernanceRecord[]> {
  return apiClient.get(
    `/governance/precedents${status ? `?status=${status}` : ''}`,
  );
}

export function approvePrecedent(
  id: string,
): Promise<PrecedentGovernanceRecord> {
  return apiClient.post(`/governance/precedents/${id}/approve`);
}

export function revokePrecedent(
  id: string,
  revokedReason: string,
): Promise<PrecedentGovernanceRecord> {
  return apiClient.post(`/governance/precedents/${id}/revoke`, {
    revokedReason,
  });
}

export function fetchRuleSuggestions(
  status?: RuleSuggestionStatus,
): Promise<RuleSuggestionRecord[]> {
  return apiClient.get(
    `/governance/rule-suggestions${status ? `?status=${status}` : ''}`,
  );
}

export function discoverPatterns(): Promise<RuleSuggestionRecord[]> {
  return apiClient.post('/governance/rule-suggestions/discover');
}

// `guidance` is the payload that actually makes an accepted pattern influence
// future requests: the backend turns it into an ACTIVE OperatingRule that
// recommendation-time retrieval reads. Accepting without it records the
// acceptance and creates nothing retrievable.
export function acceptRuleSuggestion(
  id: string,
  reviewNote?: string,
  guidance?: string,
): Promise<RuleSuggestionAcceptResult> {
  const body: { reviewNote?: string; guidance?: string } = {};
  if (reviewNote) body.reviewNote = reviewNote;
  if (guidance) body.guidance = guidance;
  return apiClient.post(
    `/governance/rule-suggestions/${id}/accept`,
    Object.keys(body).length > 0 ? body : undefined,
  );
}

export function fetchOperatingRules(): Promise<OperatingRuleRecord[]> {
  return apiClient.get('/governance/rule-suggestions/operating-rules');
}

export function revokeOperatingRule(
  id: string,
  revokedReason: string,
): Promise<OperatingRuleRecord> {
  return apiClient.post(
    `/governance/rule-suggestions/operating-rules/${id}/revoke`,
    { revokedReason },
  );
}

export function dismissRuleSuggestion(
  id: string,
  reviewNote?: string,
): Promise<RuleSuggestionRecord> {
  return apiClient.post(
    `/governance/rule-suggestions/${id}/dismiss`,
    reviewNote ? { reviewNote } : undefined,
  );
}
