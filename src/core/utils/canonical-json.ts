function compareCodeUnits(a: string, b: string): number {
    if (a < b) {
        return -1;
    }
    if (a > b) {
        return 1;
    }
    return 0;
}

function canonicalizeValue(value: unknown, seen: Set<object>): unknown {
    if (value === null || value === undefined) {
        return value;
    }

    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            return null;
        }
        return Object.is(value, -0) ? 0 : value;
    }

    if (typeof value === 'boolean' || typeof value === 'string') {
        return value;
    }

    if (typeof value === 'bigint') {
        throw new TypeError('Cannot canonicalize BigInt value to JSON');
    }

    if (typeof value === 'function' || typeof value === 'symbol') {
        return undefined;
    }

    if (typeof value === 'object') {
        if (seen.has(value)) {
            throw new TypeError('Cannot canonicalize circular structure');
        }

        const maybeToJson = value as { toJSON?: () => unknown };
        if (typeof maybeToJson.toJSON === 'function') {
            seen.add(value);
            try {
                return canonicalizeValue(maybeToJson.toJSON(), seen);
            } finally {
                seen.delete(value);
            }
        }

        seen.add(value);
        try {
            if (Array.isArray(value)) {
                return value.map((item) => {
                    const normalized = canonicalizeValue(item, seen);
                    return normalized === undefined ? null : normalized;
                });
            }

            const record = value as Record<string, unknown>;
            const sortedKeys = Object.keys(record).sort(compareCodeUnits);
            const result: Record<string, unknown> = {};
            for (const key of sortedKeys) {
                const normalized = canonicalizeValue(record[key], seen);
                if (normalized !== undefined) {
                    result[key] = normalized;
                }
            }
            return result;
        } finally {
            seen.delete(value);
        }
    }

    return undefined;
}

/**
 * Recursively clone a JSON-compatible value with object keys sorted in deterministic
 * UTF-16 code-unit order (locale-independent).
 */
export function canonicalClone<T>(value: T): T {
    return canonicalizeValue(value, new Set<object>()) as T;
}

/**
 * Deterministically serialize any JSON-compatible value with sorted object keys.
 * Essential for preserving byte-for-byte Prefix KV Cache invariance on Layer 0 & tool schemas.
 */
export function canonicalStringify(value: unknown): string {
    const cloned = canonicalClone(value);
    if (cloned === undefined) {
        return 'null';
    }
    return JSON.stringify(cloned);
}

const META_SCHEMA_KEYS = new Set(['$schema', '$id']);

function stripMetaRecursive(value: unknown, seen: Set<object>): unknown {
    if (value === null || typeof value !== 'object') {
        return value;
    }

    if (seen.has(value)) {
        throw new TypeError('Cannot strip circular JSON schema');
    }

    seen.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map((item) => stripMetaRecursive(item, seen));
        }

        const record = value as Record<string, unknown>;
        const sortedKeys = Object.keys(record).sort(compareCodeUnits);
        const result: Record<string, unknown> = {};
        for (const key of sortedKeys) {
            if (META_SCHEMA_KEYS.has(key)) {
                continue;
            }
            const cleaned = stripMetaRecursive(record[key], seen);
            if (cleaned !== undefined) {
                result[key] = cleaned;
            }
        }
        return result;
    } finally {
        seen.delete(value);
    }
}

/**
 * Remove JSON Schema meta keywords such as `$schema` (emitted by Zod v4 `z.toJSONSchema()`)
 * and `$id`, returning a deterministically key-ordered plain object.
 */
export function stripJsonSchemaMeta(schema: unknown): Record<string, unknown> {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        return {};
    }

    return stripMetaRecursive(schema, new Set<object>()) as Record<string, unknown>;
}
