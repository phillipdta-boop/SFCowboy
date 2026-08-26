import { NavLink, Outlet, Route, Routes } from "react-router-dom";
import { Home } from "./pages/Home.js";
import { Connections } from "./pages/Connections.js";
import { Pipelines } from "./pages/Pipelines.js";
import { NewDeployment } from "./pages/NewDeployment.js";
import { DeploymentDetailPage } from "./pages/DeploymentDetail.js";
import { History } from "./pages/History.js";
import { Logo } from "./Logo.js";
import { ThemeToggle } from "./ThemeToggle.js";

export function App() {
  return (
    <div>
      <nav className="app-nav">
        <div className="app-nav-links">
          <NavLink to="/">Home</NavLink>
          <NavLink to="/connections">Connections</NavLink>
          <NavLink to="/pipelines">Pipelines</NavLink>
          <NavLink to="/deploy/new">New Deployment</NavLink>
          <NavLink to="/history">History</NavLink>
        </div>
        <div className="app-nav-right">
          <ThemeToggle />
          <Logo />
        </div>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/connections" element={<Connections />} />
          <Route path="/pipelines" element={<Pipelines />} />
          <Route path="/deploy/new" element={<NewDeployment />} />
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
          <Route path="/history" element={<History />} />
        </Routes>
        <Outlet />
      </main>
    </div>
  );
}
