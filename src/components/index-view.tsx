import { memo, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { roleColors } from "@/lib/palette";
import type {
  FileInspection,
  IndexAllocator,
  IndexInspection,
} from "@/lib/types";

const count = (value: number) => value.toLocaleString();
const bytes = (value: number | null) =>
  value == null
    ? "Unknown"
    : value < 1024
      ? `${count(value)} B`
      : value < 1024 ** 2
        ? `${(value / 1024).toFixed(1)} KiB`
        : `${(value / 1024 ** 2).toFixed(1)} MiB`;

function Metrics({
  index,
}: {
  index: Pick<
    IndexInspection,
    "occupiedBytes" | "freeBytes" | "maskOverheadBytes" | "allocationBytes"
  >;
}) {
  return (
    <div className="index-metrics">
      <div>
        <span>Occupied nodes</span>
        <strong>{bytes(index.occupiedBytes)}</strong>
      </div>
      <div>
        <span>Free stored slots</span>
        <strong>{bytes(index.freeBytes)}</strong>
      </div>
      <div>
        <span>Mask overhead</span>
        <strong>{bytes(index.maskOverheadBytes)}</strong>
      </div>
      <div>
        <span>Persisted envelope</span>
        <strong>{bytes(index.allocationBytes)}</strong>
      </div>
    </div>
  );
}

function Allocator({
  allocator,
  onPick,
}: {
  allocator: IndexAllocator;
  onPick: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(32);
  const storedSlots = allocator.buffers.reduce(
    (sum, buffer) => sum + buffer.storedSlots,
    0,
  );
  return (
    <details
      className="index-allocator"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {allocator.nodeType}{" "}
        <small>
          {count(allocator.buffers.length)} buffers ·{" "}
          {count(allocator.occupiedSlots)} occupied / {count(storedSlots)}{" "}
          stored slots
        </small>
      </summary>
      {open && (
        <>
          <Metrics index={allocator} />
          <p className="section-caption">
            {bytes(allocator.segmentSize)} per node · logical capacity{" "}
            {count(allocator.capacity)} slots per buffer. Capacity outside the
            persisted envelope is not counted as bytes.
          </p>
          <div className="index-buffer-list">
            {allocator.buffers.slice(0, visible).map((buffer) => (
              <div className="index-buffer" key={buffer.bufferId}>
                <button
                  type="button"
                  className="link-chip"
                  onClick={() => onPick(buffer.blockId)}
                >
                  Block {buffer.blockId}
                  <span>buffer {buffer.bufferId}</span>
                </button>
                <small>
                  {count(buffer.segmentCount)} occupied /{" "}
                  {count(buffer.storedSlots)} stored slots ·{" "}
                  {bytes(buffer.allocationSize)} envelope · offset 0x
                  {buffer.absoluteOffset.toString(16)}
                </small>
                <div
                  className="index-slot-bar"
                  role="img"
                  aria-label={`Buffer ${buffer.bufferId}: ${count(buffer.segmentCount)} occupied of ${count(buffer.storedSlots)} stored slots`}
                >
                  {buffer.runs.slice(0, 256).map((run) => (
                    <span
                      key={run.start}
                      style={{
                        left: `${buffer.storedSlots ? (run.start / buffer.storedSlots) * 100 : 0}%`,
                        width: `${buffer.storedSlots ? (run.count / buffer.storedSlots) * 100 : 0}%`,
                        background: run.occupied
                          ? roleColors.index
                          : "var(--byte-unused)",
                      }}
                      title={`Slots ${run.start}–${run.start + run.count - 1}: ${run.occupied ? "occupied" : "free"}`}
                    />
                  ))}
                </div>
                {buffer.runs.length > 256 && (
                  <small>
                    First 256 of {count(buffer.runs.length)} coalesced slot runs
                    shown; counts cover the full buffer.
                  </small>
                )}
              </div>
            ))}
          </div>
          {visible < allocator.buffers.length && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setVisible(visible + 32)}
            >
              Load more buffers
            </Button>
          )}
        </>
      )}
    </details>
  );
}

