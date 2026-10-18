import { inspectCheckpoint } from "./checkpoint-reader";
import type {
  ByteRange,
  CheckpointHeader,
  FileBlock,
  FileInspection,
} from "./types";

export const LATEST_STORAGE_VERSION = 69;

const FILE_HEADER_SIZE = 4096;
const HEADER_COUNT = 3;
const DATA_START = FILE_HEADER_SIZE * HEADER_COUNT;
const CHECKSUM_SIZE = 8;
const BLOCK_ID_MASK = (1n << 56n) - 1n;
const INVALID_POINTER = 0xffff_ffff_ffff_ffffn;
const METADATA_BLOCK_COUNT = 64;
const MAX_CHAIN_BLOCKS = 128;
const MAX_METADATA_STREAM_BYTES = 1024 * 1024;
const MAX_PHYSICAL_BLOCKS = 100_000;
const UTF8 = new TextDecoder();

export async function readBytes(
  file: File,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0
  ) {
    throw new RangeError(
      "Byte ranges must use non-negative safe integer offsets and lengths.",
    );
  }
  if (offset + length > file.size) {
    throw new RangeError(
      `Requested bytes ${offset}–${offset + length} exceed the ${file.size}-byte file.`,
    );
  }
  if (length === 0) return new Uint8Array();
  const bytes = new Uint8Array(
    await file.slice(offset, offset + length).arrayBuffer(),
  );
  if (bytes.byteLength !== length)
    throw new Error(`Short read at byte ${offset}.`);
  return bytes;
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1000) return `${Math.round(value)} B`;
  const units = ["kB", "MB", "GB", "TB", "PB"];
  let amount = value / 1000;
  let unit = 0;
  while (amount >= 1000 && unit < units.length - 1) {
    amount /= 1000;
    unit++;
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}

export async function inspectFile(file: File): Promise<FileInspection> {
  const physical = await inspectPhysicalFile(file);
  try {
    return await inspectCheckpoint(file, physical, duckdbChecksum);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unsupported checkpoint metadata.";
    if (message.startsWith("Corrupt") || message.startsWith("Truncated"))
      throw error;
    return {
      ...physical,
      warnings: [
        ...physical.warnings.filter(
          (warning) => !warning.startsWith("Catalog objects"),
        ),
        `Native checkpoint decoding is incomplete: ${message} Logical ownership and internal fragmentation remain unknown.`,
      ],
    };
  }
}

