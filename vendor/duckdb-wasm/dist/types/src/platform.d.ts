export declare const isNode: () => boolean;
export declare const isFirefox: () => boolean;
export declare const isSafari: () => boolean;
/** Bundles have different characteristics:
 * - base: single-threaded, requires WebAssembly exception handling
 * - threads: multi-threaded, additionally requires SIMD, threads and cross origin isolation
 */
export interface DuckDBBundles {
    base: {
        mainModule: string;
        mainWorker: string;
    };
    threads?: {
        mainModule: string;
        mainWorker: string;
        pthreadWorker: string;
    };
}
export declare function getJsDelivrBundles(): DuckDBBundles;
export interface DuckDBBundle {
    mainModule: string;
    mainWorker: string | null;
    pthreadWorker: string | null;
}
export interface PlatformFeatures {
    bigInt64Array: boolean;
    crossOriginIsolated: boolean;
    wasmExceptions: boolean;
    wasmSIMD: boolean;
    wasmBulkMemory: boolean;
    wasmThreads: boolean;
}
export declare function getPlatformFeatures(): Promise<PlatformFeatures>;
/** Every bundle requires WebAssembly exception handling, throws if the platform does not support it */
export declare function checkPlatformSupport(): Promise<PlatformFeatures>;
export declare function selectBundle(bundles: DuckDBBundles): Promise<DuckDBBundle>;
