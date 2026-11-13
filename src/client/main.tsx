import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { PipelineProvider } from './hooks/usePipelineState';
import { AuthProvider } from './contexts/AuthContext';
import { PrivateRoute } from './components/PrivateRoute';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { ForgotPassword } from './pages/ForgotPassword';
import { Dashboard } from './pages/Dashboard';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { BillingPage } from './pages/BillingPage';
import { SettingsPage } from './pages/SettingsPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { ScheduledJobsPage } from './pages/ScheduledJobsPage';
import { ProgramsPage } from './pages/ProgramsPage';
import { ReviewPage } from './pages/ReviewPage';
import { ClipsPage } from './pages/ClipsPage';
import PipelineEditor from './editor/PipelineEditor';
import { ShieldProvider } from './pages/shield/ShieldContext';
import { ShieldLayout } from './pages/shield/ShieldLayout';
import { ShieldLoginPage } from './pages/shield/ShieldLoginPage';
import { ShieldTrayPage } from './pages/shield/ShieldTrayPage';
import { ShieldCaseDetailPage } from './pages/shield/ShieldCaseDetailPage';
import { ShieldMonitorPage } from './pages/shield/ShieldMonitorPage';
import { ShieldMetricsPage } from './pages/shield/ShieldMetricsPage';
import './index.css';
import './App.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <PipelineProvider>
          <Routes>
            {/* Public routes */}
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />

            {/* Shield judicial console — own JWT session, outside the app's auth guard */}
            <Route
              path="/shield"
              element={
                <ShieldProvider>
                  <Outlet />
                </ShieldProvider>
              }
            >
              <Route path="login" element={<ShieldLoginPage />} />
              <Route element={<ShieldLayout />}>
                <Route index element={<ShieldTrayPage />} />
                <Route path="cases/:id" element={<ShieldCaseDetailPage />} />
                <Route path="monitor" element={<ShieldMonitorPage />} />
                <Route path="metrics" element={<ShieldMetricsPage />} />
              </Route>
            </Route>

            {/* Protected routes with layout */}
            <Route
              element={
                <PrivateRoute>
                  <Layout />
                </PrivateRoute>
              }
            >
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/review" element={<ReviewPage />} />
              <Route path="/clips" element={<ClipsPage />} />
              <Route path="/editor" element={<PipelineEditor />} />
              <Route path="/programs" element={<ProgramsPage />} />
              <Route path="/connections/*" element={<ConnectionsPage />} />
              <Route path="/scheduled" element={<ScheduledJobsPage />} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/billing" element={<BillingPage />} />
            </Route>

            {/* Redirect root to dashboard */}
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </PipelineProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
