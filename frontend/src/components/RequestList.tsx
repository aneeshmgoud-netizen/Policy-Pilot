import { maskEmployeeId } from '../lib/mask';
import type { AccessRequest } from '../types';
import { DecisionBadge, StatusBadge } from './Badge';

function latestDecision(request: AccessRequest) {
  return request.recommendations[0]?.decision;
}

export function RequestList({
  requests,
  selectedId,
  onSelect,
}: {
  requests: AccessRequest[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="request-list">
      {requests.map((request) => {
        const decision = latestDecision(request);
        return (
          <li key={request.id}>
            <button
              type="button"
              className={`request-item${request.id === selectedId ? ' is-selected' : ''}`}
              onClick={() => onSelect(request.id)}
            >
              <div className="request-item-top">
                <span className="request-item-id">{request.requestId}</span>
                {decision ? (
                  <DecisionBadge decision={decision} />
                ) : (
                  <span className="badge badge-muted">no AI yet</span>
                )}
              </div>
              <div className="request-item-mid">
                <span className="mono">{maskEmployeeId(request.employeeId)}</span>
                <span className="request-item-target">
                  {request.entitlementKey} · {request.targetSystem}
                </span>
              </div>
              <div className="request-item-bot">
                <StatusBadge status={request.status} />
                {request.entitlementSnapshot?.sodConflicts.length ? (
                  <span className="badge badge-conflict">SoD conflict</span>
                ) : null}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