export async function inspectPhysicalFile(file: File): Promise<FileInspection> {
  if (file.size < DATA_START) {
    throw new Error(
      "This file is truncated: DuckDB v2 files need three complete 4 KiB header pages.",
    );
  }

  const headerBytes = await readBytes(file, 0, DATA_START);
  const pages = [0, 1, 2].map((index) =>
    headerBytes.subarray(
      index * FILE_HEADER_SIZE,
      (index + 1) * FILE_HEADER_SIZE,
    ),
  );
  verifyPageChecksum(pages[0], "main header");

  const main = parseMainHeader(pages[0]);
  if (main.encrypted)
    throw new Error(
      "Encrypted DuckDB files are not supported by this browser reader.",
    );

  const parsedHeaders = pages
    .slice(1)
    .map((page, index) => parseDatabaseHeader(page, (index + 1) as 1 | 2));
  const checksumValidHeaders = parsedHeaders.filter((header) => header.valid);
  if (checksumValidHeaders.length === 0)
    throw new Error(
      "Both DuckDB checkpoint headers failed checksum validation.",
    );

  // DuckDB prefers slot 2 when both checkpoints have the same iteration.
  checksumValidHeaders.sort((a, b) => {
    const left = BigInt(a.iteration);
    const right = BigInt(b.iteration);
    return left === right ? b.slot - a.slot : left > right ? -1 : 1;
  });
  const active = checksumValidHeaders[0];
  if (active.storageVersion !== LATEST_STORAGE_VERSION) {
    throw new Error(
      `Storage version ${active.storageVersion} is not supported; this reader supports DuckDB storage version ${LATEST_STORAGE_VERSION} (v2.0.0).`,
    );
  }
  if (
    !isPowerOfTwo(active.blockSize) ||
    active.blockSize < 16_384 ||
    active.blockSize > 262_144
  ) {
    throw new Error(
      `The active checkpoint has an invalid block allocation size (${active.blockSize}).`,
    );
  }
  if (active.vectorSize <= 0 || active.vectorSize > 1_048_576) {
    throw new Error(
      `The active checkpoint has an invalid vector size (${active.vectorSize}).`,
    );
  }
  const requiredFileSize = DATA_START + active.blockCount * active.blockSize;
  if (!Number.isSafeInteger(requiredFileSize) || file.size < requiredFileSize) {
    throw new Error(
      `This DuckDB file is truncated: the active header requires ${formatBytes(requiredFileSize)} of data.`,
    );
  }
  const physicalBlockCount = Math.floor(
    Math.max(0, file.size - DATA_START) / active.blockSize,
  );
  if (physicalBlockCount > MAX_PHYSICAL_BLOCKS) {
    throw new Error(
      `This file contains ${physicalBlockCount.toLocaleString()} data blocks, above the browser reader’s ${MAX_PHYSICAL_BLOCKS.toLocaleString()}-block visualization limit.`,
    );
  }

  const metaPointer = parseMetadataPointer(
    active.metaPointer,
    active.blockCount,
    "catalog metadata",
  );
  const freePointer = parseMetadataPointer(
    active.freePointer,
    active.blockCount,
    "free-list",
  );

  const verifiedDataBlocks = new Map<number, VerifiedBlock>();
  const metadataSubblocks = new Map<number, Set<number>>();
  const metadataLinks = new Map<number, Set<number>>();
  const freeBlockIds = new Set<number>();
  const freeMetadataSubblocks = new Map<number, bigint>();
  const warnings: string[] = [];

  if (metaPointer) {
    const chain = await readMetadataChain(
      file,
      active.blockSize,
      active.blockCount,
      metaPointer,
      verifiedDataBlocks,
      metadataSubblocks,
      metadataLinks,
    );
    if (chain.truncated)
      warnings.push(
        "Catalog metadata chain exceeded the browser reader’s bounded scan and is only partially mapped.",
      );
  }

  if (freePointer) {
    const chain = await readMetadataChain(
      file,
      active.blockSize,
      active.blockCount,
      freePointer,
      verifiedDataBlocks,
      metadataSubblocks,
      metadataLinks,
    );
    if (chain.truncated) {
      warnings.push(
        "Free-list metadata chain exceeded the browser reader’s bounded scan; free blocks are left unknown.",
      );
    } else {
      const parsedFreeList = parseFreeList(chain.stream, active.blockCount);
      for (const blockId of parsedFreeList.freeBlocks)
        freeBlockIds.add(blockId);
      for (const [blockId, freeMask] of parsedFreeList.freeMetadataSubblocks)
        freeMetadataSubblocks.set(blockId, freeMask);
    }
  }

  for (const blockId of metadataSubblocks.keys()) {
    if (freeBlockIds.has(blockId))
      throw new Error(
        `Corrupt DuckDB free list: block ${blockId} is both allocated metadata and free.`,
      );
  }

  const headers = parsedHeaders.map(
    ({
      checksum,
      metaPointer: _metaPointer,
      freePointer: _freePointer,
      ...header
    }) => ({ ...header, valid: header.valid }),
  );
  for (const [blockId, freeMask] of freeMetadataSubblocks) {
    if (freeBlockIds.has(blockId))
      throw new Error(
        `Corrupt DuckDB free list: metadata block ${blockId} is also marked as a free block.`,
      );
    let indices = metadataSubblocks.get(blockId);
    if (!indices) metadataSubblocks.set(blockId, (indices = new Set()));
    for (let index = 0; index < METADATA_BLOCK_COUNT; index++) {
      if (indices.has(index) && (freeMask & (1n << BigInt(index))) !== 0n) {
        throw new Error(
          `Corrupt DuckDB metadata free list: active pointer uses free metadata subblock ${blockId}.${index}.`,
        );
      }
      indices.add(index);
    }
  }
  const headerLinks = new Map<number, Set<number>>([[-3, new Set([-2, -1])]]);
  const activeHeaderBlockId = active.slot === 1 ? -2 : -1;
  const activeHeaderLinks = new Set<number>();
  if (metaPointer) activeHeaderLinks.add(metaPointer.blockId);
  if (freePointer) activeHeaderLinks.add(freePointer.blockId);
  headerLinks.set(activeHeaderBlockId, activeHeaderLinks);
  const blocks = makeBlocks(
    file.size,
    active.blockSize,
    active.blockCount,
    verifiedDataBlocks,
    metadataSubblocks,
    metadataLinks,
    headerLinks,
    freeBlockIds,
    freeMetadataSubblocks,
    pages.map((page) => readU64(page, 0)),
    [true, parsedHeaders[0].valid, parsedHeaders[1].valid],
  );
  const fingerprint = await sha256(headerBytes);
  const libraryVersion = main.libraryVersion || "DuckDB storage v2";
  warnings.push(
    "Catalog objects, column segments, and compressed vectors are not decoded. Unverified data stays unknown.",
  );

  return {
    name: file.name,
    fileSize: file.size,
    source: "file",
    storageVersion: active.storageVersion,
    blockSize: active.blockSize,
    blockHeaderSize: CHECKSUM_SIZE,
    vectorSize: active.vectorSize,
    libraryVersion,
    activeHeader: active.slot,
    headers,
    blocks,
    segments: [],
    warnings,
    capabilities: { semantic: false, exactSizes: false, checksums: true },
    headerFingerprint: fingerprint,
  };
}

