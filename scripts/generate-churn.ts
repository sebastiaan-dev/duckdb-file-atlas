import { constants, closeSync, openSync } from "node:fs";
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { inspectFile } from "../src/lib/reader";

const help = `Generate checkpointed TPC-H + ART churn snapshots for File Atlas.

Usage: bun scripts/generate-churn.ts [options]
  --duckdb PATH        CLI supporting STORAGE_VERSION 'v2.0.0'
                       (default: DUCKDB_BIN, ~/.duckdb/cli/latest/duckdb, or PATH)
  --out DIRECTORY      New output directory (default: .cache/tpch-sf2-churn)
  --sf NUMBER          TPC-H scale factor (default: 2; try 0.01 for a smoke run)
  --threads NUMBER     DuckDB worker threads (default: 4)
  --memory-limit SIZE  DuckDB memory limit (default: 4GB)
  --help               Show this help

Uses the tpch extension (INSTALL may download it). Allow several GiB of disk
space for SF2; snapshot copies use copy-on-write when the filesystem supports it.
The output directory must not already exist. SQL, logs, counts, index definitions,
engine provenance, and visualizer decoding status are retained alongside six
.duckdb snapshots. No existing database is modified.
`;

const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
const identifier = (text: string) => `"${text.replaceAll('"', '""')}"`;
const cliFlags = ["-no-agent", "-no-init", "-batch", "-bail", "-no-stdin"];
const baseTables = [
  "region",
  "nation",
  "supplier",
  "customer",
  "part",
  "partsupp",
  "orders",
  "lineitem",
];

