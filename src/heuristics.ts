import { decodeWire, type WireMessage } from './wire.ts';

/**
 * Scores in [0, 1] for each way a length-delimited payload could be read.
 * A missing entry means that reading is impossible for these bytes. Bytes
 * are always possible and have the fixed score BYTES_SCORE, so any other
 * reading has to beat that to be chosen.
 */
export interface LenAnalysis {
    readonly length: number;
    readonly message?: Candidate & { readonly wire: WireMessage };
    readonly string?: Candidate & { readonly value: string };
    readonly packedVarint?: PackedCandidate;
    readonly packedI32?: PackedCandidate;
    readonly packedI64?: PackedCandidate;
}

export interface Candidate {
    readonly score: number;
    /** A valid but uninformative reading, e.g. a single-element packed chunk */
    readonly neutral?: boolean;
}

export interface PackedCandidate extends Candidate {
    readonly count: number;
}

export const BYTES_SCORE = 0.3;
/** The score of a reading that is possible but has no evidence for it */
export const NEUTRAL_SCORE = 0.2;

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** How many nested length-delimited fields we look inside when scoring a candidate message */
const MAX_NESTED_CHECKS = 8;

/**
 * Remembers the analysis of each payload by identity. Scoring a candidate
 * message analyses its nested payloads, and inferring that message's type
 * analyses them again, so without this deep nesting costs quadratic time.
 */
export type AnalysisCache = WeakMap<Uint8Array, LenAnalysis>;

/**
 * Analyses a length-delimited payload. `offset` is the payload's absolute
 * position in the original input, so that the wire records of a candidate
 * message report absolute positions too.
 */
export function analyzeLen(bytes: Uint8Array, offset: number, depth: number, recursionLimit: number, cache: AnalysisCache): LenAnalysis {
    if (bytes.length === 0) return { length: 0 };
    const cached = cache.get(bytes);
    if (cached) return cached;

    let message: LenAnalysis['message'];
    if (depth < recursionLimit) {
        const wire = decodeWire(bytes, { offset });
        if (isWellFormed(wire)) {
            message = { wire, score: scoreMessage(wire, bytes.length, depth, recursionLimit, cache) };
        }
    }

    let string: LenAnalysis['string'];
    try {
        const value = utf8.decode(bytes);
        string = { value, score: scoreString(value, bytes, message !== undefined) };
    } catch {
        // Not UTF-8
    }

    const analysis: LenAnalysis = {
        length: bytes.length,
        message,
        string,
        packedVarint: analyzePackedVarints(bytes),
        packedI32: analyzePackedFixed(bytes, 4),
        packedI64: analyzePackedFixed(bytes, 8)
    };
    cache.set(bytes, analysis);
    return analysis;
}