interface ParsedHeader extends CheckpointHeader {
  checksum: bigint;
  metaPointer: bigint;
  freePointer: bigint;
}

interface MetadataPointer {
  blockId: number;
  subblockIndex: number;
}

interface VerifiedBlock {
  checksum: string;
}

interface LoadedBlock extends VerifiedBlock {
  bytes: Uint8Array;
}

function parseMainHeader(page: Uint8Array): {
  encrypted: boolean;
  libraryVersion: string;
} {
  const data = page.subarray(CHECKSUM_SIZE);
  if (UTF8.decode(data.subarray(0, 4)) !== "DUCK")
    throw new Error("The file does not have the DuckDB main-header signature.");
  const versionNumber = readU64(data, 4);
  const flagsOffset = 12;
  const flags = readU64(data, flagsOffset);
  const libraryVersion = readCString(data.subarray(44, 76));
  // An upgraded database can retain an older main-header version while its checkpoint uses v69.
  if (
    versionNumber !== 999n &&
    (versionNumber < 64n || versionNumber > BigInt(LATEST_STORAGE_VERSION))
  ) {
    throw new Error(
      `Main-header version marker ${versionNumber} is outside the supported storage layout.`,
    );
  }
  return { encrypted: (flags & 1n) !== 0n, libraryVersion };
}

