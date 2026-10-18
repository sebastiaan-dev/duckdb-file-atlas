import { memo, useEffect, useMemo, useState, type CSSProperties } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Button } from "@/components/ui/button";
import { IndexBufferMap } from "@/components/index-buffer-map";
import { DetailTip, InfoTip, type DetailRow } from "@/components/index-tooltip";
import {
  allocatorValue,
  formatIndexBytes as bytes,
  formatPercent,
  INDEX_ROW_LIMIT,
  indexMeasurements,
  indexUtilization,
  isMeasuredIndex,
  nodeTypeColor,
  rankAllocators,
  RAW_LINK_LIMIT,
  sortedIndexBuffers,
  type AllocatorMetric,
} from "@/lib/index-layout";
import type {
  FileInspection,
  IndexAllocator,
  IndexInspection,
} from "@/lib/types";

const share = (value: number, total: number) =>
  `${total ? (value / total) * 100 : 0}%`;

function indexRows(index: IndexInspection): DetailRow[] {
  return [
    ["Persisted", bytes(index.allocationBytes)],
    ["Occupied", bytes(index.occupiedBytes)],
    ["Free holes", bytes(index.freeBytes)],
    ["Mask", bytes(index.maskOverheadBytes)],
    ["Utilization", formatPercent(indexUtilization(index))],
  ];
}

/** Occupied bytes per node type, then free holes and mask, within one envelope. */
function EnvelopeStack({
  index,
  width,
}: {
  index: IndexInspection;
  width?: string;
}) {
  const total = index.allocationBytes!;
  return (
    <span className="index-stack" style={{ width }}>
      {index.allocators
        .filter((allocator) => allocator.occupiedBytes > 0)
        .map((allocator) => (
          <i
            key={allocator.ordinal}
            data-node-type={allocator.nodeType}
            style={{
              width: share(allocator.occupiedBytes, total),
              background: nodeTypeColor(allocator),
            }}
          />
        ))}
      <i
        className="index-free"
        style={{ width: share(index.freeBytes!, total) }}
      />
      <i
        className="index-mask"
        style={{ width: share(index.maskOverheadBytes!, total) }}
      />
    </span>
  );
}

