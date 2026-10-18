import type { IndexStorage } from "./checkpoint-catalog";
import type {
  ByteRange,
  FileBlock,
  FileInspection,
  IndexAllocator,
  IndexBuffer,
  IndexInspection,
  IndexRoot,
} from "./types";

const TYPES = [
  "EMPTY",
  "PREFIX",
  "LEAF",
  "NODE4",
  "NODE16",
  "NODE48",
  "NODE256",
  "LEAF_INLINED",
  "NODE7_LEAF",
  "NODE15_LEAF",
  "NODE256_LEAF",
];
const ALLOCATOR_TYPES = [1, 2, 3, 4, 5, 6, 8, 9, 10];
const MAX_RUNS = 100_000;
const MAX_SLOTS = 50_000_000;
function corrupt(reason: string): never {
  throw new Error(`Corrupt index storage: ${reason}.`);
}
function integer(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) corrupt(`invalid ${label}`);
}

/** Literal FixedSizeAllocator constructor geometry (including its final mask word). */
export function indexAllocatorGeometry(
  payloadSize: number,
  segmentSize: number,
) {
  integer(payloadSize, "payload size");
  integer(segmentSize, "segment size");
  if (payloadSize % 8) corrupt("unaligned payload size");
  if (!segmentSize || segmentSize % 8 || segmentSize > payloadSize - 8)
    corrupt("invalid or unaligned segment size");
  let bytes = 0,
    words = 0,
    capacity = 0;
  while (bytes < payloadSize) {
    if (!words || (words * 64) % capacity === 0) {
      words++;
      bytes += 8;
    }
    const add = Math.min(Math.floor((payloadSize - bytes) / segmentSize), 64);
    if (!add) break;
    capacity += add;
    bytes += add * segmentSize;
  }
  return { capacity, maskBytes: words * 8 };
}

/** Packed pointers only; this does not interpret raw ART node structs. */
export function interpretIndexRoot(root: bigint): IndexRoot {
  if (root < 0n || root > 0xffffffffffffffffn) corrupt("root outside uint64");
  const metadata = Number(root >> 56n),
    typeId = metadata & 0x7f;
  const result: IndexRoot = {
    packed: root.toString(),
    typeId,
    nodeType: TYPES[typeId] ?? "UNKNOWN",
    gate: !!(metadata & 0x80),
  };
  if (!metadata) result.nodeType = "EMPTY";
  else if (typeId === 7)
    result.inlinedRowId = (root & 0x00ffffffffffffffn).toString();
  else {
    result.bufferId = Number(root & 0xffffffffn);
    result.slot = Number((root >> 32n) & 0xffffffn);
  }
  return result;
}

