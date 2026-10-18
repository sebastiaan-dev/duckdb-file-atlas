const INVALID_META_POINTER = (1n << 64n) - 1n;
const BLOCK_ID_MASK = (1n << 56n) - 1n;

/**
 * DuckDB metadata pointers pack the 64-slot index into the top 8 bits and the
 * block ID into the lower 56 bits. Returns null for INVALID or unparsable values.
 */
export function decodeMetaPointer(
  raw: string,
): { blockId: number; slot: number } | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    return null;
  }
  if (value === INVALID_META_POINTER || value < 0n) return null;
  const blockId = value & BLOCK_ID_MASK;
  if (blockId > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { blockId: Number(blockId), slot: Number(value >> 56n) };
}
