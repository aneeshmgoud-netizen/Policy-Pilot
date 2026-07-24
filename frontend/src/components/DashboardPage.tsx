import { useState } from 'react';
import { useAccessRequests } from '../hooks';
import { useAuth } from '../lib/auth';
import { RequestDetail } from './RequestDetail';
import { RequestList } from './RequestList';

export function DashboardPage() {
  const { data, isLoading, isError, error, refetch, isFetching } =
    useAccessRequests();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { user, logout } = useAuth();

  const requests = data ?? [];
  const selected = requests.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>Policy Pilot</h1>
          <p className="tagline">Human-in-the-loop access review</p>
        </div>
        <div className="header-actions">
          {user && (
            <span className="current-user">
              Signed in as <strong>{user.displayName}</strong>
            </span>
          )}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      <main className="layout">
        <aside className="sidebar">
          <div className="sidebar-head">
            <h2>Requests</h2>
            <span className="count">{requests.length}</span>
          </div>

          {isLoading ? (
            <div className="state">Loading requests…</div>
          ) : isError ? (
            <div className="state state-error">
              Failed to load requests:{' '}
              {error instanceof Error ? error.message : 'unknown error'}
            </div>
          ) : requests.length === 0 ? (
            <div className="state">No access requests yet.</div>
          ) : (
            <RequestList
              requests={requests}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
        </aside>

        <section className="content">
          {selected ? (
            <RequestDetail request={selected} />
          ) : (
            <div className="placeholder">
              {requests.length === 0
                ? 'Access requests will appear here once ingested.'
                : 'Select a request to review its context, the AI recommendation, and record a decision.'}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