function parseDatabaseHeader(page: Uint8Array, slot: 1 | 2): ParsedHeader {
  let checksum = 0n;
  let valid = false;
  try {
    checksum = verifyPageChecksum(page, `checkpoint header ${slot}`);
    valid = true;
  } catch {
    // A torn inactive checkpoint is expected to be recoverable from the other slot.
  }
  const payload = page.subarray(CHECKSUM_SIZE);
  let iteration = 0n;
  let metaPointer = INVALID_POINTER;
  let freePointer = INVALID_POINTER;
  let blockCount = 0;
  let blockSize = 0;
  let vectorSize = 0;
  let storageVersion = 0;
  try {
    iteration = readU64(payload, 0);
    metaPointer = readU64(payload, 8);
    freePointer = readU64(payload, 16);
    blockCount = safeNumber(
      readU64(payload, 24),
      `checkpoint ${slot} block count`,
    );
    blockSize = safeNumber(
      readU64(payload, 32),
      `checkpoint ${slot} block size`,
    );
    vectorSize = safeNumber(
      readU64(payload, 40),
      `checkpoint ${slot} vector size`,
    );
    storageVersion = safeNumber(
      readU64(payload, 48),
      `checkpoint ${slot} storage version`,
    );
  } catch {
    valid = false;
  }
  return {
    slot,
    iteration: iteration.toString(),
    metaBlock: metaPointer.toString(),
    freeList: freePointer.toString(),
    blockCount,
    blockSize,
    vectorSize,
    storageVersion,
    valid,
    checksum,
    metaPointer,
    freePointer,
  };
}

function verifyPageChecksum(page: Uint8Array, label: string): bigint {
  const stored = readU64(page, 0);
  const computed = duckdbChecksum(page.subarray(CHECKSUM_SIZE));
  if (stored !== computed) throw new Error(`${label} checksum mismatch.`);
  return stored;
}

function duckdbChecksum(bytes: Uint8Array): bigint {
  let result = 5381n;
  const fullLength = bytes.length - (bytes.length % 8);
  for (let offset = 0; offset < fullLength; offset += 8) {
    result ^=
      (readU64(bytes, offset) * 0xbf58476d1ce4e5b9n) & 0xffff_ffff_ffff_ffffn;
  }
  if (fullLength !== bytes.length)
    result ^= checksumRemainder(bytes.subarray(fullLength));
  return result & 0xffff_ffff_ffff_ffffn;
}

function checksumRemainder(bytes: Uint8Array): bigint {
  const multiplier = 0xc6a4a7935bd1e995n;
  const seed = 0xe17a1465n;
  const shift = 47n;
  let hash =
    seed ^ ((BigInt(bytes.length) * multiplier) & 0xffff_ffff_ffff_ffffn);
  const full = bytes.length - (bytes.length % 8);
  for (let offset = 0; offset < full; offset += 8) {
    let word = readU64(bytes, offset);
    word = (word * multiplier) & 0xffff_ffff_ffff_ffffn;
    word ^= word >> shift;
    word = (word * multiplier) & 0xffff_ffff_ffff_ffffn;
    hash ^= word;
    hash = (hash * multiplier) & 0xffff_ffff_ffff_ffffn;
  }
  for (let index = full; index < bytes.length; index++) {
    hash ^= BigInt(bytes[index]) << (BigInt(index - full) * 8n);
  }
  if (bytes.length % 8 !== 0)
    hash = (hash * multiplier) & 0xffff_ffff_ffff_ffffn;
  hash ^= hash >> shift;
  hash = (hash * multiplier) & 0xffff_ffff_ffff_ffffn;
  hash ^= hash >> shift;
  return hash & 0xffff_ffff_ffff_ffffn;
}

function parseMetadataPointer(
  raw: bigint,
  blockCount: number,
  label: string,
): MetadataPointer | null {
  if (raw === INVALID_POINTER) return null;
  const blockIdBig = raw & BLOCK_ID_MASK;
  const subblockIndex = Number(raw >> 56n);
  const blockId = safeNumber(blockIdBig, `${label} block id`);
  if (subblockIndex >= METADATA_BLOCK_COUNT)
    throw new Error(
      `Corrupt DuckDB ${label} pointer: metadata subblock index ${subblockIndex} is outside 0–63.`,
    );
  if (blockId >= blockCount)
    throw new Error(
      `Corrupt DuckDB ${label} pointer: block ${blockId} is outside the ${blockCount}-block checkpoint.`,
    );
  return { blockId, subblockIndex };
}