function UtilizationMeter({ ratio }: { ratio: number | null }) {
  return (
    <span className="index-meter" aria-hidden="true">
      <i style={{ width: ratio == null ? 0 : `${ratio * 100}%` }} />
    </span>
  );
}

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
  const utilization = indexUtilization(index);
  return (
    <section className="index-selection" aria-label="Selected index">
      <div className="index-selected-heading">
        <div>
          <h3>{index.name}</h3>
          <span>{index.table}</span>
        </div>
        {measured ? (
          <DetailTip title={index.name} rows={indexRows(index)}>
            <div
              className="index-selected-size"
              tabIndex={0}
              aria-label={`${bytes(index.allocationBytes)} persisted, ${formatPercent(utilization)} utilized`}
            >
              <strong>{bytes(index.allocationBytes)}</strong>
              {utilization != null && (
                <span>
                  <UtilizationMeter ratio={utilization} />
                  {formatPercent(utilization)} used
                </span>
              )}
            </div>
          </DetailTip>
        ) : (
          <strong className="index-selected-size">Occupancy unknown</strong>
        )}
      </div>
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
              <div className="index-heading-title">
                <h4>Allocators</h4>
                <InfoTip label="About allocators">
                  <p>
                    One row per ART node type.{" "}
                    {metric === "bytes"
                      ? "Bars show occupied slot bytes (slot size × occupied slots)."
                      : "Bars show occupied slots, not logical capacity."}{" "}
                    Ranked largest first; empty classes are hidden.
                  </p>
                  <p>
                    Click a row to filter buffers; click it again to clear.
                    Capacity outside the persisted envelope is not counted as
                    bytes.
                  </p>
                </InfoTip>
              </div>
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
            <div
              className="index-allocator-bars"
              data-filtered={allocator != null || undefined}
            >
              {ranked.map((row) => (
                <AllocatorRow
                  key={row.ordinal}
                  row={row}
                  metric={metric}
                  max={max}
                  pressed={allocator === row.ordinal}
                  onToggle={() =>
                    setAllocator(allocator === row.ordinal ? null : row.ordinal)
                  }
                />
              ))}
            </div>
            {!ranked.length && (
              <p className="section-caption">
                Measured zero persisted allocator storage. This index is empty
                or has an inlined root.
              </p>
            )}
          </section>
          <IndexBufferMap
            key={allocator ?? "all"}
            tiles={tiles}
            totalBuffers={buffers.length}
            filter={selectedClass}
            onClearFilter={() => setAllocator(null)}
            selectedBlockId={selectedBlockId}
            onPick={onPick}
          />
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

function AllocatorRow({
  row,
  metric,
  max,
  pressed,
  onToggle,
}: {
  row: IndexAllocator;
  metric: AllocatorMetric;
  max: number;
  pressed: boolean;
  onToggle: () => void;
}) {
  const color = nodeTypeColor(row);
  return (
    <DetailTip
      title={row.nodeType}
      swatch={color}
      rows={[
        ["Slot size", bytes(row.segmentSize)],
        ["Buffers", row.buffers.length.toLocaleString()],
        ["Occupied slots", row.occupiedSlots.toLocaleString()],
        ["Occupied", bytes(row.occupiedBytes)],
        ["Free holes", bytes(row.freeBytes)],
      ]}
      hint={pressed ? "Click to show all buffers" : "Click to filter buffers"}
    >
      <button
        type="button"
        className="index-allocator-row"
        aria-pressed={pressed}
        style={{ "--type-color": color } as CSSProperties}
        onClick={onToggle}
      >
        <span className="index-allocator-label">
          <i className="index-swatch" />
          {row.nodeType}
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
    </DetailTip>
  );
}

/** Node types present across the whole inspection, in allocator order. */
function presentNodeTypes(indexes: IndexInspection[]): IndexAllocator[] {
  const seen = new Map<string, IndexAllocator>();
  for (const index of indexes)
    if (isMeasuredIndex(index))
      for (const allocator of index.allocators)
        if (allocator.occupiedBytes > 0 && !seen.has(allocator.nodeType))
          seen.set(allocator.nodeType, allocator);
  return [...seen.values()].sort((a, b) => a.ordinal - b.ordinal);
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
  const nodeTypes = useMemo(() => presentNodeTypes(indexes ?? []), [indexes]);
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
  if (!indexes?.length)
    return (
      <div className="index-view">
        <div className="logical-empty-state">
          <h3>No recorded index details</h3>
          <p>
            Open a database with checkpoint indexes to inspect named ownership,
            roots, and persisted allocator occupancy. Example and legacy files
            may not include index details.
          </p>
        </div>
      </div>
    );
  const complete = measuredCount === indexes.length;
  const utilization =
    measuredCount && totals.allocationBytes
      ? totals.occupiedBytes / totals.allocationBytes
      : null;
  const coverage = `${measuredCount.toLocaleString()} of ${indexes.length.toLocaleString()} indexes completely measured`;
  const unmeasured = filtered.some((index) => !isMeasuredIndex(index));
  return (
    <Tooltip.Provider delayDuration={250}>
      <div className="index-view">
        <div className="index-metrics">
          <div>
            <span>Persisted</span>
            <strong>
              {bytes(measuredCount ? totals.allocationBytes : null)}
            </strong>
          </div>
          <div>
            <span className="index-heading-title">
              Slot utilization
              <InfoTip label="About index storage totals">
                <dl className="index-tip-totals">
                  <div>
                    <dt>Occupied slots</dt>
                    <dd>{bytes(measuredCount ? totals.occupiedBytes : null)}</dd>
                  </div>
                  <div>
                    <dt>Free holes</dt>
                    <dd>{bytes(measuredCount ? totals.freeBytes : null)}</dd>
                  </div>
                  <div>
                    <dt>Mask overhead</dt>
                    <dd>
                      {bytes(measuredCount ? totals.maskOverheadBytes : null)}
                    </dd>
                  </div>
                </dl>
                <p>
                  Utilization is occupied slot bytes / persisted allocator
                  envelope. Free holes are unoccupied slots within persisted
                  envelopes, not unallocated block tails, physical gaps or whole
                  reusable free blocks.
                </p>
                {complete && <p>{coverage}.</p>}
              </InfoTip>
            </span>
            <strong>
              {formatPercent(utilization)}
              {utilization != null && <UtilizationMeter ratio={utilization} />}
            </strong>
          </div>
        </div>
        {!complete && (
          <p className="index-coverage">
            {coverage}. Totals include only measured indexes.
          </p>
        )}
        <section
          className="index-comparison"
          aria-label="Index comparison"
          data-axis-max={axisMax}
        >
          <div className="index-graph-heading">
            <div className="index-heading-title">
              <h3>Storage by index</h3>
              <InfoTip label="About index comparison">
                <p>
                  Each bar is an index's persisted allocator envelope: occupied
                  slots colored by node type, then free holes and mask overhead.
                  All bars share one byte scale across the full file, so search
                  never rescales them.
                </p>
              </InfoTip>
            </div>
            <span>
              {filtered.length === indexes.length
                ? `${indexes.length.toLocaleString()} indexes`
                : `${filtered.length.toLocaleString()} of ${indexes.length.toLocaleString()} indexes`}
            </span>
          </div>
          <div className="index-comparison-legend">
            {nodeTypes.map((allocator) => (
              <span key={allocator.nodeType}>
                <i style={{ background: nodeTypeColor(allocator) }} />
                {allocator.nodeType}
              </span>
            ))}
            <span>
              <i className="index-free" />
              Free holes
            </span>
            <span>
              <i className="index-mask" />
              Mask
            </span>
            {unmeasured && (
              <span>
                <i className="index-unknown" />
                Unknown
              </span>
            )}
          </div>
          {filtered.slice(0, visible).map((index) => {
            const measured = isMeasuredIndex(index);
            return (
              <DetailTip
                key={index.id}
                title={index.name}
                subtitle={index.table}
                rows={
                  measured
                    ? indexRows(index)
                    : [["Occupancy", "Unknown"], ["Extent", "Unknown"]]
                }
              >
                <button
                  type="button"
                  className="index-comparison-row"
                  aria-pressed={selected?.id === index.id}
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
                      <EnvelopeStack
                        index={index}
                        width={share(index.allocationBytes!, axisMax)}
                      />
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
              </DetailTip>
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
                Selected index is hidden by search. Choose another row to change
                selection.
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
      </div>
    </Tooltip.Provider>
  );
});
