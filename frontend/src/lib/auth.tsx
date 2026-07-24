import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { MOCK_USERS } from './mock-users';
import type { MockUser } from './mock-users';

const STORAGE_KEY = 'policy-pilot-auth-token';

interface AuthContextValue {
  user: MockUser | null;
  login: (token: string) => boolean;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function userForToken(token: string | null): MockUser | null {
  if (!token) {
    return null;
  }
  return MOCK_USERS.find((u) => u.token === token) ?? null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<MockUser | null>(() =>
    userForToken(localStorage.getItem(STORAGE_KEY)),
  );

  const login = useCallback((token: string) => {
    const matched = userForToken(token);
    if (!matched) {
      return false;
    }
    localStorage.setItem(STORAGE_KEY, token);
    setUser(matched);
    return true;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, login, logout }), [user, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}

/** The bearer token for the current session, or null if signed out — read directly by api-client.ts. */
export function getStoredAuthToken(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}