async function readMetadataChain(
  file: File,
  blockSize: number,
  blockCount: number,
  root: MetadataPointer,
  verifiedBlocks: Map<number, VerifiedBlock>,
  metadataSubblocks: Map<number, Set<number>>,
  metadataLinks: Map<number, Set<number>>,
): Promise<{ stream: Uint8Array; truncated: boolean }> {
  const payloadSize = blockSize - CHECKSUM_SIZE;
  const metadataBlockSize =
    Math.floor(payloadSize / METADATA_BLOCK_COUNT / 8) * 8;
  if (metadataBlockSize <= CHECKSUM_SIZE)
    throw new Error("Corrupt DuckDB metadata geometry.");
  let pointer: MetadataPointer | null = root;
  const seen = new Set<string>();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  while (pointer) {
    const key = `${pointer.blockId}:${pointer.subblockIndex}`;
    if (seen.has(key))
      throw new Error(
        `Corrupt DuckDB metadata chain: pointer cycle at block ${key}.`,
      );
    seen.add(key);
    if (seen.size > MAX_CHAIN_BLOCKS) {
      truncated = true;
      break;
    }
    if (pointer.blockId >= blockCount)
      throw new Error(
        `Corrupt DuckDB metadata chain: block ${pointer.blockId} is outside the active checkpoint.`,
      );

    const verified = await readVerifiedBlock(
      file,
      pointer.blockId,
      blockSize,
      verifiedBlocks,
    );
    let indices = metadataSubblocks.get(pointer.blockId);
    if (!indices) metadataSubblocks.set(pointer.blockId, (indices = new Set()));
    indices.add(pointer.subblockIndex);
    const data = verified.bytes.subarray(CHECKSUM_SIZE);
    const slotStart = pointer.subblockIndex * metadataBlockSize;
    if (slotStart + metadataBlockSize > data.length)
      throw new Error(
        `Corrupt DuckDB metadata pointer: slot ${pointer.subblockIndex} exceeds block ${pointer.blockId}.`,
      );

    const slot = data.subarray(slotStart, slotStart + metadataBlockSize);
    const nextRaw = readU64(slot, 0);
    const remaining = MAX_METADATA_STREAM_BYTES - total;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const chunk = slot.slice(
      CHECKSUM_SIZE,
      Math.min(slot.length, CHECKSUM_SIZE + remaining),
    );
    chunks.push(chunk);
    total += chunk.byteLength;
    if (total >= MAX_METADATA_STREAM_BYTES && nextRaw !== INVALID_POINTER) {
      truncated = true;
      break;
    }
    if (nextRaw === INVALID_POINTER) {
      pointer = null;
    } else {
      const nextPointer = parseMetadataPointer(
        nextRaw,
        blockCount,
        "metadata chain",
      );
      if (nextPointer) {
        let links = metadataLinks.get(pointer.blockId);
        if (!links) metadataLinks.set(pointer.blockId, (links = new Set()));
        links.add(nextPointer.blockId);
      }
      pointer = nextPointer;
    }
  }

  return { stream: concatenate(chunks, total), truncated };
}

async function readVerifiedBlock(
  file: File,
  blockId: number,
  blockSize: number,
  cache: Map<number, VerifiedBlock>,
): Promise<LoadedBlock> {
  const offset = DATA_START + blockId * blockSize;
  const bytes = await readBytes(file, offset, blockSize);
  const cached = cache.get(blockId);
  if (cached) return { bytes, checksum: cached.checksum };
  const stored = readU64(bytes, 0);
  const computed = duckdbChecksum(bytes.subarray(CHECKSUM_SIZE));
  if (stored !== computed)
    throw new Error(`DuckDB data block ${blockId} failed checksum validation.`);
  const checksum = `0x${stored.toString(16).padStart(16, "0")}`;
  cache.set(blockId, { checksum });
  return { bytes, checksum };
}

