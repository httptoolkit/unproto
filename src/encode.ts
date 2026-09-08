import type { Problem } from './problem.ts';
import type { PlainObject, PlainValue } from './object.ts';
import {
    describeType,
    fieldDef,
    isPackable,
    scalar,
    scalarWireType,
    I32_SCALARS,
    I64_SCALARS,
    VARINT_SCALARS,
    type FieldDef,
    type FieldType,
    type MessageType,
    type ScalarType,
    type Schema
} from './schema.ts';
import type { Field, Message, Value } from './values.ts';
import type { WireField, WireType } from './wire.ts';

const textEncoder = new TextEncoder();

/** A value that is written as a bare varint or fixed-width payload */
type ScalarValue = Exclude<Value, { readonly kind: 'message' | 'string' | 'bytes' | 'raw' }>;

class Writer {
    private bytes = new Uint8Array(256);
    private pos = 0;
    private scratch = new DataView(new ArrayBuffer(8));

    get position(): number {
        return this.pos;
    }

    /** Drops everything written since `position`, to undo a field that turned out to be unwritable */
    truncate(position: number): void {
        this.pos = position;
    }

    result(): Uint8Array {
        return this.bytes.slice(0, this.pos);
    }

    write(data: Uint8Array): void {
        this.ensure(data.length);
        this.bytes.set(data, this.pos);
        this.pos += data.length;
    }

    varint(value: bigint): void {
        this.paddedVarint(value, varintLength(value));
    }

    /** Writes an unsigned value as exactly `length` bytes, padding with redundant zero groups */
    paddedVarint(value: bigint, length: number): void {
        this.ensure(length);
        let rest = value;
        for (let i = 0; i < length; i++) {
            const byte = Number(rest & 0x7fn);
            rest >>= 7n;
            this.bytes[this.pos++] = i === length - 1 ? byte : byte | 0x80;
        }
    }

    tag(number: number, wireType: WireType): void {
        this.varint(tagValue(number, wireType));
    }

    lengthDelimited(number: number, payload: Uint8Array): void {
        this.tag(number, 2);
        this.varint(BigInt(payload.length));
        this.write(payload);
    }

    fixed32(value: bigint): void {
        this.scratch.setUint32(0, Number(BigInt.asUintN(32, value)), true);
        this.flushScratch(4);
    }

    fixed64(value: bigint): void {
        this.scratch.setBigUint64(0, BigInt.asUintN(64, value), true);
        this.flushScratch(8);
    }

    float(value: number): void {
        this.scratch.setFloat32(0, value, true);
        this.flushScratch(4);
    }

    double(value: number): void {
        this.scratch.setFloat64(0, value, true);
        this.flushScratch(8);
    }

    private flushScratch(size: number): void {
        this.ensure(size);
        for (let i = 0; i < size; i++) this.bytes[this.pos++] = this.scratch.getUint8(i);
    }

    private ensure(extra: number): void {
        if (this.pos + extra <= this.bytes.length) return;
        let size = this.bytes.length * 2;
        while (size < this.pos + extra) size *= 2;
        const grown = new Uint8Array(size);
        grown.set(this.bytes.subarray(0, this.pos));
        this.bytes = grown;
    }
}

function tagValue(number: number, wireType: WireType): bigint {
    return BigInt(number) * 8n + BigInt(wireType);
}

function varintLength(value: bigint): number {
    let length = 1;
    for (let rest = value >> 7n; rest > 0n; rest >>= 7n) length++;
    return length;
}

/** The length a varint was originally written with, or its canonical length if that is unusable */
function originalLength(value: bigint, original: number): number {
    const minimum = varintLength(value);
    return original >= minimum && original <= 10 ? original : minimum;
}

/**
 * Re-emits one wire record exactly as it was read. Lengths come from the
 * recorded byte ranges rather than from the values, so redundant padding is
 * reproduced too.
 */
