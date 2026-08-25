import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { type DeploymentSummary, fetchDeployments } from "../api/client.js";

export function History() {
  const [deployments, setDeployments] = useState<DeploymentSummary[]>([]);

  useEffect(() => {
    fetchDeployments().then(setDeployments);
  }, []);

  return (
    <div>
      <h1>History</h1>
      <table>
        <thead>
          <tr>
            <th>Started</th>
            <th>Status</th>
            <th>Test level</th>
          </tr>
        </thead>
        <tbody>
          {deployments.map((d) => (
            <tr key={d.id}>
              <td>{d.started_at}</td>
              <td>
                <Link to={`/deployments/${d.id}`}>{d.status}</Link>
              </td>
              <td>{d.test_level}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
