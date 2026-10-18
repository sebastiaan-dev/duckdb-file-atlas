import {
  blockColor,
  compressionPalette,
  stableColor,
  tablePalette,
} from "./palette";
import type { ByteRange, ColorMode, FileBlock, Segment } from "./types";

const kinds: Record<ByteRange["kind"], { label: string; background: string }> =
  {
    checksum: { label: "Checksum", background: "#f1ba7e" },
    header: { label: "Header", background: "#c7b1dd" },
    metadata: { label: "Metadata", background: "#b3a0d3" },
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
): { label: string; background: string } {
  if (range.kind === "unused" && block.role === "free")
    return { label: "Reusable free block", background: "var(--byte-free)" };
  const owned = ["segment", "validity", "dictionary"].includes(range.kind);
  if (mode === "role" || !owned) return kinds[range.kind];
  if (mode === "utilization" || mode === "fragmentation")
    return {
      label: mode === "utilization" ? "Space used" : "Internal free space",
      background: blockColor(block, mode, []),
    };
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
