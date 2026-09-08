import { decodeWire, readVarint, type WireField, type WireLen } from './wire.ts';
import type { Problem } from './problem.ts';
import {
    describeType,
    isPackable,
    fieldDef,
    scalar,
    I32_SCALARS,
    I64_SCALARS,
    VARINT_SCALARS,
    type FieldDef,
    type FieldType,
    type MessageType,
    type NamedType,
    type ScalarType
} from './schema.ts';
import type { Alternative, Field, Message, Value } from './values.ts';
import { Inferrer } from './infer.ts';

export interface InterpretContext {
    /** All known types. Types inferred for unknown fields are added here. */
    readonly types: Map<string, NamedType>;
    /** Names in `types` that were inferred rather than supplied */
    readonly inferred: Set<string>;
    /** Definitions inferred for fields the schema lacks, by containing type name then field number */
    readonly extensions: Map<string, Map<number, FieldDef>>;
    readonly problems: Problem[];
    readonly recursionLimit: number;
}

/** The occurrences of one undefined field across every instance of its containing type */
export interface UnknownFieldGroup {
    readonly typeName: string;
    readonly number: number;
    /** Depth and path of the first containing message instance seen */
    readonly depth: number;
    readonly path: readonly number[];
    readonly perSample: WireField[][];
}

/**
 * Walks a message with its schema and collects every field the schema does
 * not define, grouped by containing type and number with one sample per
 * containing message instance, so that each can be inferred once from all
 * of its occurrences together.
 */
export function collectUnknownFields(
    fields: readonly WireField[],
    type: MessageType,
    ctx: InterpretContext,
    path: readonly number[],
    depth: number,
    groups: Map<string, UnknownFieldGroup>
): void {
    const unknownHere = new Map<number, WireField[]>();
    const quiet: InterpretContext = { ...ctx, problems: [] };
    for (const occ of fields) {
        const def = type.fields.get(occ.number);
        if (!def) {
            const list = unknownHere.get(occ.number);
            if (list) list.push(occ);
            else unknownHere.set(occ.number, [occ]);
            continue;
        }
        if ((def.type.kind !== 'message' && def.type.kind !== 'map') || depth >= ctx.recursionLimit) continue;
        const nestedType = resolveMessageType(def.type, quiet, path);
        if (!nestedType) continue;
        const nestedPath = [...path, occ.number];
        if (occ.kind === 'len') {
            const wire = decodeWire(occ.bytes, { offset: occ.valueRange.start, recursionLimit: ctx.recursionLimit });
            collectUnknownFields(wire.fields, nestedType, ctx, nestedPath, depth + 1, groups);
        } else if (occ.kind === 'group') {
            collectUnknownFields(occ.fields, nestedType, ctx, nestedPath, depth + 1, groups);
        }
    }
    for (const [number, occurrences] of unknownHere) {
        const key = `${type.fullName}#${number}`;
        let group = groups.get(key);
        if (!group) {
            group = { typeName: type.fullName, number, depth, path, perSample: [] };
            groups.set(key, group);
        }
        group.perSample.push(occurrences);
    }
}

/** Decodes a list of wire fields as a message of the given type (or heuristically if none). */
export function interpretMessage(
    fields: readonly WireField[],
    type: MessageType | undefined,
    ctx: InterpretContext,
    path: readonly number[],
    depth: number
): Message {
    const grouped = new Map<number, WireField[]>();
    for (const field of fields) {
        const list = grouped.get(field.number);
        if (list) list.push(field);
        else grouped.set(field.number, [field]);
    }

    const out = new Map<number, Field>();
    for (const [number, occurrences] of grouped) {
        const fieldPath = [...path, number];
        let def = type?.fields.get(number);
        if (!def && type) {
            ctx.problems.push({
                code: 'unknown-field',
                message: `Field ${number} is not defined in ${type.fullName}`,
                offset: occurrences[0]!.range.start,
                path: fieldPath
            });
            def = ctx.extensions.get(type.fullName)?.get(number);
        }
        if (!def) {
            // Only reached for fields of types the schema does not define at all
            const inferrer = new Inferrer(ctx.types, ctx.recursionLimit, ctx.inferred, ctx.problems);
            def = inferrer.inferField(number, [occurrences], type?.fullName ?? 'Unknown', depth, path);
        }
        out.set(number, interpretField(occurrences, def, ctx, fieldPath, depth));
    }

    return { type: type?.fullName, fields: out };
}

