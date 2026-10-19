/**
 * Small helpers over the origin private file system (OPFS), which DuckDB-WASM
 * uses for `opfs://` paths and for its own scratch directories. DuckDB-WASM
 * chooses where inside OPFS it stores a file, so lookups search by name.
 */

export async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  if (!globalThis.navigator?.storage?.getDirectory)
    throw new Error(
      "This browser does not provide origin private file system storage.",
    );
  return navigator.storage.getDirectory();
}

type Entry = [string, FileSystemHandle];

async function entries(directory: FileSystemDirectoryHandle) {
  const found: Entry[] = [];
  // `entries()` is not in every lib.dom version; it is in every OPFS browser.
  for await (const entry of (
    directory as unknown as { entries(): AsyncIterable<Entry> }
  ).entries())
    found.push(entry);
  return found;
}

/** Depth-first search for a file by name. */
export async function findFile(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemFileHandle | null> {
  for (const [entryName, handle] of await entries(directory)) {
    if (handle.kind === "file" && entryName === name)
      return handle as FileSystemFileHandle;
    if (handle.kind === "directory") {
      const nested = await findFile(handle as FileSystemDirectoryHandle, name);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Remove every entry (at any depth) whose name matches. Entries another
 * context still holds open are skipped; they are retried on the next run.
 */
export async function removeMatching(
  directory: FileSystemDirectoryHandle,
  matches: (name: string, path: string) => boolean,
  path = "",
): Promise<number> {
  let removed = 0;
  for (const [name, handle] of await entries(directory)) {
    const entryPath = path ? `${path}/${name}` : name;
    if (matches(name, entryPath)) {
      try {
        await directory.removeEntry(name, { recursive: true });
        removed++;
      } catch {
        // Locked by a live worker (e.g. another tab); leave it.
      }
    } else if (handle.kind === "directory")
      removed += await removeMatching(
        handle as FileSystemDirectoryHandle,
        matches,
        entryPath,
      );
  }
  return removed;
}

/** Paths of all directories named `scratch/<id>`, used to spot new ones. */
export async function scratchDirectories(
  directory: FileSystemDirectoryHandle,
  path = "",
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const [name, handle] of await entries(directory)) {
    if (handle.kind !== "directory") continue;
    const entryPath = path ? `${path}/${name}` : name;
    if (path.split("/").at(-1) === "scratch") found.add(entryPath);
    else
      for (const nested of await scratchDirectories(
        handle as FileSystemDirectoryHandle,
        entryPath,
      ))
        found.add(nested);
  }
  return found;
}
