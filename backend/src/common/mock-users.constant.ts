// Mocked dashboard identity roster. There is no real IdP/session system for
// the reviewer-facing dashboard yet (unlike the ingestion webhook's
// ApiKeyGuard, which stands in for a real machine credential) — this is a
// deliberate stand-in so the auth *boundary* is real and enforced
// (DashboardAuthGuard rejects anything not in this list, and denies non-
// REVIEWER roles) even though the credentials themselves are fixed dev
// tokens rather than issued ones. A production deployment would replace this
// with real session/OAuth2 auth and a users table; the shape (id, role) and
// the rule that only role === 'REVIEWER' may act on decisions would carry
// over unchanged. GOVERNANCE_APPROVER is another mock-only role for the same
// reason; the real boundary is that reviewer and governance credentials are
// always distinct, while production would enforce that through real RBAC.
export type DashboardRole = 'REVIEWER' | 'VIEWER' | 'GOVERNANCE_APPROVER';

export interface MockDashboardUser {
  token: string;
  id: string;
  displayName: string;
  role: DashboardRole;
}

export const MOCK_DASHBOARD_USERS: MockDashboardUser[] = [
  {
    token: 'mock-token-alice',
    id: 'reviewer:alice',
    displayName: 'Alice Chen',
    role: 'REVIEWER',
  },
  {
    token: 'mock-token-bob',
    id: 'reviewer:bob',
    displayName: 'Bob Nakamura',
    role: 'REVIEWER',
  },
  {
    token: 'mock-token-viewer',
    id: 'viewer:dana',
    displayName: 'Dana Ortiz (view-only)',
    role: 'VIEWER',
  },
  {
    token: 'mock-token-governance',
    id: 'governance:priya',
    displayName: 'Priya Anand (governance)',
    role: 'GOVERNANCE_APPROVER',
  },
];

export function findMockUserByToken(token: string): MockDashboardUser | undefined {
  return MOCK_DASHBOARD_USERS.find((user) => user.token === token);
}
