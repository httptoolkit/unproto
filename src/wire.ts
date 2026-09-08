import type { Problem } from './problem.ts';

export type WireType = 0 | 1 | 2 | 3 | 4 | 5;

/** Byte offsets into the original input; end is exclusive. */
export interface ByteRange {
    readonly start: number;
    readonly end: number;
}

interface WireFieldBase {
    readonly number: number;
    /** From the first byte of the tag to the last byte of the value (for groups: of the end tag). */
    readonly range: ByteRange;
    /** The value bytes only (for groups: the enclosed fields). */
    readonly valueRange: ByteRange;
}

export interface WireVarint extends WireFieldBase {
    readonly kind: 'varint';
    readonly wireType: 0;
    /** The raw unsigned 64-bit value, before any type interpretation */
    readonly value: bigint;
    /** True if encoded with more bytes than necessary */
    readonly nonCanonical: boolean;
}

export interface WireI64 extends WireFieldBase {
    readonly kind: 'i64';
    readonly wireType: 1;
    readonly bytes: Uint8Array;
}

export interface WireLen extends WireFieldBase {
    readonly kind: 'len';
    readonly wireType: 2;
    readonly bytes: Uint8Array;
    /** True if the length prefix was encoded with more bytes than necessary */
    readonly nonCanonicalLength: boolean;
}

export interface WireGroup extends WireFieldBase {
    readonly kind: 'group';
    readonly wireType: 3;
    readonly fields: readonly WireField[];
    /** False if the input ended, or a different group ended, before this group's end tag */
    readonly closed: boolean;
}

/** An end-group tag with no matching open group. Always accompanied by a problem. */
export interface WireEndGroup extends WireFieldBase {
    readonly kind: 'egroup';
    readonly wireType: 4;
}

export interface WireI32 extends WireFieldBase {
    readonly kind: 'i32';
    readonly wireType: 5;
    readonly bytes: Uint8Array;
}

export type WireField = WireVarint | WireI64 | WireLen | WireGroup | WireEndGroup | WireI32;

export interface WireMessage {
    readonly fields: readonly WireField[];
    /** Bytes after the last successfully parsed field, if parsing stopped early */
    readonly trailing?: ByteRange;
    readonly problems: readonly Problem[];
}

export interface DecodeWireOptions {
    /** Maximum group nesting depth. Defaults to 100, matching the reference implementations. */
    readonly recursionLimit?: number;
    /**
     * Added to every reported offset and range, so that a nested message
     * decoded from a slice can report positions relative to the whole input.
     */
    readonly offset?: number;
}

export const MAX_FIELD_NUMBER = 536870911; // 2^29 - 1
export const MAX_LENGTH = 0x7FFFFFFF;

export interface VarintResult {
    readonly value: bigint;
    readonly length: number;
    readonly nonCanonical: boolean;
    /** True if the tenth byte carried bits beyond 64, which were discarded */
    readonly overflow: boolean;
}

// 2^(7n) for the first seven varint bytes: these fit in a double exactly,
// so we can accumulate them as numbers and only build a bigint at the end.
const VARINT_SHIFT = [1, 2 ** 7, 2 ** 14, 2 ** 21, 2 ** 28, 2 ** 35, 2 ** 42];
const U64_MASK = 0xFFFFFFFFFFFFFFFFn;

/**
 * Reads a varint of up to 10 bytes. Returns 'truncated' if the input ends
 * mid-varint, or 'too-long' if there is no terminating byte within 10.
 */
export function readVarint(input: Uint8Array, pos: number, end: number): VarintResult | 'truncated' | 'too-long' {
    let value = 0;
    let i = 0;
    for (; i < 7; i++) {
        if (pos + i >= end) return 'truncated';
        const b = input[pos + i]!;
        value += (b & 0x7f) * VARINT_SHIFT[i]!;
        if (b < 0x80) {
            return { value: BigInt(value), length: i + 1, nonCanonical: i > 0 && b === 0, overflow: false };
        }
    }
    let big = BigInt(value);
    for (; i < 10; i++) {
        if (pos + i >= end) return 'truncated';
        const b = input[pos + i]!;
        big += BigInt(b & 0x7f) << BigInt(7 * i);
        if (b < 0x80) {
            const overflow = i === 9 && (b & 0x7e) !== 0;
            return { value: big & U64_MASK, length: i + 1, nonCanonical: b === 0, overflow };
        }
    }
    return 'too-long';
}