function writeRecord(writer: Writer, record: WireField): void {
    const tag = tagValue(record.number, record.wireType);
    const prefix = record.valueRange.start - record.range.start;

    switch (record.kind) {
        case 'varint':
            writer.paddedVarint(tag, originalLength(tag, prefix));
            writer.paddedVarint(record.value, originalLength(record.value, record.valueRange.end - record.valueRange.start));
            break;
        case 'i64':
        case 'i32':
            writer.paddedVarint(tag, originalLength(tag, prefix));
            writer.write(record.bytes);
            break;
        case 'len': {
            const length = BigInt(record.bytes.length);
            // The tag and the length share one prefix, so which of the two carried
            // any padding can only be told from the non-canonical length flag.
            const tagBytes = record.nonCanonicalLength
                ? varintLength(tag)
                : originalLength(tag, prefix - varintLength(length));
            writer.paddedVarint(tag, tagBytes);
            writer.paddedVarint(length, originalLength(length, prefix - tagBytes));
            writer.write(record.bytes);
            break;
        }
        case 'group': {
            writer.paddedVarint(tag, originalLength(tag, prefix));
            for (const inner of record.fields) writeRecord(writer, inner);
            if (record.closed) {
                const endTag = tagValue(record.number, 4);
                writer.paddedVarint(endTag, originalLength(endTag, record.range.end - record.valueRange.end));
            }
            break;
        }
        case 'egroup':
            writer.paddedVarint(tag, originalLength(tag, record.range.end - record.range.start));
            break;
    }
}

export interface EncodeMessageOptions {
    /**
     * Re-emit fields that still carry their original wire records byte for
     * byte, rather than encoding them from their values. Defaults to true.
     */
    readonly preserveEncoding?: boolean;
}

/**
 * Re-encodes a decoded message. Fields that still carry the wire records
 * they were read from are copied verbatim, in their original wire order, so
 * that unknown fields, groups, packed fields and non-canonical encodings all
 * survive; anything else is encoded from its values per its definition, and
 * is appended in field number order.
 *
 * `encodeMessage(decode(bytes).message)` reproduces `bytes` exactly for any
 * input that decoded without problems, with one exception: a record whose
 * tag and length prefix were *both* padded with redundant bytes, since the
 * model records only the total width of the two together.
 */
export function encodeMessage(message: Message, options: EncodeMessageOptions = {}): Uint8Array {
    const writer = new Writer();
    writeMessage(writer, message, options.preserveEncoding ?? true);
    return writer.result();
}

function writeMessage(writer: Writer, message: Message, preserve: boolean): void {
    const records: WireField[] = [];
    const encoded: Field[] = [];
    for (const field of message.fields.values()) {
        if (preserve && field.raw.length > 0) records.push(...field.raw);
        else encoded.push(field);
    }

    records.sort((a, b) => a.range.start - b.range.start);
    for (const record of records) writeRecord(writer, record);

    encoded.sort((a, b) => a.number - b.number);
    for (const field of encoded) writeFieldValues(writer, field, preserve);
}

function writeFieldValues(writer: Writer, field: Field, preserve: boolean): void {
    const def = field.def;
    const packed = def !== undefined
        && def.packed
        && def.cardinality === 'repeated'
        && isPackable(def.type)
        && field.values.length > 0
        && field.values.every(value => value.kind !== 'raw');

    if (packed) {
        const payload = new Writer();
        for (const value of field.values) writeScalarPayload(payload, value as ScalarValue);
        writer.lengthDelimited(field.number, payload.result());
        return;
    }

    for (const value of field.values) writeValue(writer, field.number, value, def, preserve);
}

function writeValue(writer: Writer, number: number, value: Value, def: FieldDef | undefined, preserve: boolean): void {
    switch (value.kind) {
        case 'raw':
            writeRecord(writer, value.wire);
            return;
        case 'message': {
            const inner = new Writer();
            writeMessage(inner, value.value, preserve);
            if (def?.delimited) {
                writer.tag(number, 3);
                writer.write(inner.result());
                writer.tag(number, 4);
            } else {
                writer.lengthDelimited(number, inner.result());
            }
            return;
        }
        case 'string':
            writer.lengthDelimited(number, textEncoder.encode(value.value));
            return;
        case 'bytes':
            writer.lengthDelimited(number, value.value);
            return;
        default:
            writer.tag(number, scalarValueWireType(value));
            writeScalarPayload(writer, value);
    }
}