function layoutReason(index: IndexStorage): string | undefined {
  if (index.legacyRootPointer)
    return "Legacy metadata root: allocator ownership is unavailable";
  const options = Object.fromEntries(
    Object.entries(index.options).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  if (
    Object.keys(options).some(
      (key) => key !== "storage_version" && key !== "v1_0_0_storage",
    )
  )
    return "Unrecognized index storage options";
  if (options.v1_0_0_storage !== false)
    return "Legacy or unrecognized ART allocator layout";
  if (!["68", "69"].includes(String(options.storage_version)))
    return "Missing or unsupported per-index storage_version";
  if (index.allocatorInfos.length !== 9)
    return "Unrecognized ART allocator count";
  const sizes = index.allocatorInfos.map((a) => a.segmentSize);
  if (
    sizes[0] <= 9 ||
    sizes[0] > 255 ||
    sizes[0] % 8 ||
    sizes
      .slice(1, 8)
      .some((size, i) => size !== [48, 40, 152, 648, 2056, 8, 16][i]) ||
    ![40, 264].includes(sizes[8])
  )
    return "Unrecognized ART fixed-size node layout";
}

interface Envelope {
  index: IndexInspection;
  allocator?: IndexAllocator;
  buffer?: IndexBuffer;
  start: number;
  end: number;
}

/** Reads each physical block once, retaining at most one block payload at a time. */
export async function inspectIndexes(
  file: File,
  physical: FileInspection,
  tableIndexInputs: { table: string; index: IndexStorage }[],
  checksum: (bytes: Uint8Array) => bigint,
): Promise<IndexInspection[]> {
  const blocks = new Map(physical.blocks.map((block) => [block.id, block]));
  const active = physical.headers.find((h) => h.slot === physical.activeHeader);
  if (!active || physical.blockHeaderSize !== 8)
    throw new Error("Unsupported index physical block layout.");
  const payloadSize = physical.blockSize - physical.blockHeaderSize;
  const envelopes = new Map<number, Envelope[]>();
  let bufferCount = 0;
  const inspections = tableIndexInputs.map(
    ({ table, index }, ordinal): IndexInspection => {
      const rootPointer = interpretIndexRoot(index.root);
      const reason = layoutReason(index);
      const inspection: IndexInspection = {
        id: `index-${ordinal}`,
        table,
        name: index.name,
        root: index.root.toString(),
        rootPointer,
        ...(index.legacyRootPointer
          ? { legacyRootPointer: { ...index.legacyRootPointer } }
          : {}),
        options: { ...index.options },
        complete: !reason,
        ...(reason ? { reason } : {}),
        blockIds: [],
        occupiedBytes: reason ? null : 0,
        freeBytes: reason ? null : 0,
        maskOverheadBytes: reason ? null : 0,
        allocationBytes: reason ? null : 0,
        allocators: [],
      };
      const blockIds = new Set<number>();
      index.allocatorInfos.forEach((info, allocatorOrdinal) => {
        const length = info.bufferIds.length;
        if (
          [info.blockPointers, info.segmentCounts, info.allocationSizes].some(
            (a) => a.length !== length,
          )
        )
          corrupt("parallel allocator array lengths differ");
        if ((bufferCount += length) > 100_000)
          throw new Error("Index buffer browser work limit exceeded.");
        const ids = new Set<number>(),
          freeIds = new Set<number>();
        info.bufferIds.forEach((id) => {
          integer(id, "buffer ID");
          if (id > 0xffffffff || ids.has(id))
            corrupt("duplicate or oversized buffer ID");
          ids.add(id);
        });
        info.freeBufferIds.forEach((id) => {
          integer(id, "free buffer ID");
          if (!ids.has(id) || freeIds.has(id))
            corrupt("invalid free-space buffer IDs");
          freeIds.add(id);
        });
        integer(info.segmentSize, "segment size");
        if (!info.segmentSize || info.segmentSize > payloadSize - 8)
          corrupt("invalid segment size");
        const geometry = inspection.complete
          ? indexAllocatorGeometry(payloadSize, info.segmentSize)
          : undefined;
        const allocator: IndexAllocator | undefined = geometry
          ? {
              ordinal: allocatorOrdinal,
              nodeType: TYPES[ALLOCATOR_TYPES[allocatorOrdinal]],
              segmentSize: info.segmentSize,
              ...geometry,
              occupiedSlots: 0,
              occupiedBytes: 0,
              freeBytes: 0,
              maskOverheadBytes: 0,
              allocationBytes: 0,
              buffers: [],
            }
          : undefined;
        if (allocator) inspection.allocators.push(allocator);
        info.blockPointers.forEach((pointer, i) => {
          integer(pointer.blockId, "physical block ID");
          integer(pointer.offset, "buffer offset");
          const block = blocks.get(pointer.blockId),
            size = info.allocationSizes[i],
            count = info.segmentCounts[i];
          integer(size, "allocation size");
          integer(count, "segment count");
          if (
            !block ||
            pointer.blockId >= active.blockCount ||
            block.role === "free" ||
            block.role === "metadata" ||
            block.role === "header" ||
            block.size !== physical.blockSize
          )
            corrupt("buffer references unavailable block");
          if (!size || pointer.offset + size > payloadSize)
            corrupt("buffer envelope exceeds payload");
          const start = block.offset + 8 + pointer.offset,
            end = start + size;
          if (
            block.segmentIds.length ||
            block.ranges.some(
              (r) =>
                ["segment", "validity", "dictionary", "metadata"].includes(
                  r.kind,
                ) &&
                r.offset < end &&
                r.offset + r.size > start,
            )
          )
            corrupt("index overlaps column or metadata allocation");
          blockIds.add(block.id);
          let buffer: IndexBuffer | undefined;
          if (allocator) {
            const storedSlots = (size - allocator.maskBytes) / info.segmentSize;
            if (
              !Number.isInteger(storedSlots) ||
              storedSlots < 0 ||
              storedSlots > allocator.capacity ||
              !count ||
              count > storedSlots
            )
              corrupt("invalid stored slot span or count");
            if (freeIds.has(info.bufferIds[i]) !== count < allocator.capacity)
              corrupt("free-space list disagrees with capacity");
            buffer = {
              bufferId: info.bufferIds[i],
              blockId: block.id,
              offset: pointer.offset,
              absoluteOffset: start,
              allocationSize: size,
              segmentCount: count,
              storedSlots,
              occupiedBytes: count * info.segmentSize,
              freeBytes: (storedSlots - count) * info.segmentSize,
              hasFreeSpace: freeIds.has(info.bufferIds[i]),
              runs: [],
            };
            allocator.buffers.push(buffer);
            allocator.occupiedSlots += count;
            allocator.occupiedBytes += buffer.occupiedBytes;
            allocator.freeBytes += buffer.freeBytes;
            allocator.maskOverheadBytes += allocator.maskBytes;
            allocator.allocationBytes += size;
          }
          let list = envelopes.get(block.id);
          if (!list) envelopes.set(block.id, (list = []));
          list.push({ index: inspection, allocator, buffer, start, end });
        });
      });
      inspection.blockIds = [...blockIds].sort((a, b) => a - b);
      if (inspection.complete) {
        for (const allocator of inspection.allocators) {
          inspection.occupiedBytes! += allocator.occupiedBytes;
          inspection.freeBytes! += allocator.freeBytes;
          inspection.maskOverheadBytes! += allocator.maskOverheadBytes;
          inspection.allocationBytes! += allocator.allocationBytes;
        }
      }
      return inspection;
    },
  );
  // Check all owners, including unsupported ones, before reading any masks.
  for (const list of envelopes.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++)
      if (list[i].start < list[i - 1].end)
        corrupt("overlapping buffer envelopes");
  }
  let slots = 0,
    runs = 0;
  for (const [blockId, list] of envelopes) {
    const readable = list.filter(({ index, allocator, buffer }) => {
      if (!allocator || !buffer || !index.complete) return false;
      if (slots + allocator.capacity > MAX_SLOTS) {
        index.complete = false;
        index.reason = "Index mask browser work limit exceeded";
        return false;
      }
      slots += allocator.capacity;
      return true;
    });
    if (!readable.length) continue;
    const block = blocks.get(blockId)!;
    const bytes = new Uint8Array(
      await file.slice(block.offset, block.offset + block.size).arrayBuffer(),
    );
    if (bytes.length !== physical.blockSize)
      corrupt("truncated physical block");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const storedChecksum = view.getBigUint64(0, true);
    if (storedChecksum !== checksum(bytes.subarray(8)))
      corrupt(`block ${blockId} checksum mismatch`);
    for (const { index } of readable)
      (index.blockChecksums ??= {})[blockId] =
        `0x${storedChecksum.toString(16).padStart(16, "0")}`;
    for (const { index, allocator, buffer } of readable) {
      if (!allocator || !buffer || !index.complete) continue;
      let count = 0,
        highest = -1;
      for (let slot = 0; slot < allocator.capacity; slot++) {
        const occupied = !(
          bytes[8 + buffer.offset + (slot >> 3)] &
          (1 << (slot & 7))
        );
        if (occupied) {
          count++;
          highest = slot;
          if (slot >= buffer.storedSlots)
            corrupt("occupied slot beyond persisted envelope");
        }
        if (slot >= buffer.storedSlots) continue;
        const last = buffer.runs[buffer.runs.length - 1];
        if (last && last.occupied === occupied) last.count++;
        else if (runs < MAX_RUNS) {
          buffer.runs.push({ start: slot, count: 1, occupied });
          runs++;
        } else {
          index.complete = false;
          index.reason = "Index range browser work limit exceeded";
        }
      }
      if (count !== buffer.segmentCount)
        corrupt("mask occupancy disagrees with segment count");
      if (highest + 1 !== buffer.storedSlots)
        corrupt("persisted envelope disagrees with occupied high-water slot");
    }
  }
  for (const index of inspections) {
    if (!index.complete) {
      index.occupiedBytes =
        index.freeBytes =
        index.maskOverheadBytes =
        index.allocationBytes =
          null;
      for (const a of index.allocators) for (const b of a.buffers) b.runs = [];
      continue;
    }
    const root = index.rootPointer;
    if (root.nodeType === "EMPTY") {
      if (index.occupiedBytes) corrupt("empty root has occupied allocations");
    } else if (root.typeId === 7) {
      if (index.occupiedBytes) corrupt("inlined root has occupied allocations");
    } else {
      const ordinal = ALLOCATOR_TYPES.indexOf(root.typeId);
      const buffer = index.allocators[ordinal]?.buffers.find(
        (b) => b.bufferId === root.bufferId,
      );
      if (
        !buffer ||
        !buffer.runs.some(
          (r) =>
            r.occupied &&
            root.slot! >= r.start &&
            root.slot! < r.start + r.count,
        )
      )
        corrupt("root does not reference an occupied slot");
    }
  }
  return inspections;
}

