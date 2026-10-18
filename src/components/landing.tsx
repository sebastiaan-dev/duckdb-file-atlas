import { useState } from "react";
import { AlertCircle, FileUp, LoaderCircle, Lock, X } from "lucide-react";

export interface LandingProps {
  loading: boolean;
  /** A file is being dragged anywhere over the window. */
  dragging: boolean;
  error: string;
  onDismissError: () => void;
  onChooseFile: () => void;
}

/** First screen: choose or drop a local DuckDB file. */
export function Landing({
  loading,
  dragging,
  error,
  onDismissError,
  onChooseFile,
}: LandingProps) {
  const [hover, setHover] = useState(false);
  return (
    <main className="landing">
      <div className="landing-inner">
        <h1>Inspect a DuckDB database file</h1>
        <p className="landing-lede">
          See how blocks, row groups, column segments, indexes and free space
          are laid out on disk.
        </p>
        <button
          type="button"
          className={`landing-dropzone${dragging || hover ? " is-active" : ""}${loading ? " is-loading" : ""}`}
          onClick={onChooseFile}
          onPointerEnter={() => setHover(true)}
          onPointerLeave={() => setHover(false)}
          disabled={loading}
          aria-describedby="landing-privacy"
        >
          {loading ? (
            <LoaderCircle className="spin" size={26} aria-hidden="true" />
          ) : (
            <FileUp size={26} aria-hidden="true" />
          )}
          <strong>
            {loading
              ? "Reading file…"
              : dragging
                ? "Drop to inspect"
                : "Drop a .duckdb file here"}
          </strong>
          {!loading && <span>or click to choose a file</span>}
        </button>
        {error && (
          <div className="message error-message landing-error" role="alert">
            <AlertCircle size={15} />
            <span>{error}</span>
            <button
              type="button"
              aria-label="Dismiss error"
              onClick={onDismissError}
            >
              <X size={14} />
            </button>
          </div>
        )}
        <p className="landing-privacy" id="landing-privacy">
          <Lock size={12} aria-hidden="true" />
          The file is read in your browser and never uploaded. Supports DuckDB
          storage version v2.0.0 files.
        </p>
      </div>
    </main>
  );
}
