import { NavLink, Outlet, Route, Routes } from "react-router-dom";
import { Connections } from "./pages/Connections.js";
import { Pipelines } from "./pages/Pipelines.js";
import { NewDeployment } from "./pages/NewDeployment.js";
import { DeploymentDetailPage } from "./pages/DeploymentDetail.js";
import { History } from "./pages/History.js";

export function App() {
  return (
    <div>
      <nav>
        <NavLink to="/connections">Connections</NavLink>
        <NavLink to="/pipelines">Pipelines</NavLink>
        <NavLink to="/deploy/new">New Deployment</NavLink>
        <NavLink to="/history">History</NavLink>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<div>Welcome to SFCowboy</div>} />
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