function scalarValueWireType(value: ScalarValue): WireType {
    switch (value.kind) {
        case 'fixed64':
        case 'sfixed64':
        case 'double':
            return 1;
        case 'fixed32':
        case 'sfixed32':
        case 'float':
            return 5;
        default:
            return 0;
    }
}

function writeScalarPayload(writer: Writer, value: ScalarValue): void {
    switch (value.kind) {
        case 'int32':
        case 'int64':
        case 'uint32':
        case 'uint64':
        case 'enum':
            writer.varint(BigInt.asUintN(64, value.value));
            return;
        case 'sint32':
            writer.varint(zigzag(value.value, 32n));
            return;
        case 'sint64':
            writer.varint(zigzag(value.value, 64n));
            return;
        case 'bool':
            writer.varint(value.value ? 1n : 0n);
            return;
        case 'fixed32':
        case 'sfixed32':
            writer.fixed32(value.value);
            return;
        case 'fixed64':
        case 'sfixed64':
            writer.fixed64(value.value);
            return;
        case 'float':
            writer.float(value.value);
            return;
        case 'double':
            writer.double(value.value);
    }
}

function zigzag(value: bigint, width: bigint): bigint {
    return BigInt.asUintN(Number(width), (value << 1n) ^ (value >> (width - 1n)));
}

export interface EncodeResult {
    readonly bytes: Uint8Array;
    readonly problems: readonly Problem[];
}

interface ObjectContext {
    readonly schema: Schema;
    readonly problems: Problem[];
    readonly recursionLimit: number;
}

/**
 * Encodes a plain object, in the shape `toObject` produces, against a
 * schema. Values are accepted leniently: numbers and decimal strings stand
 * in for integers, enum values may be names or numbers, maps may be objects
 * or entry lists, and a single value is accepted for a repeated field.
 * Nothing throws: values that cannot be written and fields the schema does
 * not define are skipped and reported in `problems`.
 */
export function encodeObject(object: PlainObject, schema: Schema, typeName?: string): EncodeResult {
    const problems: Problem[] = [];
    const type = findMessageType(schema, typeName, problems);
    if (!type) return { bytes: new Uint8Array(0), problems };

    const writer = new Writer();
    writeObject(writer, object, type, { schema, problems, recursionLimit: 100 }, [], 0);
    return { bytes: writer.result(), problems };
}

function findMessageType(schema: Schema, name: string | undefined, problems: Problem[]): MessageType | undefined {
    if (name === undefined) {
        const messages = [...schema.types.values()].filter((type): type is MessageType => type.kind === 'message');
        if (messages.length === 1) return messages[0];
        problems.push({
            code: 'unknown-type',
            message: messages.length === 0
                ? 'The schema defines no message types'
                : 'The schema defines several message types and none was chosen'
        });
        return undefined;
    }

    const type = schema.types.get(name);
    if (type?.kind === 'message') return type;
    problems.push({
        code: 'unknown-type',
        message: type
            ? `${name} is an enum, not a message`
            : `Message type ${name} is not defined in the schema`
    });
    return undefined;
}

function writeObject(
    writer: Writer,
    object: PlainObject,
    type: MessageType,
    ctx: ObjectContext,
    path: readonly number[],
    depth: number
): void {
    const byName = new Map<string, FieldDef>();
    for (const def of type.fields.values()) byName.set(def.name, def);

    const present: { def: FieldDef; value: PlainValue }[] = [];
    for (const [key, value] of Object.entries(object)) {
        if (value === undefined || value === null) continue;
        const def = byName.get(key) ?? (/^\d+$/.test(key) ? type.fields.get(Number(key)) : undefined);
        if (!def) {
            ctx.problems.push({
                code: 'unknown-field',
                message: `Field ${key} is not defined in ${type.fullName}`,
                path
            });
            continue;
        }
        present.push({ def, value });
    }

    present.sort((a, b) => a.def.number - b.def.number);
    for (const { def, value } of present) writeObjectField(writer, def, value, ctx, path, depth);
}

