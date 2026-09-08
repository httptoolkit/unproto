import type { Field, Message, Value } from './values.ts';
import type { FieldType, ScalarType } from './schema.ts';

export type PlainValue = bigint | number | boolean | string | Uint8Array | PlainObject | PlainValue[];
export interface PlainObject { [key: string]: PlainValue }

/**
 * Flattens a decoded message into a plain object, applying the merge rules a
 * generated parser follows: repeated fields accumulate, singular scalars take
 * the last value, singular messages merge, maps collapse to an object keyed
 * by the map key, and setting a oneof member clears the others, all in wire
 * order. Fields are keyed by name where the schema gives one, and by number
 * where the definition was inferred.
 */
export function toObject(message: Message): PlainObject {
    const object: PlainObject = {};
    const resolved = resolveFields(message);

    for (const field of message.fields.values()) {
        const values = resolved.get(field.number);
        if (values === undefined) continue;
        const named = field.name !== undefined && field.def !== undefined && field.def.inferred === undefined;
        const type = field.def?.type;
        object[named ? field.name! : String(field.number)] = type?.kind === 'map'
            ? mapToPlain(values, type)
            : isRepeated(field) ? values.map(valueToPlain) : valueToPlain(values[0]!);
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

/**
 * Collapses a map field's entry messages into an object. A repeated key takes
 * its last value, and a missing key or value is its type default, both as a
 * generated parser would have it. Anything else an entry carries is dropped
 * here, and remains on the message itself.
 */
function mapToPlain(values: readonly Value[], type: FieldType & { kind: 'map' }): PlainObject {
    const object: PlainObject = {};
    for (const value of values) {
        if (value.kind !== 'message') continue;
        const key = entryPart(value.value, 1) ?? defaultFor({ kind: 'scalar', scalar: type.key });
        object[String(key)] = entryPart(value.value, 2) ?? defaultFor(type.value);
    }
    return object;
}

/** The last value of a map entry's key or value field, if it has one */
function entryPart(entry: Message, number: number): PlainValue | undefined {
    const value = entry.fields.get(number)?.values.at(-1);
    return value === undefined ? undefined : valueToPlain(value);
}

function defaultFor(type: FieldType): PlainValue {
    switch (type.kind) {
        case 'message':
        case 'map': return {};
        case 'enum': return 0n;
        case 'scalar': return SCALAR_DEFAULTS[type.scalar];
    }
}

const SCALAR_DEFAULTS: Record<ScalarType, PlainValue> = {
    double: 0, float: 0,
    int32: 0n, int64: 0n, uint32: 0n, uint64: 0n, sint32: 0n, sint64: 0n,
    fixed32: 0n, fixed64: 0n, sfixed32: 0n, sfixed64: 0n,
    bool: false, string: '', bytes: new Uint8Array(0)
};

function valueToPlain(value: Value): PlainValue {
    switch (value.kind) {
        case 'message': return toObject(value.value);
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
