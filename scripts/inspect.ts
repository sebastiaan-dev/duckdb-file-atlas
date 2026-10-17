import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectFile } from '../src/lib/reader';
import type { FileInspection, SemanticManifest, Segment } from '../src/lib/types';

const REQUIRED_STORAGE_VERSION = 69;
const REQUIRED_DUCKDB_MAJOR = 2;
const REQUIRED_DUCKDB_MINOR = 0;
const MAX_QUERY_OUTPUT_BYTES = 48 * 1024 * 1024;
const MAX_TOTAL_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_TABLES = 20_000;
const MAX_SEGMENTS = 1_000_000;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlIdentifier(value: string): string {
  if (value.length === 0 || value.length > 512) throw new Error('A catalog identifier is empty or too long to export safely.');
  return `"${value.replaceAll('"', '""')}"`;
}

function safeNumber(value: unknown, label: string): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`DuckDB returned an invalid ${label}; expected a non-negative safe integer.`);
  return number;
}

function parseEngineVersion(value: unknown): [number, number, number] {
  if (typeof value !== 'string') throw new Error('DuckDB did not report its version.');
  const match = value.match(/^v?(\d+)\.(\d+)\.(\d+)/i);
  if (!match) throw new Error(`Could not read DuckDB version "${value}".`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

async function readBounded(stream: ReadableStream<Uint8Array> | null, limit: number, label: string, kill: () => void): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        kill();
        throw new Error(`${label} exceeded the ${Math.floor(limit / (1024 * 1024))} MiB safety limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function runSql(duckdbBinary: string, databasePath: string, sql: string): Promise<JsonRecord[]> {
  const spawn = () => Bun.spawn([
      duckdbBinary,
      '--batch', '--no-init', '--no-stdin', '--no-agent', '--readonly', '-json', databasePath, '-c', sql,
    ], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  let processHandle: ReturnType<typeof spawn>;
  try {
    processHandle = spawn();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not start the DuckDB CLI at "${duckdbBinary}" (${detail}). Build or install a DuckDB CLI at version 2.0.0 or newer and pass its executable path with --duckdb.`);
  }

  const outputPromise = readBounded(processHandle.stdout, MAX_QUERY_OUTPUT_BYTES, 'DuckDB query output', () => processHandle.kill());
  const errorPromise = readBounded(processHandle.stderr, 1024 * 1024, 'DuckDB error output', () => processHandle.kill());
  const [stdoutBytes, stderrBytes, status] = await Promise.all([outputPromise, errorPromise, processHandle.exited]);
  const stdout = decode(stdoutBytes).trim();
  const stderr = decode(stderrBytes).trim();
  if (status !== 0) {
    const detail = (stderr || stdout || `DuckDB CLI exited with status ${status}`).slice(0, 3000);
    throw new Error(`DuckDB could not read the database in read-only mode. Use a DuckDB CLI built from a release that supports storage version 69, and run CHECKPOINT before exporting if the file has pending WAL changes. ${detail}`);
  }
  if (!stdout) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`DuckDB returned output that was not valid JSON in -json mode. Check that --duckdb points to the official DuckDB CLI. ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
    throw new Error('DuckDB returned an unexpected JSON result. Rebuild the CLI with DuckDB 2.0.0 or newer.');
  }
  return parsed;
}

function makeReaderFile(path: string, blob: Bun.BunFile): File {
  // Bun.file() is a lazy Blob over the path. This adapter supplies the browser File name
  // while preserving slice-based reads, so inspecting the header never loads the full DB.
  return {
    name: basename(path),
    size: blob.size,
    type: blob.type,
    lastModified: 0,
    slice: blob.slice.bind(blob),
    stream: blob.stream.bind(blob),
    arrayBuffer: blob.arrayBuffer.bind(blob),
    text: blob.text.bind(blob),
  } as unknown as File;
}

async function inspectHeader(path: string): Promise<{ inspection: FileInspection; fileSize: number }> {
  const blob = Bun.file(path);
  if (!(await blob.exists())) throw new Error(`Database file not found: ${path}`);
  const fileSize = blob.size;
  let inspection: FileInspection;
  try {
    inspection = await inspectFile(makeReaderFile(path, blob));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not inspect the DuckDB file header before querying it: ${detail}`);
  }
  if (inspection.source !== 'file' || inspection.fileSize !== fileSize) {
    throw new Error('The file inspector did not confirm the same on-disk DuckDB file and size.');
  }
  if (!inspection.headerFingerprint || !/^[a-f\d]{64}$/i.test(inspection.headerFingerprint)) {
    throw new Error('The file inspector did not return the required SHA-256 fingerprint of the first 12 KiB.');
  }
  if (inspection.storageVersion !== REQUIRED_STORAGE_VERSION) {
    throw new Error(`This exporter supports DuckDB storage version ${REQUIRED_STORAGE_VERSION} (v2.0.0) only; the inspected file uses version ${inspection.storageVersion}.`);
  }
  return { inspection, fileSize };
}

