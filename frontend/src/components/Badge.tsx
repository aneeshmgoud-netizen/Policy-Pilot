import type { AiDecision, HumanDecisionType, RequestStatus } from '../types';

export function DecisionBadge({
  decision,
}: {
  decision: AiDecision | HumanDecisionType;
}) {
  return (
    <span className={`badge badge-decision badge-${decision.toLowerCase()}`}>
      {decision}
    </span>
  );
}

export function StatusBadge({ status }: { status: RequestStatus }) {
  return (
    <span className={`badge badge-status badge-status-${status.toLowerCase()}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}
