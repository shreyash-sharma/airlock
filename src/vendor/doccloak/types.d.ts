export type EntityType = 'PERSON' | 'EMAIL' | 'PHONE' | 'SSN' | 'CREDIT_CARD' | 'DATE' | 'CURRENCY' | 'IP_ADDRESS' | 'IBAN' | 'ADDRESS' | 'COMPANY' | 'SECRET' | 'API_KEY' | 'OTHER';
export interface DetectedEntity {
    type: EntityType;
    value: string;
    start: number;
    end: number;
    confidence: number;
    detector: string;
}
export type ProgressCallback = (downloaded: number, total: number) => void;
/**
 * A detect call was cancelled through its AbortSignal (T222). Providers throw
 * it between chunks, the engine before and after the ML pass, and the worker
 * protocol client when the host acknowledges a `cancelDetect`.
 */
export declare class DetectionAbortedError extends Error {
    constructor(message?: string);
}
/** Throw DetectionAbortedError when `signal` has been aborted. */
export declare function throwIfAborted(signal: AbortSignal | undefined): void;
/**
 * Interface for detection providers.
 * Implement this to add a new model/detection backend.
 * The engine only depends on this interface — swap providers without changing anything else.
 */
export interface DetectionProvider {
    /** Human-readable name for this provider */
    readonly name: string;
    /** Initialize/download the model. Called once on app load. */
    load(): Promise<void>;
    /** Whether the provider is ready to detect */
    isLoaded(): boolean;
    /** Whether the provider is currently loading */
    isLoading(): boolean;
    /** Register a callback for download progress updates */
    onProgress(callback: ProgressCallback): void;
    /**
     * Run detection on the given text. Optional progress callback (0-1).
     * `signal` (T222) is checked between inference chunks: an aborted signal
     * makes the provider stop at the next chunk boundary and reject with
     * DetectionAbortedError (work already done is discarded).
     */
    detect(text: string, onProgress?: (progress: number) => void, signal?: AbortSignal): Promise<DetectedEntity[]>;
    /** Set detection confidence threshold */
    setThreshold(value: number): void;
    /** Get current detection confidence threshold */
    getThreshold(): number;
    /** Release the ONNX session and free memory. Provider can be re-loaded later. */
    release(): void;
}
export interface ReplacementEntry {
    original: string;
    replacement: string;
    entityType: EntityType;
}
export declare const ENTITY_COLORS: Record<EntityType, string>;
export declare const ENTITY_LABELS: Record<EntityType, string>;
