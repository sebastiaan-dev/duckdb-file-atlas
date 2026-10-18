import { FreeRunChart } from "@/components/free-run-chart";
import { memo, useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useContinuousLayout } from "@/hooks/use-continuous-layout";
import {
  buildFreeRuns,
  filterFreeRuns,
  metadataSlotSize,
} from "@/lib/free-list";
import { LARGE_BLOCK_COUNT } from "@/lib/layout";
import type { FileInspection } from "@/lib/types";

const emptyMetadata: NonNullable<FileInspection["freeList"]>["metadata"] = [];
const emptyShared: NonNullable<FileInspection["freeList"]>["multiUseBlocks"] =
  [];
const count = (value: number) => value.toLocaleString();
const bytes = (value: number) =>
  value < 1024
    ? `${count(value)} B`
    : value < 1024 ** 2
      ? `${(value / 1024).toFixed(1)} KiB`
      : `${(value / 1024 ** 2).toFixed(1)} MiB`;
export const FreeListView = memo(function FreeListView({
  inspection,
  query,
  onPick,
  onCheckpoint,
}: {
  inspection: FileInspection;
  query: string;
  onPick: (id: number) => void;
  onCheckpoint: () => void;
}) {
  const state = inspection.freeList;
  const runs = useMemo(() => (state ? buildFreeRuns(state) : []), [state]);
  const filtered = useMemo(() => filterFreeRuns(runs, query), [runs, query]);
  const layout = useContinuousLayout(
    filtered,
    inspection.blocks.length > LARGE_BLOCK_COUNT + 3,
    512,
  );
  const metadataLayout = useContinuousLayout(
    state?.metadata ?? emptyMetadata,
    inspection.blocks.length > LARGE_BLOCK_COUNT + 3,
    128,
  );
  const sharedLayout = useContinuousLayout(
    state?.multiUseBlocks ?? emptyShared,
    inspection.blocks.length > LARGE_BLOCK_COUNT + 3,
    512,
  );
  const [showShared, setShowShared] = useState(false);
  const freeSlots =
    state?.metadata.reduce((sum, block) => sum + block.freeSlots.length, 0) ??
    0;
  const freeBlocks =
    (state?.blockIds.length ?? 0) + (state?.implicitBlockIds.length ?? 0);
  const largest = runs.reduce((max, run) => Math.max(max, run.count), 0);
  if (!state)
    return (
      <div className="free-list-body">
        <p>
          No recorded free-list details. Open a database to inspect its
          checkpoint allocator.
        </p>
      </div>
    );
  return (
    <div className="free-list-body">
      <div className="free-list-metrics">
        <div>
          <span>FREE BLOCKS</span>
          <strong>{state.complete ? count(freeBlocks) : "Unknown"}</strong>
          <small>
            {state.complete
              ? bytes(freeBlocks * inspection.blockSize)
              : "Free-list traversal incomplete"}
          </small>
        </div>
        <div>
          <span>CONTIGUOUS RUNS</span>
          <strong>{state.complete ? count(runs.length) : "Unknown"}</strong>
          <small>
            {state.complete
              ? `Largest: ${count(largest)} blocks · ${bytes(largest * inspection.blockSize)}`
              : "Unknown"}
          </small>
        </div>
        <div>
          <span>FREE METADATA SLOTS</span>
          <strong>{state.complete ? count(freeSlots) : "Unknown"}</strong>
          <small>
            {state.complete
              ? `${bytes(freeSlots * metadataSlotSize(inspection.blockSize))} reusable within metadata blocks`
              : "Unknown"}
          </small>
        </div>
      </div>
      {!state.complete && (
        <p className="free-list-note">
          The bounded free-list scan is incomplete. Listed free-block totals are
          unavailable; blocks outside the checkpoint extent can still be
          identified.
        </p>
      )}
      <section
        className="allocator-section"
        aria-label="Free-list pointer chain"
      >
        <h3>Checkpoint → free-list storage</h3>
        <div className="free-list-chain">
          <Button variant="secondary" size="sm" onClick={onCheckpoint}>
            Checkpoint {state.checkpoint}
          </Button>
          {state.chain.map((node, index) => (
            <span
              className="free-chain-node"
              key={`${node.blockId}:${node.slot}`}
            >
              <ArrowRight size={12} />
              <button
                onClick={() => onPick(node.blockId)}
                title={`Free-list chain position ${index + 1}; ${node.next ? `next block ${node.next.blockId}, slot ${node.next.slot}` : "end of chain"}`}
              >
                Block {node.blockId}
                <small>slot {node.slot}</small>
              </button>
            </span>
          ))}
          {!state.root && (
            <span className="free-list-note">No free-list stream</span>
          )}
        </div>
      </section>

      <section
        className="allocator-section"
        aria-label="Metadata slot allocations"
      >
        <h3>
          Metadata slots{" "}
          <small>
            64 slots per block · {bytes(metadataSlotSize(inspection.blockSize))}{" "}
            per slot
          </small>
        </h3>
        <div className="free-slot-legend">
          <span>
            <i />
            Allocated
          </span>
          <span>
            <i className="is-free" />
            Free
          </span>
        </div>
        {state.metadata.slice(0, metadataLayout.visibleCount).map((block) => (
          <div className="free-slot-row" key={block.blockId}>
            <button onClick={() => onPick(block.blockId)}>
              Block {block.blockId}
            </button>
            <div
              className="free-slot-map"
              role="img"
              aria-label={`Block ${block.blockId}: ${block.freeSlots.length} free metadata slots out of 64`}
            >
              {Array.from({ length: 64 }, (_, slot) => (
                <span
                  key={slot}
                  className={block.freeSlots.includes(slot) ? "is-free" : ""}
                  title={`Slot ${slot}: ${block.freeSlots.includes(slot) ? "free" : "allocated"}`}
                />
              ))}
            </div>
            <small>{block.freeSlots.length}/64 free</small>
          </div>
        ))}
        {metadataLayout.hasMore && (
          <div className="continuous-load" ref={metadataLayout.sentinelRef}>
            <span>More metadata blocks load as you scroll</span>
            <Button variant="ghost" size="sm" onClick={metadataLayout.loadMore}>
              Load more metadata blocks
            </Button>
          </div>
        )}
        {!state.metadata.length && (
          <p className="free-list-note">
            {state.complete
              ? "No metadata allocation masks recorded."
              : "Metadata allocation masks are unknown."}
          </p>
        )}
      </section>
      <details
        className="allocator-section"
        onToggle={(event) => setShowShared(event.currentTarget.open)}
      >
        <summary>
          Shared blocks{" "}
          <small>
            {state.complete ? count(state.multiUseBlocks.length) : "Unknown"}
          </small>
        </summary>
        <div className="shared-block-list">
          {showShared &&
            state.multiUseBlocks
              .slice(0, sharedLayout.visibleCount)
              .map((block) => (
                <button
                  key={block.blockId}
                  onClick={() => onPick(block.blockId)}
                >
                  Block {block.blockId}
                  <small>{count(block.references)} references</small>
                </button>
              ))}
        </div>
        {showShared && sharedLayout.hasMore && (
          <div className="continuous-load" ref={sharedLayout.sentinelRef}>
            <span>More shared blocks load as you scroll</span>
            <Button variant="ghost" size="sm" onClick={sharedLayout.loadMore}>
              Load more shared blocks
            </Button>
          </div>
        )}
        {state.complete && !state.multiUseBlocks.length && (
          <p className="free-list-note">No shared-block references recorded.</p>
        )}
      </details>
      <section className="allocator-section" aria-label="Free block runs">
        <h3>
          Free block runs{" "}
          <small>
            {count(filtered.length)}
            {query ? ` of ${count(runs.length)}` : ""}
          </small>
        </h3>
        {!filtered.length && (
          <p className="free-list-note">
            {query
              ? "No free runs match this search."
              : state.complete
                ? "No whole blocks are free."
                : "Free blocks are unknown."}
          </p>
        )}
        {filtered.length > 0 && (
          <FreeRunChart
            key={inspection.headerFingerprint ?? inspection.name}
            runs={filtered.slice(0, layout.visibleCount)}
            largest={largest}
            blockSize={inspection.blockSize}
            dataStart={
              inspection.blocks.find((block) => block.id === 0)?.offset ?? 12288
            }
            matchingId={
              /^\d+$/.test(query.trim()) ? Number(query.trim()) : null
            }
            onPick={onPick}
          />
        )}
        {layout.hasMore && (
          <div className="continuous-load" ref={layout.sentinelRef}>
            <span>More runs load as you scroll</span>
            <Button variant="ghost" size="sm" onClick={layout.loadMore}>
              Load more runs
            </Button>
          </div>
        )}
      </section>
    </div>
  );
});