interface SmallVarint {
    readonly value: number;
    readonly length: number;
    readonly nonCanonical: boolean;
}

/**
 * Reads a varint that must fit in 32 bits (a tag or a length) without
 * allocating a bigint. Payload bits beyond the seventh byte mean a value
 * of at least 2^49, reported as 'too-large'; bytes that only pad the
 * encoding with zero groups are accepted and flagged as non-canonical.
 */
export function readSmallVarint(input: Uint8Array, pos: number, end: number): SmallVarint | 'truncated' | 'too-long' | 'too-large' {
    let value = 0;
    for (let i = 0; i < 10; i++) {
        if (pos + i >= end) return 'truncated';
        const b = input[pos + i]!;
        const payload = b & 0x7f;
        if (i < 7) value += payload * VARINT_SHIFT[i]!;
        else if (payload !== 0) return 'too-large';
        if (b < 0x80) return { value, length: i + 1, nonCanonical: i > 0 && payload === 0 };
    }
    return 'too-long';
}

interface State {
    readonly input: Uint8Array;
    readonly base: number;
    readonly recursionLimit: number;
    readonly problems: Problem[];
    trailing: ByteRange | undefined;
}

interface FieldsResult {
    readonly fields: WireField[];
    /** Where parsing stopped (after a consumed matching end tag, or before a foreign one) */
    readonly pos: number;
    /** The field number of the end-group tag that stopped parsing, if any */
    readonly endGroup?: number;
    /** Start offset of that end-group tag */
    readonly endGroupTagStart?: number;
    /** True if parsing stopped because of an error or truncation */
    readonly stopped: boolean;
}

/**
 * Splits protobuf bytes into raw wire-format fields without interpreting
 * them. Never throws for malformed input: parsing stops at the first byte
 * that cannot be read, the rest is reported as `trailing`, and every issue
 * is listed in `problems`.
 */
export function decodeWire(input: Uint8Array, options: DecodeWireOptions = {}): WireMessage {
    const state: State = {
        input,
        base: options.offset ?? 0,
        recursionLimit: options.recursionLimit ?? 100,
        problems: [],
        trailing: undefined
    };
    const result = readFields(state, 0, input.length, 0, undefined);
    return { fields: result.fields, trailing: state.trailing, problems: state.problems };
}

