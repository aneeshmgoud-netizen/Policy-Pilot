import type { AiDecision, DecisionOutcome, RequestStatus } from '../types';

export function DecisionBadge({
  decision,
}: {
  decision: AiDecision | DecisionOutcome;
}) {
  return (
    <span className={`badge badge-decision badge-${decision.toLowerCase()}`}>
      {decision}
    </span>
  );
}

export function OverrideBadge() {
  return <span className="badge badge-decision badge-override">override</span>;
}

export function StatusBadge({ status }: { status: RequestStatus }) {
  return (
    <span className={`badge badge-status badge-status-${status.toLowerCase()}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}
