import "./landing.css";
import "./scenarios-card.css";
import { useState } from "react";
import { ScenarioBuilder } from "./scenario-builder";
import type { ScenarioState } from "@/lib/scenarios";
import {
  AlertCircle,
  ArrowUpRight,
  ChevronDown,
  FileUp,
  FlaskConical,
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
  scenarios: {
    state: ScenarioState;
    onChange: (state: ScenarioState) => void;
    onBuilt: (file: File, state: ScenarioState) => Promise<unknown>;
  };
  /** Start with the scenarios open, e.g. for a shared scenario link. */
  scenariosOpen: boolean;
}

/** First screen: choose or drop a local DuckDB file. */
export function Landing({
  loading,
  dragging,
  error,
  onDismissError,
  onChooseFile,
  scenarios,
  scenariosOpen,
}: LandingProps) {
  // Opening scenarios makes room by turning the drop zone into a slim bar;
  // files can still be dropped anywhere in the window.
  const [open, setOpen] = useState(scenariosOpen);
  const [linkedOpen, setLinkedOpen] = useState(scenariosOpen);
  if (scenariosOpen && !linkedOpen) {
    // A shared link is decoded after the first render.
    setLinkedOpen(true);
    setOpen(true);
  }
  return (
    <main className="landing">
      <div className="landing-inner">
        <h1>Inspect a DuckDB database file</h1>
        <button
          type="button"
          className={`landing-dropzone landing-card${open ? " is-compact" : ""}${dragging ? " is-active" : ""}${loading ? " is-loading" : ""}`}
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
        <section
          className={`scenarios-card landing-card${open ? " is-open" : ""}`}
          aria-labelledby="scenarios-heading"
        >
          <button
            type="button"
            className="scenarios-header"
            aria-expanded={open}
            aria-controls="scenarios-body"
            onClick={() => setOpen((value) => !value)}
          >
            <span className="landing-card-icon" aria-hidden="true">
              <FlaskConical size={21} />
            </span>
            <span className="scenarios-copy">
              <strong id="scenarios-heading">Scenarios</strong>
              {!open && (
                <span>
                  Generate TPC-H, churn, indexes, overflow strings… or run your
                  own SQL
                </span>
              )}
            </span>
            <ChevronDown
              className="scenarios-chevron"
              size={18}
              aria-hidden="true"
            />
          </button>
          {open && (
            <div className="scenarios-body" id="scenarios-body">
              <ScenarioBuilder
                variant="landing"
                disabled={loading}
                state={scenarios.state}
                onChange={scenarios.onChange}
                onBuilt={scenarios.onBuilt}
              />
            </div>
          )}
        </section>
        <p className="landing-privacy" id="landing-privacy">
          <Lock size={12} aria-hidden="true" />
          Read locally, never uploaded · DuckDB storage v1.0.0–v2.0.0
        </p>
      </div>
    </main>
  );
}