function parseFreeList(
  stream: Uint8Array,
  blockCount: number,
): { freeBlocks: number[]; freeMetadataSubblocks: Array<[number, bigint]> } {
  let cursor = 0;
  const freeCount = readStreamCount(stream, cursor, "free block count");
  cursor += 8;
  const freeBytes = safeMultiply(freeCount, 8, "free block list");
  ensureAvailable(stream, cursor, freeBytes, "free block list");
  const freeBlocks: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < freeCount; i++) {
    const raw = readI64(stream, cursor + i * 8);
    if (raw < 0 || raw >= blockCount)
      throw new Error(
        `Corrupt DuckDB free list: block ${raw} is outside the ${blockCount}-block checkpoint.`,
      );
    const blockId = Number(raw);
    if (seen.has(blockId))
      throw new Error(
        `Corrupt DuckDB free list: block ${blockId} appears more than once.`,
      );
    seen.add(blockId);
    freeBlocks.push(blockId);
  }
  cursor += freeBytes;

  const multiUseCount = readStreamCount(
    stream,
    cursor,
    "multi-use block count",
  );
  cursor += 8;
  const multiUseBytes = safeMultiply(multiUseCount, 12, "multi-use block list");
  ensureAvailable(stream, cursor, multiUseBytes, "multi-use block list");
  for (let i = 0; i < multiUseCount; i++) {
    const blockId = readI64(stream, cursor + i * 12);
    const useCount = new DataView(
      stream.buffer,
      stream.byteOffset + cursor + i * 12 + 8,
      4,
    ).getUint32(0, true);
    if (blockId < 0 || blockId >= blockCount || useCount < 2)
      throw new Error(
        `Corrupt DuckDB multi-use block entry for block ${blockId}.`,
      );
  }
  cursor += multiUseBytes;
  ensureAvailable(stream, cursor, 8, "metadata block count");
  const metadataCount = readStreamCount(stream, cursor, "metadata block count");
  cursor += 8;
  const metadataBytes = safeMultiply(metadataCount, 16, "metadata block list");
  ensureAvailable(stream, cursor, metadataBytes, "metadata block list");
  const freeMetadataSubblocks: Array<[number, bigint]> = [];
  const seenMetadataBlocks = new Set<number>();
  for (let i = 0; i < metadataCount; i++) {
    const blockId = readI64(stream, cursor + i * 16);
    const freeMask = readU64(stream, cursor + i * 16 + 8);
    if (blockId < 0 || blockId >= blockCount)
      throw new Error(
        `Corrupt DuckDB metadata free list: block ${blockId} is outside the ${blockCount}-block checkpoint.`,
      );
    if (seenMetadataBlocks.has(Number(blockId)))
      throw new Error(
        `Corrupt DuckDB metadata free list: block ${blockId} appears more than once.`,
      );
    seenMetadataBlocks.add(Number(blockId));
    freeMetadataSubblocks.push([Number(blockId), freeMask]);
  }
  return { freeBlocks, freeMetadataSubblocks };
}

