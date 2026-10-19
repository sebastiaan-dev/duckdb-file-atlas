import "./landing.css";
import { TpchGenerator } from "./tpch-generator";
import {
  AlertCircle,
  ArrowUpRight,
  FileUp,
  LoaderCircle,
  Lock,
  X,
} from "lucide-react";

export interface LandingProps {
  loading: boolean;
  /** A file is being dragged anywhere over the window. */
  dragging: boolean;
  error: string;
  onDismissError: () => void;
  onChooseFile: () => void;
  onGenerated: (file: File) => void | Promise<void>;
}

/** First screen: choose or drop a local DuckDB file. */
export function Landing({
  loading,
  dragging,
  error,
  onDismissError,
  onChooseFile,
  onGenerated,
}: LandingProps) {
  return (
    <main className="landing">
      <div className="landing-inner">
        <h1>Inspect a DuckDB database file</h1>
        <p className="landing-lede">
          See how blocks, row groups, indexes and free space are laid out on
          disk.
        </p>
        <button
          type="button"
          className={`landing-dropzone landing-card${dragging ? " is-active" : ""}${loading ? " is-loading" : ""}`}
          onClick={onChooseFile}
          disabled={loading}
          aria-describedby="landing-privacy"
        >
          <span className="landing-card-icon is-accent" aria-hidden="true">
            {loading ? (
              <LoaderCircle className="spin" size={23} />
            ) : (
              <FileUp size={23} />
            )}
          </span>
          <span className="landing-upload-copy">
            <strong>
              {loading
                ? "Reading file…"
                : dragging
                  ? "Drop to inspect"
                  : "Drop a .duckdb file here"}
            </strong>
            <span>
              {loading ? "Decoding the checkpoint" : "or click to browse"}
            </span>
          </span>
          <ArrowUpRight
            className="landing-upload-arrow"
            size={20}
            aria-hidden="true"
          />
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
        <TpchGenerator onGenerated={onGenerated} disabled={loading} />
        <p className="landing-privacy" id="landing-privacy">
          <Lock size={12} aria-hidden="true" />
          Read locally, never uploaded · DuckDB storage v1.0.0–v2.0.0
        </p>
      </div>
    </main>
  );
}
