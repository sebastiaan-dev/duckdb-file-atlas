import { DuckDBRuntime, DuckDBFileInfo } from './runtime';
import { DuckDBModule } from './duckdb_module';
import { JsBufferFile, JsBufferFileSystem } from './js_buffer_file';
export declare const NODE_RUNTIME: DuckDBRuntime & {
    _filesById: Map<number, any>;
    _fileInfoCache: Map<number, DuckDBFileInfo>;
    /** js_buffer:// files, DuckDB's temporary directory among them */
    _jsBuffers: JsBufferFileSystem;
    resolveFileInfo(mod: DuckDBModule, fileId: number): DuckDBFileInfo | null;
    jsBuffer(path: string): JsBufferFile;
};
export default NODE_RUNTIME;
