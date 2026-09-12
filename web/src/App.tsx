import { useEffect, useState } from "react";
import { NavLink, Outlet, Route, Routes, useLocation } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { Home } from "./pages/Home.js";
import { Connections } from "./pages/Connections.js";
import { ConnectionDetail } from "./pages/ConnectionDetail.js";
import { Pipelines } from "./pages/Pipelines.js";
import { NewPipeline } from "./pages/NewPipeline.js";
import { PipelineDetail } from "./pages/PipelineDetail.js";
import { PipelineRunDetail } from "./pages/PipelineRunDetail.js";
import { Deployments } from "./pages/Deployments.js";
import { NewDeployment } from "./pages/NewDeployment.js";
import { DeploymentDetailPage } from "./pages/DeploymentDetail.js";
import { History } from "./pages/History.js";
import { Login } from "./pages/Login.js";
import { ResetPassword } from "./pages/ResetPassword.js";
import { AcceptInvite } from "./pages/AcceptInvite.js";
import { Team } from "./pages/Team.js";
import { Logo } from "./Logo.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { UserMenu } from "./UserMenu.js";
import { DisplayNameField } from "./DisplayNameField.js";
import { supabase } from "./supabaseClient.js";
import { HomeIcon, ConnectionsIcon, PipelinesIcon, DeploymentsIcon, HistoryIcon } from "./NavIcons.js";
import { FlowBackground } from "./components/FlowBackground.js";

// The New Deployment page's component table needs real room for its columns; every other page
// is a form/list that reads better narrow, so only these routes get the wider layout. A
// deployment detail page can also render that same component table (reopening a pending draft),
// so it's matched by pattern rather than listed as a single fixed path.
const WIDE_PATHS = ["/deploy/new"];
const WIDE_PATH_PATTERN = /^\/deployments\/[^/]+$/;

// Routes reachable without a session. Login handles its own "already logged in" case by simply
// redirecting on successful sign-in; it doesn't need this list to also exclude itself.
function isPublicPath(pathname: string): boolean {
  return pathname === "/login" || pathname === "/reset-password" || pathname === "/accept-invite";
}

export function App() {
  const location = useLocation();
  const isWide = WIDE_PATHS.includes(location.pathname) || WIDE_PATH_PATTERN.test(location.pathname);
  const [session, setSession] = useState<Session | null>(null);
  const [checkedAuth, setCheckedAuth] = useState(false);

  useEffect(() => {
    if (isPublicPath(location.pathname)) {
      setCheckedAuth(true);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) {
        window.location.href = "/login";
        return;
      }
      setSession(data.session);
      setCheckedAuth(true);
    });
    // Keeps `session` current if the token refreshes or the user signs out in another tab —
    // Supabase's client handles the refresh itself; this just mirrors the result into state.
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (!newSession && !isPublicPath(location.pathname)) {
        window.location.href = "/login";
        return;
      }
      setSession(newSession);
    });
    return () => subscription.subscription.unsubscribe();
  }, [location.pathname]);

  if (isPublicPath(location.pathname)) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/accept-invite" element={<AcceptInvite />} />
      </Routes>
    );
  }

  if (!checkedAuth || !session) {
    return <div className="auth-page">Loading…</div>;
  }

  const displayName = (session.user.user_metadata?.name as string | undefined) ?? session.user.email ?? "";

  return (
    <div>
      <FlowBackground />
      <nav className="app-nav">
        <div className="app-nav-links">
          <NavLink to="/">
            <HomeIcon /> Home
          </NavLink>
          <NavLink to="/connections">
            <ConnectionsIcon /> Connections
          </NavLink>
          <NavLink to="/pipelines">
            <PipelinesIcon /> Pipelines
          </NavLink>
          <NavLink to="/deploy">
            <DeploymentsIcon /> Deployments
          </NavLink>
          <NavLink to="/history">
            <HistoryIcon /> History
          </NavLink>
          <NavLink to="/team">Team</NavLink>
        </div>
        <div className="app-nav-right">
          <UserMenu name={displayName} email={session.user.email ?? ""} />
          <DisplayNameField />
          <ThemeToggle />
          <Logo />
        </div>
      </nav>
      <main className={isWide ? "wide" : undefined}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/connections" element={<Connections />} />
          <Route path="/connections/:id" element={<ConnectionDetail />} />
          <Route path="/pipelines" element={<Pipelines />} />
          <Route path="/pipelines/new" element={<NewPipeline />} />
          <Route path="/pipelines/:id" element={<PipelineDetail />} />
          <Route path="/pipelines/:pipelineId/runs/:runId" element={<PipelineRunDetail />} />
          <Route path="/deploy" element={<Deployments />} />
          <Route path="/deploy/new" element={<NewDeployment />} />
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
          <Route path="/history" element={<History />} />
          <Route path="/team" element={<Team />} />
        </Routes>
        <Outlet />
      </main>
    </div>
  );
}
