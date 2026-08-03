import { useState } from 'react';
import {
  useAcceptRuleSuggestion,
  useApprovePrecedent,
  useDiscoverPatterns,
  useDismissRuleSuggestion,
  useOperatingRules,
  usePrecedents,
  useRevokeOperatingRule,
  useRevokePrecedent,
  useRuleSuggestions,
} from '../hooks';
import { ApiError } from '../lib/api-client';
import { useAuth } from '../lib/auth';
import type { PrecedentStatus, RuleSuggestionStatus } from '../types';
import { useToast } from './Toast';

function formatDate(value: string | null): string {
  if (!value) return 'an unknown date';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
    new Date(value),
  );
}

function errorMessage(error: unknown, action: string): string {
  return error instanceof ApiError
    ? `${action} failed (${error.status})`
    : `${action} failed`;
}

export function GovernanceQueuePage() {
  const { user, logout } = useAuth();
  const showToast = useToast();
  const [precedentStatus, setPrecedentStatus] =
    useState<PrecedentStatus>('PROPOSED');
  const [suggestionStatus, setSuggestionStatus] =
    useState<RuleSuggestionStatus>('PROPOSED');
  const [precedentReview, setPrecedentReview] = useState<{
    id: string;
    action: 'Reject' | 'Revoke';
  } | null>(null);
  const [revokedReason, setRevokedReason] = useState('');
  const [suggestionReview, setSuggestionReview] = useState<{
    id: string;
    action: 'Accept' | 'Dismiss';
  } | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  // The guidance an approver attaches when accepting. This — not the review
  // note — is what becomes a retrievable OperatingRule and changes future
  // recommendations.
  const [guidance, setGuidance] = useState('');
  const [ruleRevoke, setRuleRevoke] = useState<string | null>(null);
  const [ruleRevokedReason, setRuleRevokedReason] = useState('');

  const precedents = usePrecedents(precedentStatus);
  const suggestions = useRuleSuggestions(suggestionStatus);
  const discover = useDiscoverPatterns();
  const approve = useApprovePrecedent();
  const revoke = useRevokePrecedent();
  const accept = useAcceptRuleSuggestion();
  const dismiss = useDismissRuleSuggestion();
  const operatingRules = useOperatingRules();
  const revokeRule = useRevokeOperatingRule();

  const startPrecedentReview = (id: string, action: 'Reject' | 'Revoke') => {
    setPrecedentReview({ id, action });
    setRevokedReason('');
  };

  const startSuggestionReview = (id: string, action: 'Accept' | 'Dismiss') => {
    setSuggestionReview({ id, action });
    setReviewNote('');
    setGuidance('');
  };

  const submitPrecedentReview = () => {
    if (!precedentReview || !revokedReason.trim()) return;
    revoke.mutate(
      { id: precedentReview.id, revokedReason: revokedReason.trim() },
      {
        onSuccess: () => {
          showToast(
            precedentReview.action === 'Reject'
              ? 'Precedent rejected.'
              : 'Precedent revoked.',
            'success',
          );
          setPrecedentReview(null);
          setRevokedReason('');
        },
        onError: (error) => showToast(errorMessage(error, precedentReview.action), 'error'),
      },
    );
  };

  const submitSuggestionReview = () => {
    if (!suggestionReview) return;
    const variables = {
      id: suggestionReview.id,
      ...(reviewNote.trim() ? { reviewNote: reviewNote.trim() } : {}),
    };
    if (suggestionReview.action === 'Accept') {
      accept.mutate(
        {
          ...variables,
          ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
        },
        {
          onSuccess: (result) => {
            // Say plainly whether anything retrievable was created. An
            // acceptance with no guidance is recorded but changes no future
            // recommendation, and the approver should not have to infer that.
            showToast(
              result.operatingRuleId
                ? `Accepted. Operating rule is now active for ${result.targetSystem} / ${result.entitlementKey}.`
                : 'Accepted, but no guidance was supplied — no operating rule was created, so future requests are unchanged.',
              result.operatingRuleId ? 'success' : 'error',
            );
            setSuggestionReview(null);
            setReviewNote('');
            setGuidance('');
          },
          onError: (error) => showToast(errorMessage(error, 'Accept'), 'error'),
        },
      );
      return;
    }
    dismiss.mutate(variables, {
      onSuccess: () => {
        showToast('Suggestion dismissed.', 'success');
        setSuggestionReview(null);
        setReviewNote('');
        setGuidance('');
      },
      onError: (error) => showToast(errorMessage(error, 'Dismiss'), 'error'),
    });
  };

  const suggestionMutationPending = accept.isPending || dismiss.isPending;

  const submitRuleRevoke = () => {
    if (!ruleRevoke || !ruleRevokedReason.trim()) return;
    revokeRule.mutate(
      { id: ruleRevoke, revokedReason: ruleRevokedReason.trim() },
      {
        onSuccess: () => {
          showToast(
            'Operating rule revoked. It will not be retrieved for any further request.',
            'success',
          );
          setRuleRevoke(null);
          setRuleRevokedReason('');
        },
        onError: (error) => showToast(errorMessage(error, 'Revoke'), 'error'),
      },
    );
  };

  return (
    <div className="app governance-page">
      <header className="app-header">
        <div>
          <h1>Policy Pilot</h1>
          <p className="tagline">Live Learning governance queue</p>
        </div>
        <div className="header-actions">
          <span className="current-user">
            Signed in as <strong>{user?.displayName}</strong>
          </span>
          <button type="button" className="btn btn-ghost" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      <main className="governance-content">
        <div className="governance-intro">
          <div>
            <h2>Governance review</h2>
            <p className="muted">
              Review retained precedent and candidate patterns before they influence
              future recommendations.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-override"
            disabled={discover.isPending}
            onClick={() =>
              discover.mutate(undefined, {
                onSuccess: (created) =>
                  showToast(
                    `Pattern discovery found ${created.length} new suggestion(s).`,
                    'success',
                  ),
                onError: (error) =>
                  showToast(errorMessage(error, 'Pattern discovery'), 'error'),
              })
            }
          >
            {discover.isPending ? 'Discovering…' : 'Discover patterns'}
          </button>
        </div>

        <section className="governance-section">
          <div className="governance-section-head">
            <h3>Precedents</h3>
            <label>
              Status
              <select
                value={precedentStatus}
                onChange={(event) => {
                  setPrecedentStatus(event.target.value as PrecedentStatus);
                  setPrecedentReview(null);
                }}
              >
                <option value="PROPOSED">Proposed</option>
                <option value="ACTIVE">Active</option>
                <option value="REVOKED">Revoked</option>
              </select>
            </label>
          </div>
          {precedents.isLoading ? (
            <p className="state">Loading precedents…</p>
          ) : precedents.isError ? (
            <p className="state state-error">Failed to load precedents.</p>
          ) : precedents.data?.length === 0 ? (
            <p className="state">No {precedentStatus.toLowerCase()} precedents.</p>
          ) : (
            <ul className="governance-list">
              {precedents.data?.map((precedent) => (
                <li key={precedent.id} className="governance-card">
                  <div className="governance-card-head">
                    <div>
                      <strong>{precedent.targetSystem}</strong>
                      <span className="mono"> {precedent.entitlementKey}</span>
                    </div>
                    <span className={`badge badge-governance-${precedent.status.toLowerCase()}`}>
                      {precedent.status}
                    </span>
                  </div>
                  <p>{precedent.summary}</p>
                  {precedent.approvedBy && (
                    <p className="muted">Approved by {precedent.approvedBy}</p>
                  )}
                  {precedent.revokedReason && (
                    <p className="review-detail">
                      <span className="label">Revocation reason</span>{' '}
                      {precedent.revokedReason}
                    </p>
                  )}
                  {precedent.status === 'PROPOSED' && (
                    <div className="governance-actions">
                      <button
                        type="button"
                        className="btn btn-approve"
                        disabled={approve.isPending}
                        onClick={() =>
                          approve.mutate(precedent.id, {
                            onSuccess: () => showToast('Precedent approved.', 'success'),
                            onError: (error) =>
                              showToast(errorMessage(error, 'Approve'), 'error'),
                          })
                        }
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="btn btn-deny"
                        onClick={() => startPrecedentReview(precedent.id, 'Reject')}
                      >
                        Reject
                      </button>
                    </div>
                  )}
                  {precedent.status === 'ACTIVE' && (
                    <div className="governance-actions">
                      <button
                        type="button"
                        className="btn btn-deny"
                        onClick={() => startPrecedentReview(precedent.id, 'Revoke')}
                      >
                        Revoke
                      </button>
                    </div>
                  )}
                  {precedentReview?.id === precedent.id && (
                    <div className="inline-review-form">
                      <label htmlFor={`revoke-${precedent.id}`}>
                        {precedentReview.action} reason <span className="required">(required)</span>
                      </label>
                      <textarea
                        id={`revoke-${precedent.id}`}
                        value={revokedReason}
                        onChange={(event) => setRevokedReason(event.target.value)}
                        rows={2}
                      />
                      <div className="governance-actions">
                        <button
                          type="button"
                          className="btn btn-deny"
                          disabled={revoke.isPending || !revokedReason.trim()}
                          onClick={submitPrecedentReview}
                        >
                          Confirm {precedentReview.action}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={revoke.isPending}
                          onClick={() => setPrecedentReview(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="governance-section">
          <div className="governance-section-head">
            <h3>Rule Suggestions</h3>
            <label>
              Status
              <select
                value={suggestionStatus}
                onChange={(event) => {
                  setSuggestionStatus(event.target.value as RuleSuggestionStatus);
                  setSuggestionReview(null);
                }}
              >
                <option value="PROPOSED">Proposed</option>
                <option value="ACCEPTED">Accepted</option>
                <option value="DISMISSED">Dismissed</option>
              </select>
            </label>
          </div>
          {suggestions.isLoading ? (
            <p className="state">Loading rule suggestions…</p>
          ) : suggestions.isError ? (
            <p className="state state-error">Failed to load rule suggestions.</p>
          ) : suggestions.data?.length === 0 ? (
            <p className="state">No {suggestionStatus.toLowerCase()} rule suggestions.</p>
          ) : (
            <ul className="governance-list">
              {suggestions.data?.map((suggestion) => (
                <li key={suggestion.id} className="governance-card">
                  <div className="governance-card-head">
                    <div>
                      <strong>{suggestion.patternType.replace(/_/g, ' ')}</strong>
                      <p className="mono">
                        {suggestion.targetSystem} / {suggestion.entitlementKey}
                      </p>
                    </div>
                    <span className={`badge badge-governance-${suggestion.status.toLowerCase()}`}>
                      {suggestion.status}
                    </span>
                  </div>
                  <p>{suggestion.description}</p>
                  <p className="muted">
                    {suggestion.supportingDecisionIds.length} supporting decision(s)
                  </p>
                  {suggestion.status === 'PROPOSED' && (
                    <div className="governance-actions">
                      <button
                        type="button"
                        className="btn btn-approve"
                        onClick={() => startSuggestionReview(suggestion.id, 'Accept')}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        className="btn btn-deny"
                        onClick={() => startSuggestionReview(suggestion.id, 'Dismiss')}
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                  {suggestionReview?.id === suggestion.id && (
                    <div className="inline-review-form">
                      <label htmlFor={`suggestion-${suggestion.id}`}>
                        Review note <span className="muted">(optional, not read by the AI)</span>
                      </label>
                      <textarea
                        id={`suggestion-${suggestion.id}`}
                        value={reviewNote}
                        onChange={(event) => setReviewNote(event.target.value)}
                        rows={2}
                      />
                      {suggestionReview.action === 'Accept' && (
                        <>
                          <label htmlFor={`guidance-${suggestion.id}`}>
                            Operating guidance{' '}
                            <span className="muted">
                              — read by the AI on every future{' '}
                              {suggestion.targetSystem} / {suggestion.entitlementKey}{' '}
                              request. Leave empty to record the acceptance only.
                            </span>
                          </label>
                          <textarea
                            id={`guidance-${suggestion.id}`}
                            value={guidance}
                            onChange={(event) => setGuidance(event.target.value)}
                            placeholder="e.g. Escalate these to Data Governance until the Q3 recertification closes, even where the cost center is otherwise eligible."
                            rows={3}
                          />
                          {guidance.trim().length > 0 && guidance.trim().length < 10 && (
                            <p className="state state-error">
                              Guidance must be a usable instruction, not a placeholder.
                            </p>
                          )}
                        </>
                      )}
                      <div className="governance-actions">
                        <button
                          type="button"
                          className={
                            suggestionReview.action === 'Accept'
                              ? 'btn btn-approve'
                              : 'btn btn-deny'
                          }
                          disabled={suggestionMutationPending}
                          onClick={submitSuggestionReview}
                        >
                          Confirm {suggestionReview.action}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={suggestionMutationPending}
                          onClick={() => setSuggestionReview(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Approved operating guidance — the knowledge that actually reaches
            future recommendations, and the one place it can be withdrawn. */}
        <section className="governance-section">
          <div className="governance-section-head">
            <div>
              <h2>Operating rules</h2>
              <p className="muted">
                Approved guidance read by the AI on every matching request. Revoking
                one takes effect on the next request — no deploy.
              </p>
            </div>
          </div>
          {operatingRules.isLoading ? (
            <p className="state">Loading operating rules…</p>
          ) : operatingRules.isError ? (
            <p className="state state-error">Failed to load operating rules.</p>
          ) : operatingRules.data?.length === 0 ? (
            <p className="state">
              No operating rules yet. Accept a rule suggestion with guidance to create one.
            </p>
          ) : (
            <ul className="governance-list">
              {operatingRules.data?.map((rule) => (
                <li key={rule.id} className="governance-card">
                  <div className="governance-card-head">
                    <div>
                      <strong>{rule.patternType.replace(/_/g, ' ')}</strong>
                      <p className="mono">
                        {rule.targetSystem} / {rule.entitlementKey}
                      </p>
                    </div>
                    <span className={`badge badge-governance-${rule.status.toLowerCase()}`}>
                      {rule.status}
                    </span>
                  </div>
                  <blockquote>{rule.guidance}</blockquote>
                  <p className="muted">
                    Approved by <span className="mono">{rule.approvedBy}</span> on{' '}
                    {formatDate(rule.approvedAt)}
                    {rule.status === 'REVOKED' && rule.revokedReason
                      ? ` · revoked: ${rule.revokedReason}`
                      : ''}
                  </p>
                  {rule.status === 'ACTIVE' && (
                    <div className="governance-actions">
                      <button
                        type="button"
                        className="btn btn-deny"
                        onClick={() => {
                          setRuleRevoke(rule.id);
                          setRuleRevokedReason('');
                        }}
                      >
                        Revoke
                      </button>
                    </div>
                  )}
                  {ruleRevoke === rule.id && (
                    <div className="inline-review-form">
                      <label htmlFor={`rule-revoke-${rule.id}`}>
                        Reason <span className="required">(required)</span>
                      </label>
                      <textarea
                        id={`rule-revoke-${rule.id}`}
                        value={ruleRevokedReason}
                        onChange={(event) => setRuleRevokedReason(event.target.value)}
                        rows={2}
                      />
                      <div className="governance-actions">
                        <button
                          type="button"
                          className="btn btn-deny"
                          disabled={revokeRule.isPending || !ruleRevokedReason.trim()}
                          onClick={submitRuleRevoke}
                        >
                          Confirm revoke
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={revokeRule.isPending}
                          onClick={() => setRuleRevoke(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
