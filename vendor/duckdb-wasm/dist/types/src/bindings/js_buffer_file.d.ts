/**
 * js_buffer:// files: bytes held by the runtime, outside the WASM heap.
 *
 * The WASM heap is the scarce resource of DuckDB in the browser, not the disk. DuckDB's temporary directory
 * (spilling) therefore points here by default (js_buffer://tmp): blocks that do not fit the memory limit move to
 * JavaScript memory and come back when needed, with no file system involved and the same behaviour on every
 * platform.
 *
 * The file offers the subset of FileSystemSyncAccessHandle the runtime uses, so the file operations of the
 * runtime treat it like an OPFS access handle.
 */
export declare const JS_BUFFER_PREFIX = "js_buffer://";
export declare class JsBufferFile {
    private chunks;
    private size;
    getSize(): number;
    read(out: Uint8Array, options: {
        at: number;
    }): number;
    write(input: Uint8Array, options: {
        at: number;
    }): number;
    truncate(size: number): void;
    flush(): void;
    close(): void;
    /** Chunks come into existence as the file grows, zero-filled */
    private reserve;
}
/** The js_buffer:// files of a runtime, keyed by path */
export declare class JsBufferFileSystem {
    private files;
    static isPath(path: string): boolean;
    get(path: string): JsBufferFile | undefined;
    /** Open a file, created if asked for */
    open(path: string, create: boolean): JsBufferFile | null;
    exists(path: string): boolean;
    remove(path: string): void;
    move(from: string, to: string): void;
    /** Any path with the scheme is a directory that exists, there is no hierarchy to maintain */
    directoryExists(path: string): boolean;
    /** The files directly below a directory */
    list(directory: string): string[];
    /** Remove a directory with everything in it */
    removeDirectory(directory: string): void;
    /** All paths, for globbing */
    paths(): string[];
}
