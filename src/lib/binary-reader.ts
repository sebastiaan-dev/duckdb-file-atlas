/** Revision-69 BinarySerializer primitives, bounded and independent of the host platform. */
export class BinaryReader {
  private chunk = 0;
  private position = 0;
  private consumed = 0;
  private depth = 0;
  private readonly chunks: Uint8Array[];
  readonly length: number;

  constructor(input: Uint8Array | Uint8Array[]) {
    this.chunks = input instanceof Uint8Array ? [input] : input;
    this.length = this.chunks.reduce((total, bytes) => total + bytes.length, 0);
  }
  get offset() {
    return this.consumed;
  }
  get remaining() {
    return this.length - this.consumed;
  }
  raw(count: number): Uint8Array {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.remaining)
      throw new Error(`Truncated checkpoint metadata at byte ${this.offset}.`);
    while (
      this.chunk < this.chunks.length &&
      this.position === this.chunks[this.chunk].length
    ) {
      this.chunk++;
      this.position = 0;
    }
    const current = this.chunks[this.chunk];
    if (count === 0) return new Uint8Array();
    if (this.position + count <= current.length) {
      const result = current.subarray(this.position, this.position + count);
      this.position += count;
      this.consumed += count;
      return result;
    }
    const result = new Uint8Array(count);
    let copied = 0;
    while (copied < count) {
      const source = this.chunks[this.chunk];
      const take = Math.min(count - copied, source.length - this.position);
      result.set(source.subarray(this.position, this.position + take), copied);
      copied += take;
      this.position += take;
      this.consumed += take;
      if (this.position === source.length) {
        this.chunk++;
        this.position = 0;
      }
    }
    return result;
  }
  u8() {
    return this.raw(1)[0];
  }
  bool() {
    const value = this.u8();
    if (value > 1) throw new Error("Invalid checkpoint boolean.");
    return value === 1;
  }
  u16() {
    const bytes = this.raw(2);
    return bytes[0] | (bytes[1] << 8);
  }
  peekField() {
    const chunk = this.chunk,
      position = this.position,
      consumed = this.consumed;
    const value = this.u16();
    this.chunk = chunk;
    this.position = position;
    this.consumed = consumed;
    return value;
  }
  field(expected: number) {
    const actual = this.u16();
    if (actual !== expected)
      throw new Error(
        `Unsupported checkpoint field ${actual}; expected ${expected} at byte ${this.offset - 2}.`,
      );
  }
  optional(id: number) {
    if (this.peekField() !== id) return false;
    this.field(id);
    return true;
  }
  end() {
    this.field(0xffff);
  }
  object<T>(read: () => T): T {
    if (++this.depth > 64)
      throw new Error("Checkpoint object nesting exceeds 64 levels.");
    try {
      const result = read();
      this.end();
      return result;
    } finally {
      this.depth--;
    }
  }
  unsigned(): bigint {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = this.u8();
      result |= BigInt(byte & 127) << shift;
      if ((byte & 128) === 0) {
        if (result > 0xffffffffffffffffn)
          throw new Error("Checkpoint integer exceeds 64 bits.");
        return result;
      }
    }
    throw new Error("Invalid checkpoint variable integer.");
  }
  signed(): bigint {
    let result = 0n,
      shift = 0n,
      byte = 0;
    do {
      if (shift >= 70n) throw new Error("Invalid checkpoint signed integer.");
      byte = this.u8();
      result |= BigInt(byte & 127) << shift;
      shift += 7n;
    } while (byte & 128);
    if (byte & 64) result |= -(1n << shift);
    if (result < -(1n << 63n) || result >= 1n << 63n)
      throw new Error("Checkpoint signed integer exceeds 64 bits.");
    return result;
  }
  uint() {
    return safeInteger(this.unsigned());
  }
  int() {
    return safeInteger(this.signed());
  }
  fixedU64() {
    const bytes = this.raw(8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(
      0,
      true,
    );
  }
  f32() {
    const bytes = this.raw(4);
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getFloat32(0, true);
  }
  f64() {
    const bytes = this.raw(8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
  }
  blob() {
    const length = this.uint();
    if (length > 16 * 1024 * 1024)
      throw new Error("Checkpoint blob exceeds 16 MiB.");
    return this.raw(length);
  }
  string() {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.blob());
  }
  nullable<T>(read: () => T): T | null {
    return this.bool() ? read() : null;
  }
  list<T>(read: (index: number) => T): T[] {
    const count = this.uint();
    if (count > 1_000_000 || count > this.remaining)
      throw new Error("Invalid or oversized checkpoint list.");
    return Array.from({ length: count }, (_, index) => read(index));
  }
}
export function safeInteger(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new Error(
      "Checkpoint integer exceeds JavaScript safe integer precision.",
    );
  return number;
}
export interface MetaPointer {
  blockPointer: bigint;
  offset: number;
}
export function readMetaPointer(reader: BinaryReader): MetaPointer {
  return reader.object(() => ({
    blockPointer: reader.optional(100) ? reader.unsigned() : 0n,
    offset: reader.optional(101) ? reader.uint() : 0,
  }));
}
export function readBlockPointer(reader: BinaryReader): {
  blockId: number;
  offset: number;
} {
  return reader.object(() => {
    reader.field(100);
    return {
      blockId: reader.int(),
      offset: reader.optional(101) ? reader.uint() : 0,
    };
  });
}