async function requireCheckpointedFile(databasePath: string): Promise<void> {
  // Read-only DuckDB can still replay a WAL into its catalog. The semantic map
  // must describe the checkpoint represented by the browser's physical file.
  for (const suffix of ['.wal', '.wal.checkpoint', '.wal.recovery']) {
    const wal = Bun.file(databasePath + suffix);
    if (await wal.exists() && wal.size > 0) {
      throw new Error(`Unresolved WAL file ${basename(databasePath + suffix)}. Run CHECKPOINT and close the database before exporting its physical layout.`);
    }
  }
}

/** Read a checked DuckDB file and export semantic rows using the DuckDB CLI in read-only mode. */
export async function collectManifest(filePath: string, duckdbBinary: string): Promise<SemanticManifest> {
  const databasePath = resolve(filePath);
  const cliPath = resolve(duckdbBinary);
  await requireCheckpointedFile(databasePath);
  const before = await inspectHeader(databasePath);

  let totalOutputBytes = 0;
  const run = async (sql: string): Promise<JsonRecord[]> => {
    const rows = await runSql(cliPath, databasePath, sql);
    totalOutputBytes += new TextEncoder().encode(JSON.stringify(rows)).byteLength;
    if (totalOutputBytes > MAX_TOTAL_OUTPUT_BYTES) {
      throw new Error(`Semantic export exceeded the ${Math.floor(MAX_TOTAL_OUTPUT_BYTES / (1024 * 1024))} MiB safety limit. Export a smaller database.`);
    }
    return rows;
  };

  const infoRows = await run(`SELECT version() AS engine_version, tags['storage_version'] AS storage_version FROM duckdb_databases() WHERE database_name = current_database() AND NOT internal`);
  if (infoRows.length !== 1) throw new Error('Could not identify the opened DuckDB database.');
  const engineVersion = parseEngineVersion(infoRows[0].engine_version);
  if (compareVersion(engineVersion, [REQUIRED_DUCKDB_MAJOR, REQUIRED_DUCKDB_MINOR, 0]) < 0) {
    throw new Error(`The DuckDB CLI is too old (${String(infoRows[0].engine_version)}). Use version 2.0.0 or newer, which supports the storage version 69 header inspected before the query.`);
  }
  if (infoRows[0].storage_version !== 'v2.0.0+') {
    throw new Error(`The DuckDB CLI reported storage version ${String(infoRows[0].storage_version)} for the opened file; this exporter requires v2.0.0+ (storage version 69).`);
  }

  const tableRows = await run(`SELECT schema_name, table_name, table_oid FROM duckdb_tables() WHERE database_name = current_database() AND NOT internal AND NOT temporary ORDER BY schema_name, table_name`);
  if (tableRows.length > MAX_TABLES) throw new Error(`Database has ${tableRows.length} tables; the safe export limit is ${MAX_TABLES}.`);

  const segments: Segment[] = [];
  for (const tableRow of tableRows) {
    const schema = tableRow.schema_name;
    const tableName = tableRow.table_name;
    if (typeof schema !== 'string' || typeof tableName !== 'string') throw new Error('DuckDB returned an invalid schema or table name.');
    const tableOid = safeNumber(tableRow.table_oid, 'table OID');
    const qualifiedName = `${sqlIdentifier(schema)}.${sqlIdentifier(tableName)}`;
    const tableLabel = `${schema}.${tableName}`;
    const rows = await run(`
      SELECT row_group_id, column_name, column_id, column_path, segment_id, segment_type, start, count,
             compression, stats::VARCHAR AS stats, block_id, block_offset
      FROM pragma_storage_info(${sqlString(qualifiedName)})
      WHERE persistent AND block_id IS NOT NULL AND block_id >= 0 AND block_offset IS NOT NULL AND block_offset >= 0
      ORDER BY row_group_id, column_id, segment_id
    `);
    for (const row of rows) {
      const rowGroup = safeNumber(row.row_group_id, 'row group ID');
      const columnId = safeNumber(row.column_id, 'column ID');
      const segmentNumber = safeNumber(row.segment_id, 'segment ID');
      const blockId = safeNumber(row.block_id, 'block ID');
      const payloadOffset = safeNumber(row.block_offset, 'segment block offset');
      const blockHeaderSize = before.inspection.blockHeaderSize;
      const offset = payloadOffset + blockHeaderSize;
      if (!Number.isSafeInteger(offset)) throw new Error('DuckDB returned a segment offset outside the safe integer range.');
      if (typeof row.column_name !== 'string' || typeof row.column_path !== 'string' || typeof row.segment_type !== 'string' || typeof row.compression !== 'string') {
        throw new Error('DuckDB returned incomplete column segment metadata.');
      }
      const rowStart = safeNumber(row.start, 'segment row start');
      const rowCount = safeNumber(row.count, 'segment row count');
      const identity = [tableOid, rowGroup, columnId, row.column_path, segmentNumber, row.segment_type, rowStart, rowCount, blockId, offset, row.compression].join('\u0000');
      const id = `${tableOid}:${createHash('sha256').update(identity).digest('hex')}`;
      const segment: Segment = {
        id,
        table: tableLabel,
        column: row.column_name,
        columnType: row.segment_type,
        rowGroup,
        blockId,
        offset,
        byteSize: null,
        rowStart,
        rowCount,
        compression: row.compression,
        ...(typeof row.stats === 'string' ? { stats: row.stats } : {}),
      };
      segments.push(segment);
      if (segments.length > MAX_SEGMENTS) throw new Error(`Semantic export exceeded the safe limit of ${MAX_SEGMENTS} segments.`);
    }
  }

  await requireCheckpointedFile(databasePath);
  const after = await inspectHeader(databasePath);
  if (after.fileSize !== before.fileSize || after.inspection.headerFingerprint?.toLowerCase() !== before.inspection.headerFingerprint?.toLowerCase()) {
    throw new Error('The DuckDB file header changed while semantic metadata was being read. Retry against a stable, checkpointed file.');
  }

  return {
    format: 'duckdb-file-layout/v1',
    storageVersion: REQUIRED_STORAGE_VERSION,
    fileSize: before.fileSize,
    headerFingerprint: before.inspection.headerFingerprint!.toLowerCase(),
    fileName: basename(databasePath),
    segments,
  };
}

