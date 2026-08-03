import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export function GovernanceProtectedRoute({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (user.role !== 'GOVERNANCE_APPROVER') {
    return (
      <div className="auth-denied">
        <h2>Access denied</h2>
        <p>
          Signed in as <strong>{user.displayName}</strong> ({user.role}), but this
          page requires the GOVERNANCE_APPROVER role.
        </p>
        <button type="button" className="btn btn-ghost" onClick={logout}>
          Switch identity
        </button>
      </div>
    );
  }

  return <>{children}</>;
}
