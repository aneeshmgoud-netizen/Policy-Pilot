import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../lib/auth';

/**
 * Client-side route guard: redirects unauthenticated visitors to /login, and
 * shows an explicit "access denied" state (rather than silently redirecting)
 * for an authenticated identity that lacks the REVIEWER role — mirroring the
 * backend's DashboardAuthGuard role check, though the backend remains the
 * real enforcement point; this only prevents the dashboard from rendering
 * for an unauthorized user in the browser.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (user.role !== 'REVIEWER') {
    return (
      <div className="auth-denied">
        <h2>Access denied</h2>
        <p>
          Signed in as <strong>{user.displayName}</strong> ({user.role}), but
          this dashboard requires the REVIEWER role.
        </p>
        <button type="button" className="btn btn-ghost" onClick={logout}>
          Switch identity
        </button>
      </div>
    );
  }

  return <>{children}</>;
}
