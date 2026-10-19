import { useState } from "react";
import { formatBytes, formatNumber } from "@/lib/format";
import {
  compressionPalette,
  roleColors,
  stableColor,
  tablePalette,
} from "@/lib/palette";
import type {
  BlockRangeSummary,
  RangeByteKind,
  RangeOwner,
} from "@/lib/block-range";
import type { StorageRole } from "@/lib/types";
import "./block-range-details.css";

const OWNER_LIMIT = 6;

const KIND_LABELS: Record<RangeByteKind, string> = {
  data: "Table data",
  index: "Index",
  metadata: "Metadata & headers",
  unused: "Unused in blocks",
  free: "Free blocks",
  unknown: "Unknown",
};
const KIND_COLORS: Record<RangeByteKind, string> = {
  data: roleColors.data,
  index: roleColors.index,
  metadata: roleColors.metadata,
  unused: "var(--byte-unused)",
  free: "var(--byte-free)",
  unknown: "var(--chart-unknown)",
};
const ROLE_LABELS: Record<StorageRole, string> = {
  header: "Header",
  metadata: "Metadata",
  data: "Table data",
  index: "Index",
  free: "Free",
  unknown: "Unknown",
};

const offset = (value: number) =>
  `0x${Math.max(0, value).toString(16).padStart(8, "0")}`;
const percent = (part: number, whole: number) => {
  if (whole <= 0) return "—";
  const value = (part / whole) * 100;
  return part > 0 && value < 0.1 ? "<0.1%" : `${value.toFixed(1)}%`;
};

