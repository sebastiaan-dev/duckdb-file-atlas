import { useMemo, useState } from "react";
import { formatBytes, formatNumber } from "@/lib/format";
import type { FileBlock, Segment } from "@/lib/types";
import "./overflow-allocations.css";

/** Checkpoint allocation references, not a decoded string-chain diagram. */
export function OverflowAllocations({
  segment,
  blocksById,
  onBlockClick,
}: {
  segment: Segment;
  blocksById: ReadonlyMap<number, FileBlock>;
  onBlockClick: (block: FileBlock) => void;
}) {
  const [visible, setVisible] = useState(64);
  const blocks = useMemo(
    () =>
      [...new Set(segment.auxiliaryBlocks ?? [])]
        .map((id) => blocksById.get(id))
        .filter((block): block is FileBlock => !!block)
        .sort((a, b) => a.offset - b.offset),
    [segment, blocksById],
  );
  if (!blocks.length) return null;
  return (
    <section
      className="detail-section overflow-allocations"
      aria-label="Overflow allocations"
    >
      <div className="detail-section-heading">
        <span>Overflow allocations</span>
        <span>{formatNumber(blocks.length)} blocks</span>
      </div>
      <p className="section-caption">
        {formatBytes(blocks.reduce((sum, block) => sum + block.size, 0))} in
        referenced blocks. Internal usage is not measured; allocations may be
        shared.
      </p>
      <div className="overflow-block-grid">
        {blocks.slice(0, visible).map((block) => (
          <button
            type="button"
            key={block.id}
            onClick={() => onBlockClick(block)}
            className="overflow-block-link overflow-allocation-mark"
            aria-label={`Inspect overflow block ${block.id}`}
            title={`Block ${block.id} · ${formatBytes(block.size)} · ${(block.overflowSegmentIds ?? []).length} referencing segments`}
          >
            {block.id}
          </button>
        ))}
      </div>
      {visible < blocks.length && (
        <button
          type="button"
          className="raw-header-link"
          onClick={() => setVisible((count) => count + 64)}
        >
          Show more ({formatNumber(blocks.length - visible)} remaining)
        </button>
      )}
      <p className="section-caption">
        Blocks are shown in file order. String pointers and chain order are not
        decoded.
      </p>
    </section>
  );
}
