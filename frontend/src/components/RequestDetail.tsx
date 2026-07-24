import type { AccessRequest } from '../types';
import { DecisionBadge, StatusBadge } from './Badge';
import { DecisionControls } from './DecisionControls';

function confidencePct(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

export function RequestDetail({ request }: { request: AccessRequest }) {
  const snapshot = request.entitlementSnapshot;
  const recommendation = request.recommendations[0];
  const humanDecision = request.humanDecisions[0];
  const decided = request.status === 'DECIDED';

  return (
    <div className="detail">
      <header className="detail-header">
        <div>
          <h2>{request.requestId}</h2>
          <p className="detail-sub">
            {request.entitlementKey} on <strong>{request.targetSystem}</strong>
          </p>
        </div>
        <StatusBadge status={request.status} />
      </header>

      {/* --- Context --- */}
      <section className="detail-section">
        <h3>Request Context</h3>
        <dl className="kv">
          <div>
            <dt>Requester</dt>
            <dd className="mono">{request.employeeId}</dd>
          </div>
          <div>
            <dt>Title / Dept</dt>
            <dd>
              {request.requesterTitle} · {request.requesterDepartment}
            </dd>
          </div>
          <div>
            <dt>Cost center</dt>
            <dd className="mono">{request.requesterCostCenter}</dd>
          </div>
          <div>
            <dt>Request type</dt>
            <dd>{request.requestType}</dd>
          </div>
        </dl>
        <div className="justification">
          <span className="label">Justification</span>
          <blockquote>{request.justification}</blockquote>
        </div>
      </section>

      {/* --- Current entitlements + SoD --- */}
      <section className="detail-section">
        <h3>Current Entitlements</h3>
        {!snapshot ? (
          <p className="muted">Entitlement snapshot not yet available.</p>
        ) : (
          <>
            {snapshot.sodConflicts.length > 0 && (
              <div className="conflict-box">
                <strong>⚠ Separation-of-Duties conflict</strong>
                <ul>
                  {snapshot.sodConflicts.map((c) => (
                    <li key={c.ruleId}>
                      <span className="mono">{c.ruleId}</span> — conflicts with
                      held <span className="mono">{c.conflictingEntitlementKey}</span>
                      : {c.description}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {snapshot.alreadyHasRequestedEntitlement && (
              <p className="info-line">
                Requester already holds the requested entitlement.
              </p>
            )}
            {snapshot.currentActiveEntitlements.length === 0 ? (
              <p className="muted">No active entitlements on record.</p>
            ) : (
              <ul className="entitlement-list">
                {snapshot.currentActiveEntitlements.map((e) => (
                  <li key={`${e.systemName}:${e.entitlementKey}`}>
                    <span className="mono">{e.entitlementKey}</span>
                    <span className="muted"> on {e.systemName}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {/* --- AI insights --- */}
      <section className="detail-section">
        <h3>AI Recommendation</h3>
        {!recommendation ? (
          <p className="muted">No AI recommendation yet.</p>
        ) : (
          <div className="ai-insights">
            <div className="ai-headline">
              <DecisionBadge decision={recommendation.decision} />
              <span className="confidence">
                confidence {confidencePct(recommendation.confidence)}
              </span>
              <span className="model-tag">
                {recommendation.modelName} · {recommendation.promptVersion}
              </span>
            </div>
            <p className="ai-justification">{recommendation.justification}</p>
            <div className="citations">
              <span className="label">Policy citations</span>
              {recommendation.citations.length === 0 ? (
                <p className="muted">No citations provided.</p>
              ) : (
                <ul>
                  {recommendation.citations.map((c, i) => (
                    <li key={i} className="citation">
                      <div className="citation-head">
                        <span className="mono">{c.documentName}</span>
                        {c.section && <span className="section">§ {c.section}</span>}
                      </div>
                      <blockquote>{c.excerpt}</blockquote>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </section>

      {/* --- Decision --- */}
      <section className="detail-section">
        {decided && humanDecision ? (
          <div className="decided-box">
            <h3>Decision Recorded</h3>
            <p>
              <DecisionBadge decision={humanDecision.decision} /> by{' '}
              <span className="mono">{humanDecision.reviewerId}</span>
            </p>
            {humanDecision.rationale && (
              <blockquote>{humanDecision.rationale}</blockquote>
            )}
          </div>
        ) : (
          <DecisionControls accessRequestId={request.id} />
        )}
      </section>
    </div>
  );
}
