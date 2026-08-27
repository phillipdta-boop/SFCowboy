export interface ProgressBarProps {
  label: string;
  value: number;
  max: number;
}

/** A labeled X/Y progress bar — used for live component/test counts while a deploy is running. */
export function ProgressBar({ label, value, max }: ProgressBarProps) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="progress-bar-row">
      <span className="progress-bar-label">{label}</span>
      <div
        className="progress-bar-track"
        role="progressbar"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
      >
        <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="progress-bar-count">
        {value} / {max}
      </span>
    </div>
  );
}
