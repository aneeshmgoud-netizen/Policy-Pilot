import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchAccessRequests,
  submitDecision,
  type DecisionResponse,
} from './lib/access-requests';
import type { AccessRequest, DecisionPayload } from './types';

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
