import { decodeWire, readVarint, type WireMessage } from './wire.ts';

/**
 * Scores in [0, 1] for each way a length-delimited payload could be read.
 * A missing entry means that reading is impossible for these bytes. Bytes
 * are always possible and have the fixed score BYTES_SCORE, so any other
 * reading has to beat that to be chosen.
 */
export interface LenAnalysis {
    readonly length: number;
    readonly message?: { readonly wire: WireMessage; readonly score: number };
    readonly string?: { readonly value: string; readonly score: number };
    readonly packedVarint?: { readonly count: number; readonly score: number };
    readonly packedI32?: { readonly count: number; readonly score: number };
    readonly packedI64?: { readonly count: number; readonly score: number };
}

export const BYTES_SCORE = 0.3;

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** How many nested length-delimited fields we look inside when scoring a candidate message */
const MAX_NESTED_CHECKS = 8;

export function analyzeLen(bytes: Uint8Array, depth: number, recursionLimit: number): LenAnalysis {
    if (bytes.length === 0) return { length: 0 };

    let message: LenAnalysis['message'];
    if (depth < recursionLimit) {
        const wire = decodeWire(bytes);
        if (wire.problems.length === 0 && wire.trailing === undefined && wire.fields.length > 0) {
            message = { wire, score: scoreMessage(wire, depth, recursionLimit) };
        }
    }

    let string: LenAnalysis['string'];
    try {
        const value = utf8.decode(bytes);
        string = { value, score: scoreString(value) };
    } catch {
        // Not UTF-8
    }

    return {
        length: bytes.length,
        message,
        string,
        packedVarint: analyzePackedVarints(bytes),
        packedI32: analyzePackedFixed(bytes, 4),
        packedI64: analyzePackedFixed(bytes, 8)
    };
}

/** The best score of any reading other than opaque bytes, or 0 if there is none */
export function bestNonBytesScore(analysis: LenAnalysis): number {
    return Math.max(
        analysis.message?.score ?? 0,
        analysis.string?.score ?? 0,
        analysis.packedVarint?.score ?? 0,
        analysis.packedI32?.score ?? 0,
        analysis.packedI64?.score ?? 0
    );
}

function scoreString(value: string): number {
    if (value.includes('\0')) return 0.05;
    let total = 0;
    let printable = 0;
    for (const char of value) {
        total++;
        const code = char.codePointAt(0)!;
        const control = (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
            || (code >= 0x7f && code <= 0x9f)
            || code === 0xfffd;
        if (!control) printable++;
    }
    const ratio = printable / total;
    return ratio * ratio;
}

function scoreMessage(wire: WireMessage, depth: number, recursionLimit: number): number {
    let score = 0.6;

    const wireTypesByNumber = new Map<number, Set<number>>();
    let hasGroups = false;
    let hasNonCanonical = false;
    let smallNumberBonus = 0;
    let largeNumberPenalty = 0;
    let nestedBonus = 0;
    let nestedPenalty = 0;
    let nestedChecked = 0;

    for (const field of wire.fields) {
        let types = wireTypesByNumber.get(field.number);
        if (!types) {
            types = new Set();
            wireTypesByNumber.set(field.number, types);
            if (field.number <= 15) smallNumberBonus = Math.min(0.15, smallNumberBonus + 0.05);
            if (field.number >= 19000 && field.number <= 19999) largeNumberPenalty += 0.3;
            else if (field.number > 1000) largeNumberPenalty = Math.min(0.3, largeNumberPenalty + 0.15);
        }
        types.add(field.wireType);

        if (field.kind === 'group') hasGroups = true;
        if (field.kind === 'varint' && field.nonCanonical) hasNonCanonical = true;
        if (field.kind === 'len' && field.bytes.length > 0 && nestedChecked < MAX_NESTED_CHECKS) {
            nestedChecked++;
            const best = bestNonBytesScore(analyzeLen(field.bytes, depth + 1, recursionLimit));
            if (best >= 0.7) nestedBonus = Math.min(0.2, nestedBonus + 0.1);
            else if (best < 0.4) nestedPenalty = Math.min(0.2, nestedPenalty + 0.1);
        }
    }

    const distinct = wireTypesByNumber.size;
    score += (Math.min(distinct, 3) - 1) * 0.075;
    score += smallNumberBonus;
    score -= largeNumberPenalty;
    for (const types of wireTypesByNumber.values()) {
        if (types.size > 1) { score -= 0.4; break; }
    }
    if (hasGroups) score -= 0.1;
    if (hasNonCanonical) score -= 0.2;
    score += nestedBonus - nestedPenalty;

    return Math.max(0, Math.min(1, score));
}

function analyzePackedVarints(bytes: Uint8Array): LenAnalysis['packedVarint'] {
    let pos = 0;
    let count = 0;
    let large = false;
    while (pos < bytes.length) {
        const varint = readVarint(bytes, pos, bytes.length);
        if (varint === 'truncated' || varint === 'too-long' || varint.nonCanonical || varint.overflow) return undefined;
        if (varint.value >= 0x100000000n && varint.value < 0x8000000000000000n) large = true;
        pos += varint.length;
        count++;
    }
    if (count < 2) return undefined;
    let score = 0.4;
    if (count >= 3) score += 0.1;
    if (large) score -= 0.1;
    return { count, score };
}

function analyzePackedFixed(bytes: Uint8Array, size: 4 | 8): LenAnalysis['packedI32'] {
    if (bytes.length % size !== 0 || bytes.length < size * 2) return undefined;
    const count = bytes.length / size;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let allReasonableFloats = true;
    let anyZero = false;
    for (let i = 0; i < count; i++) {
        const value = size === 4 ? view.getFloat32(i * size, true) : view.getFloat64(i * size, true);
        if (!isReasonableFloat(value, size)) { allReasonableFloats = false; break; }
        if (value === 0) anyZero = true;
    }
    // A run of plausible non-zero floats is strong evidence; zeros are ambiguous with varints
    const score = !allReasonableFloats ? 0.25 : anyZero ? 0.45 : 0.55;
    return { count, score };
}

/**
 * Whether a float decoded from raw bits looks like a number someone meant
 * to write, rather than an integer or random bytes read as a float: finite,
 * and with an exponent within a modest range around zero (or exactly zero).
 */
export function isReasonableFloat(value: number, size: 4 | 8): boolean {
    if (value === 0) return true;
    if (!Number.isFinite(value)) return false;
    const exponent = Math.log2(Math.abs(value));
    return Math.abs(exponent) <= (size === 4 ? 40 : 100);
}
