import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchAccessRequests,
  submitDecision,
  type DecisionResponse,
} from './lib/access-requests';
import {
  acceptRuleSuggestion,
  fetchOperatingRules,
  revokeOperatingRule,
  approvePrecedent,
  discoverPatterns,
  dismissRuleSuggestion,
  fetchPrecedents,
  fetchRuleSuggestions,
  revokePrecedent,
} from './lib/governance';
import type {
  AccessRequest,
  DecisionPayload,
  OperatingRuleRecord,
  PrecedentGovernanceRecord,
  PrecedentStatus,
  RuleSuggestionAcceptResult,
  RuleSuggestionRecord,
  RuleSuggestionStatus,
} from './types';

const ACCESS_REQUESTS_KEY = ['access-requests'] as const;

export function useAccessRequests() {
  return useQuery<AccessRequest[]>({
    queryKey: ACCESS_REQUESTS_KEY,
    queryFn: fetchAccessRequests,
  });
}

export interface SubmitDecisionVariables {
  accessRequestId: string;
  payload: DecisionPayload;
}

export function useSubmitDecision() {
  const queryClient = useQueryClient();
  return useMutation<DecisionResponse, Error, SubmitDecisionVariables>({
    mutationFn: ({ accessRequestId, payload }) =>
      submitDecision(accessRequestId, payload),
    onSuccess: () => {
      // Re-fetch the list so the decided request reflects its new status.
      void queryClient.invalidateQueries({ queryKey: ACCESS_REQUESTS_KEY });
    },
  });
}

const GOVERNANCE_PRECEDENTS_KEY = ['governance-precedents'] as const;
const RULE_SUGGESTIONS_KEY = ['rule-suggestions'] as const;

export function usePrecedents(status?: PrecedentStatus) {
  return useQuery<PrecedentGovernanceRecord[]>({
    queryKey: [...GOVERNANCE_PRECEDENTS_KEY, status],
    queryFn: () => fetchPrecedents(status),
  });
}

export function useApprovePrecedent() {
  const queryClient = useQueryClient();
  return useMutation<PrecedentGovernanceRecord, Error, string>({
    mutationFn: approvePrecedent,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: GOVERNANCE_PRECEDENTS_KEY });
    },
  });
}

export function useRevokePrecedent() {
  const queryClient = useQueryClient();
  return useMutation<
    PrecedentGovernanceRecord,
    Error,
    { id: string; revokedReason: string }
  >({
    mutationFn: ({ id, revokedReason }) => revokePrecedent(id, revokedReason),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: GOVERNANCE_PRECEDENTS_KEY });
    },
  });
}

export function useRuleSuggestions(status?: RuleSuggestionStatus) {
  return useQuery<RuleSuggestionRecord[]>({
    queryKey: [...RULE_SUGGESTIONS_KEY, status],
    queryFn: () => fetchRuleSuggestions(status),
  });
}

export function useDiscoverPatterns() {
  const queryClient = useQueryClient();
  return useMutation<RuleSuggestionRecord[], Error>({
    mutationFn: discoverPatterns,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RULE_SUGGESTIONS_KEY });
    },
  });
}

export function useAcceptRuleSuggestion() {
  const queryClient = useQueryClient();
  return useMutation<
    RuleSuggestionAcceptResult,
    Error,
    { id: string; reviewNote?: string; guidance?: string }
  >({
    mutationFn: ({ id, reviewNote, guidance }) =>
      acceptRuleSuggestion(id, reviewNote, guidance),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RULE_SUGGESTIONS_KEY });
      void queryClient.invalidateQueries({ queryKey: GOVERNANCE_PRECEDENTS_KEY });
      // Accepting with guidance creates an operating rule, so the rule list
      // must refetch too.
      void queryClient.invalidateQueries({ queryKey: OPERATING_RULES_KEY });
    },
  });
}

export function useDismissRuleSuggestion() {
  const queryClient = useQueryClient();
  return useMutation<
    RuleSuggestionRecord,
    Error,
    { id: string; reviewNote?: string }
  >({
    mutationFn: ({ id, reviewNote }) => dismissRuleSuggestion(id, reviewNote),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RULE_SUGGESTIONS_KEY });
    },
  });
}

const OPERATING_RULES_KEY = ['governance', 'operating-rules'] as const;

export function useOperatingRules() {
  return useQuery<OperatingRuleRecord[], Error>({
    queryKey: OPERATING_RULES_KEY,
    queryFn: fetchOperatingRules,
  });
}

export function useRevokeOperatingRule() {
  const queryClient = useQueryClient();
  return useMutation<
    OperatingRuleRecord,
    Error,
    { id: string; revokedReason: string }
  >({
    mutationFn: ({ id, revokedReason }) => revokeOperatingRule(id, revokedReason),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: OPERATING_RULES_KEY });
    },
  });
}
