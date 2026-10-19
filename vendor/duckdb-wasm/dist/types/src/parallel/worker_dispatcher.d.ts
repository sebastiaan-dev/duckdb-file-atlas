import { DuckDBBindings } from '../bindings';
import { WorkerResponseVariant, WorkerRequestVariant } from './worker_request';
import { Logger, LogEntryVariant } from '../log';
import { InstantiationProgress } from '../bindings/progress';
export declare abstract class AsyncDuckDBDispatcher implements Logger {
    /** The bindings */
    protected _bindings: DuckDBBindings | null;
    /** The next message id */
    protected _nextMessageId: number;
    /** Instantiate the wasm module */
    protected abstract instantiate(mainModule: string, pthreadWorker: string | null, progress: (p: InstantiationProgress) => void): Promise<DuckDBBindings>;
    /** Post a response to the main thread */
    protected abstract postMessage(response: WorkerResponseVariant, transfer: ArrayBuffer[]): void;
    /** Send log entry to the main thread */
    log(entry: LogEntryVariant): void;
    /** Send plain OK without further data */
    protected sendOK(request: WorkerRequestVariant): void;
    /** Fail with an error */
    protected failWith(request: WorkerRequestVariant, e: Error): void;
    /** The requests are processed in the order they arrive, even if a request has to wait for asynchronous work */
    private _requests;
    /** Checkpoint files, unless a query is still executing: a pending query that was not polled to its end or a
     * result stream that was not fetched to its end keeps DuckDB's worker threads busy between requests */
    private checkpointFiles;
    /** Process a request from the main thread */
    onMessage(request: WorkerRequestVariant): Promise<void>;
    /** Process a single request */
    private processRequest;
}
