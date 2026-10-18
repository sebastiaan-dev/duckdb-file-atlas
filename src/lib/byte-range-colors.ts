import {
  blockColor,
  compressionPalette,
  stableColor,
  tablePalette,
  roleColors,
} from "./palette";
import { nodeTypeColor } from "./index-layout";
import type {
  ByteRange,
  ColorMode,
  FileBlock,
  IndexInspection,
  Segment,
} from "./types";

const kinds: Record<ByteRange["kind"], { label: string; background: string }> =
  {
    checksum: { label: "Checksum", background: "#f1ba7e" },
    header: { label: "Header", background: "#c7b1dd" },
    metadata: { label: "Metadata", background: "#b3a0d3" },
    index: { label: "Index nodes", background: roleColors.index },
    segment: { label: "Segment data", background: "#7065db" },
    validity: { label: "Validity", background: "#82a8d4" },
    dictionary: { label: "Dictionary", background: "#d7b86f" },
    unused: { label: "Unused bytes", background: "var(--byte-unused)" },
    unknown: {
      label: "Unknown bytes",
      background:
        "repeating-linear-gradient(135deg, var(--chart-unknown) 0 3px, var(--line) 3px 4px)",
    },
  };

/** Ownership colors never turn unknown or allocator bytes into measured data. */
export function byteRangeAppearance(
  range: ByteRange,
  block: FileBlock,
  mode: ColorMode,
  segment?: Segment,
  index?: Pick<IndexInspection, "table" | "name">,
): { label: string; background: string } {
  if (range.kind === "unused" && block.role === "free")
    return { label: "Reusable free block", background: "var(--byte-free)" };
  const owned = ["segment", "validity", "dictionary", "index"].includes(
    range.kind,
  );
  if (mode === "role" && range.kind === "index" && range.nodeType)
    return range.indexMask
      ? { label: "Index free-slot mask", background: "var(--index-mask)" }
      : {
          label: `${range.nodeType} nodes`,
          background: nodeTypeColor({ nodeType: range.nodeType, ordinal: 0 }),
        };
  if (mode === "role" && range.kind === "unused" && range.nodeType)
    return {
      label: `Free ${range.nodeType} slots`,
      background:
        "repeating-linear-gradient(135deg, var(--index-free-a) 0 3px, var(--index-free-b) 3px 6px)",
    };
  if (mode === "role" || !owned) return kinds[range.kind];
  if (mode === "utilization" || mode === "fragmentation")
    return {
      label: mode === "utilization" ? "Space used" : "Internal free space",
      background: blockColor(block, mode, []),
    };
  if (range.kind === "index") {
    if (mode === "compression" || !index)
      return {
        label:
          mode === "compression"
            ? "Unknown compression (index nodes)"
            : "Unknown index ownership",
        background: roleColors.unknown,
      };
    const owner =
      mode === "table" ? index.table : `${index.table} / ${index.name}`;
    return { label: owner, background: stableColor(owner, tablePalette) };
  }
  if (!segment) return kinds[range.kind];
  const owner =
    mode === "table"
      ? segment.table
      : mode === "column"
        ? `${segment.table}.${segment.column}`
        : segment.compression;
  return {
    label: owner,
    background: stableColor(
      owner,
      mode === "compression" ? compressionPalette : tablePalette,
    ),
  };
}
