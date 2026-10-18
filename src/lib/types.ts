export type StorageRole =
  | "header"
  | "metadata"
  | "data"
  | "index"
  | "free"
  | "unknown";
export type ColorMode =
  | "role"
  | "table"
  | "column"
  | "compression"
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
    | "validity"
    | "dictionary"
    | "unused"
    | "unknown";
  segmentId?: string;
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
}
export interface FileInspection {
  freeList?: FreeListState;
  name: string;
  fileSize: number;
  source: "demo" | "file";
  storageVersion: number;
  headerFingerprint?: string;
  native?: {
    tables: number;
    rowGroups: number;
    complete: boolean;
    catalog?: {
      name: string;
      rows: number;
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