function interpretField(
    occurrences: readonly WireField[],
    def: FieldDef,
    ctx: InterpretContext,
    path: readonly number[],
    depth: number
): Field {
    const values = occurrences.flatMap(occ => interpretOccurrence(occ, def, ctx, path, depth));

    // Alternatives are only wanted when someone looks at them, and computing them
    // for every field roughly doubles the work, so they are produced on first access
    let alternatives: Alternative[] | undefined;
    return {
        number: def.number,
        name: def.name,
        def,
        values,
        raw: occurrences,
        get alternatives() {
            alternatives ??= interpretAlternatives(occurrences, def, ctx, path, depth);
            return alternatives;
        }
    };
}

function interpretAlternatives(
    occurrences: readonly WireField[],
    def: FieldDef,
    ctx: InterpretContext,
    path: readonly number[],
    depth: number
): Alternative[] {
    return (def.inferred?.alternatives ?? []).map(alt => {
        const altDef = fieldDef({
            ...def,
            type: alt.type,
            packed: alt.packed,
            cardinality: alt.packed ? 'repeated' : def.cardinality,
            inferred: undefined
        });
        const scratch: InterpretContext = { ...ctx, problems: [] };
        return {
            type: alt.type,
            packed: alt.packed,
            values: occurrences.flatMap(occ => interpretOccurrence(occ, altDef, scratch, path, depth))
        };
    });
}

