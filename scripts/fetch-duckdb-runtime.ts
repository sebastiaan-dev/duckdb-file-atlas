/**
 * Make the vendored DuckDB-WASM runtime available to Vite under
 * public/duckdb-runtime/<source id>/, verifying every file against
 * vendor/duckdb-wasm/runtime.json. Files already present with the right
 * checksum are kept; a staged copy from scripts/vendor-duckdb-wasm.ts is used
 * before downloading from the GitHub release.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface RuntimeFile {
  asset: string;
  path: string;
  size: number;
  sha256: string;
}
interface RuntimeManifest {
  sourceId: string;
  repository: string;
  tag: string;
  release: string;
  files: RuntimeFile[];
}

const ROOT = join(import.meta.dir, "..");
const manifest: RuntimeManifest = JSON.parse(
  await readFile(join(ROOT, "vendor/duckdb-wasm/runtime.json"), "utf8"),
);
const target = join(ROOT, "public/duckdb-runtime", manifest.sourceId);
const staged = join(ROOT, ".cache/duckdb-wasm", manifest.sourceId);

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

async function verified(path: string, file: RuntimeFile) {
  if (!existsSync(path)) return null;
  const bytes = new Uint8Array(await readFile(path));
  return bytes.length === file.size && digest(bytes) === file.sha256
    ? bytes
    : null;
}

/** A token for private repositories: CI provides one, locally `gh` does. */
function token() {
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

let assetIds: Map<string, number> | undefined;
async function download(file: RuntimeFile): Promise<Uint8Array> {
  // Public releases download directly.
  const direct = new URL(file.asset, manifest.release);
  const response = await fetch(direct);
  if (response.ok) return new Uint8Array(await response.arrayBuffer());
  const auth = token();
  if (!auth || (response.status !== 404 && response.status !== 401))
    throw new Error(`Downloading ${direct} failed: HTTP ${response.status}`);
  // Private repositories need the authenticated asset API.
  const api = `https://api.github.com/repos/${manifest.repository}`;
  const headers = { Authorization: `Bearer ${auth}` };
  if (!assetIds) {
    const release = await fetch(`${api}/releases/tags/${manifest.tag}`, {
      headers,
    });
    if (!release.ok)
      throw new Error(
        `Release ${manifest.tag} of ${manifest.repository}: HTTP ${release.status}`,
      );
    const { assets } = (await release.json()) as {
      assets: { id: number; name: string }[];
    };
    assetIds = new Map(assets.map((asset) => [asset.name, asset.id]));
  }
  const id = assetIds.get(file.asset);
  if (id == null)
    throw new Error(`Release ${manifest.tag} has no asset ${file.asset}`);
  const asset = await fetch(`${api}/releases/assets/${id}`, {
    headers: { ...headers, Accept: "application/octet-stream" },
  });
  if (!asset.ok)
    throw new Error(`Downloading ${file.asset} failed: HTTP ${asset.status}`);
  return new Uint8Array(await asset.arrayBuffer());
}

let fetched = 0;
for (const file of manifest.files) {
  const destination = join(target, file.path);
  if (await verified(destination, file)) continue;
  const bytes =
    (await verified(join(staged, file.path), file)) ?? (await download(file));
  if (bytes.length !== file.size || digest(bytes) !== file.sha256)
    throw new Error(`Checksum mismatch for release asset ${file.asset}`);
  await mkdir(dirname(destination), { recursive: true });
  // Write atomically so an interrupted fetch never leaves a truncated asset.
  await writeFile(`${destination}.partial`, bytes);
  await rename(`${destination}.partial`, destination);
  fetched++;
}
if (fetched)
  console.log(
    `DuckDB-WASM runtime ${manifest.sourceId}: ${fetched} file(s) installed in public/`,
  );
