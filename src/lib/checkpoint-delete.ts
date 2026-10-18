import { BinaryReader } from "./binary-reader";

export interface CheckpointDeleteRange {
  /** Row-group-relative position, not a table row ID or a physical byte offset. */
  start: number;
  count: number;
}
export interface CheckpointDeleteVector {
  vectorIndex: number;
  rowStart: number;
  rowCount: number;
  deletedRows: number;
  encoding: string;
  deletedRanges: CheckpointDeleteRange[];
}
export interface CheckpointDeletes {
  deletedRows: number;
  vectors: CheckpointDeleteVector[];
}

const MAX_ROW_GROUP_SIZE = 1 << 30;
const MAX_VECTORS = 65_536;
const MAX_WORK = 16 * 1024 * 1024;
const MAX_RANGES = 262_144;

function corrupt(message: string): never {
  throw new Error(`Corrupt checkpoint deletes: ${message}.`);
}
function fixedU32(reader: BinaryReader): number {
  const bytes = reader.raw(4);
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
}
function fixedNumber(reader: BinaryReader): number {
  const value = reader.fixedU64();
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    corrupt("integer exceeds JavaScript safe integer precision");
  return Number(value);
}

/**
 * Decode one native ReadStream rooted at row.deletes[0]. Other delete pointers
 * describe allocations of this same stream, not additional streams. The caller
 * must return exact zero for an empty pointer list (there is no payload then).
 *
 * Set/valid mask bits are DELETED rows. Full-vector validation precedes clipping
 * to the final vector's actual rows. Stop at chunk_count, leaving slot padding
 * and retained/reused stream tails unread. Work and range budgets bound hostile
 * inputs without allocating a per-row object or a vector-sized boolean array.
 */
export function decodeCheckpointDeletes(
  reader: BinaryReader,
  vectorSize: number,
  rowGroupCount: number,
): CheckpointDeletes {
  if (
    !Number.isSafeInteger(vectorSize) ||
    vectorSize <= 0 ||
    vectorSize > MAX_ROW_GROUP_SIZE
  )
    corrupt("invalid vector size");
  if (
    !Number.isSafeInteger(rowGroupCount) ||
    rowGroupCount < 0 ||
    rowGroupCount > MAX_ROW_GROUP_SIZE
  )
    corrupt("invalid row-group count");
  const chunkCount = fixedNumber(reader);
  if (chunkCount > Math.ceil(rowGroupCount / vectorSize))
    corrupt("chunk count exceeds row-group vector count");
  if (chunkCount > MAX_VECTORS)
    throw new Error("Checkpoint deletion vector work limit exceeded.");
  if (chunkCount > Math.floor(reader.remaining / 9))
    throw new Error("Truncated checkpoint deletes: chunk records are missing.");

  let work = 0,
    rangeCount = 0,
    deletedRows = 0,
    previousVector = -1;
  const vectors: CheckpointDeleteVector[] = [];
  const charge = (amount: number) => {
    work += amount;
    if (work > MAX_WORK)
      throw new Error("Checkpoint deletion decode work limit exceeded.");
  };
  for (let chunk = 0; chunk < chunkCount; chunk++) {
    charge(1);
    const vectorIndex = fixedNumber(reader);
    if (vectorIndex <= previousVector)
      corrupt("duplicate or unsorted vector index");
    previousVector = vectorIndex;
    const rowStart = vectorIndex * vectorSize;
    if (
      !Number.isSafeInteger(rowStart) ||
      rowStart >= MAX_ROW_GROUP_SIZE ||
      rowStart >= rowGroupCount
    )
      corrupt("vector index exceeds row-group bounds");
    const rowCount = Math.min(vectorSize, rowGroupCount - rowStart);
    const type = reader.u8();
    const deletedRanges: CheckpointDeleteRange[] = [];
    let vectorDeleted = 0;
    const add = (start: number, end: number) => {
      // Positions beyond the last partial vector are valid serialized mask data.
      end = Math.min(end, rowCount);
      if (start >= end) return;
      vectorDeleted += end - start;
      const absolute = rowStart + start;
      const previous = deletedRanges[deletedRanges.length - 1];
      if (previous && previous.start + previous.count === absolute) {
        previous.count += end - start;
      } else {
        if (++rangeCount > MAX_RANGES)
          throw new Error("Checkpoint deleted range work limit exceeded.");
        deletedRanges.push({ start: absolute, count: end - start });
      }
    };
    let encoding: string;
    if (type === 2) {
      encoding = "empty";
    } else if (type === 0 || type === 1) {
      if (fixedNumber(reader) !== rowStart)
        corrupt("stored vector start does not match vector index");
      if (type === 0) {
        encoding = "constant";
        add(0, rowCount);
      } else {
        const format = reader.u8();
        if (format === 0) {
          encoding = "bitmask";
          charge(vectorSize);
          const bytes = reader.raw(Math.ceil(vectorSize / 64) * 8);
          let fullDeleted = 0,
            runStart = -1;
          for (let position = 0; position < vectorSize; position++) {
            const deleted =
              (bytes[position >>> 3] & (1 << (position & 7))) !== 0;
            if (deleted) {
              fullDeleted++;
              if (runStart < 0) runStart = position;
            } else if (runStart >= 0) {
              add(runStart, position);
              runStart = -1;
            }
          }
          if (runStart >= 0) add(runStart, vectorSize);
          if (fullDeleted === 0 || fullDeleted === vectorSize)
            corrupt(
              "VECTOR_INFO mask must contain both deleted and alive rows",
            );
        } else if (format === 1 || format === 2) {
          encoding = format === 1 ? "deleted-positions" : "alive-positions";
          const entries = fixedU32(reader);
          if (entries > vectorSize)
            corrupt("sparse entry count exceeds vector size");
          charge(entries);
          const width = vectorSize < 65535 ? 2 : 4;
          if (entries > Math.floor(reader.remaining / width))
            throw new Error(
              "Truncated checkpoint deletes: sparse indexes are missing.",
            );
          // With unique indexes these encodings are mixed iff 0 < entries < size.
          if (entries === 0 || entries === vectorSize)
            corrupt(
              "VECTOR_INFO mask must contain both deleted and alive rows",
            );
          let previous = -1;
          for (let entry = 0; entry < entries; entry++) {
            const index = width === 2 ? reader.u16() : fixedU32(reader);
            if (index >= vectorSize)
              corrupt("sparse index exceeds vector size");
            if (index <= previous)
              corrupt("duplicate or unsorted sparse index");
            if (format === 1) add(index, index + 1);
            else add(previous + 1, index);
            previous = index;
          }
          if (format === 2) add(previous + 1, vectorSize);
        } else {
          corrupt(`unknown validity encoding ${format}`);
        }
      }
    } else {
      corrupt(`unknown chunk type ${type}`);
    }
    deletedRows += vectorDeleted;
    vectors.push({
      vectorIndex,
      rowStart,
      rowCount,
      deletedRows: vectorDeleted,
      encoding,
      deletedRanges,
    });
  }
  return { deletedRows, vectors };
}