function IndexCard({
  index,
  onPick,
}: {
  index: IndexInspection;
  onPick: (id: number) => void;
}) {
  const [openBlocks, setOpenBlocks] = useState(false);
  const [visibleBlocks, setVisibleBlocks] = useState(32);
  const [visibleAllocators, setVisibleAllocators] = useState(16);
  const root = index.rootPointer;
  return (
    <section
      className="index-card"
      aria-label={`${index.table} / ${index.name}`}
    >
      <h3>
        {index.name}
        <small>{index.table}</small>
      </h3>
      <p className="index-root mono">
        Root: {index.root} · {root.nodeType}
        {root.bufferId != null
          ? ` · buffer ${root.bufferId}, slot ${root.slot}`
          : ""}
        {root.inlinedRowId != null ? ` · row ID ${root.inlinedRowId}` : ""}
        {root.gate ? " · gate" : ""}
      </p>
      {!index.complete && (
        <p className="index-incomplete">
          {index.reason ??
            "Index layout is unsupported or incomplete; occupancy remains unknown."}
        </p>
      )}
      {index.legacyRootPointer && (
        <p className="section-caption">
          Legacy root: block {index.legacyRootPointer.blockId}, offset{" "}
          {index.legacyRootPointer.offset}
        </p>
      )}
      <Metrics index={index} />
      {index.complete &&
        index.allocators
          .slice(0, visibleAllocators)
          .map((allocator) => (
            <Allocator
              key={allocator.ordinal}
              allocator={allocator}
              onPick={onPick}
            />
          ))}
      {index.complete && visibleAllocators < index.allocators.length && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setVisibleAllocators(visibleAllocators + 16)}
        >
          Load more allocators
        </Button>
      )}
      <details
        className="index-allocator"
        onToggle={(event) => setOpenBlocks(event.currentTarget.open)}
      >
        <summary>
          Referenced blocks <small>{count(index.blockIds.length)}</small>
        </summary>
        {openBlocks && (
          <div className="link-list">
            {index.blockIds.slice(0, visibleBlocks).map((id) => (
              <button
                type="button"
                className="link-chip"
                key={id}
                onClick={() => onPick(id)}
              >
                Block {id}
              </button>
            ))}
            {visibleBlocks < index.blockIds.length && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setVisibleBlocks(visibleBlocks + 32)}
              >
                Load more index blocks
              </Button>
            )}
            {!index.blockIds.length && (
              <p className="section-caption">
                {index.complete
                  ? "No persisted blocks referenced (empty or inlined root)."
                  : "No allocator blocks were recorded; legacy root ownership may be unavailable."}
              </p>
            )}
          </div>
        )}
      </details>
    </section>
  );
}

export const IndexView = memo(function IndexView({
  inspection,
  query,
  onPick,
}: {
  inspection: FileInspection;
  query: string;
  onPick: (id: number) => void;
}) {
  const [visible, setVisible] = useState(32);
  const indexes = inspection.indexes;
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return (indexes ?? []).filter((index) =>
      `${index.table} ${index.name}`.toLocaleLowerCase().includes(term),
    );
  }, [indexes, query]);
  const measured = (indexes ?? []).filter(
    (index) =>
      index.complete &&
      index.occupiedBytes != null &&
      index.freeBytes != null &&
      index.maskOverheadBytes != null &&
      index.allocationBytes != null,
  );
  const totals = measured.reduce(
    (total, index) => ({
      occupiedBytes: total.occupiedBytes + (index.occupiedBytes ?? 0),
      freeBytes: total.freeBytes + (index.freeBytes ?? 0),
      maskOverheadBytes:
        total.maskOverheadBytes + (index.maskOverheadBytes ?? 0),
      allocationBytes: total.allocationBytes + (index.allocationBytes ?? 0),
    }),
    {
      occupiedBytes: 0,
      freeBytes: 0,
      maskOverheadBytes: 0,
      allocationBytes: 0,
    },
  );
  return (
    <div className="index-view">
      {!indexes?.length ? (
        <div className="logical-empty-state">
          <h3>No recorded index details</h3>
          <p>
            Open a database with checkpoint indexes to inspect named ownership,
            roots, and persisted allocator occupancy. Example and legacy files
            may not include index details.
          </p>
        </div>
      ) : (
        <>
          <Metrics
            index={
              measured.length
                ? totals
                : {
                    occupiedBytes: null,
                    freeBytes: null,
                    maskOverheadBytes: null,
                    allocationBytes: null,
                  }
            }
          />
          <p className="section-caption">
            Recorded totals: {count(measured.length)} of {count(indexes.length)}{" "}
            indexes completely measured. Free stored slots are holes within
            persisted buffers, not unallocated block tails or whole reusable
            free blocks. Index metrics are separate from the data-only internal
            free-space overview.
          </p>
          <div className="free-slot-legend">
            <span>
              <i style={{ background: roleColors.index }} />
              Occupied
            </span>
            <span>
              <i style={{ background: "var(--byte-unused)" }} />
              Free stored slots
            </span>
          </div>
          {!filtered.length && (
            <p className="empty-search">No indexes match “{query}”.</p>
          )}
          {filtered.slice(0, visible).map((index) => (
            <IndexCard key={index.id} index={index} onPick={onPick} />
          ))}
          {visible < filtered.length && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setVisible(visible + 32)}
            >
              Load more indexes
            </Button>
          )}
        </>
      )}
    </div>
  );
});