function writeObjectField(
    writer: Writer,
    def: FieldDef,
    value: PlainValue,
    ctx: ObjectContext,
    parentPath: readonly number[],
    depth: number
): void {
    const path = [...parentPath, def.number];
    const type = def.type;

    if (type.kind === 'map') {
        const keyDef = fieldDef({ number: 1, name: 'key', type: scalar(type.key) });
        const valueDef = fieldDef({ number: 2, name: 'value', type: type.value });
        for (const entry of mapEntries(value, type, ctx, path, def)) {
            const payload = new Writer();
            writeObjectField(payload, keyDef, entry.key, ctx, path, depth + 1);
            writeObjectField(payload, valueDef, entry.value, ctx, path, depth + 1);
            writer.lengthDelimited(def.number, payload.result());
        }
        return;
    }

    if (def.cardinality === 'repeated') {
        const items = listItems(type, value);
        if (def.packed && isPackable(type)) {
            const payload = new Writer();
            for (const item of items) writePackableValue(payload, type, item, ctx, path, def);
            const bytes = payload.result();
            if (bytes.length > 0) writer.lengthDelimited(def.number, bytes);
            return;
        }
        for (const item of items) writeSingularValue(writer, def, item, ctx, path, depth);
        return;
    }

    if (def.presence === 'implicit' && isTypeDefault(type, value)) return;
    writeSingularValue(writer, def, value, ctx, path, depth);
}

function writeSingularValue(
    writer: Writer,
    def: FieldDef,
    value: PlainValue,
    ctx: ObjectContext,
    path: readonly number[],
    depth: number
): void {
    const type = def.type;

    if (type.kind === 'message') {
        const payload = nestedMessageBytes(type.name, value, def, ctx, path, depth);
        if (payload === undefined) return;
        if (def.delimited) {
            writer.tag(def.number, 3);
            writer.write(payload);
            writer.tag(def.number, 4);
        } else {
            writer.lengthDelimited(def.number, payload);
        }
        return;
    }

    if (type.kind === 'scalar' && (type.scalar === 'string' || type.scalar === 'bytes')) {
        const payload = type.scalar === 'string'
            ? textBytes(value, ctx, path, def)
            : byteString(value, ctx, path, def);
        if (payload === undefined) return;
        writer.lengthDelimited(def.number, payload);
        return;
    }

    // The tag has to be written before the value is known to be writable
    const mark = writer.position;
    writer.tag(def.number, fieldWireType(type));
    if (!writePackableValue(writer, type, value, ctx, path, def)) writer.truncate(mark);
}

/** The wire type one value of this type is written with, leaving aside group encoding */
function fieldWireType(type: FieldType): WireType {
    if (type.kind === 'scalar') return scalarWireType(type.scalar);
    return type.kind === 'enum' ? 0 : 2;
}

/** Writes one bare varint or fixed-width value; false (having written nothing) if it does not fit the type */
function writePackableValue(
    writer: Writer,
    type: FieldType,
    value: PlainValue,
    ctx: ObjectContext,
    path: readonly number[],
    def: FieldDef
): boolean {
    if (type.kind === 'enum') {
        const number = enumNumber(type.name, value, ctx, path, def);
        if (number === undefined) return false;
        writer.varint(BigInt.asUintN(64, number));
        return true;
    }

    if (type.kind !== 'scalar') return false;
    const scalarType = type.scalar;

    if (scalarType === 'bool') {
        const flag = toBool(value);
        if (flag === undefined) {
            invalidValue(ctx, path, def, value);
            return false;
        }
        writer.varint(flag ? 1n : 0n);
        return true;
    }

    if (scalarType === 'float' || scalarType === 'double') {
        const number = toNumber(value);
        if (number === undefined) {
            invalidValue(ctx, path, def, value);
            return false;
        }
        if (scalarType === 'float') writer.float(number);
        else writer.double(number);
        return true;
    }

    const integer = intValue(scalarType, value, ctx, path, def);
    if (integer === undefined) return false;

    if (VARINT_SCALARS.has(scalarType)) {
        if (scalarType === 'sint32') writer.varint(zigzag(integer, 32n));
        else if (scalarType === 'sint64') writer.varint(zigzag(integer, 64n));
        else writer.varint(BigInt.asUintN(64, integer));
    } else if (I64_SCALARS.has(scalarType)) {
        writer.fixed64(integer);
    } else if (I32_SCALARS.has(scalarType)) {
        writer.fixed32(integer);
    } else {
        return false;
    }
    return true;
}

