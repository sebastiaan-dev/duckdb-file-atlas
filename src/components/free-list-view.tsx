import { InfoTip } from "@/components/detail-tooltip";
import { FreeRunChart, type FreeRunOrder } from "@/components/free-run-chart";
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
type ChainNode = NonNullable<FileInspection["freeList"]>["chain"][number];
/** Collapse consecutive slots of one metadata block into a single chain step. */
function groupChain(chain: ChainNode[]) {
  const groups: {
    blockId: number;
    first: number;
    last: number;
    count: number;
    position: number;
  }[] = [];
  chain.forEach((node, index) => {
    const previous = groups.at(-1);
    if (
      previous &&
      previous.blockId === node.blockId &&
      node.slot === previous.last + 1
    ) {
      previous.last = node.slot;
      previous.count++;
    } else
      groups.push({
        blockId: node.blockId,
        first: node.slot,
        last: node.slot,
        count: 1,
        position: index + 1,
      });
  });
  return groups;
}

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
  const [order, setOrder] = useState<FreeRunOrder>("position");
  const ordered = useMemo(
    () =>
      order === "size"
        ? filtered
            .slice()
            .sort((a, b) => b.count - a.count || a.start - b.start)
        : filtered,
    [filtered, order],
  );
  const chain = useMemo(() => groupChain(state?.chain ?? []), [state?.chain]);
  const layout = useContinuousLayout(
    ordered,
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
  const dataStart =
    inspection.blocks.find((block) => block.id === 0)?.offset ?? 12288;
  // Include undiscovered blocks in the axis without allocating one DOM node per block.
  const totalBlocks = Math.max(
    0,
    Math.ceil((inspection.fileSize - dataStart) / inspection.blockSize),
  );
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
          <span>Reusable space</span>
          <strong>
            {state.complete
              ? bytes(freeBlocks * inspection.blockSize)
              : "Unknown"}
          </strong>
          <small>
            {state.complete
              ? `${count(freeBlocks)} whole blocks`
              : "Free-list traversal incomplete"}
          </small>
        </div>
        <div>
          <span>Contiguous runs</span>
          <strong>{state.complete ? count(runs.length) : "Unknown"}</strong>
          <small>
            {state.complete
              ? `Largest: ${count(largest)} blocks · ${bytes(largest * inspection.blockSize)}`
              : "Unknown"}
          </small>
        </div>
        <div>
          <span>Free metadata slots</span>
          <strong>{state.complete ? count(freeSlots) : "Unknown"}</strong>
          <small>
            {state.complete
              ? `${bytes(freeSlots * metadataSlotSize(inspection.blockSize))} within metadata blocks`
              : "Unknown"}
          </small>
        </div>
      </div>
      {(state.trimmedBlocks ?? 0) > 0 && (
        <p className="free-list-note">
          DuckDB already returned {count(state.trimmedBlocks!)} trailing free
          block{state.trimmedBlocks === 1 ? "" : "s"} (
          {bytes(state.trimmedBlocks! * inspection.blockSize)}) to the
          filesystem after this checkpoint. The header still counts them, but
          they are no longer part of the file and are not listed here.
        </p>
      )}
      {!state.complete && (
        <p className="free-list-note">
          The bounded free-list scan is incomplete. Listed free-block totals are
          unavailable; blocks outside the checkpoint extent can still be
          identified.
        </p>
      )}
      <section
        className="allocator-section free-runs-section"
        aria-label="Free block runs"
      >
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
            runs={ordered.slice(0, layout.visibleCount)}
            allRuns={filtered}
            order={order}
            onOrderChange={setOrder}
            largest={largest}
            totalBlocks={totalBlocks}
            blockSize={inspection.blockSize}
            dataStart={dataStart}
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
      <section
        className="allocator-section"
        aria-label="Free-list pointer chain"
      >
        <h3 className="heading-with-info">
          Allocator storage
          <InfoTip label="About allocator storage">
            <p>
              The checkpoint points to a chain of metadata slots containing the
              free list. These blocks store allocator records; they are not
              themselves free runs.
            </p>
          </InfoTip>
        </h3>
        <div className="free-list-chain">
          <Button variant="secondary" size="sm" onClick={onCheckpoint}>
            Checkpoint {state.checkpoint}
          </Button>
          {chain.map((group) => (
            <span
              className="free-chain-node"
              key={`${group.blockId}:${group.first}`}
            >
              <ArrowRight size={12} />
              <button
                onClick={() => onPick(group.blockId)}
                title={`Free-list chain positions ${group.position}–${group.position + group.count - 1}: ${group.count} consecutive metadata slot${group.count === 1 ? "" : "s"} in block ${group.blockId}`}
              >
                Block {group.blockId}
                <small>
                  {group.count === 1
                    ? `slot ${group.first}`
                    : `slots ${group.first}–${group.last}`}
                </small>
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
        <h3 className="heading-with-info">
          Metadata slots
          <InfoTip label="About metadata slots">
            <p>
              Each metadata block has 64 slots of{" "}
              {bytes(metadataSlotSize(inspection.blockSize))}. Free slots are
              reusable within a metadata block, not whole reusable blocks.
            </p>
          </InfoTip>
        </h3>
        <div className="free-slot-legend">
          <span>
            <i className="is-free" />
            Free slot
          </span>
          <span>
            <i />
            Allocated
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
          Multi-use blocks{" "}
          <small>
            {state.complete ? count(state.multiUseBlocks.length) : "Unknown"}
          </small>
          <InfoTip label="About multi-use blocks">
            <p>
              Blocks the checkpoint records as referenced more than once, such
              as metadata blocks whose slots several structures share. DuckDB
              keeps a reference count so a block is only freed when every
              reference is gone.
            </p>
          </InfoTip>
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
    </div>
  );
});
