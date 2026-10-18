import { memo, useMemo, useState } from "react";
import { InfoTip } from "@/components/detail-tooltip";
import { internalFreeBytes } from "@/lib/fragmentation";
import {
  blockOwners,
  compressionPalette,
  fragmentationSteps,
  rampLabels,
  roleColors,
  spaceRamp,
  stableColor,
  tablePalette,
  utilizationSteps,
} from "@/lib/palette";
import type {
  ColorMode,
  FileBlock,
  IndexInspection,
  Segment,
  StorageRole,
} from "@/lib/types";

const CATEGORY_LIMIT = 10;
const ROLE_ORDER: StorageRole[] = ["data", "index", "metadata", "free"];
const ROLE_LABELS: Record<StorageRole, string> = {
  header: "Header",
  metadata: "Metadata",
  data: "Table data",
  index: "Index",
  free: "Free",
  unknown: "Unknown",
};
const EMPTY: Segment[] = [];

const EXPLANATIONS: Record<ColorMode, string> = {
  role: "Each tile is one block in file-offset order, colored by what it stores. Free blocks are reusable; unknown blocks could not be attributed.",
  table:
    "Blocks colored by owning table. Blocks shared by several owners show split colors.",
  column:
    "Blocks colored by owning column or index. Blocks shared by several owners show split colors.",
  compression:
    "Blocks colored by the compression of the segments they store. Index blocks have no column codec.",
  fragmentation:
    "Unused bytes inside measured data and index blocks, as a share of the block. Whole free blocks are not counted.",
  utilization:
    "Bytes in use as a share of each block. Reusable free blocks are shown separately.",
};

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="legend-item">
      <i style={{ background: color }} />
      {label}
    </span>
  );
}

/** Legend for the physical block map: only entries that actually occur. */
export const PhysicalLegend = memo(function PhysicalLegend({
  mode,
  semanticReady,
  blocks,
  segmentsByBlock,
  indexes = [],
  segments = [],
  matches,
}: {
  mode: ColorMode;
  semanticReady: boolean;
  blocks: FileBlock[];
  segmentsByBlock: Map<number, Segment[]>;
  indexes?: IndexInspection[];
  segments?: Segment[];
  matches?: number | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const presence = useMemo(() => {
    const roles = new Set(blocks.map((block) => block.role));
    const owned = blocks.filter((block) => block.role !== "free");
    const unknown =
      mode === "fragmentation"
        ? owned.some((block) => internalFreeBytes(block) == null)
        : mode === "utilization"
          ? owned.some((block) => block.usedBytes == null)
          : mode === "role"
            ? roles.has("unknown")
            : owned.some(
                (block) =>
                  !blockOwners(
                    block,
                    mode,
                    segmentsByBlock.get(block.id) ?? EMPTY,
                  ).length,
              );
    return { roles, free: roles.has("free"), unknown };
  }, [blocks, mode, segmentsByBlock]);
  const categories = useMemo(() => {
    if (mode !== "table" && mode !== "column" && mode !== "compression")
      return [];
    const names =
      mode === "table"
        ? [
            ...segments.map((segment) => segment.table),
            ...indexes.map((index) => index.table),
          ]
        : mode === "column"
          ? [
              ...segments.map(
                (segment) => `${segment.table}.${segment.column}`,
              ),
              ...indexes.map((index) => `${index.table} / ${index.name}`),
            ]
          : segments.map((segment) => segment.compression);
    const palette = mode === "compression" ? compressionPalette : tablePalette;
    return [...new Set(names)]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, color: stableColor(name, palette) }));
  }, [mode, segments, indexes]);

  let entries: { label: string; color: string }[];
  if (mode === "role")
    entries = ROLE_ORDER.filter((role) => presence.roles.has(role)).map(
      (role) => ({ label: ROLE_LABELS[role], color: roleColors[role] }),
    );
  else if (mode === "fragmentation" || mode === "utilization") {
    const labels = rampLabels(
      mode === "fragmentation" ? fragmentationSteps : utilizationSteps,
    );
    entries = spaceRamp.map((color, step) => ({ label: labels[step], color }));
  } else
    entries = categories.map(({ name, color }) => ({ label: name, color }));
  // Free and unknown stay visible even when categories overflow.
  const showFree = mode !== "role" && presence.free;
  const hidden =
    !expanded && entries.length > CATEGORY_LIMIT + 1
      ? entries.length - CATEGORY_LIMIT
      : 0;
  const shown = hidden ? entries.slice(0, CATEGORY_LIMIT) : entries;
  const pending =
    !semanticReady &&
    (mode === "table" || mode === "column" || mode === "compression");
  return (
    <div className="legend physical-legend" aria-label="Block map legend">
      {pending ? (
        <span className="legend-empty">
          Available after checkpoint metadata is decoded
        </span>
      ) : (
        <>
          {shown.map((entry) => (
            <Swatch key={entry.label} {...entry} />
          ))}
          {hidden > 0 && (
            <button
              type="button"
              className="legend-more"
              onClick={() => setExpanded(true)}
            >
              +{hidden} more
            </button>
          )}
          {expanded && entries.length > CATEGORY_LIMIT + 1 && (
            <button
              type="button"
              className="legend-more"
              onClick={() => setExpanded(false)}
            >
              Show less
            </button>
          )}
          {showFree && <Swatch label="Free" color={roleColors.free} />}
          {presence.unknown && (
            <span className="legend-unknown">
              <i />
              {mode === "fragmentation" || mode === "utilization"
                ? "Unmeasured"
                : "Unknown"}
            </span>
          )}
        </>
      )}
      <span className="legend-aside">
        {matches != null && (
          <span className="legend-matches">
            {matches.toLocaleString()} match{matches === 1 ? "" : "es"}
          </span>
        )}
        <InfoTip label="About the block map">
          <p>{EXPLANATIONS[mode]}</p>
          <p>
            Hover a tile for details; click to inspect its bytes. Arrow keys
            move between blocks.
          </p>
        </InfoTip>
      </span>
    </div>
  );
});