function nestedMessageBytes(
    typeName: string,
    value: PlainValue,
    def: FieldDef,
    ctx: ObjectContext,
    path: readonly number[],
    depth: number
): Uint8Array | undefined {
    if (value instanceof Uint8Array) return value;

    const type = ctx.schema.types.get(typeName);
    if (type?.kind !== 'message') {
        ctx.problems.push({
            code: 'unknown-type',
            message: type
                ? `${typeName} is an enum, not a message`
                : `Message type ${typeName} is not defined in the schema`,
            path
        });
        return undefined;
    }

    if (typeof value !== 'object' || Array.isArray(value)) {
        invalidValue(ctx, path, def, value);
        return undefined;
    }

    if (depth >= ctx.recursionLimit) {
        ctx.problems.push({
            code: 'recursion-limit',
            message: `Message nesting exceeds the limit of ${ctx.recursionLimit}`,
            path
        });
        return undefined;
    }

    const payload = new Writer();
    writeObject(payload, value, type, ctx, path, depth + 1);
    return payload.result();
}

interface MapEntry {
    readonly key: PlainValue;
    readonly value: PlainValue;
}

function mapEntries(
    value: PlainValue,
    type: FieldType & { readonly kind: 'map' },
    ctx: ObjectContext,
    path: readonly number[],
    def: FieldDef
): MapEntry[] {
    if (Array.isArray(value)) {
        const entries: MapEntry[] = [];
        for (const item of value) {
            if (typeof item === 'object' && !Array.isArray(item) && !(item instanceof Uint8Array)
                && ('key' in item || '1' in item)) {
                entries.push({
                    key: item['key'] ?? item['1'] ?? typeDefault(scalar(type.key)),
                    value: item['value'] ?? item['2'] ?? typeDefault(type.value)
                });
            } else {
                invalidValue(ctx, path, def, item);
            }
        }
        return entries;
    }

    if (typeof value === 'object' && !(value instanceof Uint8Array)) {
        return Object.entries(value).map(([key, entryValue]) => ({ key, value: entryValue }));
    }

    invalidValue(ctx, path, def, value);
    return [];
}

/** The value a field of this type takes when it is absent */
function typeDefault(type: FieldType): PlainValue {
    if (type.kind === 'message' || type.kind === 'map') return {};
    if (type.kind === 'enum') return 0n;
    switch (type.scalar) {
        case 'string': return '';
        case 'bytes': return new Uint8Array(0);
        case 'bool': return false;
        case 'float': case 'double': return 0;
        default: return 0n;
    }
}

/** The values of a repeated field: an array, except where the field itself takes one */
function listItems(type: FieldType, value: PlainValue): readonly PlainValue[] {
    if (!Array.isArray(value)) return [value];
    // An array of small numbers is a bytes value rather than a list of them
    if (type.kind === 'scalar' && type.scalar === 'bytes' && value.length > 0 && isByteList(value)) return [value];
    return value;
}

function isTypeDefault(type: FieldType, value: PlainValue): boolean {
    if (type.kind === 'message' || type.kind === 'map') return false;
    if (type.kind === 'enum') return value === 0 || value === 0n;
    switch (type.scalar) {
        case 'string': return value === '';
        case 'bytes': return (value instanceof Uint8Array || Array.isArray(value)) && value.length === 0;
        case 'bool': return value === false;
        default: return value === 0 || value === 0n;
    }
}

