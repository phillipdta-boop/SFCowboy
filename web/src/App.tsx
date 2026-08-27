import { NavLink, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { Home } from "./pages/Home.js";
import { Connections } from "./pages/Connections.js";
import { Pipelines } from "./pages/Pipelines.js";
import { Deployments } from "./pages/Deployments.js";
import { NewDeployment } from "./pages/NewDeployment.js";
import { DeploymentDetailPage } from "./pages/DeploymentDetail.js";
import { History } from "./pages/History.js";
import { Logo } from "./Logo.js";
import { ThemeToggle } from "./ThemeToggle.js";

// The New Deployment page's component table needs real room for its columns; every other page
// is a form/list that reads better narrow, so only this route gets the wider layout.
const WIDE_PATHS = ["/deploy/new"];

export function App() {
  const location = useLocation();
  const isWide = WIDE_PATHS.includes(location.pathname);

  return (
    <div>
      <nav className="app-nav">
        <div className="app-nav-links">
          <NavLink to="/">Home</NavLink>
          <NavLink to="/connections">Connections</NavLink>
          <NavLink to="/pipelines">Pipelines</NavLink>
          <NavLink to="/deploy">Deployments</NavLink>
          <NavLink to="/history">History</NavLink>
        </div>
        <div className="app-nav-right">
          <ThemeToggle />
          <Logo />
        </div>
      </nav>
      <main className={isWide ? "wide" : undefined}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/connections" element={<Connections />} />
          <Route path="/pipelines" element={<Pipelines />} />
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
