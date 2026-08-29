import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { type Pipeline, fetchPipeline } from "../api/client.js";

export function PipelineDetail() {
  const { id } = useParams<{ id: string }>();
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    fetchPipeline(id)
      .then(setPipeline)
      .catch((err) => setLoadError((err as Error).message));
  }, [id]);

  if (loadError) return <p role="alert">{loadError}</p>;
  if (!pipeline) return <p>Loading…</p>;

  return (
    <div>
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link to="/pipelines">Pipelines</Link>
        <span aria-hidden="true"> › </span>
        <span>{pipeline.name}</span>
      </nav>
      <h1>{pipeline.name}</h1>
    </div>
  );
}
