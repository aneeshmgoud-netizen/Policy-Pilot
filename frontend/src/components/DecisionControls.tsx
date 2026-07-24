import { useState } from 'react';
import { useSubmitDecision } from '../hooks';
import { ApiError } from '../lib/api-client';
import type { HumanDecisionType } from '../types';
import { useToast } from './Toast';

export function DecisionControls({ accessRequestId }: { accessRequestId: string }) {
  const [overriding, setOverriding] = useState(false);
  const [rationale, setRationale] = useState('');
  const submit = useSubmitDecision();
  const showToast = useToast();

  const decide = (decisionType: HumanDecisionType) => {
    const payload =
      decisionType === 'OVERRIDE'
        ? { decisionType, rationale: rationale.trim() }
        : { decisionType };

    submit.mutate(
      { accessRequestId, payload },
      {
        onSuccess: () => {
          showToast(`Decision recorded: ${decisionType}`, 'success');
          setOverriding(false);
          setRationale('');
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

  const pending = submit.isPending;
  const overrideDisabled = pending || rationale.trim().length === 0;

  return (
    <div className="decision-controls">
      <h3>Reviewer Decision</h3>
      {!overriding ? (
        <div className="decision-buttons">
          <button
            type="button"
            className="btn btn-approve"
            disabled={pending}
            onClick={() => decide('APPROVE')}
          >
            Approve
          </button>
          <button
            type="button"
            className="btn btn-deny"
            disabled={pending}
            onClick={() => decide('DENY')}
          >
            Deny
          </button>
          <button
            type="button"
            className="btn btn-override"
            disabled={pending}
            onClick={() => setOverriding(true)}
          >
            Override…
          </button>
        </div>
      ) : (
        <div className="override-form">
          <label htmlFor="rationale">
            Override rationale <span className="required">(required)</span>
          </label>
          <textarea
            id="rationale"
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            placeholder="Explain why you are overriding the AI recommendation…"
            rows={3}
          />
          <div className="decision-buttons">
            <button
              type="button"
              className="btn btn-override"
              disabled={overrideDisabled}
              onClick={() => decide('OVERRIDE')}
            >
              Submit Override
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={pending}
              onClick={() => {
                setOverriding(false);
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
