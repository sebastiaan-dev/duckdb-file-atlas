/**
 * Vendor a DuckDB-WASM build that can write v2.0 storage.
 *
 * No published DuckDB-WASM package can write STORAGE_VERSION 'v2.0.0' yet, so
 * the generator pins a duckdb-wasm CI build (loadable-extension variant) of
 * DuckDB 2.0. This script turns one such CI run into:
 *
 *   vendor/duckdb-wasm/       the small JS API package (committed, used via
 *                             `file:`), plus runtime.json with checksums
 *   .cache/duckdb-wasm/<id>/  the large runtime assets (WASM, worker, TPC-H
 *                             extension), which `--publish` uploads to a
 *                             GitHub release of this repository
 *
 * CI artifacts expire, so the release is the durable source that
 * scripts/fetch-duckdb-runtime.ts downloads from (and verifies) at build time.
 *
 *   bun scripts/vendor-duckdb-wasm.ts <duckdb-wasm run id> [--publish]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

const UPSTREAM = "duckdb/duckdb-wasm";
/**
 * Extensions served next to the runtime. TPC-H/TPC-DS generate samples; the
 * others are autoloaded by user SQL (time zones, JSON, Parquet). Core
 * functions and nanoarrow are linked into the runtime itself.
 */
const EXTENSIONS = ["tpch", "tpcds", "icu", "json", "parquet"];
const ROOT = join(import.meta.dir, "..");
const VENDOR = join(ROOT, "vendor/duckdb-wasm");

const [runId, ...flags] = process.argv.slice(2);
if (!runId || !/^\d+$/.test(runId)) {
  console.error(
    "usage: bun scripts/vendor-duckdb-wasm.ts <run id> [--publish]",
  );
  process.exit(2);
}
const publish = flags.includes("--publish");
const repository = execFileSync(
  "gh",
  ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
  { cwd: ROOT, encoding: "utf8" },
).trim();

const sha256 = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? files(join(directory, entry.name))
        : [join(directory, entry.name)],
    ),
  );
  return nested.flat();
}

