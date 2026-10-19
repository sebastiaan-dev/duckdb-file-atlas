/**
 * OPFS scratch: synchronous creation of `opfs://` files.
 *
 * OPFS sync access handles can only be acquired asynchronously, but DuckDB opens files from synchronous code in the
 * middle of a query. Real files (`opfs://<path>` at `/duckdb/fs/<path>`) therefore have their handles prepared ahead
 * of a query, and only the files a query names are open: an access handle is exclusive (a `read-only` one still
 * excludes writers), so a file held open here is unavailable to other tabs. Reads take `read-only` handles, which
 * other tabs can share, databases take `readwrite` ones. Files DuckDB names at runtime (temporary files of a COPY, write-ahead logs, spill files, ...) cannot be
 * prepared: they are served from a pool of pre-opened files in `/duckdb/scratch/<uuid>/`, and a manifest records
 * which virtual path each pool file stands for. Renames and removals are manifest edits. Between queries a
 * checkpoint moves the mapped pool files to their real paths, so the directory converges to real names and the
 * manifest to empty. Each DuckDB instance (tab) has its own scratch directory, the exclusive sync handle on its
 * manifest tells whether the owner is still alive; scratch directories of dead owners are reconciled at startup.
 *
 * Layout of the OPFS root (other programs may use the root, nothing outside `/duckdb/` is touched):
 *   /duckdb/fs/<path>                 <-> opfs://<path>
 *   /duckdb/scratch/<uuid>/manifest   one JSON line per mapping {"v": virtual path, "p": pool file}
 *   /duckdb/scratch/<uuid>/pool-<k>   pre-opened files, mapped ones are in flight to /duckdb/fs, the rest are free
 * Files that exist at the root (the layout before /duckdb/fs) are read in place.
 *
 * Directories: the tree below /duckdb/fs is walked at mount (names only, nothing is opened), so existence, listing
 * and globbing are answered synchronously. Creating and removing directories are recorded and applied at the
 * checkpoint, like the moves of files. The walk is repeated before a glob is expanded, other tabs may have added
 * files.
 */
export declare const OPFS_PREFIX = "opfs://";
/** DuckDB's home directory: small files below it are cached at mount, DuckDB opens them (persistent secrets)
 * without naming them in SQL, so they cannot be prepared ahead of a query */
export declare const OPFS_HOME = "opfs://home";
export type OPFSAccessMode = 'read' | 'write';
export interface OPFSScratchOptions {
    /** The number of pre-opened pool files, the number of files a single query can create */
    poolSize: number;
    /** Receives a debug line per scratch operation */
    debug?: (event: string, ...args: any[]) => void;
}
export declare class OPFSScratch {
    /** The OPFS root */
    private root;
    /** /duckdb/fs */
    private fsDir;
    /** /duckdb/scratch/<uuid> */
    private scratchDir;
    /** The manifest, its exclusive handle also tells other instances that this one is alive */
    private manifest;
    private manifestSize;
    /** Free pool files */
    private pool;
    private poolCounter;
    private readonly poolSize;
    /** Virtual paths served from a pool file */
    private mapped;
    /** Virtual paths served from a real file, open */
    private real;
    /** Files below /duckdb/fs, known from the walk; open or not */
    private tree;
    /** The content of small files below the home directory, served copy-on-open */
    private cached;
    /** Virtual paths written to since the last checkpoint */
    private written;
    /** Real files removed or replaced, deleted at the next checkpoint */
    private pendingDelete;
    /** Files removed that were not open, deleted by path at the next checkpoint */
    private pendingDeletePaths;
    /** Directories below /duckdb/fs, as virtual paths without trailing separator (the root is implicit) */
    private directories;
    /** Directories created and removed since the last checkpoint, applied in that order after the file deletes */
    private pendingCreateDirs;
    private pendingRemoveDirs;
    private constructor();
    /** The debug log */
    private readonly debug;
    /** Mount: create the layout, open the manifest, fill the pool, reconcile scratch of dead instances */
    static mount(options: OPFSScratchOptions): Promise<OPFSScratch>;
    /** Open sync access handles for every file below a directory. Files another instance holds open are skipped */
    /** Walk a directory, recording the names of files and directories */
    private scan;
    /** Walk /duckdb/fs again: files and directories that other tabs added or removed since the mount */
    rescan(): Promise<void>;
    /** The handles of the sync access registry are keyed by virtual path, this is the view of them */
    get handles(): Map<string, FileSystemSyncAccessHandle>;
    /** Get the sync access handle of a virtual path, if it is open */
    getHandle(path: string): FileSystemSyncAccessHandle | undefined;
    /** Does the file exist? */
    exists(path: string): boolean;
    /** Is the file open with a read-only handle? */
    isReadOnly(path: string): boolean;
    /** Is there anything for a checkpoint to do? */
    get dirty(): boolean;
    /** Prepare a real file ahead of a query: open its access handle. Returns false if the file does not exist, it
     * is then created in the scratch when first opened */
    prepare(path: string, mode: OPFSAccessMode): Promise<boolean>;
    /** The files a glob pattern matches, the tree is rescanned first */
    expand(pattern: string): Promise<string[]>;
    /** Checkpoint: delete removed files, move mapped pool files to their real paths, refill the pool */
    checkpoint(): Promise<void>;
    private checkpointInternal;
    /** Close everything, the scratch directory of a cleanly closed instance is removed */
    close(): Promise<void>;
    /** Open a virtual path for DuckDB: the prepared real file, the mapped pool file, or a fresh pool file */
    open(path: string): FileSystemSyncAccessHandle;
    /** Note a write, the checkpoint moves written copies into place */
    markWritten(path: string): void;
    /** Release a real file's handle without removing the file (DuckDB dropped it from its registry) */
    release(path: string): void;
    /** Move a file: a manifest edit, the content is never copied */
    move(from: string, to: string): void;
    /** Remove a file */
    remove(path: string): void;
    /** Does the directory exist? The root always does, a directory also exists through its files */
    directoryExists(path: string): boolean;
    /** Create a directory, with its parents */
    createDirectory(path: string): void;
    /** Remove a directory with everything below it */
    removeDirectory(path: string): void;
    /** The entries directly below a directory */
    list(path: string): {
        name: string;
        isDirectory: boolean;
    }[];
    /** The files matching a glob pattern (* within a name, ** across directories, ? a character) */
    glob(pattern: string): string[];
    /** All files: known on disk and in flight, the pending deletes are gone already */
    private files;
    /** A directory path without its trailing separator */
    private static trimDirectory;
    /** The directory and its parents, outermost first */
    private static parents;
    private removeInternal;
    /** Resolve a directory below /duckdb/fs, created on request */
    private resolveDirectory;
    /** Locate a real file: under /duckdb/fs, or at the root for files of the previous layout */
    private locate;
    /** Fill the pool */
    private replenish;
    private appendManifest;
    private rewriteManifest;
    /** Reconcile the scratch directories of instances that are no longer alive */
    private sweep;
}
