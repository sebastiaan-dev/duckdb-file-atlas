import "./tpch-generator.css";
import { useEffect, useId, useRef, useState } from "react";
import { Database, Download, LoaderCircle } from "lucide-react";
import {
  DEFAULT_TPCH_SCALE_FACTOR,
  generateTpchDatabase,
  tpchGenerationError,
  type TpchScaleFactor,
} from "../lib/tpch-generator";

export interface TpchGeneratorProps {
  onGenerated: (file: File) => void | Promise<void>;
  /** Disable starting/opening while the parent is reading another file. */
  disabled?: boolean;
}

/** Optional landing-screen sample generator; mounting does not load WASM. */
export function TpchGenerator({
  onGenerated,
  disabled = false,
}: TpchGeneratorProps) {
  const id = useId();
  const [scaleFactor, setScaleFactor] = useState<TpchScaleFactor>(
    DEFAULT_TPCH_SCALE_FACTOR,
  );
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [downloadURL, setDownloadURL] = useState("");
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
      active.current = null;
    };
  }, []);

  useEffect(() => {
    if (!file) {
      setDownloadURL("");
      return;
    }
    const url = URL.createObjectURL(file);
    setDownloadURL(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  async function generate() {
    if (active.current || disabled || opening) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
    setFile(null);
    try {
      const generated = await generateTpchDatabase({
        scaleFactor,
        signal: controller.signal,
        onProgress: (message) => {
          if (active.current === controller) setProgress(message);
        },
      });
      if (active.current !== controller) return;
      setFile(generated);
      setProgress(
        `Ready: ${generated.name} (${(generated.size / 1024 / 1024).toFixed(1)} MiB).`,
      );
    } catch (cause) {
      if (active.current !== controller) return;
      setError(tpchGenerationError(cause));
      setProgress("");
    } finally {
      if (active.current === controller) {
        active.current = null;
        setBusy(false);
      }
    }
  }

  function cancel() {
    active.current?.abort();
    active.current = null;
    setBusy(false);
    setProgress("Generation cancelled.");
  }

  async function open() {
    if (!file || disabled || opening) return;
    setOpening(true);
    setError("");
    try {
      await onGenerated(file);
    } catch (cause) {
      if (mounted.current)
        setError(
          `Could not open the generated file. You can still download it. ${cause instanceof Error ? cause.message : String(cause)}`,
        );
    } finally {
      if (mounted.current) setOpening(false);
    }
  }

  return (
    <section
      className="tpch-generator landing-card"
      aria-labelledby={`${id}-heading`}
    >
      <div className="tpch-generator-heading">
        <span className="landing-card-icon" aria-hidden="true">
          <Database size={23} />
        </span>
        <div>
          <h2 id={`${id}-heading`}>Generate a TPC-H sample</h2>
          <p>No file? Create one in your browser.</p>
        </div>
      </div>
      <div className="tpch-generator-controls">
        <label htmlFor={`${id}-scale`}>TPC-H scale factor</label>{" "}
        <select
          id={`${id}-scale`}
          value={scaleFactor}
          disabled={busy || opening || disabled}
          onChange={(event) =>
            setScaleFactor(Number(event.target.value) as TpchScaleFactor)
          }
        >
          <option value="1">1 · standard</option>
          <option value="0.1">0.1 · medium</option>
          <option value="0.01">0.01 · small</option>
        </select>{" "}
        <button
          type="button"
          className="tpch-generate-button"
          onClick={() => void generate()}
          disabled={busy || opening || disabled}
          aria-describedby={`${id}-privacy`}
        >
          {busy && (
            <LoaderCircle className="spin" size={14} aria-hidden="true" />
          )}
          {busy ? "Generating TPC-H…" : "Generate TPC-H"}
        </button>{" "}
        {busy && (
          <button type="button" onClick={cancel}>
            Cancel generation
          </button>
        )}
      </div>
      <p className="tpch-generator-privacy" id={`${id}-privacy`}>
        Downloads DuckDB-WASM and the TPC-H extension. Larger scale factors use
        more memory.
      </p>
      <p role="status" aria-live="polite" aria-atomic="true">
        {progress}
      </p>
      {error && (
        <p className="message error-message" role="alert">
          {error}
        </p>
      )}
      {file && downloadURL && (
        <div className="tpch-generator-result">
          <p className="tpch-format-note">
            Eight tables in v1.5.0 storage, which does not record exact segment
            sizes.
          </p>
          <a href={downloadURL} download={file.name}>
            <Download size={14} aria-hidden="true" /> Download .duckdb
          </a>{" "}
          <button
            type="button"
            onClick={() => void open()}
            disabled={disabled || opening}
          >
            {opening ? "Opening sample…" : "Open generated sample"}
          </button>
        </div>
      )}
    </section>
  );
}
