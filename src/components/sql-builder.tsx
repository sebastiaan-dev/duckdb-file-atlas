import "./sql-builder.css";
import { useEffect, useId, useRef, useState } from "react";
import { Check, Link2, LoaderCircle, Play } from "lucide-react";
import {
  BUILD_BLOCK_SIZES,
  BUILD_STORAGE_VERSIONS,
  StatementError,
  type BuildBlockSize,
  type BuildStorageVersion,
} from "@/lib/database-builder";
import {
  buildFromRecipe,
  encodeRecipe,
  SQL_PRESETS,
  type SqlRecipe,
} from "@/lib/sql-recipes";

export interface SqlBuilderProps {
  recipe: SqlRecipe;
  onRecipeChange: (recipe: SqlRecipe) => void;
  /** Receives the built file; the builder stays busy until it resolves. */
  onBuilt: (file: File, recipe: SqlRecipe) => void | Promise<void>;
  disabled?: boolean;
  /** Styling context: the dark landing card or a workspace dialog. */
  variant: "landing" | "workspace";
  autoFocus?: boolean;
}

const kib = (bytes: number) => `${bytes / 1024} KiB`;

/**
 * Edit and run SQL against a fresh database file; the result opens in the
 * atlas. Runs in an isolated worker, so mounting this does not load WASM.
 */
export function SqlBuilder({
  recipe,
  onRecipeChange,
  onBuilt,
  disabled = false,
  variant,
  autoFocus = false,
}: SqlBuilderProps) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<{
    message: string;
    statement?: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  const preset = SQL_PRESETS.find((item) => item.script === recipe.script);

  async function run() {
    if (active.current || disabled) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError(null);
    try {
      const file = await buildFromRecipe(recipe, {
        signal: controller.signal,
        onProgress: (message) => {
          if (active.current === controller) setProgress(message);
        },
      });
      if (active.current !== controller) return;
      setProgress("Opening the database…");
      await onBuilt(file, recipe);
      setProgress("");
    } catch (cause) {
      if (active.current !== controller) return;
      setProgress("");
      setError(
        cause instanceof StatementError
          ? { message: cause.message, statement: cause.statement.sql }
          : {
              message: `The database could not be built. ${cause instanceof Error ? cause.message : String(cause)}`,
            },
      );
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
    setProgress("Cancelled.");
  }

  async function copyLink() {
    const url = new URL(window.location.href);
    url.hash = await encodeRecipe(recipe);
    await navigator.clipboard.writeText(url.href);
    setCopied(true);
  }

  return (
    <div className={`sql-builder is-${variant}`}>
      <div className="sql-builder-row">
        <label htmlFor={`${id}-preset`}>Start from</label>
        <select
          id={`${id}-preset`}
          value={preset?.id ?? ""}
          disabled={busy}
          onChange={(event) => {
            const next = SQL_PRESETS.find(
              (item) => item.id === event.target.value,
            );
            if (next) onRecipeChange({ ...recipe, script: next.script });
          }}
        >
          {!preset && <option value="">Your SQL</option>}
          {SQL_PRESETS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </div>
      <textarea
        aria-label="SQL script"
        className="sql-builder-editor"
        value={recipe.script}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoFocus={autoFocus}
        rows={10}
        readOnly={busy}
        onChange={(event) =>
          onRecipeChange({ ...recipe, script: event.target.value })
        }
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void run();
          }
        }}
      />
      <div className="sql-builder-row sql-builder-options">
        <label>
          <span>Storage</span>
          <select
            value={recipe.storageVersion}
            disabled={busy}
            onChange={(event) =>
              onRecipeChange({
                ...recipe,
                storageVersion: event.target.value as BuildStorageVersion,
              })
            }
          >
            {BUILD_STORAGE_VERSIONS.map((version) => (
              <option key={version} value={version}>
                {version}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Block size</span>
          <select
            value={recipe.blockSize}
            disabled={busy}
            onChange={(event) =>
              onRecipeChange({
                ...recipe,
                blockSize: Number(event.target.value) as BuildBlockSize,
              })
            }
          >
            {BUILD_BLOCK_SIZES.map((size) => (
              <option key={size} value={size}>
                {kib(size)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="sql-builder-row sql-builder-actions">
        {busy ? (
          <button type="button" onClick={cancel}>
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="sql-builder-run"
            onClick={() => void run()}
            disabled={disabled || !recipe.script.trim()}
            title="Run (⌘/Ctrl + Enter)"
          >
            <Play size={14} aria-hidden="true" />
            Run SQL
          </button>
        )}
        {busy && (
          <span className="sql-builder-busy">
            <LoaderCircle className="spin" size={14} aria-hidden="true" />
          </span>
        )}
        <button
          type="button"
          className="sql-builder-link"
          onClick={() => void copyLink()}
          disabled={!recipe.script.trim()}
          title="Copy a link that reproduces this database"
        >
          {copied ? (
            <Check size={14} aria-hidden="true" />
          ) : (
            <Link2 size={14} aria-hidden="true" />
          )}
          {copied ? "Link copied" : "Copy link"}
        </button>
      </div>
      <p className="sql-builder-note">
        Runs in a fresh database in your browser; unqualified names create
        tables in the new file, which is checkpointed and opened when the script
        ends.
      </p>
      <p role="status" aria-live="polite" aria-atomic="true">
        {progress}
      </p>
      {error && (
        <div className="message error-message sql-builder-error" role="alert">
          <span>{error.message}</span>
          {error.statement && (
            <pre className="sql-builder-statement">
              {error.statement.length > 400
                ? `${error.statement.slice(0, 400)}…`
                : error.statement}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
