import "./landing.css";
import { TpchGenerator, type TpchGeneratorProps } from "./tpch-generator";
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
  sql: TpchGeneratorProps["sql"];
  /** Open the generator on the SQL tab, e.g. for a shared SQL link. */
  generatorMode: TpchGeneratorProps["initialMode"];
}

/** First screen: choose or drop a local DuckDB file. */
export function Landing({
  loading,
  dragging,
  error,
  onDismissError,
  onChooseFile,
  onGenerated,
  sql,
  generatorMode,
}: LandingProps) {
  return (
    <main className="landing">
      <div className="landing-inner">
        <h1>Inspect a DuckDB database file</h1>
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
        <TpchGenerator
          // A shared link arrives after the first render; remount on it.
          key={generatorMode}
          onGenerated={onGenerated}
          disabled={loading}
          sql={sql}
          initialMode={generatorMode}
        />
        <p className="landing-privacy" id="landing-privacy">
          <Lock size={12} aria-hidden="true" />
          Read locally, never uploaded · DuckDB storage v1.0.0–v2.0.0
        </p>
      </div>
    </main>
  );
}
