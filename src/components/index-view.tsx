import { memo, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { IndexBufferMap } from "@/components/index-buffer-map";
import {
  allocatorValue,
  formatIndexBytes as bytes,
  INDEX_ROW_LIMIT,
  indexMeasurements,
  isMeasuredIndex,
  rankAllocators,
  RAW_LINK_LIMIT,
  sortedIndexBuffers,
  type AllocatorMetric,
} from "@/lib/index-layout";
import type { FileInspection, IndexInspection } from "@/lib/types";

function SelectedIndex({
  index,
  selectedBlockId,
  onPick,
}: {
  index: IndexInspection;
  selectedBlockId?: number | null;
  onPick: (id: number) => void;
}) {
  const [metric, setMetric] = useState<AllocatorMetric>("bytes");
  const [allocator, setAllocator] = useState<number | null>(null);
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const [rawLimit, setRawLimit] = useState(RAW_LINK_LIMIT);
  useEffect(() => {
    setMetric("bytes");
    setAllocator(null);
    setTechnicalOpen(false);
    setRawLimit(RAW_LINK_LIMIT);
  }, [index]);
  const measured = isMeasuredIndex(index);
  const ranked = useMemo(() => rankAllocators(index, metric), [index, metric]);
  const buffers = useMemo(() => sortedIndexBuffers(index), [index]);
  const tiles = useMemo(
    () =>
      allocator == null
        ? buffers
        : buffers.filter((tile) => tile.allocator.ordinal === allocator),
    [buffers, allocator],
  );
  const max = ranked.reduce(
    (maximum, row) => Math.max(maximum, allocatorValue(row, metric)),
    0,
  );
  const selectedClass = ranked.find((row) => row.ordinal === allocator);
  return (
    <section className="index-selection" aria-label="Selected index">
      <div className="index-selected-heading">
        <div>
          <span className="eyebrow">Selected index</span>
          <h3>{index.name}</h3>
          <span>{index.table}</span>
        </div>
        <strong>
          {measured
            ? `${bytes(index.allocationBytes)} persisted`
            : "Occupancy unknown"}
        </strong>
      </div>
      {measured && (
        <p className="index-selected-facts">
          {bytes(index.occupiedBytes)} occupied · {bytes(index.freeBytes)} free
          stored-slot holes · {bytes(index.maskOverheadBytes)} mask overhead
        </p>
      )}
      {!measured ? (
        <p className="index-incomplete">
          {index.reason ??
            "Index layout is unsupported or incomplete; occupancy remains unknown."}{" "}
          Allocator counts and buffer colors are not measured.
        </p>
      ) : (
        <div className="index-linked-graphs">
          <section className="index-graph" aria-label="Allocator breakdown">
            <div className="index-graph-heading">
              <h4>2 · Allocator breakdown</h4>
              <div
                className="index-toggle"
                role="group"
                aria-label="Allocator ranking metric"
              >
                <button
                  type="button"
                  aria-pressed={metric === "bytes"}
                  onClick={() => setMetric("bytes")}
                >
                  Bytes
                </button>
                <button
                  type="button"
                  aria-pressed={metric === "slots"}
                  onClick={() => setMetric("slots")}
                >
                  Slot count
                </button>
              </div>
            </div>
            <p className="section-caption">
              {metric === "bytes"
                ? "Occupied slot bytes (slot size × occupied slots)."
                : "Occupied slots, not logical capacity."}{" "}
              Ranked largest first; empty classes hidden.
            </p>
            <button
              type="button"
              className="index-reset"
              aria-pressed={allocator == null}
              onClick={() => setAllocator(null)}
            >
              All allocators
            </button>
            <div className="index-allocator-bars">
              {ranked.map((row) => (
                <button
                  type="button"
                  className="index-allocator-row"
                  key={row.ordinal}
                  aria-pressed={allocator === row.ordinal}
                  title={`${row.nodeType}: ${bytes(row.occupiedBytes)} occupied · ${row.occupiedSlots.toLocaleString()} occupied slots · ${bytes(row.segmentSize)} per slot · ${bytes(row.freeBytes)} free stored-slot holes`}
                  onClick={() => setAllocator(row.ordinal)}
                >
                  <span className="index-allocator-label">
                    {row.nodeType}
                    <small>
                      {bytes(row.segmentSize)} / slot ·{" "}
                      {row.buffers.length.toLocaleString()} buffers
                    </small>
                  </span>
                  <span className="index-rank-track">
                    <i
                      style={{
                        width: `${max ? (allocatorValue(row, metric) / max) * 100 : 0}%`,
                      }}
                    />
                  </span>
                  <strong>
                    {metric === "bytes"
                      ? bytes(row.occupiedBytes)
                      : row.occupiedSlots.toLocaleString()}
                  </strong>
                </button>
              ))}
            </div>
            {!ranked.length && (
              <p className="section-caption">
                Measured zero persisted allocator storage. This index is empty
                or has an inlined root.
              </p>
            )}
            <p className="section-caption">
              Click a class to filter buffers. Capacity outside the persisted
              envelope is not counted as bytes.
            </p>
          </section>
          <div>
            <p className="index-filter-caption">
              {selectedClass
                ? `${selectedClass.nodeType} buffers`
                : "All allocator classes"}
            </p>
            <IndexBufferMap
              key={allocator ?? "all"}
              tiles={tiles}
              totalBuffers={buffers.length}
              selectedBlockId={selectedBlockId}
              onPick={onPick}
            />
          </div>
        </div>
      )}
      <details
        className="index-technical"
        open={technicalOpen}
        onToggle={(event) => setTechnicalOpen(event.currentTarget.open)}
      >
        <summary>
          Technical details <small>Root, options & raw block links</small>
        </summary>
        {technicalOpen && (
          <div>
            <p className="index-root mono">
              Root: {index.root} · {index.rootPointer.nodeType}
              {index.rootPointer.bufferId != null
                ? ` · buffer ${index.rootPointer.bufferId}, slot ${index.rootPointer.slot}`
                : ""}
              {index.rootPointer.inlinedRowId != null
                ? ` · row ID ${index.rootPointer.inlinedRowId}`
                : ""}
              {index.rootPointer.gate ? " · gate" : ""}
            </p>
            {index.legacyRootPointer && (
              <p className="section-caption">
                Legacy root: block {index.legacyRootPointer.blockId}, offset{" "}
                {index.legacyRootPointer.offset}
              </p>
            )}
            <p className="index-root mono">
              Options: {JSON.stringify(index.options)}
            </p>
            <p className="section-caption">
              Referenced blocks: {index.blockIds.length.toLocaleString()}. Raw
              links open physical details; ART child links are not decoded.
            </p>
            <div className="link-list">
              {index.blockIds.slice(0, rawLimit).map((id) => (
                <button
                  type="button"
                  className="link-chip"
                  key={id}
                  onClick={() => onPick(id)}
                >
                  Block {id}
                </button>
              ))}
            </div>
            {rawLimit < index.blockIds.length && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRawLimit(rawLimit + RAW_LINK_LIMIT)}
              >
                Load more index blocks
              </Button>
            )}
            {measured && (
              <div className="index-raw-buffers">
                {buffers.slice(0, rawLimit).map((tile) => (
                  <button
                    type="button"
                    className="link-chip"
                    key={tile.key}
                    onClick={() => onPick(tile.buffer.blockId)}
                  >
                    {tile.allocator.nodeType} · buffer {tile.buffer.bufferId} ·
                    block {tile.buffer.blockId} · 0x
                    {tile.buffer.absoluteOffset.toString(16)}
                  </button>
                ))}
                {rawLimit < buffers.length && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRawLimit(rawLimit + RAW_LINK_LIMIT)}
                  >
                    Load more raw buffers
                  </Button>
                )}
              </div>
            )}
            {!index.blockIds.length && (
              <p className="section-caption">
                {measured
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
  selectedBlockId,
  onPick,
}: {
  inspection: FileInspection;
  query: string;
  selectedBlockId?: number | null;
  onPick: (id: number) => void;
}) {
  const [visibleState, setVisible] = useState({
    inspection,
    limit: INDEX_ROW_LIMIT,
  });
  const [selection, setSelection] = useState<{
    inspection: FileInspection;
    id: string;
  } | null>(() => {
    const initial = inspection.indexes?.find((index) =>
      `${index.table} ${index.name}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
    );
    return initial ? { inspection, id: initial.id } : null;
  });
  const indexes = inspection.indexes;
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return (indexes ?? []).filter((index) =>
      `${index.table} ${index.name}`.toLocaleLowerCase().includes(term),
    );
  }, [indexes, query]);
  const measurements = useMemo(
    () => indexMeasurements(indexes ?? []),
    [indexes],
  );
  const selected =
    (selection?.inspection === inspection
      ? indexes?.find((index) => index.id === selection.id)
      : undefined) ?? filtered[0];
  if (
    selected &&
    (selection?.inspection !== inspection ||
      !indexes?.some((index) => index.id === selection.id))
  ) {
    setSelection({ inspection, id: selected.id });
  }
  const visible =
    visibleState.inspection === inspection
      ? visibleState.limit
      : INDEX_ROW_LIMIT;
  const { totals, measuredCount, axisMax } = measurements;
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
          <div className="index-metrics">
            <div>
              <span>Recorded indexes</span>
              <strong>{indexes.length.toLocaleString()}</strong>
            </div>
            <div>
              <span>Persisted envelope</span>
              <strong>
                {bytes(measuredCount ? totals.allocationBytes : null)}
              </strong>
            </div>
            <div>
              <span>Occupied slot bytes</span>
              <strong>
                {bytes(measuredCount ? totals.occupiedBytes : null)}
              </strong>
            </div>
            <div>
              <span>Free stored-slot holes</span>
              <strong>{bytes(measuredCount ? totals.freeBytes : null)}</strong>
            </div>
            <div>
              <span>Mask overhead</span>
              <strong>
                {bytes(measuredCount ? totals.maskOverheadBytes : null)}
              </strong>
            </div>
          </div>
          <p className="section-caption index-coverage">
            Measured coverage: {measuredCount.toLocaleString()} of{" "}
            {indexes.length.toLocaleString()} indexes completely measured.
            Totals include only measured indexes. Free stored slots are holes
            within persisted envelopes, not unallocated block tails, physical
            gaps or whole reusable free blocks.
          </p>
          <section
            className="index-comparison"
            aria-label="Index comparison"
            data-axis-max={axisMax}
          >
            <div className="index-graph-heading">
              <h3>1 · Compare persisted indexes</h3>
              <span>
                {filtered.length.toLocaleString()} of{" "}
                {indexes.length.toLocaleString()} indexes
              </span>
            </div>
            <div className="index-comparison-legend">
              <span>
                <i className="index-occupied" />
                Occupied slots
              </span>
              <span>
                <i className="index-free" />
                Free holes
              </span>
              <span>
                <i className="index-mask" />
                Mask
              </span>
              <span>
                <i className="index-unknown" />
                Unknown extent
              </span>
            </div>
            <div className="index-axis">
              <span>Shared byte axis · full file</span>
              <span>0 — {bytes(axisMax)}</span>
            </div>
            {filtered.slice(0, visible).map((index) => {
              const measured = isMeasuredIndex(index);
              return (
                <button
                  type="button"
                  className="index-comparison-row"
                  key={index.id}
                  aria-pressed={selected?.id === index.id}
                  title={
                    measured
                      ? `${index.name}: ${bytes(index.allocationBytes)} persisted · ${bytes(index.occupiedBytes)} occupied · ${bytes(index.freeBytes)} free holes · ${bytes(index.maskOverheadBytes)} mask overhead`
                      : `${index.name}: occupancy and envelope extent unknown`
                  }
                  onClick={() => setSelection({ inspection, id: index.id })}
                >
                  <span className="index-comparison-name">
                    {index.name}
                    <small>{index.table}</small>
                  </span>
                  <span
                    className="index-comparison-track"
                    aria-label={
                      measured
                        ? `${bytes(index.occupiedBytes)} occupied, ${bytes(index.freeBytes)} free holes, ${bytes(index.maskOverheadBytes)} mask`
                        : "Unknown occupancy and envelope extent"
                    }
                  >
                    {measured ? (
                      <span
                        className="index-stack"
                        style={{
                          width: `${axisMax ? (index.allocationBytes! / axisMax) * 100 : 0}%`,
                        }}
                      >
                        {[
                          ["index-occupied", index.occupiedBytes],
                          ["index-free", index.freeBytes],
                          ["index-mask", index.maskOverheadBytes],
                        ].map(([className, value]) => (
                          <i
                            key={String(className)}
                            className={String(className)}
                            style={{
                              width: `${index.allocationBytes ? (Number(value) / index.allocationBytes) * 100 : 0}%`,
                            }}
                          />
                        ))}
                      </span>
                    ) : (
                      <span className="index-unknown index-unknown-extent">
                        Unmeasured · extent unknown
                      </span>
                    )}
                  </span>
                  <strong>
                    {measured ? bytes(index.allocationBytes) : "Unknown"}
                    {measured && index.allocationBytes === 0 && (
                      <small>Empty / inlined</small>
                    )}
                  </strong>
                </button>
              );
            })}
            {!filtered.length && (
              <p className="empty-search">No indexes match “{query}”.</p>
            )}
            {visible < filtered.length && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setVisible({ inspection, limit: visible + INDEX_ROW_LIMIT })
                }
              >
                Load more indexes
              </Button>
            )}
          </section>
          {selected && (
            <>
              {!filtered.some((index) => index.id === selected.id) && (
                <p className="section-caption">
                  Selected index is hidden by search. Choose another comparison
                  row to change selection.
                </p>
              )}
              <SelectedIndex
                key={selected.id}
                index={selected}
                selectedBlockId={selectedBlockId}
                onPick={onPick}
              />
            </>
          )}
        </>
      )}
    </div>
  );
});
