import xxhash, { type XXHashAPI } from 'xxhash-wasm';

let apiInstance: XXHashAPI | null = null;
let initPromise: Promise<XXHashAPI> | null = null;

/** Initialize the xxhash-wasm runtime (idempotent; concurrent calls share one promise). */
export async function initXxHash(): Promise<void> {
    if (apiInstance) {
        return;
    }

    if (!initPromise) {
        initPromise = xxhash()
            .then((api) => {
                apiInstance = api;
                return api;
            })
            .catch((error) => {
                initPromise = null;
                throw error;
            });
    }

    await initPromise;
}

export function isXxHashInitialized(): boolean {
    return apiInstance !== null;
}

/** Compute 64-bit xxHash hex digest synchronously (requires `initXxHash()` beforehand). */
export function hashTextSync(text: string): string {
    if (!apiInstance) {
        throw new Error('xxhash-wasm is not initialized; call await initXxHash() first');
    }
    return apiInstance.h64ToString(text);
}

/** Lazily initialize xxhash-wasm if needed and compute 64-bit xxHash hex digest. */
export async function hashText(text: string): Promise<string> {
    await initXxHash();
    return hashTextSync(text);
}