const INT_RANGES: Readonly<Partial<Record<ScalarType, readonly [bigint, bigint]>>> = {
    int32: [-(2n ** 31n), 2n ** 31n - 1n],
    sint32: [-(2n ** 31n), 2n ** 31n - 1n],
    sfixed32: [-(2n ** 31n), 2n ** 31n - 1n],
    uint32: [0n, 2n ** 32n - 1n],
    fixed32: [0n, 2n ** 32n - 1n],
    int64: [-(2n ** 63n), 2n ** 63n - 1n],
    sint64: [-(2n ** 63n), 2n ** 63n - 1n],
    sfixed64: [-(2n ** 63n), 2n ** 63n - 1n],
    uint64: [0n, 2n ** 64n - 1n],
    fixed64: [0n, 2n ** 64n - 1n]
};

function intValue(
    type: ScalarType,
    value: PlainValue,
    ctx: ObjectContext,
    path: readonly number[],
    def: FieldDef
): bigint | undefined {
    const range = INT_RANGES[type];
    const integer = toBigInt(value);
    if (range === undefined || integer === undefined || integer < range[0] || integer > range[1]) {
        invalidValue(ctx, path, def, value);
        return undefined;
    }
    return integer;
}

function enumNumber(
    typeName: string,
    value: PlainValue,
    ctx: ObjectContext,
    path: readonly number[],
    def: FieldDef
): bigint | undefined {
    if (typeof value === 'string') {
        const type = ctx.schema.types.get(typeName);
        const named = type?.kind === 'enum' ? type.values.find(candidate => candidate.name === value) : undefined;
        if (named) return BigInt(named.number);
    }
    return intValue('int32', value, ctx, path, def);
}

function textBytes(value: PlainValue, ctx: ObjectContext, path: readonly number[], def: FieldDef): Uint8Array | undefined {
    // Bytes are accepted so that strings that decoded as invalid UTF-8 can be written back
    if (value instanceof Uint8Array) return value;
    if (typeof value === 'string') return textEncoder.encode(value);
    if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') {
        return textEncoder.encode(String(value));
    }
    invalidValue(ctx, path, def, value);
    return undefined;
}

function byteString(value: PlainValue, ctx: ObjectContext, path: readonly number[], def: FieldDef): Uint8Array | undefined {
    if (value instanceof Uint8Array) return value;
    if (typeof value === 'string') return textEncoder.encode(value);
    if (isByteList(value)) return Uint8Array.from(value);
    invalidValue(ctx, path, def, value);
    return undefined;
}

function isByteList(value: PlainValue): value is number[] {
    return Array.isArray(value)
        && value.every(item => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255);
}

function toBigInt(value: PlainValue): bigint | undefined {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'boolean') return value ? 1n : 0n;
    if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value) : undefined;
    if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) return BigInt(value.trim());
    return undefined;
}

function toNumber(value: PlainValue): number | undefined {
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'string') {
        const text = value.trim();
        const number = Number(text);
        if (text !== '' && (!Number.isNaN(number) || text === 'NaN')) return number;
    }
    return undefined;
}

function toBool(value: PlainValue): boolean | undefined {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return value !== 0n;
    if (typeof value === 'number') return value !== 0;
    if (value === 'true') return true;
    if (value === 'false') return false;
    const integer = typeof value === 'string' ? toBigInt(value) : undefined;
    return integer === undefined ? undefined : integer !== 0n;
}

function invalidValue(ctx: ObjectContext, path: readonly number[], def: FieldDef, value: PlainValue): void {
    ctx.problems.push({
        code: 'invalid-value',
        message: `Field ${def.number} (${def.name}) is ${describeType(def.type)} but the value is ${describeValue(value)}`,
        path
    });
}

function describeValue(value: PlainValue): string {
    if (typeof value === 'string') return JSON.stringify(value);
    if (value instanceof Uint8Array) return `${value.length} bytes`;
    if (Array.isArray(value)) return `a list of ${value.length}`;
    if (typeof value === 'object') return 'an object';
    return String(value);
}
