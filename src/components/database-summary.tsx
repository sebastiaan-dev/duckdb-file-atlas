import { useId, useState, type ReactNode } from "react";
import { ChevronDown, Info } from "lucide-react";
import { formatBytes, formatNumber } from "@/lib/format";
import { roleColors } from "@/lib/palette";
import type { FileInspection, StorageRole } from "@/lib/types";

export interface RoleShare {
  role: StorageRole;
  label: string;
  bytes: number;
}

export interface DatabaseSummaryProps {
  inspection: FileInspection;
  blockCount: number;
  freeBlockCount: number | null;
  semanticReady: boolean;
  tableCount: number;
  fragmentation: {
    bytes: number;
    ratio: number | null;
    coverage: number;
    measuredBlocks: number;
  };
  roles: RoleShare[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Heading-level actions and badges (import metadata, example, …). */
  actions?: ReactNode;
}

/** Storage by role; flex shares keep segments and gaps inside the track. */
function AllocationRail({
  roles,
  fileSize,
  compact = false,
}: {
  roles: RoleShare[];
  fileSize: number;
  compact?: boolean;
}) {
  return (
    <div
      className={`allocation-rail${compact ? " is-compact" : ""}`}
      role="img"
      aria-label={`File footprint by storage role: ${roles.map((role) => `${role.label} ${formatBytes(role.bytes)}`).join(", ")}`}
    >
      {roles.map((role) => (
        <span
          key={role.role}
          style={{
            flex: `${role.bytes / Math.max(1, fileSize)} 1 0`,
            backgroundColor: roleColors[role.role],
          }}
          title={`${role.label}: ${formatBytes(role.bytes)}`}
        />
      ))}
    </div>
  );
}

/**
 * The database overview. Expanded, it shows headline metrics, storage by
 * role, file properties and inspection notes; collapsed, a single line keeps
 * the file name, key figures and the role rail visible above the data views.
 */
export function DatabaseSummary({
  inspection,
  blockCount,
  freeBlockCount,
  semanticReady,
  tableCount,
  fragmentation,
  roles,
  expanded,
  onExpandedChange,
  actions,
}: DatabaseSummaryProps) {
  const detailsId = useId();
  const [notesOpen, setNotesOpen] = useState(false);
  const present = roles.filter((role) => role.bytes > 0);
  const notes = inspection.warnings;
  const internalFree = fragmentation.measuredBlocks
    ? formatBytes(fragmentation.bytes, true)
    : null;
  const toggle = (
    <button
      type="button"
      className="summary-toggle"
      aria-expanded={expanded}
      aria-controls={detailsId}
      aria-label={expanded ? "Collapse summary" : "Expand summary"}
      title={expanded ? "Collapse summary" : "Expand summary"}
      onClick={() => onExpandedChange(!expanded)}
    >
      <ChevronDown size={15} />
    </button>
  );

  if (!expanded)
    return (
      <section
        className="database-summary is-collapsed"
        aria-label="Database overview"
      >
        {toggle}
        <h1 title={inspection.name}>{inspection.name}</h1>
        <dl className="summary-chips">
          <div>
            <dt>Size</dt>
            <dd>{formatBytes(inspection.fileSize)}</dd>
          </div>
          <div>
            <dt>Blocks</dt>
            <dd>
              {formatNumber(blockCount)}
              {freeBlockCount != null && (
                <small> · {formatNumber(freeBlockCount)} free</small>
              )}
            </dd>
          </div>
          {semanticReady && (
            <div>
              <dt>Segments</dt>
              <dd>{formatNumber(inspection.segments.length)}</dd>
            </div>
          )}
          {internalFree && (
            <div>
              <dt>Internal free</dt>
              <dd>{internalFree}</dd>
            </div>
          )}
        </dl>
        <AllocationRail
          roles={present}
          fileSize={inspection.fileSize}
          compact
        />
        {notes.length > 0 && (
          <button
            type="button"
            className="summary-notes-badge"
            onClick={() => {
              setNotesOpen(true);
              onExpandedChange(true);
            }}
            title="Show inspection notes"
          >
            <Info size={12} />
            {`${notes.length} note${notes.length === 1 ? "" : "s"}`}
          </button>
        )}
        {actions && <div className="summary-actions">{actions}</div>}
      </section>
    );

  return (
    <section
      className="database-summary is-expanded"
      aria-label="Database overview"
    >
      <div className="workspace-heading">
        <div className="summary-title">
          {toggle}
          <h1>{inspection.name}</h1>
        </div>
        {actions && <div className="heading-actions">{actions}</div>}
      </div>
      <div className="overview-card" id={detailsId}>
        <div className="overview-metrics">
          <div className="hero-metric">
            <span className="eyebrow">File size</span>
            <strong>{formatBytes(inspection.fileSize)}</strong>
            <small>{formatNumber(inspection.fileSize)} bytes on disk</small>
          </div>
          <div className="support-metric">
            <span className="eyebrow">Blocks</span>
            <strong>{formatNumber(blockCount)}</strong>
            <small>
              {freeBlockCount != null
                ? `${formatNumber(freeBlockCount)} free · `
                : ""}
              {formatBytes(inspection.blockSize)} each
            </small>
          </div>
          <div className="support-metric">
            <span className="eyebrow">Segments</span>
            <strong>
              {semanticReady ? formatNumber(inspection.segments.length) : "—"}
            </strong>
            <small>
              {semanticReady
                ? `${tableCount} tables`
                : "Native decoding unavailable"}
            </small>
          </div>
          <div className="support-metric">
            <span className="eyebrow">Internal free space</span>
            <strong
              title={`${formatNumber(fragmentation.bytes)} bytes in completely mapped data blocks`}
            >
              {internalFree ?? "—"}
            </strong>
            <small>
              {fragmentation.measuredBlocks
                ? `${((fragmentation.ratio ?? 0) * 100).toFixed(2)}% unused · ${Math.round(fragmentation.coverage * 100)}% of data blocks measured`
                : "Complete segment extents required"}
            </small>
          </div>
        </div>
        <AllocationRail roles={present} fileSize={inspection.fileSize} />
        <div className="overview-key">
          {present.map((role) => (
            <span key={role.role}>
              <i style={{ backgroundColor: roleColors[role.role] }} />
              {role.label}
              <strong>{formatBytes(role.bytes)}</strong>
            </span>
          ))}
        </div>
        <div className="overview-footer">
          <dl className="file-properties" aria-label="File properties">
            <div>
              <dt>Storage revision</dt>
              <dd>v{inspection.storageVersion}</dd>
            </div>
            <div>
              <dt>Block allocation</dt>
              <dd>{formatBytes(inspection.blockSize)}</dd>
            </div>
            <div>
              <dt>Vector size</dt>
              <dd>{formatNumber(inspection.vectorSize)}</dd>
            </div>
            {inspection.libraryVersion && (
              <div>
                <dt>Written by</dt>
                <dd>{inspection.libraryVersion}</dd>
              </div>
            )}
          </dl>
          {notes.length > 0 && (
            <details
              className="inspection-notes"
              open={notesOpen}
              onToggle={(event) => setNotesOpen(event.currentTarget.open)}
            >
              <summary>
                <Info size={13} />
                {`Inspection notes and decoding coverage (${notes.length})`}
                <ChevronDown size={12} />
              </summary>
              <div>
                {notes.map((note, index) => (
                  <p key={index}>{note}</p>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </section>
  );
}
