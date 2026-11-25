/**
 * A detect call was cancelled through its AbortSignal (T222). Providers throw
 * it between chunks, the engine before and after the ML pass, and the worker
 * protocol client when the host acknowledges a `cancelDetect`.
 */
export class DetectionAbortedError extends Error {
    constructor(message = 'Detection aborted') {
        super(message);
        this.name = 'DetectionAbortedError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
/** Throw DetectionAbortedError when `signal` has been aborted. */
export function throwIfAborted(signal) {
    if (signal?.aborted)
        throw new DetectionAbortedError();
}
export const ENTITY_COLORS = {
    PERSON: '#7B2FF7',
    EMAIL: '#2563EB',
    PHONE: '#0D9488',
    SSN: '#B45309',
    CREDIT_CARD: '#CA8A04',
    DATE: '#6D28D9',
    CURRENCY: '#EA580C',
    IP_ADDRESS: '#0284C7',
    IBAN: '#A16207',
    ADDRESS: '#DC2626',
    COMPANY: '#DB2777',
    SECRET: '#E11D48',
    API_KEY: '#059669',
    OTHER: '#6B7280',
};
export const ENTITY_LABELS = {
    PERSON: 'Name',
    EMAIL: 'Email',
    PHONE: 'Phone',
    SSN: 'SSN',
    CREDIT_CARD: 'Credit Card',
    DATE: 'Date',
    CURRENCY: 'Currency',
    IP_ADDRESS: 'IP Address',
    IBAN: 'IBAN',
    ADDRESS: 'Address',
    COMPANY: 'Company',
    SECRET: 'Secret',
    API_KEY: 'API Key',
    OTHER: 'Other',
};