const work = await mkdtemp(join(tmpdir(), "duckdb-wasm-vendor-"));
try {
  for (const artifact of [
    "duckdb-wasm-packages-loadable",
    "extension-repository-base-loadable",
  ]) {
    execFileSync(
      "gh",
      [
        "run",
        "download",
        runId,
        "-R",
        UPSTREAM,
        "-n",
        artifact,
        "-D",
        join(work, artifact),
      ],
      { stdio: "inherit" },
    );
    // Some artifacts arrive as a nested zip.
    for (const file of await files(join(work, artifact)))
      if (file.endsWith(".zip"))
        execFileSync("unzip", ["-q", "-o", file, "-d", dirname(file)]);
  }
  const pkg = join(work, "duckdb-wasm-packages-loadable/packages/duckdb-wasm");
  const manifest = JSON.parse(
    await readFile(join(pkg, "package.json"), "utf8"),
  );
  const extensionRoot = join(work, "extension-repository-base-loadable");
  const [sourceId] = await readdir(extensionRoot);
  const version = manifest.version as string;
  const tag = `duckdb-wasm-${version}`;

  // 1. The JS API package: browser ESM build and its types only.
  await rm(VENDOR, { recursive: true, force: true });
  await mkdir(join(VENDOR, "dist"), { recursive: true });
  await cp(
    join(pkg, "dist/duckdb-browser.mjs"),
    join(VENDOR, "dist/duckdb-browser.mjs"),
  );
  await cp(
    join(pkg, "dist/duckdb-browser.d.ts"),
    join(VENDOR, "dist/duckdb-browser.d.ts"),
  );
  await cp(join(pkg, "dist/types"), join(VENDOR, "dist/types"), {
    recursive: true,
    filter: (source) => !source.includes("/types/test"),
  });
  await writeFile(
    join(VENDOR, "package.json"),
    `${JSON.stringify(
      {
        name: "@duckdb/duckdb-wasm",
        version,
        description: `${manifest.description} (vendored CI build, see README.md)`,
        license: manifest.license,
        type: "module",
        module: "dist/duckdb-browser.mjs",
        types: "dist/duckdb-browser.d.ts",
        exports: {
          ".": {
            types: "./dist/duckdb-browser.d.ts",
            import: "./dist/duckdb-browser.mjs",
          },
        },
        sideEffects: false,
        dependencies: manifest.dependencies,
      },
      null,
      2,
    )}\n`,
  );
  const license = execFileSync(
    "gh",
    [
      "api",
      `repos/${UPSTREAM}/contents/LICENSE`,
      "-H",
      "Accept: application/vnd.github.raw",
    ],
    { encoding: "utf8" },
  );
  await writeFile(join(VENDOR, "LICENSE"), license);

  // 2. Runtime assets, staged for the release and described with checksums.
  const stage = join(ROOT, ".cache/duckdb-wasm", sourceId);
  await rm(stage, { recursive: true, force: true });
  const assets = [
    { source: join(pkg, "dist/duckdb-base.wasm"), path: "duckdb-base.wasm" },
    {
      source: join(pkg, "dist/duckdb-browser-base.worker.js"),
      path: "duckdb-browser-base.worker.js",
    },
    // DuckDB-WASM requests `<repository>/<source id>/<platform>/<name>`.
    ...EXTENSIONS.map((name) => ({
      source: join(
        extensionRoot,
        sourceId,
        `wasm_base/${name}.duckdb_extension.wasm`,
      ),
      path: `extensions/${sourceId}/wasm_base/${name}.duckdb_extension.wasm`,
    })),
  ];
  const runtime = [];
  for (const asset of assets) {
    const target = join(stage, asset.path);
    await mkdir(dirname(target), { recursive: true });
    await cp(asset.source, target);
    const name = asset.path.split("/").at(-1)!;
    runtime.push({
      asset: name,
      path: asset.path,
      size: (await readFile(target)).length,
      sha256: await sha256(target),
    });
  }
  const duckdbVersion = execFileSync(
    "node",
    [
      "-e",
      // The worker embeds the DuckDB version it was built from.
      `const s=require('fs').readFileSync(${JSON.stringify(join(pkg, "dist/duckdb-base.wasm"))},'latin1');` +
        "const m=s.match(/v\\d+\\.\\d+\\.\\d+-dev\\d+/);process.stdout.write(m?m[0]:'unknown')",
    ],
    { encoding: "utf8" },
  );
  await writeFile(
    join(VENDOR, "runtime.json"),
    `${JSON.stringify(
      {
        package: version,
        duckdb: duckdbVersion,
        sourceId,
        upstreamRun: `https://github.com/${UPSTREAM}/actions/runs/${runId}`,
        repository,
        tag,
        release: `https://github.com/${repository}/releases/download/${tag}/`,
        files: runtime,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(VENDOR, "README.md"),
    `# Vendored DuckDB-WASM ${version}

DuckDB-WASM built from DuckDB ${duckdbVersion} (source \`${sourceId}\`) by
duckdb-wasm CI run <https://github.com/${UPSTREAM}/actions/runs/${runId}>
(loadable-extension variant). Published DuckDB-WASM packages cannot write
\`STORAGE_VERSION 'v2.0.0'\` yet; the TPC-H generator needs a DuckDB 2.0 build.

Only the JS API lives here. The WASM module, worker and extensions are
release assets of this repository (\`${tag}\`), listed with checksums in
\`runtime.json\` and fetched by \`scripts/fetch-duckdb-runtime.ts\`.

Regenerate with \`bun scripts/vendor-duckdb-wasm.ts <run id> --publish\`.
DuckDB and DuckDB-WASM are MIT licensed; see LICENSE.
`,
  );

  if (publish) {
    const uploads = runtime.map((file) => join(stage, file.path));
    const exists = execFileSync(
      "gh",
      ["release", "list", "--json", "tagName", "-q", ".[].tagName"],
      {
        cwd: ROOT,
        encoding: "utf8",
      },
    )
      .split("\n")
      .includes(tag);
    if (exists)
      execFileSync("gh", ["release", "upload", tag, ...uploads, "--clobber"], {
        cwd: ROOT,
        stdio: "inherit",
      });
    else
      execFileSync(
        "gh",
        [
          "release",
          "create",
          tag,
          ...uploads,
          "--title",
          `DuckDB-WASM ${version} runtime (DuckDB ${duckdbVersion})`,
          "--notes",
          `Runtime assets for the in-browser TPC-H generator, vendored from ${UPSTREAM} run ${runId}. Checksums: vendor/duckdb-wasm/runtime.json.`,
          "--prerelease",
        ],
        { cwd: ROOT, stdio: "inherit" },
      );
  }
  console.log(
    `Vendored ${version} (DuckDB ${duckdbVersion}, ${sourceId}) into ${relative(ROOT, VENDOR)}`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