function usage(): string {
  return 'Usage: bun scripts/inspect.ts --duckdb /path/to/duckdb /path/to/file.duckdb\nPrints a duckdb-file-layout/v1 semantic manifest to stdout.';
}

function parseArgs(args: string[]): { duckdb: string; database: string } {
  let duckdb: string | undefined;
  let database: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') throw new Error(usage());
    if (argument === '--duckdb') {
      if (duckdb !== undefined || index + 1 >= args.length) throw new Error(usage());
      duckdb = args[++index];
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option ${argument}.\n${usage()}`);
    } else if (database === undefined) {
      database = argument;
    } else {
      throw new Error(`Unexpected extra argument ${argument}.\n${usage()}`);
    }
  }
  if (!duckdb || !database) throw new Error(usage());
  return { duckdb, database };
}

async function main(): Promise<void> {
  try {
    const { duckdb, database } = parseArgs(Bun.argv.slice(2));
    const manifest = await collectManifest(database, duckdb);
    const json = `${JSON.stringify(manifest, null, 2)}\n`;
    if (new TextEncoder().encode(json).byteLength > MAX_TOTAL_OUTPUT_BYTES) {
      throw new Error(`Manifest exceeds the ${Math.floor(MAX_TOTAL_OUTPUT_BYTES / (1024 * 1024))} MiB output limit.`);
    }
    process.stdout.write(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
