import { Table2 } from "lucide-react";
import { checkpointStatus } from "@/lib/checkpoint-status";
import { formatNumber } from "@/lib/format";
import type { CheckpointHeader } from "@/lib/types";

export interface SidebarTable {
  name: string;
  segments: number;
}

export interface AppSidebarProps {
  tables: SidebarTable[];
  /** Schema prefix shared by every table (e.g. `main.`), shown once. */
  schemaPrefix: string;
  /** Explains an empty table list. */
  emptyMessage: string;
  activeTable: string;
  onPickTable: (name: string) => void;
  headers: CheckpointHeader[];
  activeSlot: 1 | 2;
  selectedSlot: 1 | 2 | null;
  onSelectCheckpoint: (slot: 1 | 2) => void;
  /** Rail: icon-only column; full: tables and checkpoints. */
  variant: "full" | "rail";
  onExpand?: () => void;
}

function CheckpointCard({
  checkpoint,
  activeSlot,
  selected,
  onClick,
}: {
  checkpoint: CheckpointHeader;
  activeSlot: 1 | 2;
  selected: boolean;
  onClick: () => void;
}) {
  const status = checkpointStatus(checkpoint, activeSlot);
  return (
    <button
      type="button"
      className={`checkpoint-card ${selected ? "selected" : ""}`}
      data-status={status.tone}
      onClick={onClick}
      aria-pressed={selected}
      title={status.description}
    >
      <span className="checkpoint-indicator" />
      <span className="checkpoint-copy">
        <span className="checkpoint-title">Checkpoint {checkpoint.slot}</span>
        <span className="checkpoint-subtitle">
          {checkpoint.valid
            ? `Iteration ${checkpoint.iteration}`
            : "Invalid snapshot"}
        </span>
      </span>
      <span className={`checkpoint-state is-${status.tone}`}>
        {status.label}
      </span>
    </button>
  );
}

/** Tables (click to filter) and checkpoint headers. */
export function AppSidebar(props: AppSidebarProps) {
  const {
    tables,
    schemaPrefix,
    emptyMessage,
    activeTable,
    onPickTable,
    headers,
    activeSlot,
    selectedSlot,
    onSelectCheckpoint,
    variant,
    onExpand,
  } = props;
  if (variant === "rail")
    return (
      <nav className="sidebar-rail" aria-label="Sidebar (collapsed)">
        <button
          type="button"
          className="rail-button"
          onClick={onExpand}
          aria-label={`Show ${tables.length} tables`}
          title={`${tables.length} tables · show sidebar`}
        >
          <Table2 size={15} />
          <small>{tables.length}</small>
        </button>
        <span className="rail-divider" />
        {headers.map((header) => {
          const status = checkpointStatus(header, activeSlot);
          return (
            <button
              type="button"
              key={header.slot}
              className={`rail-button rail-checkpoint${selectedSlot === header.slot ? " selected" : ""}`}
              data-status={status.tone}
              aria-pressed={selectedSlot === header.slot}
              aria-label={`Checkpoint ${header.slot}, ${status.label}`}
              title={`Checkpoint ${header.slot} · ${status.label}${header.valid ? ` · iteration ${header.iteration}` : ""}`}
              onClick={() => onSelectCheckpoint(header.slot)}
            >
              <i />
              <small>{header.slot}</small>
            </button>
          );
        })}
      </nav>
    );
  return (
    <div className="sidebar-inner">
      <div className="side-section">
        <div className="eyebrow-row">
          <span className="eyebrow">TABLES</span>
          <span className="side-count">{tables.length}</span>
        </div>
        {tables.length ? (
          <div className="side-tables">
            {schemaPrefix && (
              <span className="side-schema">
                Schema <code>{schemaPrefix.slice(0, -1)}</code>
                <small>segments</small>
              </span>
            )}
            {tables.map((table) => (
              <button
                type="button"
                key={table.name}
                className={activeTable === table.name ? "active" : ""}
                aria-pressed={activeTable === table.name}
                onClick={() => onPickTable(table.name)}
                title={`${table.name} · ${formatNumber(table.segments)} segments. Click to highlight; click again to clear.`}
              >
                <Table2 size={14} />
                <span>{table.name.slice(schemaPrefix.length)}</span>
                <small aria-label={`${table.segments} segments`}>
                  {formatNumber(table.segments)}
                </small>
              </button>
            ))}
          </div>
        ) : (
          <p className="side-empty">{emptyMessage}</p>
        )}
      </div>
      <div className="side-section side-section-divider">
        <div className="eyebrow-row">
          <span className="eyebrow">CHECKPOINTS</span>
          <span className="side-count">{headers.length}</span>
        </div>
        <div className="checkpoint-list">
          {headers.map((header) => (
            <CheckpointCard
              key={header.slot}
              checkpoint={header}
              activeSlot={activeSlot}
              selected={selectedSlot === header.slot}
              onClick={() => onSelectCheckpoint(header.slot)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