/** Mutates only referenced index allocation blocks; leaves column segments untouched. */
export function attachIndexRanges(
  blocks: FileBlock[],
  indexes: IndexInspection[],
): void {
  const owners = new Map<number, IndexInspection[]>();
  const allocations = new Map<
    number,
    { index: IndexInspection; allocator: IndexAllocator; buffer: IndexBuffer }[]
  >();
  for (const index of indexes) {
    for (const id of index.blockIds) {
      let list = owners.get(id);
      if (!list) owners.set(id, (list = []));
      list.push(index);
    }
    for (const allocator of index.allocators)
      for (const buffer of allocator.buffers) {
        let list = allocations.get(buffer.blockId);
        if (!list) allocations.set(buffer.blockId, (list = []));
        list.push({ index, allocator, buffer });
      }
  }
  for (const block of blocks) {
    const list = owners.get(block.id);
    if (!list) continue;
    if (
      ["free", "metadata", "header"].includes(block.role) ||
      block.segmentIds.length ||
      block.ranges.some((r) =>
        ["segment", "validity", "dictionary", "metadata"].includes(r.kind),
      )
    )
      corrupt("index block conflicts with another allocation");
    block.role = "index";
    block.indexIds = list.map((index) => index.id);
    block.indexOwners = list.map(({ id, table, name }) => ({
      id,
      table,
      name,
    }));
    block.checksum =
      list.map((index) => index.blockChecksums?.[block.id]).find(Boolean) ??
      block.checksum;
    block.label = list
      .map((index) => `${index.table} / ${index.name}`)
      .join(", ");
    if (list.some((index) => !index.complete)) {
      block.usedBytes = null;
      block.ranges = [
        {
          id: `block-${block.id}-checksum`,
          label: block.checksum
            ? "Verified index block checksum"
            : "Index block checksum (unverified)",
          offset: block.offset,
          size: 8,
          kind: "checksum",
        },
        {
          id: `block-${block.id}-index-unknown`,
          label: "Incomplete index allocation ownership",
          offset: block.offset + 8,
          size: block.size - 8,
          kind: "unknown",
        },
      ];
      continue;
    }
    const ranges: ByteRange[] = [
      {
        id: `block-${block.id}-checksum`,
        label: "Verified index block checksum",
        offset: block.offset,
        size: 8,
        kind: "checksum",
      },
    ];
    for (const { index, allocator, buffer } of allocations.get(block.id) ??
      []) {
      const id = `${index.id}-${allocator.ordinal}-${buffer.bufferId}`;
      ranges.push({
        id: `${id}-mask`,
        indexId: index.id,
        label: `${index.name}: ${allocator.nodeType} free-slot mask`,
        offset: buffer.absoluteOffset,
        size: allocator.maskBytes,
        kind: "index",
        nodeType: allocator.nodeType,
        indexMask: true,
      });
      for (const [ordinal, run] of buffer.runs.entries())
        ranges.push({
          id: `${id}-run-${ordinal}`,
          indexId: index.id,
          label: `${index.name}: ${run.count} ${run.occupied ? "occupied" : "free"} ${allocator.nodeType} slots`,
          offset:
            buffer.absoluteOffset +
            allocator.maskBytes +
            run.start * allocator.segmentSize,
          size: run.count * allocator.segmentSize,
          kind: run.occupied ? "index" : "unused",
          nodeType: allocator.nodeType,
        });
    }
    ranges.sort((a, b) => a.offset - b.offset);
    const partition: ByteRange[] = [];
    let cursor = block.offset;
    for (const range of ranges) {
      if (
        range.offset < cursor ||
        range.offset + range.size > block.offset + block.size
      )
        corrupt("index ranges overlap or exceed block");
      if (range.offset > cursor)
        partition.push({
          id: `block-${block.id}-gap-${cursor}`,
          label: "Unallocated index alignment gap",
          offset: cursor,
          size: range.offset - cursor,
          kind: "unused",
        });
      partition.push(range);
      cursor = range.offset + range.size;
    }
    if (cursor < block.offset + block.size)
      partition.push({
        id: `block-${block.id}-tail`,
        label: "Unallocated index block tail",
        offset: cursor,
        size: block.offset + block.size - cursor,
        kind: "unused",
      });
    block.ranges = partition;
    block.usedBytes = partition.reduce(
      (sum, range) =>
        sum +
        (range.kind === "index" || range.kind === "checksum" ? range.size : 0),
      0,
    );
  }
}
