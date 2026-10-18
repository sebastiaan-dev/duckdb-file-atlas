import { internalFreeBytes } from "./fragmentation";
import type { ColorMode, FileBlock, Segment, StorageRole } from "./types";

export const roleColors: Record<StorageRole, string> = {
  header: "#f1ac84",
  metadata: "#c6a565",
  data: "#6961d8",
  index: "#67aaa7",
  free: "var(--chart-empty)",
  unknown: "var(--chart-unknown)",
};
export const spaceRamp = ["#eeecf8", "#c4bfec", "#9890df", "#6258ce"] as const;
/**
 * Lower bounds (exclusive) for spaceRamp steps 1–3. Cells and legends share
 * these so the legend always describes the stepped colors actually drawn.
 */
export const fragmentationSteps = [0.02, 0.2, 0.5] as const;
export const utilizationSteps = [0.08, 0.45, 0.8] as const;
export function rampStep(ratio: number, steps: readonly number[]) {
  return steps.filter((step) => ratio > step).length;
}
/** Human-readable range labels for each ramp step, e.g. "≤ 2%", "2–20%". */
export function rampLabels(steps: readonly number[]) {
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  return [
    `≤ ${pct(steps[0])}`,
    ...steps
      .slice(1)
      .map((step, i) => `${Math.round(steps[i] * 100)}–${pct(step)}`),
    `> ${pct(steps.at(-1)!)}`,
  ];
}
export const tablePalette = [
  "#6961d8",
  "#72aaa7",
  "#d7a267",
  "#ae87c5",
  "#689ac8",
  "#cb8388",
  "#a4b56f",
  "#bd9b5e",
];
export const compressionPalette = [
  "#689ac8",
  "#91ac79",
  "#ae87c5",
  "#d7a267",
  "#72aaa7",
  "#cb8388",
  "#858ac5",
];

export function stableColor(value: string, palette: readonly string[]) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1)
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  return palette[Math.abs(hash) % palette.length] ?? "#d6d6df";
}

export function blockOwners(
  block: FileBlock,
  mode: ColorMode,
  segments: Segment[],
) {
  const owners = segments.filter((segment) => segment.blockId === block.id);
  if (mode === "table")
    return [
      ...new Set([
        ...owners.map((segment) => segment.table),
        ...(block.indexOwners ?? []).map((index) => index.table),
      ]),
    ];
  if (mode === "column")
    return [
      ...new Set([
        ...owners.map((segment) => `${segment.table}.${segment.column}`),
        ...(block.indexOwners ?? []).map(
          (index) => `${index.table} / ${index.name}`,
        ),
      ]),
    ];
  if (mode === "compression")
    return [...new Set(owners.map((segment) => segment.compression))];
  return [];
}

export function blockCellColors(
  block: FileBlock,
  mode: ColorMode,
  segments: Segment[],
): string[] {
  if (block.role === "free") return [roleColors.free];
  if (mode === "role") return [roleColors[block.role]];
  if (mode === "fragmentation") {
    const unused = internalFreeBytes(block);
    if (unused == null) return [roleColors.unknown];
    const ratio = unused / block.size;
    return [spaceRamp[rampStep(ratio, fragmentationSteps)]];
  }
  if (mode === "utilization") {
    if (block.usedBytes == null || block.size <= 0) return [roleColors.unknown];
    const ratio = Math.max(0, Math.min(1, block.usedBytes / block.size));
    return [spaceRamp[rampStep(ratio, utilizationSteps)]];
  }
  const owners = blockOwners(block, mode, segments);
  return owners.length
    ? owners.map((owner) =>
        stableColor(
          owner,
          mode === "compression" ? compressionPalette : tablePalette,
        ),
      )
    : [roleColors.unknown];
}

export function blockColor(
  block: FileBlock,
  mode: ColorMode,
  segments: Segment[],
) {
  return blockCellColors(block, mode, segments)[0];
}
