import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { MOCK_USERS } from '../lib/mock-users';

// Mocked identity switcher — no password, since there's no real IdP behind
// this yet (see backend/src/common/mock-users.constant.ts). Picking an
// identity here sets the bearer token api-client.ts attaches to every
// request; the backend's DashboardAuthGuard is the actual enforcement point.
export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleLogin = (token: string) => {
    if (login(token)) {
      navigate('/', { replace: true });
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>Policy Pilot</h1>
        <p className="tagline">Sign in as a reviewer (mocked identity — no password)</p>
        <ul className="identity-list">
          {MOCK_USERS.map((u) => (
            <li key={u.token}>
              <button
                type="button"
                className="btn identity-btn"
                onClick={() => handleLogin(u.token)}
              >
                <span className="identity-name">{u.displayName}</span>
                <span className="badge badge-muted">{u.role}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
