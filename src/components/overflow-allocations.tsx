import { useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import { InfoTip } from "@/components/detail-tooltip";
import { formatBytes, formatNumber, formatOffset } from "@/lib/format";
import { overflowRuns } from "@/lib/overflow";
import { roleColors } from "@/lib/palette";
import type { FileBlock, Segment } from "@/lib/types";
import "./overflow-allocations.css";

const RUN_PAGE = 8;

/**
 * A segment's string-overflow allocations, grouped into file-contiguous runs.
 * These are checkpoint allocation references, not a decoded string chain.
 */
export function OverflowAllocations({
  segment,
  blocksById,
  onBlockClick,
  onRangeClick,
}: {
  segment: Segment;
  blocksById: ReadonlyMap<number, FileBlock>;
  onBlockClick: (block: FileBlock) => void;
  /** Selects the inclusive block range on the physical map. */
  onRangeClick: (firstId: number, lastId: number) => void;
}) {
  const [visible, setVisible] = useState(RUN_PAGE);
  const runs = useMemo(
    () => overflowRuns(segment, blocksById),
    [segment, blocksById],
  );
  if (!runs.length) return null;
  const blocks = runs.reduce((sum, run) => sum + run.blocks, 0);
  const bytes = runs.reduce((sum, run) => sum + run.bytes, 0);
  return (
    <div
      className="overflow-allocations"
      role="group"
      aria-label="Overflow allocations"
    >
      <div className="overflow-allocations-heading">
        <span>
          Overflow
          <InfoTip label="About overflow allocations">
            <p>
              Blocks this segment references for strings too large to store
              inline. Sizes are whole blocks: usage inside them is not measured,
              and blocks may be shared with other segments.
            </p>
          </InfoTip>
        </span>
        <span>
          {formatNumber(blocks)} block{blocks === 1 ? "" : "s"} ·{" "}
          {formatBytes(bytes)}
        </span>
      </div>
      <ul className="overflow-run-list">
        {runs.slice(0, visible).map((run) => {
          const single = run.blocks === 1;
          const name = single
            ? `Block ${run.first.id}`
            : `Blocks ${run.first.id}–${run.last.id}`;
          return (
            <li key={run.first.id}>
              <button
                type="button"
                className="physical-link-card overflow-run"
                aria-label={
                  single
                    ? `Inspect overflow block ${run.first.id}`
                    : `Select overflow blocks ${run.first.id} to ${run.last.id}`
                }
                onClick={() =>
                  single
                    ? onBlockClick(run.first)
                    : onRangeClick(run.first.id, run.last.id)
                }
              >
                <span
                  className="overflow-run-swatch overflow-allocation-mark"
                  style={{ background: roleColors.overflow }}
                />
                <span>
                  <strong>{name}</strong>
                  <small>
                    {formatOffset(run.first.offset)}
                    {single
                      ? ""
                      : ` · ${formatNumber(run.blocks)} blocks`} ·{" "}
                    {formatBytes(run.bytes)}
                  </small>
                </span>
                <ArrowRight size={14} />
              </button>
            </li>
          );
        })}
      </ul>
      {visible < runs.length && (
        <button
          type="button"
          className="raw-header-link"
          onClick={() => setVisible((count) => count + RUN_PAGE * 4)}
        >
          Show more ({formatNumber(runs.length - visible)} more runs)
        </button>
      )}
    </div>
  );
}
