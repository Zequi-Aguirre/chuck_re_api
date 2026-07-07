import { Navigate, Route, Routes } from "react-router-dom";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import { useAuth } from "./auth";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/LoginPage";
import { ConnectionsPage } from "./pages/ConnectionsPage";
import { ConnectionDetailPage } from "./pages/ConnectionDetailPage";
import { TextCustomersPage } from "./pages/TextCustomersPage";
import { ReportSettingsPage } from "./pages/ReportSettingsPage";
import { OrchestratorSettingsPage } from "./pages/OrchestratorSettingsPage";
import { SkipTraceSettingsPage } from "./pages/SkipTraceSettingsPage";
import { CompsSettingsPage } from "./pages/CompsSettingsPage";
import { CompsSelectionSettingsPage } from "./pages/CompsSelectionSettingsPage";
import { CreditSettingsPage } from "./pages/CreditSettingsPage";
import { OnboardingSettingsPage } from "./pages/OnboardingSettingsPage";
import { AdminsPage } from "./pages/AdminsPage";
import { ReactNode } from "react";

/** Gate that redirects to /login until a session is confirmed. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <FullScreenSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/**
 * Superadmin-only gate (JAK-125). A regular admin who deep-links to /admins is
 * bounced to the dashboard — the tab is also hidden, and the API 403s, so this
 * is defense-in-depth rather than the only guard.
 */
function RequireSuperadmin({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <FullScreenSpinner />;
  if (user?.role !== "superadmin") return <Navigate to="/" replace />;
  return <>{children}</>;
}

function FullScreenSpinner() {
  return (
    <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh" }}>
      <CircularProgress />
    </Box>
  );
}

export function App() {
  const { user, loading } = useAuth();

  return (
    <Routes>
      <Route
        path="/login"
        element={loading ? <FullScreenSpinner /> : user ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<ConnectionsPage />} />
        <Route path="/connections/:locationId" element={<ConnectionDetailPage />} />
        <Route path="/text-customers" element={<TextCustomersPage />} />
        {/* AI Prompt (JAK-131) — available to ANY logged-in admin, not gated. */}
        <Route path="/report-settings" element={<ReportSettingsPage />} />
        {/* Router Prompt (JAK-135) — available to ANY logged-in admin, not gated. */}
        <Route path="/router-settings" element={<OrchestratorSettingsPage />} />
        {/* Skip-Trace (JAK-136) — available to ANY logged-in admin, not gated. */}
        <Route path="/skiptrace-settings" element={<SkipTraceSettingsPage />} />
        {/* Comps (JAK-137) — available to ANY logged-in admin, not gated. */}
        <Route path="/comps-settings" element={<CompsSettingsPage />} />
        {/* Comps Selection engine (JAK-164) — available to ANY logged-in admin, not gated. */}
        <Route path="/comps-selection-settings" element={<CompsSelectionSettingsPage />} />
        {/* Credits (JAK-162) — per-feature default grants + out-of-credits messages. */}
        <Route path="/credit-settings" element={<CreditSettingsPage />} />
        {/* Onboarding Ask (JAK-first-text-welcome) — editable after-3rd-report email ask. */}
        <Route path="/onboarding-settings" element={<OnboardingSettingsPage />} />
        <Route
          path="/admins"
          element={
            <RequireSuperadmin>
              <AdminsPage />
            </RequireSuperadmin>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
