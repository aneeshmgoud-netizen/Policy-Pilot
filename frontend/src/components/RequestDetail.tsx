import type {
  AccessRequest,
  AiRecommendation,
  DecisionExecutionView,
  DecisionOutcome,
} from '../types';
import { DecisionBadge, OverrideBadge, StatusBadge } from './Badge';
import { DecisionControls } from './DecisionControls';

function confidencePct(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function formatDate(value: string | null): string {
  if (!value) return 'an unknown date';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
    new Date(value),
  );
}

function knowledgeRetainedMessage(
  feedback: AccessRequest['humanDecisions'][number]['feedback'],
): string | null {
  if (!feedback) return null;
  if (!feedback.precedentEligible) {
    return 'Case-only — not flagged for future reference.';
  }
  if (feedback.precedentStatus === 'ACTIVE') {
    return `Promoted as precedent on ${formatDate(feedback.precedentApprovedAt)}.`;
  }
  if (feedback.precedentStatus === 'REVOKED') {
    return 'Was promoted as precedent, later revoked.';
  }
  return 'Flagged as potential precedent — pending governance review.';
}

// Heading for the recommendation panel. The panel shows the EFFECTIVE
// recommendation, which is not always the AI's — labelling a deterministic
// override "AI Recommendation" (as this did previously) attributes a decision
// to the model that the model did not make, and shows the model's confidence
// as if it were confidence in that override.
function recommendationHeading(recommendation: AiRecommendation): string {
  switch (recommendation.decisionSource) {
    case 'GROUNDING_GATE':
      return 'System Recommendation (verification override)';
    case 'SOD_RULE':
      return 'System Recommendation (Separation-of-Duties rule)';
    default:
      return 'AI Recommendation';
  }
}

// Only meaningful when the gate rewrote something. Returns null otherwise, so
// the ordinary case stays visually unchanged rather than gaining a
// "nothing was overridden" line on every request.
function overrideNotice(recommendation: AiRecommendation): string | null {
  if (recommendation.decisionSource !== 'GROUNDING_GATE') {
    return null;
  }
  const proposed = recommendation.modelDecision;
  const confidence =
    recommendation.modelConfidence === null
      ? null
      : confidencePct(recommendation.modelConfidence);
  if (!proposed) {
    return 'Automated verification replaced the original recommendation below.';
  }
  const proposedText =
    confidence === null
      ? `proposed ${proposed}`
      : `proposed ${proposed} at ${confidence} confidence`;
  return proposed === recommendation.decision
    ? `${recommendation.modelName} ${proposedText}; automated verification kept the decision but rewrote the reasoning below.`
    : `${recommendation.modelName} ${proposedText}. Automated verification did not accept it — the ${recommendation.decision} below was produced by the system, not the model.`;
}

function impliedOutcome(decision: string | undefined): DecisionOutcome | null {
  if (decision === 'APPROVE') return 'GRANT';
  if (decision === 'DENY') return 'DENY';
  return null;
}

// A generic, safe-to-render message per execution status. Deliberately never
// touches any raw error text — the API doesn't even send it (see
// DecisionExecutionView / decisions.service.ts's ExecutionView). Only status,
// attempts, and a stable error code reach the browser.
function executionMessage(execution: DecisionExecutionView): string | null {
  switch (execution.status) {
    case 'SUCCEEDED':
      return null;
    case 'PENDING':
      return execution.attempts > 0
        ? `Execution failed after ${execution.attempts} attempt(s). Retry is pending.`
        : 'Execution pending.';
    case 'PROCESSING':
      return 'Execution in progress.';
    case 'FAILED':
      return 'Execution failed. Administrative review required.';
    case 'UNKNOWN_LEGACY':
      return 'Execution status unknown — recorded before execution tracking existed.';
    default:
      return null;
  }
}

export function RequestDetail({ request }: { request: AccessRequest }) {
  const snapshot = request.entitlementSnapshot;
  const recommendation = request.recommendations[0];
  const humanDecision = request.humanDecisions[0];
  const decided = request.status === 'DECIDED';
  const awaitingDecision = request.status === 'RECOMMENDED';

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
        <h3>{recommendation ? recommendationHeading(recommendation) : 'AI Recommendation'}</h3>
        {!recommendation ? (
          <p className="muted">No AI recommendation yet.</p>
        ) : (
          <div className="ai-insights">
            <div className="ai-headline">
              <DecisionBadge decision={recommendation.decision} />
              {/* Confidence is the model's own number. It is only meaningful
                  alongside a decision the model actually made, so it is hidden
                  once the gate has overridden — the override notice reports it
                  attached to the proposal it belongs to instead. */}
              {recommendation.decisionSource !== 'GROUNDING_GATE' && (
                <span className="confidence">
                  confidence {confidencePct(recommendation.confidence)}
                </span>
              )}
              <span className="model-tag">
                {recommendation.modelName} · {recommendation.promptVersion}
              </span>
            </div>
            {overrideNotice(recommendation) && (
              <p className="override-notice">{overrideNotice(recommendation)}</p>
            )}
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

      {/* --- Supporting precedent, deliberately distinct from policy evidence --- */}
      <section className="detail-section precedent-panel">
        <h3>Precedent</h3>
        {!recommendation ? (
          <p className="muted">(no precedent cited)</p>
        ) : (
          <div className="citations precedent-citations">
            {recommendation.precedentCitations.length === 0 ? (
              <p className="muted">(no precedent cited)</p>
            ) : (
              <ul>
                {recommendation.precedentCitations.map((citation) => (
                  <li key={citation.precedentRecordId} className="citation">
                    <div className="citation-head">
                      <DecisionBadge
                        decision={citation.outcomeSnapshot as DecisionOutcome}
                      />
                      <span className="precedent-relevance">
                        {citation.relevanceReason}
                      </span>
                    </div>
                    <blockquote>{citation.summarySnapshot}</blockquote>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* --- Decision --- */}
      <section className="detail-section">
        {decided && humanDecision ? (
          <div className="decided-box">
            <h3>Decision Recorded</h3>
            <p>
              <DecisionBadge decision={humanDecision.outcome} />{' '}
              {humanDecision.overridesRecommendation && <OverrideBadge />} by{' '}
              <span className="mono">{humanDecision.reviewerId}</span>
            </p>
            {humanDecision.rationale && (
              <blockquote>{humanDecision.rationale}</blockquote>
            )}
            {humanDecision.feedback && (
              <div className="decision-feedback">
                <p>
                  <span className="label">Feedback reason</span>{' '}
                  <span className="mono">
                    {humanDecision.feedback.reasonCode}
                  </span>
                </p>
                {humanDecision.feedback.missingContext && (
                  <div>
                    <span className="label">Missing context</span>
                    <blockquote>{humanDecision.feedback.missingContext}</blockquote>
                  </div>
                )}
                <p className="knowledge-retained">
                  <span className="label">Knowledge retained</span>{' '}
                  {knowledgeRetainedMessage(humanDecision.feedback)}
                </p>
              </div>
            )}
            {humanDecision.execution && executionMessage(humanDecision.execution) && (
              <p className="info-line">{executionMessage(humanDecision.execution)}</p>
            )}
          </div>
        ) : awaitingDecision ? (
          <DecisionControls
            accessRequestId={request.id}
            recommendedOutcome={impliedOutcome(recommendation?.decision)}
          />
        ) : (
          <p className="muted">Not yet ready for a reviewer decision.</p>
        )}
      </section>
    </div>
  );
}