/** Whether every byte was consumed by valid, balanced fields, with at least one field */
export function isWellFormed(wire: WireMessage): boolean {
    return wire.problems.length === 0 && wire.trailing === undefined && wire.fields.length > 0;
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

function scoreString(value: string, bytes: Uint8Array, couldBeMessage: boolean): number {
    let total = 0;
    let printable = 0;
    let hardControls = 0;
    let leadingWhitespaceControls = 0;
    for (const char of value) {
        total++;
        const code = char.codePointAt(0)!;
        const whitespaceControl = code === 0x09 || code === 0x0a || code === 0x0d;
        const control = (code < 0x20 && !whitespaceControl)
            || (code >= 0x7f && code <= 0x9f)
            || code === 0xfffd;
        if (control) hardControls++;
        else printable++;
        if (whitespaceControl && total <= 2) leadingWhitespaceControls++;
    }
    const ratio = printable / total;
    let score = ratio * ratio;
    // Control characters other than tab/newline hardly ever appear in real text, but
    // are exactly what small tags and lengths look like. NUL is included: a single
    // terminator is survivable, a scattering of them is not text.
    score -= 0.25 * hardControls;
    // Text rarely starts with a tab or newline; message fields 1 and 2 encode as those
    score -= 0.15 * leadingWhitespaceControls;
    // A printable first byte that is also a length-delimited tag, when the rest lines up
    // as a message, is a suspicious coincidence
    if (couldBeMessage && (bytes[0]! & 0x7) === 2) score -= 0.1;
    return Math.max(0, score);
}

function scoreMessage(wire: WireMessage, payloadLength: number, depth: number, recursionLimit: number, cache: AnalysisCache): number {
    let score = 0.6;

    const wireTypesByNumber = new Map<number, Set<number>>();
    let hasGroups = false;
    let hasNonCanonical = false;
    let smallNumberBonus = 0;
    let hasLargeNumber = false;
    let hasReservedNumber = false;
    let ascending = true;
    let previousNumber = 0;
    let coveredBytes = 0;
    let nestedPenalty = 0;
    let nestedChecked = 0;

    for (const field of wire.fields) {
        let types = wireTypesByNumber.get(field.number);
        if (!types) {
            types = new Set();
            wireTypesByNumber.set(field.number, types);
            if (field.number <= 15) smallNumberBonus = Math.min(0.15, smallNumberBonus + 0.05);
            if (field.number >= 19000 && field.number <= 19999) hasReservedNumber = true;
            else if (field.number > 1000) hasLargeNumber = true;
        }
        types.add(field.wireType);
        if (field.number < previousNumber) ascending = false;
        previousNumber = field.number;

        if (field.kind === 'group') hasGroups = true;
        if (field.kind === 'varint' && field.nonCanonical) hasNonCanonical = true;
        if (field.kind === 'len' && field.bytes.length > 0 && nestedChecked < MAX_NESTED_CHECKS) {
            nestedChecked++;
            const best = bestNonBytesScore(analyzeLen(field.bytes, field.valueRange.start, depth + 1, recursionLimit, cache));
            if (best >= 0.7) coveredBytes += field.bytes.length;
            else if (best > BYTES_SCORE) coveredBytes += field.bytes.length / 2;
            else nestedPenalty = Math.min(0.2, nestedPenalty + 0.1);
        }
    }

    const distinct = wireTypesByNumber.size;
    score += (Math.min(distinct, 3) - 1) * 0.075;
    score += smallNumberBonus;
    // Large field numbers are unusual but legal, so they count once and lightly;
    // the reserved range should never appear on the wire
    if (hasReservedNumber) score -= 0.3;
    else if (hasLargeNumber) score -= 0.1;
    // Serializers write fields in number order, so a coherent message usually is
    if (distinct >= 2) score += ascending ? 0.05 : -0.05;
    for (const types of wireTypesByNumber.values()) {
        if (types.size > 1) { score -= 0.4; break; }
    }
    if (hasGroups) score -= 0.1;
    if (hasNonCanonical) score -= 0.2;
    // Nested values that read well themselves explain the payload: the more of it they
    // cover, the less likely the tag and length bytes around them are a coincidence
    score += 0.3 * (coveredBytes / payloadLength) - nestedPenalty;

    return Math.max(0, Math.min(1, score));
}

// Classifies the varints in a payload from their byte lengths alone, without
// materialising values: a canonical varint of n bytes is at least 2^(7(n-1)).
export function analyzePackedVarints(bytes: Uint8Array): PackedCandidate | undefined {
    let pos = 0;
    let count = 0;
    let zeros = 0;
    let wide = 0;
    let large = false;
    let printableBytes = 0;
    while (pos < bytes.length) {
        const start = pos;
        while (pos < bytes.length && bytes[pos]! >= 0x80) pos++;
        if (pos >= bytes.length) return undefined;
        const last = bytes[pos]!;
        pos++;
        const length = pos - start;
        if (length > 10) return undefined;
        if (length > 1 && last === 0) return undefined;
        if (length === 10 && (last & 0x7e) !== 0) return undefined;
        if (length === 1) {
            if (last === 0) zeros++;
            if (isPrintableAscii(last)) printableBytes++;
        }
        if (length >= 4) wide++;
        if (length === 5) {
            // The only width where 2^32 falls mid-range
            if (last >= 0x10) large = true;
        } else if (length >= 6 && length <= 9) {
            large = true;
        }
        count++;
    }
    if (count === 0) return undefined;
    if (count === 1) return { count, score: NEUTRAL_SCORE, neutral: true };
    let score = 0.4;
    if (count >= 3) score += 0.1;
    // Little-endian fixed-width integers read as varints produce runs of zeros
    if (count >= 3 && bytes.length % 4 === 0 && zeros * 3 >= count) score -= 0.1;
    // Random binary that happens to parse as varints gives mostly wide values
    if (wide * 2 > count) score -= 0.15;
    else if (large) score -= 0.1;
    // Text is also a run of single-byte varints, which is no evidence at all; anything
    // that is not entirely text keeps the benefit of the doubt
    if (printableBytes === count) score -= 0.25;
    return { count, score };
}

function isPrintableAscii(byte: number): boolean {
    return (byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

// "Small" means the top byte (fixed32) or top four bytes (fixed64) carry only sign
const SMALL_INT_LIMIT = { 4: 2n ** 23n, 8: 2n ** 31n } as const;

export function analyzePackedFixed(bytes: Uint8Array, size: 4 | 8): PackedCandidate | undefined {
    if (bytes.length % size !== 0 || bytes.length === 0) return undefined;
    const count = bytes.length / size;
    if (count === 1) return { count, score: NEUTRAL_SCORE, neutral: true };
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let allReasonableFloats = true;
    let anyZero = false;
    let allSmallInts = true;
    let cleanLowWords = true;
    let halvesAreFloats = true;
    for (let i = 0; i < count; i++) {
        const value = size === 4 ? view.getFloat32(i * size, true) : view.getFloat64(i * size, true);
        if (!isReasonableFloat(value, size)) allReasonableFloats = false;
        if (value === 0) anyZero = true;
        const int = size === 4 ? BigInt(view.getInt32(i * size, true)) : view.getBigInt64(i * size, true);
        if (int >= SMALL_INT_LIMIT[size] || int < -SMALL_INT_LIMIT[size]) allSmallInts = false;
        if (size === 8) {
            if (view.getUint32(i * size, true) !== 0) cleanLowWords = false;
            // A float someone wrote has a short mantissa; a double's low word does not
            const low = view.getUint32(i * size, true);
            if ((low & 0xff) !== 0
                || !isReasonableFloat(view.getFloat32(i * size, true), 4)
                || !isReasonableFloat(view.getFloat32(i * size + 4, true), 4)) {
                halvesAreFloats = false;
            }
        }
    }
    // A run of plausible non-zero floats is strong evidence; zeros are ambiguous with varints.
    // Small integers are a decent sign too: random bytes rarely have their high bytes clear.
    // The same bytes often read plausibly at both widths, so the 64-bit reading gets a
    // nudge exactly when its shape says so: doubles with few significant bits have empty
    // low words, and small 64-bit integers have empty high words (which the 32-bit reading
    // would show as interleaved zeros).
    let score = allReasonableFloats ? (anyZero ? 0.45 : 0.55)
        : allSmallInts ? 0.45
        : 0.25;
    if (size === 8 && score > 0.25 && (allReasonableFloats ? cleanLowWords : true)) score += 0.02;
    // Two floats glued together read as a double whose low word is itself a plausible float;
    // a genuine double with significant low bits almost never splits that way
    if (size === 8 && allReasonableFloats && !cleanLowWords && halvesAreFloats) score -= 0.15;
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
