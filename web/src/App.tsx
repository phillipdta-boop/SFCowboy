import { NavLink, Outlet, Route, Routes, useLocation } from "react-router-dom";
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
import { Logo } from "./Logo.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { DisplayNameField } from "./DisplayNameField.js";
import { HomeIcon, ConnectionsIcon, PipelinesIcon, DeploymentsIcon, HistoryIcon } from "./NavIcons.js";
import { FlowBackground } from "./components/FlowBackground.js";

// The New Deployment page's component table needs real room for its columns; every other page
// is a form/list that reads better narrow, so only these routes get the wider layout. A
// deployment detail page can also render that same component table (reopening a pending draft),
// so it's matched by pattern rather than listed as a single fixed path.
const WIDE_PATHS = ["/deploy/new"];
const WIDE_PATH_PATTERN = /^\/deployments\/[^/]+$/;

export function App() {
  const location = useLocation();
  const isWide = WIDE_PATHS.includes(location.pathname) || WIDE_PATH_PATTERN.test(location.pathname);

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
        </div>
        <div className="app-nav-right">
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
        </Routes>
        <Outlet />
      </main>
    </div>
  );
}
