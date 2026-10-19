import type { CheckpointDeleteVector } from "./checkpoint-delete";

export type StorageRole =
  "header" | "metadata" | "data" | "index" | "free" | "unknown";
export type ColorMode =
  | "role"
  | "table"
  | "column"
  | "compression"
  | "rowgroup"
  | "utilization"
  | "fragmentation";
export interface ByteRange {
  /** offset is an absolute file byte offset. */
  id: string;
  label: string;
  offset: number;
  size: number;
  kind:
    | "checksum"
    | "header"
    | "metadata"
    | "segment"
    | "index"
    | "validity"
    | "dictionary"
    | "unused"
    | "unknown";
  segmentId?: string;
  indexId?: string;
  /** ART allocator node type for index ranges, e.g. `NODE16`. */
  nodeType?: string;
  /** True for an allocator's free-slot bitmask rather than node slots. */
  indexMask?: boolean;
}
export interface FileBlock {
  id: number;
  offset: number;
  size: number;
  role: StorageRole;
  label: string;
  usedBytes: number | null;
  ranges: ByteRange[];
  segmentIds: string[];
  indexIds?: string[];
  indexOwners?: { id: string; table: string; name: string }[];
  links: number[];
  checksum?: string;
}
export interface Segment {
  id: string;
  table: string;
  column: string;
  columnType: string;
  rowGroup: number;
  /** offset is block-relative, including the physical checksum/header bytes. */
  blockId: number;
  offset: number;
  byteSize: number | null;
  rowStart: number;
  rowCount: number;
  storedByteSize?: number;
  auxiliaryBlocks?: number[];
  rowGroupRowStart?: number;
  rowGroupRowCount?: number;
  compression: string;
  min?: string;
  max?: string;
  nullCount?: number;
  stats?: string;
}
export interface CheckpointHeader {
  slot: 1 | 2;
  iteration: string;
  metaBlock: string;
  freeList: string;
  blockCount: number;
  blockSize: number;
  vectorSize: number;
  storageVersion: number;
  valid: boolean;
}
export interface MetadataSlotPointer {
  blockId: number;
  slot: number;
}
export interface FreeListState {
  checkpoint: 1 | 2;
  complete: boolean;
  root: MetadataSlotPointer | null;
  chain: (MetadataSlotPointer & { next: MetadataSlotPointer | null })[];
  blockIds: number[];
  implicitBlockIds: number[];
  metadata: { blockId: number; freeSlots: number[] }[];
  multiUseBlocks: { blockId: number; references: number }[];
  /**
   * Blocks the active header counts but DuckDB already truncated from the end
   * of the file after the checkpoint. They hold no data and have no bytes.
   */
  trimmedBlocks?: number;
}
/** Scalar integer Values are decimal strings to preserve uint64 precision. */
export type IndexOption = null | boolean | number | string | IndexOption[];
export interface IndexRoot {
  packed: string;
  nodeType: string;
  typeId: number;
  gate: boolean;
  bufferId?: number;
  slot?: number;
  inlinedRowId?: string;
}
export interface IndexSlotRun {
  /** Slot coordinates, not individual slot objects. */
  start: number;
  count: number;
  occupied: boolean;
}
export interface IndexBuffer {
  bufferId: number;
  blockId: number;
  /** Payload-relative offset; absoluteOffset includes the checksum/header. */
  offset: number;
  absoluteOffset: number;
  allocationSize: number;
  segmentCount: number;
  storedSlots: number;
  occupiedBytes: number;
  freeBytes: number;
  hasFreeSpace: boolean;
  runs: IndexSlotRun[];
}
export interface IndexAllocator {
  ordinal: number;
  nodeType: string;
  segmentSize: number;
  /** Logical slot capacity per buffer, including slots outside the persisted envelope. */
  capacity: number;
  maskBytes: number;
  occupiedSlots: number;
  occupiedBytes: number;
  freeBytes: number;
  maskOverheadBytes: number;
  allocationBytes: number;
  buffers: IndexBuffer[];
}
export interface IndexInspection {
  id: string;
  table: string;
  name: string;
  root: string;
  rootPointer: IndexRoot;
  legacyRootPointer?: { blockId: number; offset: number };
  options: Record<string, IndexOption>;
  complete: boolean;
  reason?: string;
  /** Known referenced blocks, also available for unsupported layouts. */
  blockIds: number[];
  blockChecksums?: Record<number, string>;
  occupiedBytes: number | null;
  freeBytes: number | null;
  maskOverheadBytes: number | null;
  allocationBytes: number | null;
  allocators: IndexAllocator[];
}
export interface NativeRowGroup {
  table: string;
  rowGroup: number;
  rowStart: number;
  physicalRows: number;
  deletedRows: number;
  liveRows: number;
  deleteVectors: CheckpointDeleteVector[];
}
export interface FileInspection {
  indexes?: IndexInspection[];
  freeList?: FreeListState;
  name: string;
  fileSize: number;
  storageVersion: number;
  headerFingerprint?: string;
  native?: {
    tables: number;
    rowGroups: number;
    complete: boolean;
    rowGroupsInfo?: NativeRowGroup[];
    catalog?: {
      name: string;
      rows: number;
      deletedRows?: number;
      liveRows?: number;
      columns: { name: string; type: string }[];
      rowGroups: number;
    }[];
  };
  blockSize: number;
  blockHeaderSize: number;
  vectorSize: number;
  libraryVersion: string;
  activeHeader: 1 | 2;
  headers: CheckpointHeader[];
  blocks: FileBlock[];
  segments: Segment[];
  warnings: string[];
  capabilities: { semantic: boolean; exactSizes: boolean; checksums: boolean };
}
export interface SemanticManifest {
  format: "duckdb-file-layout/v1";
  storageVersion: number;
  fileSize: number;
  headerFingerprint: string;
  segments: Segment[];
  fileName?: string;
}
