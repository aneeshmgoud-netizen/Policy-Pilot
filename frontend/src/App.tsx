import { Navigate, Route, Routes } from 'react-router-dom';
import { DashboardPage } from './components/DashboardPage';
import { LoginPage } from './components/LoginPage';
import { ProtectedRoute } from './components/ProtectedRoute';
import { GovernanceProtectedRoute } from './components/GovernanceProtectedRoute';
import { GovernanceQueuePage } from './components/GovernanceQueuePage';
import './App.css';

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/governance"
        element={
          <GovernanceProtectedRoute>
            <GovernanceQueuePage />
          </GovernanceProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
