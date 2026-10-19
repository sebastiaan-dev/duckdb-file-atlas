import { ArrowDownRight, ArrowRight } from "lucide-react";
import { formatBytes, formatNumber } from "@/lib/format";
import { rowGroupColor, type RowGroupSummary } from "@/lib/row-groups";
import type { FileBlock } from "@/lib/types";

const BLOCK_LIMIT = 48;
const offset = (value: number) =>
  `0x${Math.max(0, value).toString(16).padStart(8, "0")}`;

function Pair({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="detail-pair">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

/** Where one row group's column data lives on disk. */
export function RowGroupDetails({
  summary,
  blocksById,
  onBlockClick,
  onShowOnMap,
}: {
  summary: RowGroupSummary;
  blocksById: Map<number, FileBlock>;
  onBlockClick: (id: number) => void;
  /** Present when the physical map is not the current view. */
  onShowOnMap?: () => void;
}) {
  const { rows, blockIds } = summary;
  const span =
    summary.startOffset != null && summary.endOffset != null
      ? summary.endOffset - summary.startOffset
      : null;
  return (
    <div className="detail-content">
      <div className="selected-kind-row">
        <span
          className="role-dot"
          style={{ backgroundColor: rowGroupColor(summary) }}
        />
        <span>Row group</span>
      </div>
      <div className="detail-card">
        {rows && (
          <Pair label="Rows">
            {formatNumber(rows.liveRows)}
            {rows.deletedRows > 0 && (
              <small className="detail-pair-note">
                {" "}
                of {formatNumber(rows.physicalRows)} ·{" "}
                {formatNumber(rows.deletedRows)} deleted
              </small>
            )}
          </Pair>
        )}
        <Pair label="Columns">
          {formatNumber(summary.columns)}
          <small className="detail-pair-note">
            {" "}
            {formatNumber(summary.segments)} segments
          </small>
        </Pair>
        <Pair label="Column data">
          {summary.unknownSizeSegments ===
          summary.segments - summary.constantSegments
            ? "Unknown"
            : formatBytes(summary.dataBytes)}
          {summary.unknownSizeSegments > 0 &&
            summary.unknownSizeSegments <
              summary.segments - summary.constantSegments && (
              <small className="detail-pair-note">
                {" "}
                +{formatNumber(summary.unknownSizeSegments)} unknown
              </small>
            )}
        </Pair>
        <Pair label="Blocks">
          {formatNumber(blockIds.length)}
          {summary.blockIds.length > 0 && (
            <small className="detail-pair-note">
              {" "}
              {formatBytes(summary.blockBytes)}
            </small>
          )}
        </Pair>
        {span != null && (
          <Pair label="Byte span">
            <span
              title={`${offset(summary.startOffset!)}–${offset(summary.endOffset!)}`}
            >
              {formatBytes(span)}
            </span>
          </Pair>
        )}
        <Pair label="Contiguous runs">
          {blockIds.length ? formatNumber(summary.runs) : "—"}
          {summary.runs === 1 && (
            <small className="detail-pair-note"> contiguous</small>
          )}
        </Pair>
        {summary.sharedBlocks > 0 && (
          <Pair label="Shared blocks">
            {formatNumber(summary.sharedBlocks)}
            <small className="detail-pair-note"> with other row groups</small>
          </Pair>
        )}
        {summary.overflowBlocks > 0 && (
          <Pair label="String overflow">
            {formatNumber(summary.overflowBlocks)} blocks
          </Pair>
        )}
        {summary.constantSegments > 0 && (
          <Pair label="Constant segments">
            {formatNumber(summary.constantSegments)}
            <small className="detail-pair-note"> no block</small>
          </Pair>
        )}
      </div>
      {onShowOnMap && blockIds.length > 0 && (
        <button className="raw-header-link" type="button" onClick={onShowOnMap}>
          Show on the physical map
          <ArrowRight size={13} />
        </button>
      )}
      {blockIds.length > 0 && (
        <div className="detail-section">
          <div className="detail-section-heading">
            <span>Blocks in file order</span>
            <span>{formatNumber(blockIds.length)}</span>
          </div>
          <div className="link-list">
            {blockIds.slice(0, BLOCK_LIMIT).map((id) => (
              <button
                type="button"
                key={id}
                className="link-chip"
                onClick={() => onBlockClick(id)}
              >
                <ArrowDownRight size={13} />
                Block {id}
                <span>{blocksById.get(id)?.role}</span>
              </button>
            ))}
          </div>
          {blockIds.length > BLOCK_LIMIT && (
            <p className="section-caption range-coverage">
              +{formatNumber(blockIds.length - BLOCK_LIMIT)} more blocks are
              highlighted on the map.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
