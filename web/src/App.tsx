import { NavLink, Outlet, Route, Routes } from "react-router-dom";

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
        </Routes>
        <Outlet />
      </main>
    </div>
  );
}
