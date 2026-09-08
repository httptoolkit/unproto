import type { Field, Message, Value } from './values.ts';

export type PlainValue = bigint | number | boolean | string | Uint8Array | PlainObject | PlainValue[];
export interface PlainObject { [key: string]: PlainValue }

export interface ToObjectOptions {
    /**
     * How to key the object: by field name, by field number, or (the
     * default) by name for fields from a real schema and number for inferred ones.
     */
    readonly keys?: 'auto' | 'name' | 'number';
    /** Prepended to every key; useful with numeric keys, e.g. 'f' for f1, f2. */
    readonly prefix?: string;
}

/**
 * Flattens a decoded message into a plain object, merging occurrences the
 * way a generated parser would: repeated fields become arrays, singular
 * scalars take the last value, singular messages are merged.
 */
export function toObject(message: Message, options: ToObjectOptions = {}): PlainObject {
    const keys = options.keys ?? 'auto';
    const prefix = options.prefix ?? '';
    const object: PlainObject = {};

    for (const field of message.fields.values()) {
        const useName = keys === 'name' || (keys === 'auto' && field.def !== undefined && field.def.inferred === undefined);
        const key = prefix + (useName && field.name !== undefined ? field.name : String(field.number));
        object[key] = fieldToPlain(field, options);
    }
    return object;
}

function fieldToPlain(field: Field, options: ToObjectOptions): PlainValue {
    const repeated = field.def ? field.def.cardinality === 'repeated' : field.values.length > 1;
    if (repeated) return field.values.map(v => valueToPlain(v, options));

    const last = field.values[field.values.length - 1];
    if (last === undefined) return [];
    if (field.values.length === 1 || last.kind !== 'message') return valueToPlain(last, options);

    let merged: PlainValue = {};
    for (const value of field.values) {
        merged = merge(merged, valueToPlain(value, options));
    }
    return merged;
}

function valueToPlain(value: Value, options: ToObjectOptions): PlainValue {
    switch (value.kind) {
        case 'message': return toObject(value.value, options);
        case 'enum': return value.name ?? value.value;
        case 'raw': {
            const wire = value.wire;
            switch (wire.kind) {
                case 'varint': return wire.value;
                case 'len': case 'i32': case 'i64': return wire.bytes;
                default: return new Uint8Array(0);
            }
        }
        default: return value.value;
    }
}

function isPlainObject(value: PlainValue): value is PlainObject {
    return typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array);
}

function merge(base: PlainValue, next: PlainValue): PlainValue {
    if (!isPlainObject(base) || !isPlainObject(next)) return next;
    const result: PlainObject = { ...base };
    for (const [key, value] of Object.entries(next)) {
        const existing = result[key];
        if (existing === undefined) result[key] = value;
        else if (Array.isArray(existing) && Array.isArray(value)) result[key] = [...existing, ...value];
        else result[key] = merge(existing, value);
    }
    return result;
}
