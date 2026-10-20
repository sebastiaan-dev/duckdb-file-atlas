import "./scenario-builder.css";
import { useEffect, useId, useRef, useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { TipContent } from "./detail-tooltip";
import {
  Check,
  Link2,
  LoaderCircle,
  Play,
  Settings2,
  SquarePen,
} from "lucide-react";
import {
  BUILD_BLOCK_SIZES,
  BUILD_STORAGE_VERSIONS,
  BUILD_THREADS,
  DEFAULT_BLOCK_SIZE,
  DEFAULT_STORAGE_VERSION,
  DEFAULT_THREADS,
  StatementError,
  type BuildBlockSize,
  type BuildStorageVersion,
  type BuildThreads,
} from "@/lib/database-builder";
import { threadSupport } from "@/lib/thread-support";
import {
  buildError,
  buildScenario,
  encodeScenario,
  scenario,
  scenarioScript,
  SCENARIOS,
  validSettings,
  type ScenarioState,
} from "@/lib/scenarios";

export interface ScenarioBuilderProps {
  state: ScenarioState;
  onChange: (state: ScenarioState) => void;
  /** Receives the built file; the builder stays busy until it resolves. */
  onBuilt: (file: File, state: ScenarioState) => void | Promise<unknown>;
  disabled?: boolean;
  /** Styling context: the dark landing card or a workspace dialog. */
  variant: "landing" | "workspace";
}

const kib = (bytes: number) => `${bytes / 1024} KiB`;

/**
 * Pick a scenario, adjust its settings and build a database from it in an
 * isolated worker. Mounting does not load WASM.
 */
export function ScenarioBuilder({
  state,
  onChange,
  onBuilt,
  disabled = false,
  variant,
}: ScenarioBuilderProps) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<{
    message: string;
    statement?: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [threadsSupported, setThreadsSupported] = useState<boolean | null>(
    null,
  );
  useEffect(() => {
    let mounted = true;
    void threadSupport().then(
      (supported) => {
        if (mounted) setThreadsSupported(supported);
      },
      () => {
        if (mounted) setThreadsSupported(false);
      },
    );
    return () => {
      mounted = false;
    };
  }, []);
  const optionsRef = useRef<HTMLDivElement>(null);
  // Close the options menu on an outside press or Escape.
  useEffect(() => {
    if (!optionsOpen) return;
    const press = (event: PointerEvent) => {
      if (!optionsRef.current?.contains(event.target as Node))
        setOptionsOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Keep Escape from also closing a surrounding dialog.
      event.preventDefault();
      event.stopPropagation();
      setOptionsOpen(false);
      optionsRef.current?.querySelector("button")?.focus();
    };
    document.addEventListener("pointerdown", press);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", press);
      document.removeEventListener("keydown", key, true);
    };
  }, [optionsOpen]);
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

  const definition = scenario(state.id);
  const settings = validSettings(definition, state.settings[state.id]);
  const script = scenarioScript(state);
  const customFormat =
    state.storageVersion !== DEFAULT_STORAGE_VERSION ||
    state.blockSize !== DEFAULT_BLOCK_SIZE;
  const customThreads = state.threads !== DEFAULT_THREADS;
  const threadsUnavailable = customThreads && threadsSupported !== true;
  const threadNotice = threadsUnavailable
    ? threadsSupported === null
      ? `Checking support for ${state.threads} threads…`
      : `${state.threads} threads are unavailable in this browser or page. Select Single threaded in File format options to generate.`
    : "";
  const settingsBadge = [
    ...(customFormat ? [state.storageVersion, kib(state.blockSize)] : []),
    ...(customThreads ? [`${state.threads} threads`] : []),
  ].join(" · ");
  const setSetting = (key: string, value: string) =>
    onChange({
      ...state,
      settings: {
        ...state.settings,
        [state.id]: { ...settings, [key]: value },
      },
    });

  async function run() {
    if (active.current || disabled || threadsUnavailable) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError(null);
    try {
      const file = await buildScenario(state, {
        signal: controller.signal,
        onProgress: (message) => {
          if (active.current === controller) setProgress(message);
        },
      });
      if (active.current !== controller) return;
      setProgress("Opening the database…");
      await onBuilt(file, state);
      setProgress("");
    } catch (cause) {
      if (active.current !== controller) return;
      setProgress("");
      setError(
        cause instanceof StatementError
          ? { message: cause.message, statement: cause.statement.sql }
          : { message: buildError(cause) },
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
    setProgress("Generation cancelled.");
  }

  async function copyLink() {
    const url = new URL(window.location.href);
    url.hash = await encodeScenario(state);
    await navigator.clipboard.writeText(url.href);
    setCopied(true);
  }

  return (
    <div className={`scenario-builder is-${variant}`}>
      <div className="scenario-tiles" role="radiogroup" aria-label="Scenario">
        {SCENARIOS.map((item) => {
          const selected = item.id === state.id;
          return (
            // What each scenario shows lives in its tooltip, keeping the
            // card itself to tiles and settings.
            <Tooltip.Root key={item.id}>
              <Tooltip.Trigger asChild>
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-description={item.summary}
                  className="scenario-tile"
                  disabled={busy}
                  onClick={() => onChange({ ...state, id: item.id })}
                >
                  {item.name}
                </button>
              </Tooltip.Trigger>
              <TipContent wide>
                <p>{item.summary}</p>
              </TipContent>
            </Tooltip.Root>
          );
        })}
      </div>

      {state.id === "custom" ? (
        <textarea
          aria-label="SQL script"
          className="scenario-editor"
          value={state.script}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          rows={9}
          readOnly={busy}
          onChange={(event) =>
            onChange({ ...state, script: event.target.value })
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void run();
            }
          }}
        />
      ) : (
        <div className="scenario-fields">
          {definition.fields.map((field) =>
            field.kind === "choice" ? (
              <div
                className="scenario-field"
                key={field.key}
                role="group"
                aria-labelledby={`${id}-${field.key}`}
              >
                <span id={`${id}-${field.key}`}>{field.label}</span>
                <div className="scenario-choices">
                  {field.options.map((option) => (
                    <button
                      type="button"
                      key={option.value}
                      aria-pressed={settings[field.key] === option.value}
                      disabled={busy}
                      onClick={() => setSetting(field.key, option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <label className="scenario-toggle" key={field.key}>
                <input
                  type="checkbox"
                  checked={settings[field.key] === "1"}
                  disabled={busy}
                  onChange={(event) =>
                    setSetting(field.key, event.target.checked ? "1" : "0")
                  }
                />
                {field.label}
              </label>
            ),
          )}
        </div>
      )}

      <div className="scenario-actions">
        {busy ? (
          <button type="button" onClick={cancel}>
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="scenario-run"
            onClick={() => void run()}
            disabled={disabled || !script.trim() || threadsUnavailable}
            aria-describedby={
              threadsUnavailable ? `${id}-thread-notice` : undefined
            }
            aria-label={
              state.id === "custom" ? "Run SQL" : `Generate ${definition.name}`
            }
            title={
              state.id === "custom"
                ? "Run SQL (⌘/Ctrl + Enter)"
                : `Generate ${definition.name}`
            }
          >
            <Play size={16} aria-hidden="true" />
          </button>
        )}
        {busy && <LoaderCircle className="spin" size={15} aria-hidden="true" />}
        <div className="scenario-actions-end">
          {/* Any scenario continues as editable SQL in Custom. */}
          {state.id !== "custom" && (
            <button
              type="button"
              className="scenario-edit"
              disabled={busy}
              onClick={() => onChange({ ...state, id: "custom", script })}
              title="Open this scenario's SQL in Custom"
            >
              <SquarePen size={14} aria-hidden="true" />
              Edit SQL
            </button>
          )}
          <div className="scenario-options-menu" ref={optionsRef}>
            <button
              type="button"
              className="scenario-options-toggle"
              aria-label="File format options"
              aria-expanded={optionsOpen}
              aria-controls={`${id}-options`}
              title="Storage format, block size and threads"
              onClick={() => setOptionsOpen((value) => !value)}
            >
              <Settings2 size={15} aria-hidden="true" />
              {/* Non-default choices stay visible while the menu is closed. */}
              {settingsBadge && <span>{settingsBadge}</span>}
            </button>
            {optionsOpen && (
              <div
                className="scenario-options"
                id={`${id}-options`}
                role="group"
                aria-label="File format"
              >
                <label>
                  <span>Storage</span>
                  <select
                    value={state.storageVersion}
                    disabled={busy}
                    onChange={(event) =>
                      onChange({
                        ...state,
                        storageVersion: event.target
                          .value as BuildStorageVersion,
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
                    value={state.blockSize}
                    disabled={busy}
                    onChange={(event) =>
                      onChange({
                        ...state,
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
                <label>
                  <span>Threads</span>
                  <select
                    value={state.threads}
                    disabled={busy}
                    aria-describedby={
                      threadsSupported !== true
                        ? `${id}-thread-support`
                        : undefined
                    }
                    onChange={(event) =>
                      onChange({
                        ...state,
                        threads: Number(event.target.value) as BuildThreads,
                      })
                    }
                  >
                    {BUILD_THREADS.map((threads) => (
                      <option
                        key={threads}
                        value={threads}
                        disabled={threads > 1 && threadsSupported !== true}
                      >
                        {threads === 1
                          ? "Single threaded"
                          : `${threads} threads`}
                      </option>
                    ))}
                  </select>
                </label>
                {threadsSupported !== true && (
                  <p
                    className="scenario-thread-help"
                    id={`${id}-thread-support`}
                  >
                    {threadsSupported === null
                      ? "Checking multithreading support…"
                      : "Multiple threads require browser support and a cross-origin isolated page."}
                  </p>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            className="scenario-link"
            onClick={() => void copyLink()}
            disabled={!script.trim()}
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
      </div>
      <p
        id={`${id}-thread-notice`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {threadNotice || progress}
      </p>
      {error && (
        <div className="message error-message scenario-error" role="alert">
          <span>{error.message}</span>
          {error.statement && (
            <pre>
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
