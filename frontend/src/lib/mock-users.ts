// Mirrors backend/src/common/mock-users.constant.ts. This is a mocked,
// dev-only identity roster (no real login/passwords) — the backend is the
// actual enforcement point (DashboardAuthGuard rejects anything not in its
// own roster); this list only drives the identity-switcher UI so a reviewer
// can pick who they're "logged in as" without a real auth server.
export type DashboardRole = 'REVIEWER' | 'VIEWER';

export interface MockUser {
  token: string;
  id: string;
  displayName: string;
  role: DashboardRole;
}

export const MOCK_USERS: MockUser[] = [
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
];
