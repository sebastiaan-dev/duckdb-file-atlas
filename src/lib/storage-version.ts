/** DuckDB storage format versions this reader decodes (v1.0.0 through v2.0.0). */
export const MIN_STORAGE_VERSION = 64;
export const LATEST_STORAGE_VERSION = 69;

const NAMES: Record<number, string> = {
  64: "v1.0.0",
  65: "v1.2.0",
  66: "v1.3.0",
  67: "v1.4.0",
  68: "v1.5.0",
  69: "v2.0.0",
};

export function storageVersionName(version: number): string {
  return NAMES[version] ?? `storage ${version}`;
}

/**
 * Resolve the checkpoint header's version field to a storage version.
 *
 * From v2.0.0 the field stores the storage version (69) and the main header
 * stores 999. Before that it stored the deprecated *serialization* version,
 * which DuckDB maps as follows (SingleFileBlockManager
 * SetStorageVersionInDatabaseHeader). Some old releases wrote the storage
 * version 64 by mistake; 0 means "unset". Returns null when unknown.
 */
export function resolveStorageVersion(
  mainVersion: bigint,
  headerValue: number,
): number | null {
  if (mainVersion === 999n || headerValue >= LATEST_STORAGE_VERSION)
    return headerValue === LATEST_STORAGE_VERSION ? headerValue : null;
  switch (headerValue) {
    case 0: // unset
    case 1: // v0.10.2
    case 64: // storage version written by mistake
    case 2: // v1.0.0
    case 3: // v1.1.0
      return 64;
    case 4:
      return 65;
    case 5:
      return 66;
    case 6:
      return 67;
    case 7:
      return 68;
    default:
      return null;
  }
}