function Meter({ ratio }: { ratio: number }) {
  return (
    <span className="space-used-meter" aria-hidden="true">
      <i style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%` }} />
    </span>
  );
}

function Pair({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="detail-pair">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

/** Ranked owners; widths share the selection's total so lists compare. */
function OwnerList({
  title,
  owners,
  total,
  color,
}: {
  title: string;
  owners: RangeOwner[];
  total: number;
  color: (name: string) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!owners.length) return null;
  const shown = expanded ? owners : owners.slice(0, OWNER_LIMIT);
  return (
    <div className="detail-section">
      <div className="detail-section-heading">
        <span>{title}</span>
        <span>{formatNumber(owners.length)}</span>
      </div>
      <ul className="range-owner-list">
        {shown.map((owner) => (
          <li
            key={owner.name}
            title={`${owner.name}: ${formatBytes(owner.bytes, true)} in ${formatNumber(owner.blocks)} block${owner.blocks === 1 ? "" : "s"}`}
          >
            <i style={{ background: color(owner.name) }} />
            <span>{owner.name}</span>
            <strong>{formatBytes(owner.bytes)}</strong>
            <span className="range-owner-bar" aria-hidden="true">
              <b
                style={{
                  width: `${(owner.bytes / Math.max(1, total)) * 100}%`,
                  background: color(owner.name),
                }}
              />
            </span>
          </li>
        ))}
      </ul>
      {owners.length > OWNER_LIMIT && (
        <button
          type="button"
          className="range-owner-more"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? "Show fewer"
            : `Show ${formatNumber(owners.length - OWNER_LIMIT)} more`}
        </button>
      )}
    </div>
  );
}

/** Inspector content for a multi-block selection on the physical map. */
export function BlockRangeDetails({ summary }: { summary: BlockRangeSummary }) {
  const { totalBytes, used, internalFree, unmeasuredBlocks, composition } =
    summary;
  const nonFreeBlocks = summary.blockCount - summary.freeBlocks;
  return (
    <div className="detail-content">
      <div className="selected-kind-row">
        <span
          className="role-dot"
          style={{ backgroundColor: "var(--chart-primary)" }}
        />
        <span>Block range</span>
      </div>
      <div className="detail-card">
        <Pair label="Blocks">{formatNumber(summary.blockCount)}</Pair>
        <Pair label="Size">{formatBytes(totalBytes)}</Pair>
        <Pair label="Byte span">
          <span className="mono">
            {offset(summary.startOffset)}–{offset(summary.endOffset)}
          </span>
        </Pair>
        <Pair label="Space used">
          {used.blocks ? (
            <span
              className="space-used-value"
              title={`${formatBytes(used.bytes, true)} of ${formatBytes(used.ofBytes, true)} in ${formatNumber(used.blocks)} measured blocks`}
            >
              <Meter ratio={used.bytes / used.ofBytes} />
              {formatBytes(used.bytes)} · {percent(used.bytes, used.ofBytes)}
            </span>
          ) : (
            "Unknown"
          )}
        </Pair>
        <Pair label="Internal free space">
          {internalFree.blocks
            ? `${formatBytes(internalFree.bytes, true)} · ${percent(internalFree.bytes, internalFree.ofBytes)}`
            : "Unknown"}
        </Pair>
        {summary.freeBlocks > 0 && (
          <Pair label="Free blocks">
            {formatNumber(summary.freeBlocks)} ·{" "}
            {formatBytes(
              summary.roles.find((role) => role.role === "free")?.bytes ?? 0,
            )}
          </Pair>
        )}
        {summary.segmentCount > 0 && (
          <Pair label="Segments">{formatNumber(summary.segmentCount)}</Pair>
        )}
      </div>
      {unmeasuredBlocks > 0 && (
        <p className="section-caption range-coverage">
          {formatNumber(nonFreeBlocks - unmeasuredBlocks)} of{" "}
          {formatNumber(nonFreeBlocks)} allocated blocks record their usage;
          totals cover only those.
        </p>
      )}

      <div className="detail-section">
        <div className="detail-section-heading">
          <span>Byte composition</span>
          <span>{formatBytes(totalBytes)}</span>
        </div>
        <div
          className="range-composition"
          role="img"
          aria-label={composition
            .map(
              (part) =>
                `${KIND_LABELS[part.kind]} ${formatBytes(part.bytes)} (${percent(part.bytes, totalBytes)})`,
            )
            .join(", ")}
        >
          {composition.map((part) => (
            <span
              key={part.kind}
              className={`range-composition-${part.kind}`}
              style={{
                flexGrow: part.bytes,
                background: KIND_COLORS[part.kind],
              }}
            />
          ))}
        </div>
        <ul className="range-key">
          {composition.map((part) => (
            <li key={part.kind}>
              <i
                className={`range-composition-${part.kind}${part.kind === "free" ? " is-free" : ""}`}
                style={{ background: KIND_COLORS[part.kind] }}
              />
              <span>{KIND_LABELS[part.kind]}</span>
              <small>{percent(part.bytes, totalBytes)}</small>
              <strong>{formatBytes(part.bytes)}</strong>
            </li>
          ))}
        </ul>
      </div>

      <div className="detail-section">
        <div className="detail-section-heading">
          <span>Blocks by role</span>
          <span>{formatNumber(summary.blockCount)}</span>
        </div>
        <ul className="range-key">
          {summary.roles.map((role) => (
            <li key={role.role}>
              <i
                style={{ background: roleColors[role.role] }}
                className={role.role === "free" ? "is-free" : undefined}
              />
              <span>{ROLE_LABELS[role.role]}</span>
              <small>{formatBytes(role.bytes)}</small>
              <strong>{formatNumber(role.blocks)}</strong>
            </li>
          ))}
        </ul>
      </div>

      <OwnerList
        title="Tables"
        owners={summary.tables}
        total={totalBytes}
        color={(name) => stableColor(name, tablePalette)}
      />
      <OwnerList
        title="Indexes"
        owners={summary.indexes}
        total={totalBytes}
        color={() => roleColors.index}
      />
      <OwnerList
        title="Compression"
        owners={summary.compressions}
        total={totalBytes}
        color={(name) => stableColor(name, compressionPalette)}
      />
    </div>
  );
}