function readFields(state: State, start: number, end: number, depth: number, group: number | undefined): FieldsResult {
    const { input, base } = state;
    const fields: WireField[] = [];
    let pos = start;

    const stop = (code: Problem['code'], message: string, at: number): FieldsResult => {
        state.problems.push({ code, message, offset: base + at });
        state.trailing = { start: base + at, end: base + end };
        return { fields, pos: end, stopped: true };
    };

    while (pos < end) {
        const tagStart = pos;
        const tag = readSmallVarint(input, pos, end);
        if (tag === 'truncated') return stop('truncated', 'Input ended in the middle of a tag', tagStart);
        if (tag === 'too-long') return stop('invalid-tag', 'Tag varint is longer than 10 bytes', tagStart);
        if (tag === 'too-large' || tag.value > 0xFFFFFFFF) return stop('invalid-tag', 'Tag value does not fit in 32 bits', tagStart);
        pos += tag.length;

        const tagNumber = tag.value;
        const wireType = tagNumber & 0x7;
        const number = tagNumber >>> 3;

        if (number === 0) return stop('invalid-field-number', 'Field number 0 is not allowed', tagStart);
        if (wireType === 6 || wireType === 7) {
            return stop('invalid-wire-type', `Wire type ${wireType} is not defined (field ${number})`, tagStart);
        }

        switch (wireType) {
            case 0: {
                const varint = readVarint(input, pos, end);
                if (varint === 'truncated') return stop('truncated', `Input ended inside the varint value of field ${number}`, tagStart);
                if (varint === 'too-long') return stop('varint-too-long', `Varint value of field ${number} is longer than 10 bytes`, tagStart);
                if (varint.overflow) {
                    state.problems.push({
                        code: 'varint-overflow',
                        message: `Varint value of field ${number} has bits beyond 64 (ignored)`,
                        offset: base + pos
                    });
                }
                fields.push({
                    kind: 'varint', wireType: 0, number,
                    value: varint.value, nonCanonical: varint.nonCanonical,
                    range: { start: base + tagStart, end: base + pos + varint.length },
                    valueRange: { start: base + pos, end: base + pos + varint.length }
                });
                pos += varint.length;
                break;
            }
            case 1:
            case 5: {
                const size = wireType === 1 ? 8 : 4;
                if (pos + size > end) return stop('truncated', `Input ended inside the ${size}-byte value of field ${number}`, tagStart);
                const bytes = input.subarray(pos, pos + size);
                const range = { start: base + tagStart, end: base + pos + size };
                const valueRange = { start: base + pos, end: base + pos + size };
                fields.push(wireType === 1
                    ? { kind: 'i64', wireType: 1, number, bytes, range, valueRange }
                    : { kind: 'i32', wireType: 5, number, bytes, range, valueRange });
                pos += size;
                break;
            }
            case 2: {
                const length = readSmallVarint(input, pos, end);
                if (length === 'truncated') return stop('truncated', `Input ended inside the length of field ${number}`, tagStart);
                if (length === 'too-long') return stop('length-too-large', `Length of field ${number} is not a valid varint`, tagStart);
                if (length === 'too-large' || length.value > MAX_LENGTH) return stop('length-too-large', `Length of field ${number} exceeds 2^31 - 1`, tagStart);
                const valueStart = pos + length.length;
                const valueEnd = valueStart + length.value;
                if (valueEnd > end) {
                    return stop('truncated', `Field ${number} declares ${length.value} bytes but only ${end - valueStart} remain`, tagStart);
                }
                fields.push({
                    kind: 'len', wireType: 2, number,
                    bytes: input.subarray(valueStart, valueEnd),
                    nonCanonicalLength: length.nonCanonical,
                    range: { start: base + tagStart, end: base + valueEnd },
                    valueRange: { start: base + valueStart, end: base + valueEnd }
                });
                pos = valueEnd;
                break;
            }
            case 3: {
                if (depth >= state.recursionLimit) {
                    return stop('recursion-limit', `Group nesting exceeds the limit of ${state.recursionLimit}`, tagStart);
                }
                const inner = readFields(state, pos, end, depth + 1, number);
                const closed = inner.endGroup === number;
                let valueEnd = inner.pos;
                let groupEnd = inner.pos;
                if (closed) {
                    // The end tag may have been consumed by the inner call or handed up
                    // unconsumed by a deeper one, so recompute its extent from its start.
                    valueEnd = inner.endGroupTagStart!;
                    const endTag = readSmallVarint(input, valueEnd, end);
                    groupEnd = valueEnd + (typeof endTag === 'string' ? 1 : endTag.length);
                }

                if (!closed && !inner.stopped) {
                    state.problems.push(inner.endGroup === undefined
                        ? { code: 'unclosed-group', message: `Group ${number} was never closed`, offset: base + tagStart }
                        : {
                            code: 'mismatched-end-group',
                            message: `Group ${number} was closed by an end tag for group ${inner.endGroup}`,
                            offset: base + inner.pos
                        });
                }

                fields.push({
                    kind: 'group', wireType: 3, number,
                    fields: inner.fields, closed,
                    range: { start: base + tagStart, end: base + groupEnd },
                    valueRange: { start: base + pos, end: base + valueEnd }
                });
                pos = groupEnd;

                if (inner.stopped) return { fields, pos, stopped: true };
                if (!closed && inner.endGroup !== undefined && group !== undefined) {
                    // The foreign end tag may belong to one of our ancestors: hand it up
                    return { fields, pos, endGroup: inner.endGroup, endGroupTagStart: inner.endGroupTagStart, stopped: false };
                }
                // At the top level the loop will pick the foreign end tag up as an orphan
                break;
            }
            case 4: {
                if (group === number) {
                    return { fields, pos, endGroup: number, endGroupTagStart: tagStart, stopped: false };
                }
                if (group !== undefined) {
                    // Not ours: leave it unconsumed for an outer group to match against
                    return { fields, pos: tagStart, endGroup: number, endGroupTagStart: tagStart, stopped: false };
                }
                state.problems.push({
                    code: 'unexpected-end-group',
                    message: `End tag for group ${number} with no matching start`,
                    offset: base + tagStart
                });
                fields.push({
                    kind: 'egroup', wireType: 4, number,
                    range: { start: base + tagStart, end: base + pos },
                    valueRange: { start: base + pos, end: base + pos }
                });
                break;
            }
        }
    }

    return { fields, pos, stopped: false };
}
