import { BUILTIN_DOCS } from './builtin';
import {
    DocsRegistry,
    type ExternalDocRegistration,
} from './registry';

export * from './builtin';
export * from './registry';

export const defaultDocsRegistry = new DocsRegistry(BUILTIN_DOCS);

export function registerExtensionDocs(
    input: ExternalDocRegistration | readonly ExternalDocRegistration[],
): () => void {
    return defaultDocsRegistry.register(input);
}

export function unregisterExtensionDoc(namespace: string, relPath: string): boolean {
    return defaultDocsRegistry.unregister(namespace, relPath);
}

export function unregisterExtensionNamespace(namespace: string): number {
    return defaultDocsRegistry.unregisterNamespace(namespace);
}

export function clearExternalDocs(): void {
    defaultDocsRegistry.clearExternal();
}