function makeBlocks(
  fileSize: number,
  blockSize: number,
  blockCount: number,
  verifiedBlocks: Map<number, VerifiedBlock>,
  metadataSubblocks: Map<number, Set<number>>,
  metadataLinks: Map<number, Set<number>>,
  headerLinks: Map<number, Set<number>>,
  freeBlockIds: Set<number>,
  freeMetadataSubblocks: Map<number, bigint>,
  headerChecksums: bigint[],
  headerChecksumValid: boolean[],
): FileBlock[] {
  const blocks: FileBlock[] = [
    makeHeaderBlock(
      -3,
      0,
      "Main header",
      headerChecksums[0],
      true,
      headerLinks.get(-3),
    ),
    makeHeaderBlock(
      -2,
      FILE_HEADER_SIZE,
      "Checkpoint header 1",
      headerChecksums[1],
      headerChecksumValid[1],
      headerLinks.get(-2),
    ),
    makeHeaderBlock(
      -1,
      FILE_HEADER_SIZE * 2,
      "Checkpoint header 2",
      headerChecksums[2],
      headerChecksumValid[2],
      headerLinks.get(-1),
    ),
  ];
  const physicalCount = Math.floor(
    Math.max(0, fileSize - DATA_START) / blockSize,
  );
  const subblockSize =
    Math.floor((blockSize - CHECKSUM_SIZE) / METADATA_BLOCK_COUNT / 8) * 8;
  for (let id = 0; id < physicalCount; id++) {
    const offset = DATA_START + id * blockSize;
    const indices = metadataSubblocks.get(id);
    const freeMask = freeMetadataSubblocks.get(id) ?? 0n;
    let role: FileBlock["role"] = "unknown";
    let label = `Unclassified data block ${id}`;
    let usedBytes: number | null = null;
    if (indices?.size) {
      role = "metadata";
      label = verifiedBlocks.has(id)
        ? `Checksum-verified metadata block ${id}`
        : `Metadata allocator block ${id} (block checksum unverified)`;
    } else if (freeBlockIds.has(id) || id >= blockCount) {
      role = "free";
      label =
        id >= blockCount
          ? `Implicitly free block ${id}`
          : `Free block ${id} (verified free list)`;
      usedBytes = 0;
    }
    const ranges: ByteRange[] = [
      {
        id: `block-${id}-checksum`,
        label: verifiedBlocks.has(id)
          ? "Verified checksum"
          : "Checksum (unverified)",
        offset,
        size: CHECKSUM_SIZE,
        kind: "checksum",
      },
    ];
    if (indices?.size && freeMetadataSubblocks.has(id)) {
      let index = 0;
      while (index < METADATA_BLOCK_COUNT) {
        const firstFree = (freeMask & (1n << BigInt(index))) !== 0n;
        let runEnd = index + 1;
        while (
          runEnd < METADATA_BLOCK_COUNT &&
          ((freeMask & (1n << BigInt(runEnd))) !== 0n) === firstFree
        )
          runEnd++;
        ranges.push({
          id: `block-${id}-meta-${index}-${runEnd - 1}`,
          label: firstFree
            ? `Free metadata subblocks ${index}–${runEnd - 1}`
            : `Allocated metadata subblocks ${index}–${runEnd - 1}`,
          offset: offset + CHECKSUM_SIZE + index * subblockSize,
          size: (runEnd - index) * subblockSize,
          kind: firstFree ? "unused" : "metadata",
        });
        index = runEnd;
      }
      const used = subblockSize * METADATA_BLOCK_COUNT;
      if (blockSize - CHECKSUM_SIZE - used > 0) {
        ranges.push({
          id: `block-${id}-metadata-tail`,
          label: "Unused metadata block tail",
          offset: offset + CHECKSUM_SIZE + used,
          size: blockSize - CHECKSUM_SIZE - used,
          kind: "unused",
        });
      }
    } else if (indices?.size) {
      let index = 0;
      while (index < METADATA_BLOCK_COUNT) {
        if (indices.has(index)) {
          ranges.push({
            id: `block-${id}-meta-${index}`,
            label: `Checksum-verified metadata subblock ${index}`,
            offset: offset + CHECKSUM_SIZE + index * subblockSize,
            size: subblockSize,
            kind: "metadata",
          });
          index++;
          continue;
        }
        const start = index;
        while (index < METADATA_BLOCK_COUNT && !indices.has(index)) index++;
        ranges.push({
          id: `block-${id}-unclassified-meta-${start}-${index - 1}`,
          label: "Unclassified metadata slots",
          offset: offset + CHECKSUM_SIZE + start * subblockSize,
          size: (index - start) * subblockSize,
          kind: "unknown",
        });
      }
      const used = subblockSize * METADATA_BLOCK_COUNT;
      if (blockSize - CHECKSUM_SIZE - used > 0) {
        ranges.push({
          id: `block-${id}-metadata-tail`,
          label: "Unused metadata block tail",
          offset: offset + CHECKSUM_SIZE + used,
          size: blockSize - CHECKSUM_SIZE - used,
          kind: "unused",
        });
      }
    } else {
      ranges.push({
        id: `block-${id}-body`,
        label: role === "free" ? "Free block data" : "Unclassified block data",
        offset: offset + CHECKSUM_SIZE,
        size: blockSize - CHECKSUM_SIZE,
        kind: role === "free" ? "unused" : "unknown",
      });
    }
    blocks.push({
      id,
      offset,
      size: blockSize,
      role,
      label,
      usedBytes,
      ranges,
      segmentIds: [],
      links: Array.from(metadataLinks.get(id) ?? []),
      checksum: verifiedBlocks.get(id)?.checksum,
    });
  }
  const tail = Math.max(0, fileSize - (DATA_START + physicalCount * blockSize));
  if (tail > 0) {
    const offset = DATA_START + physicalCount * blockSize;
    blocks.push({
      id: physicalCount,
      offset,
      size: tail,
      role: "unknown",
      label: "Trailing partial block bytes",
      usedBytes: null,
      ranges: [
        {
          id: "trailing-bytes",
          label: "Unknown trailing bytes",
          offset,
          size: tail,
          kind: "unknown",
        },
      ],
      segmentIds: [],
      links: [],
    });
  }
  return blocks;
}