function interpretOccurrence(
    occ: WireField,
    def: FieldDef,
    ctx: InterpretContext,
    path: readonly number[],
    depth: number
): Value[] {
    const type = def.type;

    switch (occ.kind) {
        case 'varint':
            if (type.kind === 'scalar' && VARINT_SCALARS.has(type.scalar)) return [fromVarint(type.scalar, occ.value)];
            if (type.kind === 'enum') return [enumValue(type.name, occ.value, ctx)];
            break;
        case 'i64':
            if (type.kind === 'scalar' && I64_SCALARS.has(type.scalar)) return [fromFixed(type.scalar, occ.bytes)];
            break;
        case 'i32':
            if (type.kind === 'scalar' && I32_SCALARS.has(type.scalar)) return [fromFixed(type.scalar, occ.bytes)];
            break;
        case 'len':
            if (type.kind === 'scalar' && type.scalar === 'string') return [fromString(occ, def, ctx, path)];
            if (type.kind === 'scalar' && type.scalar === 'bytes') return [{ kind: 'bytes', value: occ.bytes }];
            if (type.kind === 'message' || type.kind === 'map') return [nestedMessage(occ, type, ctx, path, depth)];
            if (def.cardinality === 'repeated' && isPackable(type)) return fromPacked(occ, def, ctx, path);
            break;
        case 'group':
            if (type.kind === 'message' || type.kind === 'map') {
                return [{ kind: 'message', value: interpretMessage(occ.fields, resolveMessageType(type, ctx, path), ctx, path, depth + 1) }];
            }
            break;
        case 'egroup':
            break;
    }

    ctx.problems.push({
        code: 'wire-type-mismatch',
        message: `Field ${def.number} (${def.name}) is declared as ${describeType(type)} but was encoded as ${occ.kind}`,
        offset: occ.range.start,
        path
    });
    return [{ kind: 'raw', wire: occ }];
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function fromString(occ: WireLen, def: FieldDef, ctx: InterpretContext, path: readonly number[]): Value {
    try {
        return { kind: 'string', value: utf8.decode(occ.bytes) };
    } catch {
        ctx.problems.push({
            code: 'invalid-utf8',
            message: `Field ${def.number} (${def.name}) is declared as string but is not valid UTF-8`,
            offset: occ.valueRange.start,
            path
        });
        return { kind: 'bytes', value: occ.bytes };
    }
}

function nestedMessage(
    occ: WireLen,
    type: FieldType & { kind: 'message' | 'map' },
    ctx: InterpretContext,
    path: readonly number[],
    depth: number
): Value {
    if (depth >= ctx.recursionLimit) {
        ctx.problems.push({
            code: 'recursion-limit',
            message: `Message nesting exceeds the limit of ${ctx.recursionLimit}`,
            offset: occ.range.start,
            path
        });
        return { kind: 'raw', wire: occ };
    }

    const wire = decodeWire(occ.bytes, { offset: occ.valueRange.start, recursionLimit: ctx.recursionLimit });
    for (const problem of wire.problems) ctx.problems.push({ ...problem, path });
    if (wire.trailing) {
        ctx.problems.push({
            code: 'nested-message-problems',
            message: `Nested message could not be fully decoded; ${wire.trailing.end - wire.trailing.start} bytes were skipped`,
            offset: wire.trailing.start,
            path
        });
    }
    return { kind: 'message', value: interpretMessage(wire.fields, resolveMessageType(type, ctx, path), ctx, path, depth + 1) };
}

function resolveMessageType(
    type: FieldType & { kind: 'message' | 'map' },
    ctx: InterpretContext,
    path: readonly number[]
): MessageType | undefined {
    if (type.kind === 'map') {
        return {
            kind: 'message',
            name: 'MapEntry',
            fullName: 'MapEntry',
            fields: new Map([
                [1, fieldDef({ number: 1, name: 'key', type: scalar(type.key) })],
                [2, fieldDef({ number: 2, name: 'value', type: type.value })]
            ]),
            oneofs: [],
            mapEntry: true,
            messageSet: false
        };
    }
    const resolved = ctx.types.get(type.name);
    if (resolved?.kind === 'message') return resolved;
    ctx.problems.push({
        code: 'unknown-type',
        message: resolved
            ? `${type.name} is an enum, not a message`
            : `Message type ${type.name} is not defined; decoding heuristically`,
        path
    });
    return undefined;
}

function enumValue(typeName: string, raw: bigint, ctx: InterpretContext): Value {
    const value = BigInt.asIntN(32, raw);
    const type = ctx.types.get(typeName);
    const name = type?.kind === 'enum'
        ? type.values.find(v => BigInt(v.number) === value)?.name
        : undefined;
    return { kind: 'enum', value, name, type: typeName };
}

function fromPacked(occ: WireLen, def: FieldDef, ctx: InterpretContext, path: readonly number[]): Value[] {
    const type = def.type;
    const values: Value[] = [];
    const bytes = occ.bytes;
    const fail = (message: string, at: number) => {
        ctx.problems.push({
            code: 'invalid-packed-data',
            message: `Packed field ${def.number} (${def.name}): ${message}`,
            offset: occ.valueRange.start + at,
            path
        });
    };

    if (type.kind === 'enum' || (type.kind === 'scalar' && VARINT_SCALARS.has(type.scalar))) {
        let pos = 0;
        while (pos < bytes.length) {
            const varint = readVarint(bytes, pos, bytes.length);
            if (varint === 'truncated' || varint === 'too-long') {
                fail('ends with an incomplete varint', pos);
                break;
            }
            if (varint.overflow) {
                ctx.problems.push({
                    code: 'varint-overflow',
                    message: `Packed field ${def.number} (${def.name}) has a value with bits beyond 64 (ignored)`,
                    offset: occ.valueRange.start + pos,
                    path
                });
            }
            values.push(type.kind === 'enum' ? enumValue(type.name, varint.value, ctx) : fromVarint(type.scalar, varint.value));
            pos += varint.length;
        }
    } else if (type.kind === 'scalar') {
        const size = I64_SCALARS.has(type.scalar) ? 8 : 4;
        const whole = bytes.length - (bytes.length % size);
        for (let pos = 0; pos < whole; pos += size) {
            values.push(fromFixed(type.scalar, bytes.subarray(pos, pos + size)));
        }
        if (whole !== bytes.length) fail(`length ${bytes.length} is not a multiple of ${size}`, whole);
    }
    return values;
}

function fromVarint(type: ScalarType, raw: bigint): Value {
    switch (type) {
        case 'int32': return { kind: 'int32', value: BigInt.asIntN(32, raw) };
        case 'int64': return { kind: 'int64', value: BigInt.asIntN(64, raw) };
        case 'uint32': return { kind: 'uint32', value: BigInt.asUintN(32, raw) };
        case 'uint64': return { kind: 'uint64', value: raw };
        case 'sint32': return { kind: 'sint32', value: unzigzag(BigInt.asUintN(32, raw)) };
        case 'sint64': return { kind: 'sint64', value: unzigzag(raw) };
        case 'bool': return { kind: 'bool', value: raw !== 0n };
        default: throw new Error(`${type} is not a varint type`);
    }
}

function unzigzag(value: bigint): bigint {
    return (value >> 1n) ^ -(value & 1n);
}

function fromFixed(type: ScalarType, bytes: Uint8Array): Value {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    switch (type) {
        case 'fixed32': return { kind: 'fixed32', value: BigInt(view.getUint32(0, true)) };
        case 'sfixed32': return { kind: 'sfixed32', value: BigInt(view.getInt32(0, true)) };
        case 'float': return { kind: 'float', value: view.getFloat32(0, true) };
        case 'fixed64': return { kind: 'fixed64', value: view.getBigUint64(0, true) };
        case 'sfixed64': return { kind: 'sfixed64', value: view.getBigInt64(0, true) };
        case 'double': return { kind: 'double', value: view.getFloat64(0, true) };
        default: throw new Error(`${type} is not a fixed-width type`);
    }
}
