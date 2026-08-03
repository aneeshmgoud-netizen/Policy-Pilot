import { useState } from 'react';
import { useSubmitDecision } from '../hooks';
import { ApiError } from '../lib/api-client';
import {
  PRECEDENT_REASON_CODES,
  type DecisionOutcome,
  type DecisionPayload,
  type PrecedentReasonCode,
} from '../types';
import { useToast } from './Toast';

// recommendedOutcome is the outcome implied by the AI recommendation (APPROVE
// -> GRANT, DENY -> DENY), or null when there is no recommendation yet or it
// escalated. It only drives the client-side "do we need a rationale" prompt —
// the server is the source of truth and re-derives this itself from the
// actual recommendation before accepting the decision.
export function DecisionControls({
  accessRequestId,
  recommendedOutcome,
}: {
  accessRequestId: string;
  recommendedOutcome: DecisionOutcome | null;
}) {
  const [pendingOutcome, setPendingOutcome] = useState<DecisionOutcome | null>(null);
  const [rationale, setRationale] = useState('');
  const [reasonCode, setReasonCode] = useState<PrecedentReasonCode | ''>('');
  const [missingContext, setMissingContext] = useState('');
  const [precedentEligible, setPrecedentEligible] = useState(false);
  const submit = useSubmitDecision();
  const showToast = useToast();

  const submitOutcome = (outcome: DecisionOutcome, rationaleValue?: string) => {
    if (!reasonCode) {
      // Guarded by the disabled buttons below; this is the belt-and-braces
      // check so a stray call can't post a decision the API would reject.
      return;
    }
    const payload: DecisionPayload = { outcome, reasonCode };
    if (rationaleValue?.trim()) {
      payload.rationale = rationaleValue.trim();
    }
    if (missingContext.trim()) {
      payload.missingContext = missingContext.trim();
    }
    payload.precedentEligible = precedentEligible;

    submit.mutate(
      { accessRequestId, payload },
      {
        onSuccess: () => {
          showToast(`Decision recorded: ${outcome}`, 'success');
          setPendingOutcome(null);
          setRationale('');
          setReasonCode('');
          setMissingContext('');
          setPrecedentEligible(false);
        },
        onError: (error) => {
          const message =
            error instanceof ApiError
              ? `Failed to record decision (${error.status})`
              : 'Failed to record decision';
          showToast(message, 'error');
        },
      },
    );
  };

  const decide = (outcome: DecisionOutcome) => {
    const overrides = recommendedOutcome === null || recommendedOutcome !== outcome;
    if (overrides) {
      // Disagreeing with the AI (or there's nothing to agree with) requires
      // a rationale — collect it before submitting.
      setPendingOutcome(outcome);
      return;
    }
    submitOutcome(outcome);
  };

  const pending = submit.isPending;
  // A reason is required for every decision, agreement included — the system
  // has to preserve why a recommendation was accepted, not only why it was
  // changed, and the reason code is what a future precedent is summarized and
  // retrieved by.
  const reasonMissing = reasonCode === '';
  const decideDisabled = pending || reasonMissing;
  const confirmDisabled =
    pending || reasonMissing || rationale.trim().length === 0;

  return (
    <div className="decision-controls">
      <h3>Reviewer Decision</h3>
      <fieldset className="feedback-fields">
        <legend>Review feedback</legend>
        <label htmlFor="reason-code">
          Reason <span className="required">(required)</span>
        </label>
        <select
          id="reason-code"
          value={reasonCode}
          disabled={pending}
          onChange={(event) =>
            setReasonCode(event.target.value as PrecedentReasonCode | '')
          }
        >
          <option value="">Select a reason…</option>
          {PRECEDENT_REASON_CODES.map((code) => (
            <option key={code} value={code}>
              {code.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
        <label htmlFor="missing-context">Missing context</label>
        <textarea
          id="missing-context"
          value={missingContext}
          disabled={pending}
          onChange={(event) => setMissingContext(event.target.value)}
          placeholder="Optional context the recommendation did not capture"
          rows={2}
        />
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={precedentEligible}
            disabled={pending}
            onChange={(event) => setPrecedentEligible(event.target.checked)}
          />
          This decision may be useful for similar future requests
        </label>
      </fieldset>
      {pendingOutcome === null ? (
        <>
          {reasonMissing && (
            <p className="muted">Select a reason to record a decision.</p>
          )}
          <div className="decision-buttons">
            <button
              type="button"
              className="btn btn-approve"
              disabled={decideDisabled}
              onClick={() => decide('GRANT')}
            >
              Grant
            </button>
            <button
              type="button"
              className="btn btn-deny"
              disabled={decideDisabled}
              onClick={() => decide('DENY')}
            >
              Deny
            </button>
          </div>
        </>
      ) : (
        <div className="override-form">
          <label htmlFor="rationale">
            Rationale <span className="required">(required — disagrees with AI recommendation)</span>
          </label>
          <textarea
            id="rationale"
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            placeholder={`Explain why you are choosing ${pendingOutcome} against the AI recommendation…`}
            rows={3}
          />
          <div className="decision-buttons">
            <button
              type="button"
              className="btn btn-override"
              disabled={confirmDisabled}
              onClick={() => submitOutcome(pendingOutcome, rationale)}
            >
              Submit {pendingOutcome}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={pending}
              onClick={() => {
                setPendingOutcome(null);
                setRationale('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