function makeHeaderBlock(
  id: -3 | -2 | -1,
  offset: number,
  label: string,
  checksum: bigint,
  checksumValid: boolean,
  links: Set<number> = new Set(),
): FileBlock {
  const page = id === -3 ? 0 : id === -2 ? 1 : 2;
  return {
    id,
    offset,
    size: FILE_HEADER_SIZE,
    role: "header",
    label,
    usedBytes: FILE_HEADER_SIZE,
    ranges: [
      {
        id: `header-${page}-checksum`,
        label: checksumValid ? "Verified checksum" : "Checksum mismatch",
        offset,
        size: CHECKSUM_SIZE,
        kind: "checksum",
      },
      {
        id: `header-${page}-body`,
        label,
        offset: offset + CHECKSUM_SIZE,
        size: FILE_HEADER_SIZE - CHECKSUM_SIZE,
        kind: "header",
      },
    ],
    segmentIds: [],
    links: Array.from(links),
    checksum: `0x${checksum.toString(16).padStart(16, "0")}`,
  };
}

function readU64(bytes: Uint8Array, offset: number): bigint {
  if (offset < 0 || offset + 8 > bytes.length)
    throw new Error("Truncated DuckDB header or metadata field.");
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(
    0,
    true,
  );
}

function readI64(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 8 > bytes.length)
    throw new Error("Truncated DuckDB metadata stream.");
  const value = new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    8,
  ).getBigInt64(0, true);
  if (
    value < BigInt(Number.MIN_SAFE_INTEGER) ||
    value > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error("DuckDB metadata contains an out-of-range block id.");
  return Number(value);
}

function safeNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`DuckDB ${label} is outside the supported integer range.`);
  return Number(value);
}

function readCString(bytes: Uint8Array): string {
  const nul = bytes.indexOf(0);
  return UTF8.decode(nul >= 0 ? bytes.subarray(0, nul) : bytes).trim();
}

function readStreamCount(
  stream: Uint8Array,
  offset: number,
  label: string,
): number {
  ensureAvailable(stream, offset, 8, label);
  return safeNumber(readU64(stream, offset), label);
}

function ensureAvailable(
  stream: Uint8Array,
  offset: number,
  size: number,
  label: string,
): void {
  if (!Number.isSafeInteger(size) || size < 0 || offset + size > stream.length)
    throw new Error(`Corrupt or truncated DuckDB ${label}.`);
}

function safeMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result))
    throw new Error(`DuckDB ${label} is too large to inspect safely.`);
  return result;
}

function isPowerOfTwo(value: number): boolean {
  return (
    Number.isSafeInteger(value) && value > 0 && (value & (value - 1)) === 0
  );
}

function concatenate(chunks: Uint8Array[], length: number): Uint8Array {
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
