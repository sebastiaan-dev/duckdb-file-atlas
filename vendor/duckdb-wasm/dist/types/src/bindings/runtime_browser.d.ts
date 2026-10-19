import { Logger } from '../log';
import { OPFSScratch } from './opfs_scratch';
import { JsBufferFile, JsBufferFileSystem } from './js_buffer_file';
import { DuckDBFileInfo, DuckDBGlobalFileInfo, DuckDBRuntime } from './runtime';
import { DuckDBModule } from './duckdb_module';
export declare const BROWSER_RUNTIME: DuckDBRuntime & {
    _files: Map<string, any>;
    _fileInfoCache: Map<number, DuckDBFileInfo>;
    _globalFileInfo: DuckDBGlobalFileInfo | null;
    _preparedHandles: Record<string, FileSystemSyncAccessHandle>;
    _opfsRoot: FileSystemDirectoryHandle | null;
    _opfsScratch: OPFSScratch | null;
    _opfsScratchMount: Promise<OPFSScratch> | null;
    _logger: Logger | null;
    /** OPFS files prepared ahead of queries, held open until dropped */
    _opfsPinned: Set<string>;
    /** DuckDB's open handles per OPFS file, files it does not hold are released after a checkpoint */
    _opfsOpen: Map<string, number>;
    /** js_buffer:// files, DuckDB's temporary directory among them */
    _jsBuffers: JsBufferFileSystem;
    jsBuffer(path: string): JsBufferFile;
    /** Log a file operation at debug level */
    debug(event: string, ...args: any[]): void;
    _opfsCheckpoint: Promise<void> | null;
    getFileInfo(mod: DuckDBModule, fileId: number): DuckDBFileInfo | null;
    getGlobalFileInfo(mod: DuckDBModule): DuckDBGlobalFileInfo | null;
    assignOPFSRoot(): Promise<void>;
    checkpointFiles(): Promise<void>;
};
export default BROWSER_RUNTIME;