interface Stage {
  name: string;
  description: string;
  lookFor: string;
  sql: string;
  tables: string[];
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      duckdb: { type: "string" },
      out: { type: "string" },
      sf: { type: "string", default: "2" },
      threads: { type: "string", default: "4" },
      "memory-limit": { type: "string", default: "4GB" },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(help);
    return;
  }
  const sf = Number(values.sf);
  const threads = Number(values.threads);
  if (!Number.isFinite(sf) || sf <= 0)
    throw new Error("--sf must be positive and finite.");
  if (!Number.isSafeInteger(threads) || threads < 1)
    throw new Error("--threads must be a positive integer.");
  const eventCount = Math.ceil(sf * 200_000);
  if (!Number.isSafeInteger(eventCount))
    throw new Error("Scale factor is too large.");
  const installed = join(homedir(), ".duckdb/cli/latest/duckdb");
  const duckdb =
    values.duckdb ??
    process.env.DUCKDB_BIN ??
    ((await Bun.file(installed).exists()) ? installed : "duckdb");
  const executable = Bun.which(duckdb);
  if (!executable)
    throw new Error(`DuckDB CLI not found: ${duckdb}. Pass --duckdb PATH.`);
  const versionResult = Bun.spawnSync([executable, "-no-agent", "--version"]);
  if (versionResult.exitCode !== 0)
    throw new Error(versionResult.stderr.toString());
  const version = versionResult.stdout.toString().trim();
  const directory = resolve(values.out ?? `.cache/tpch-sf${sf}-churn`);
  await mkdir(dirname(directory), { recursive: true });
  // Deliberately not recursive: never mix a new run with old snapshots or logs.
  try {
    await mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `Output directory already exists: ${directory}. Choose a new --out directory.`,
      );
    throw error;
  }
  const work = join(directory, "working.duckdb");
  const baseline = join(directory, "01-tpch.duckdb");
  const temp = join(directory, "spill");
  await mkdir(temp);
  const settings = `
SET threads = ${threads};
SET memory_limit = ${quote(values["memory-limit"]!)};
SET temp_directory = ${quote(temp)};
SET checkpoint_threshold = '16GB';
`;
  const stages: Stage[] = [
    {
      name: "01-tpch",
      description: `Unindexed TPC-H SF${sf}, using the normal generated row order.`,
      lookFor:
        "Baseline table/column compression, row groups, metadata slots, and physical packing.",
      tables: baseTables,
      sql: `
ATTACH ${quote(work)} AS atlas (STORAGE_VERSION 'v2.0.0');
USE atlas;
INSTALL tpch;
LOAD tpch;
CALL dbgen(sf = ${sf});
`,
    },
    {
      name: "02-indexed",
      description:
        "Add five ART indexes: unique integer, duplicate integer, composite, and two string indexes.",
      lookFor:
        "Index/table footprint, allocator node families, and buffer occupancy before churn.",
      tables: baseTables,
      sql: `
CREATE UNIQUE INDEX orders_key_idx ON orders(o_orderkey);
CREATE INDEX orders_customer_idx ON orders(o_custkey);
CREATE UNIQUE INDEX lineitem_order_line_idx ON lineitem(l_orderkey, l_linenumber);
CREATE INDEX customer_name_idx ON customer(c_name);
CREATE INDEX part_name_idx ON part(p_name);
`,
    },
    {
      name: "03-deleted",
      description:
        "Delete approximately 40% of orders and their lineitems, spread across the key space.",
      lookFor:
        "Live versus physical row counts, ART free-slot holes, and whole reusable blocks. Deletes are not guaranteed to shrink the file.",
      tables: baseTables,
      sql: `
BEGIN;
DELETE FROM lineitem WHERE l_orderkey % 10 IN (0, 1, 2, 3);
DELETE FROM orders WHERE o_orderkey % 10 IN (0, 1, 2, 3);
COMMIT;
`,
    },
    {
      name: "04-refilled-updated",
      description:
        "Restore one deleted key cohort, append another with new keys, then update indexed and non-indexed columns.",
      lookFor:
        "Reused index slots, new row groups, changed string compression, and mixed old/new allocations.",
      tables: baseTables,
      sql: `
-- Read seeds from the closed baseline, not from extra tables in the working file.
ATTACH ${quote(baseline)} AS seed (READ_ONLY);
BEGIN;
INSERT INTO orders SELECT * FROM seed.main.orders WHERE o_orderkey % 10 = 0;
INSERT INTO lineitem SELECT * FROM seed.main.lineitem WHERE l_orderkey % 10 = 0;
INSERT INTO orders
  SELECT * REPLACE (
    o_orderkey + (SELECT max(o_orderkey) + 1 FROM seed.main.orders) AS o_orderkey,
    o_orderdate + 365 AS o_orderdate
  ) FROM seed.main.orders WHERE o_orderkey % 10 = 1;
INSERT INTO lineitem
  SELECT * REPLACE (
    l_orderkey + (SELECT max(o_orderkey) + 1 FROM seed.main.orders) AS l_orderkey,
    l_shipdate + 365 AS l_shipdate,
    l_commitdate + 365 AS l_commitdate,
    l_receiptdate + 365 AS l_receiptdate
  ) FROM seed.main.lineitem WHERE l_orderkey % 10 = 1;
UPDATE orders SET
  o_custkey = ((o_custkey + 16) % (SELECT max(c_custkey) FROM customer)) + 1,
  o_comment = 'updated: ' || md5(o_orderkey::VARCHAR)
WHERE o_orderkey % 13 = 0;
UPDATE part SET p_name = p_name || ' refreshed' WHERE p_partkey % 10 = 0;
UPDATE lineitem SET l_comment = l_comment || ' / ' || md5(l_orderkey::VARCHAR)
WHERE l_orderkey % 17 = 0;
COMMIT;
DETACH seed;
`,
    },
    {
      name: "05-additions",
      description: `Add ${eventCount.toLocaleString()} synthetic events, three indexes, and a disposable staging table.`,
      lookFor:
        "Duplicate-key leaf storage, string prefixes, null validity, long-string auxiliary storage, and new allocations.",
      tables: [...baseTables, "churn_events", "churn_stage"],
      sql: `
CREATE TABLE churn_events AS
SELECT i::BIGINT AS id,
       (i % 64)::INTEGER AS bucket,
       'tenant/' || (i % 64)::VARCHAR || '/event/' || md5(i::VARCHAR) AS path,
       CASE WHEN i % 7 = 0 THEN NULL ELSE (i % 1000)::INTEGER END AS nullable_value,
       DATE '2026-01-01' + (i % 180)::INTEGER AS event_date,
       CASE WHEN i % 128 = 0 THEN repeat(md5(i::VARCHAR), 160)
            WHEN i % 3 = 0 THEN repeat('repeatable payload ', 8)
            ELSE md5(i::VARCHAR) || md5((i + 1)::VARCHAR) END AS payload
FROM range(${eventCount}) t(i);
CREATE UNIQUE INDEX events_id_idx ON churn_events(id);
CREATE INDEX events_bucket_idx ON churn_events(bucket);
CREATE INDEX events_path_idx ON churn_events(path);
CREATE TABLE churn_stage AS
SELECT id, path, payload || md5(path) AS payload FROM churn_events;
`,
    },
    {
      name: "06-index-and-table-churn",
      description:
        "Drop staging and two indexes; delete most events; checkpoint; reinsert fresh events and rebuild/change indexes.",
      lookFor:
        "Free runs and their file positions, allocation reuse, old versus rebuilt ART storage, and remaining tail allocations.",
      tables: [...baseTables, "churn_events"],
      sql: `
DROP TABLE churn_stage;
DROP INDEX customer_name_idx;
DROP INDEX orders_customer_idx;
DELETE FROM churn_events WHERE id % 4 <> 0;
-- Persist the sparse state before allocating again, so reuse can occur.
CHECKPOINT;
INSERT INTO churn_events
SELECT id + ${eventCount} AS id, bucket,
       'new/' || path AS path, nullable_value, event_date + 180 AS event_date,
       payload || ' appended' AS payload
FROM churn_events;
UPDATE churn_events SET bucket = (bucket + 1) % 64 WHERE id % 8 = 0;
CREATE INDEX orders_status_customer_idx ON orders(o_orderstatus, o_custkey);
DROP INDEX part_name_idx;
CREATE INDEX part_name_idx ON part(p_name);
DROP INDEX events_path_idx;
CREATE INDEX events_path_idx ON churn_events(path);
`,
    },
  ];

  const manifest = {
    format: "file-atlas-churn/v1",
    createdAt: new Date().toISOString(),
    engine: version,
    executable,
    sf,
    threads,
    memoryLimit: values["memory-limit"],
    storageVersion: 69,
    complete: false,
    stages: [] as Record<string, unknown>[],
  };
  const saveManifest = () =>
    writeFile(
      join(directory, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
  await saveManifest();
  await writeFile(
    join(directory, "README.md"),
    `# File Atlas churn snapshots\n\n${version}\n\nTPC-H SF${sf}, ${threads} threads, ${values["memory-limit"]} memory limit.\n\nOpen the numbered .duckdb files directly in File Atlas. Each is checkpointed\nand copied only after its writer exits. The baseline is reused only as a\nread-only seed source. This is a visualization workload, not a valid TPC-H\nbenchmark after churn. Physical placement can vary with engine and threading.\n\n${stages.map((stage) => `## ${stage.name}.duckdb\n\n${stage.description}\n\nLook for: ${stage.lookFor}\n`).join("\n")}\nSQL and logs are retained per stage; manifest.json contains exact row counts\nand index definitions. A failed run keeps working.duckdb for diagnosis and\nleaves complete=false. Do not open the working file while generation runs.\n`,
  );

  console.log(`DuckDB: ${version}\nOutput: ${directory}`);
  for (const [i, stage] of stages.entries()) {
    const sql = settings + stage.sql + "\nCHECKPOINT;\n";
    const sqlPath = join(directory, stage.name + ".sql");
    const logPath = join(directory, stage.name + ".log");
    await writeFile(sqlPath, sql);
    const start = Date.now();
    console.log(
      `[${i + 1}/${stages.length}] ${stage.name}: ${stage.description}`,
    );
    const log = openSync(logPath, "wx");
    try {
      const child = Bun.spawn(
        [executable, ...cliFlags, i === 0 ? ":memory:" : work, "-c", sql],
        { stdin: "ignore", stdout: log, stderr: log },
      );
      const exit = await child.exited;
      if (exit !== 0)
        throw new Error(
          `Stage ${stage.name} failed (exit ${exit}). See ${logPath}`,
        );
    } finally {
      closeSync(log);
    }
    // Do not snapshot a database with outstanding WAL/recovery state.
    for (const suffix of [".wal", ".wal.checkpoint", ".wal.recovery"]) {
      const wal = Bun.file(work + suffix);
      if ((await wal.exists()) && (await wal.stat()).size > 0)
        throw new Error(
          `Refusing to copy database with nonempty ${work + suffix}`,
        );
    }
    // Keep valid DuckDB snapshots even when File Atlas hits a decoding limit.
    // This workload is also a way to discover gaps in the visualizer.
    let visualizer: Record<string, unknown>;
    try {
      const inspection = await inspectFile(Bun.file(work) as unknown as File);
      visualizer = {
        storageVersion: inspection.storageVersion,
        blockSize: inspection.blockSize,
        checkpoint: inspection.activeHeader,
        nativeComplete: inspection.native?.complete ?? false,
        measuredIndexes:
          inspection.indexes?.filter((index) => index.complete).length ?? 0,
        freeBlocks: inspection.freeList?.complete
          ? inspection.freeList.blockIds.length +
            inspection.freeList.implicitBlockIds.length
          : null,
        warnings: inspection.warnings,
      };
    } catch (error) {
      visualizer = {
        error: error instanceof Error ? error.message : String(error),
      };
      console.warn(`  Visualizer warning: ${visualizer.error}`);
    }
    const snapshot = join(directory, stage.name + ".duckdb");
    await copyFile(
      work,
      snapshot,
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
    );

    const counts = stage.tables
      .map(
        (table) =>
          `SELECT ${quote(table)} AS table_name, count(*) AS rows FROM ${identifier(table)}`,
      )
      .join(" UNION ALL ");
    function audit(query: string) {
      const result = Bun.spawnSync(
        [executable!, ...cliFlags, "-readonly", "-json", snapshot, "-c", query],
        { stdout: "pipe", stderr: "pipe" },
      );
      if (result.exitCode !== 0)
        throw new Error(`Audit failed: ${result.stderr.toString()}`);
      return JSON.parse(result.stdout.toString());
    }
    const fileSize = (await stat(snapshot)).size;
    const tables = audit(counts);
    const indexes = audit(
      "SELECT index_name, table_name, is_unique, expressions, sql FROM duckdb_indexes() ORDER BY index_name",
    );
    manifest.stages.push({
      name: stage.name,
      description: stage.description,
      lookFor: stage.lookFor,
      file: stage.name + ".duckdb",
      bytes: fileSize,
      visualizer,
      seconds: Math.round((Date.now() - start) / 100) / 10,
      tables,
      indexes,
    });
    await saveManifest();
    console.log(
      `  ${(fileSize / 1024 ** 2).toFixed(1)} MiB · ${indexes.length} indexes · ${((Date.now() - start) / 1000).toFixed(1)} s`,
    );
  }
  await rm(work);
  await rm(temp, { recursive: true });
  manifest.complete = true;
  await saveManifest();
  console.log(
    `\nDone. Open ${join(directory, "06-index-and-table-churn.duckdb")}\nCompare with 02-indexed.duckdb and 03-deleted.duckdb for index occupancy changes.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
