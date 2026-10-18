import type { FileInspection, FileBlock } from "./types";

export function internalFreeBytes(block: FileBlock): number | null {
  if (!["data", "index"].includes(block.role) || block.usedBytes == null)
    return null;
  return block.ranges
    .filter((range) => range.kind === "unused")
    .reduce((sum, range) => sum + range.size, 0);
}

/** Only bytes in completely mapped data blocks contribute; whole free blocks are separate. */
export function fragmentationSummary(inspection: FileInspection) {
  let bytes = 0,
    measuredBytes = 0,
    dataBytes = 0,
    measuredBlocks = 0;
  for (const block of inspection.blocks) {
    if (block.role !== "data") continue;
    dataBytes += block.size;
    const unused = internalFreeBytes(block);
    if (unused == null) continue;
    bytes += unused;
    measuredBytes += block.size;
    measuredBlocks++;
  }
  return {
    bytes,
    measuredBytes,
    dataBytes,
    measuredBlocks,
    coverage: dataBytes ? measuredBytes / dataBytes : 0,
    ratio: measuredBytes ? bytes / measuredBytes : null,
  };
}
