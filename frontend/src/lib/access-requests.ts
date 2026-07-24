import { apiClient } from './api-client';
import type { AccessRequest, DecisionPayload } from '../types';

export function fetchAccessRequests(): Promise<AccessRequest[]> {
  return apiClient.get<AccessRequest[]>('/access-requests');
}

export interface DecisionResponse {
  id: string;
  accessRequestId: string;
  decisionType: string;
  status: string;
}

export function submitDecision(
  accessRequestId: string,
  payload: DecisionPayload,
): Promise<DecisionResponse> {
  return apiClient.post<DecisionResponse>(
    `/access-requests/${accessRequestId}/decisions`,
    payload,
  );
}
