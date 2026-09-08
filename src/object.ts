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
 * Flattens a decoded message into a plain object, applying the merge rules a
 * generated parser follows: repeated fields accumulate, singular scalars take
 * the last value, singular messages merge, and setting a oneof member clears
 * the others, all in wire order.
 */
export function toObject(message: Message, options: ToObjectOptions = {}): PlainObject {
    const keys = options.keys ?? 'auto';
    const prefix = options.prefix ?? '';
    const object: PlainObject = {};
    const resolved = resolveFields(message);

    for (const field of message.fields.values()) {
        const values = resolved.get(field.number);
        if (values === undefined) continue;
        const useName = keys === 'name' || (keys === 'auto' && field.def !== undefined && field.def.inferred === undefined);
        const key = prefix + (useName && field.name !== undefined ? field.name : String(field.number));
        object[key] = isRepeated(field)
            ? values.map(v => valueToPlain(v, options))
            : valueToPlain(values[0]!, options);
    }
    return object;
}

function isRepeated(field: Field): boolean {
    return field.def ? field.def.cardinality === 'repeated' : field.values.length > 1;
}

/**
 * The effective values of each field after replaying its singular
 * occurrences in wire order. A field cleared by a later oneof member is absent.
 */
function resolveFields(message: Message): Map<number, Value[]> {
    const result = new Map<number, Value[]>();
    const events: { field: Field; index: number; offset: number }[] = [];
    for (const field of message.fields.values()) {
        if (isRepeated(field)) {
            result.set(field.number, [...field.values]);
            continue;
        }
        field.values.forEach((_, index) => events.push({ field, index, offset: field.raw[index]?.range.start ?? index }));
    }
    events.sort((a, b) => a.offset - b.offset);

    for (const { field, index } of events) {
        const value = field.values[index]!;
        const oneof = field.def?.oneof;
        if (oneof !== undefined) {
            for (const other of message.fields.values()) {
                if (other !== field && other.def?.oneof === oneof) result.delete(other.number);
            }
        }
        const existing = result.get(field.number)?.[0];
        result.set(field.number, [
            existing?.kind === 'message' && value.kind === 'message'
                ? { kind: 'message', value: mergeMessages(existing.value, value.value) }
                : value
        ]);
    }
    return result;
}

/**
 * Joins two occurrences of one message so that resolving the result replays
 * both in wire order. Earlier occurrences sit earlier in the input, so their
 * records keep their precedence by offset.
 */
function mergeMessages(base: Message, next: Message): Message {
    const fields = new Map<number, Field>(base.fields);
    for (const [number, field] of next.fields) {
        const existing = fields.get(number);
        fields.set(number, existing ? {
            number,
            name: existing.name,
            def: existing.def,
            values: [...existing.values, ...field.values],
            raw: [...existing.raw, ...field.raw],
            alternatives: []
        } : field);
    }
    return { type: base.type, fields };
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
