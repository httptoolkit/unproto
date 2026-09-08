import { decodeWire, type WireField, type WireI32, type WireI64, type WireMessage, type WireType } from './wire.ts';
import {
    scalar,
    type AlternativeType,
    type FieldDef,
    type FieldType,
    type MessageType,
    type NamedType,
    type Presence,
    type Schema
} from './schema.ts';
import {
    analyzeLen,
    isReasonableFloat,
    BYTES_SCORE,
    NEUTRAL_SCORE,
    type AnalysisCache,
    type Candidate as LenCandidate,
    type LenAnalysis
} from './heuristics.ts';
import type { Problem } from './problem.ts';

export interface InferOptions {
    /** Name given to the root message type. Defaults to 'Message'. */
    readonly rootName?: string;
    readonly recursionLimit?: number;
}

/**
 * Infers a schema from one or more messages of the same type. With a single
 * sample every field is 'optional' and repeated only if it appears more
 * than once; more samples give better cardinality and type evidence.
 */
export function inferSchema(samples: readonly Uint8Array[], options: InferOptions = {}): Schema {
    return inferSchemaFromWire(samples.map(s => decodeWire(s, { recursionLimit: options.recursionLimit })), options);
}

/** @internal Lets decode() reuse the wire records it has already read and collect inference problems */
export function inferSchemaFromWire(samples: readonly WireMessage[], options: InferOptions = {}, problems: Problem[] = []): Schema {
    const rootName = options.rootName ?? 'Message';
    const types = new Map<string, NamedType>();
    const inferrer = new Inferrer(types, options.recursionLimit ?? 100, new Set(), problems);
    inferrer.inferMessageType(inferrer.allocateName(rootName), samples.map(w => w.fields), 0);
    return inferrer.needsEditions
        ? { syntax: 'editions', edition: '2023', types }
        : { syntax: 'proto3', types };
}

type Candidate = 'message' | 'string' | 'packedVarint' | 'packedI64' | 'packedI32' | 'bytes';
const CANDIDATE_ORDER: readonly Candidate[] = ['string', 'message', 'packedVarint', 'packedI32', 'packedI64', 'bytes'];

export class Inferrer {
    /** Set when the data uses group encoding, which proto3 cannot express */
    needsEditions = false;

    /** All known types, keyed by full name; inferred types are added here */
    readonly types: Map<string, NamedType>;
    /** The names in `types` that inference owns and may replace; anything else is left alone */
    readonly owned: Set<string>;
    readonly recursionLimit: number;
    readonly problems: Problem[];
    private readonly cache: AnalysisCache = new WeakMap();

    constructor(types: Map<string, NamedType>, recursionLimit: number, owned: Set<string>, problems: Problem[]) {
        this.types = types;
        this.recursionLimit = recursionLimit;
        this.owned = owned;
        this.problems = problems;
    }

    /** Returns the name itself, or a numbered variant if a supplied type already uses it */
    allocateName(base: string): string {
        let name = base;
        for (let i = 2; this.types.has(name) && !this.owned.has(name); i++) name = `${base}_${i}`;
        this.owned.add(name);
        return name;
    }

    /**
     * Infers (and registers) a message type from samples, each being the
     * field list of one message of that type.
     */
    inferMessageType(fullName: string, samples: readonly (readonly WireField[])[], depth: number): MessageType {
        const perNumber = new Map<number, WireField[][]>();
        samples.forEach((fields, sampleIndex) => {
            for (const field of fields) {
                let perSample = perNumber.get(field.number);
                if (!perSample) {
                    perSample = samples.map(() => []);
                    perNumber.set(field.number, perSample);
                }
                perSample[sampleIndex]!.push(field);
            }
        });

        const fields = new Map<number, FieldDef>();
        for (const [number, perSample] of perNumber) {
            fields.set(number, this.inferField(number, perSample, fullName, depth));
        }

        const type: MessageType = {
            kind: 'message',
            name: fullName.slice(fullName.lastIndexOf('.') + 1),
            fullName,
            fields,
            oneofs: [],
            mapEntry: false,
            messageSet: false
        };
        this.types.set(fullName, type);
        return type;
    }

    /** Infers a field from its occurrences, grouped per sample message */
    inferField(number: number, perSample: readonly (readonly WireField[])[], parentFullName: string, depth: number): FieldDef {
        const all = perSample.flat();
        const counts = new Map<WireType, number>();
        for (const field of all) counts.set(field.wireType, (counts.get(field.wireType) ?? 0) + 1);
        const dominant = ([2, 0, 1, 5, 3, 4] as const).reduce((best, wt) =>
            (counts.get(wt) ?? 0) > (counts.get(best) ?? 0) ? wt : best);

        const repeated = perSample.some(s => s.length > 1);
        let nestedName = `${parentFullName}.Field${number}`;

        let type: FieldType;
        let alternatives: AlternativeType[] = [];
        let packed = false;
        let delimited = false;
        let presence: Presence = 'implicit';
        let forceRepeated = false;

        switch (dominant) {
            case 0: {
                const values = all.filter(f => f.kind === 'varint').map(f => f.value);
                type = scalar('int64');
                alternatives = varintAlternatives(values);
                if (values.some(v => v === 0n)) presence = 'explicit';
                break;
            }
            case 1:
            case 5: {
                const size = dominant === 1 ? 8 : 4;
                const chunks = all
                    .filter((f): f is WireI64 | WireI32 => f.wireType === dominant)
                    .map(f => f.bytes);
                ({ type, alternatives } = fixedTypes(chunks, size));
                if (chunks.some(c => c.every(b => b === 0))) presence = 'explicit';
                break;
            }
            case 2: {
                const occurrences = all.filter(f => f.kind === 'len');
                const analyses = occurrences.map(o => analyzeLen(o.bytes, depth, this.recursionLimit, this.cache));
                const tooDeep = depth >= this.recursionLimit && occurrences.find(o => o.bytes.length > 0);
                if (tooDeep) {
                    this.problems.push({
                        code: 'recursion-limit',
                        message: `Field ${number} is nested deeper than the limit of ${this.recursionLimit}; its content was not analysed`,
                        offset: tooDeep.range.start
                    });
                }
                const evidence = {
                    varint: (counts.get(0) ?? 0) > 0,
                    i32: (counts.get(5) ?? 0) > 0,
                    i64: (counts.get(1) ?? 0) > 0
                };
                const ranked = rankCandidates(analyses, evidence);
                const chosen = ranked[0]!;

                if (analyses.some(a => a.message)) {
                    nestedName = this.allocateName(nestedName);
                    const nestedSamples = analyses.map(a => a.message?.wire.fields ?? []);
                    this.inferMessageType(nestedName, nestedSamples, depth + 1);
                }

                const toType = (candidate: Candidate): AlternativeType => {
                    switch (candidate) {
                        case 'message': return { type: { kind: 'message', name: nestedName }, packed: false };
                        case 'string': return { type: scalar('string'), packed: false };
                        case 'bytes': return { type: scalar('bytes'), packed: false };
                        case 'packedVarint': return { type: scalar('int64'), packed: true };
                        case 'packedI32': return { type: fixedTypes(splitFixed(occurrences.map(o => o.bytes), 4), 4).type, packed: true };
                        case 'packedI64': return { type: fixedTypes(splitFixed(occurrences.map(o => o.bytes), 8), 8).type, packed: true };
                    }
                };

                ({ type, packed } = toType(chosen));
                alternatives = ranked.slice(1).map(toType);
                if (packed) forceRepeated = true;
                if (!packed && analyses.some(a => a.length === 0)) presence = 'explicit';
                break;
            }
            case 3: {
                const groups = all.filter(f => f.kind === 'group');
                nestedName = this.allocateName(nestedName);
                this.inferMessageType(nestedName, groups.map(g => g.fields), depth + 1);
                type = { kind: 'message', name: nestedName };
                delimited = true;
                this.needsEditions = true;
                break;
            }
            case 4: {
                type = scalar('bytes');
                break;
            }
        }

        if (type.kind === 'message') presence = 'explicit';

        return {
            number,
            name: `field_${number}`,
            type,
            cardinality: repeated || forceRepeated ? 'repeated' : 'optional',
            presence,
            packed,
            delimited,
            inferred: { alternatives }
        };
    }
}

function varintAlternatives(values: readonly bigint[]): AlternativeType[] {
    const alternatives: AlternativeType[] = [];
    const signed = values.map(v => BigInt.asIntN(64, v));
    if (signed.every(v => v >= -0x80000000n && v <= 0x7fffffffn)) alternatives.push({ type: scalar('int32'), packed: false });
    alternatives.push({ type: scalar('uint64'), packed: false });
    alternatives.push({ type: scalar('sint64'), packed: false });
    if (values.every(v => v === 0n || v === 1n)) alternatives.push({ type: scalar('bool'), packed: false });
    return alternatives;
}

function fixedTypes(chunks: readonly Uint8Array[], size: 4 | 8): { type: FieldType; alternatives: AlternativeType[] } {
    const floatType = scalar(size === 4 ? 'float' : 'double');
    const unsignedType = scalar(size === 4 ? 'fixed32' : 'fixed64');
    const signedType = scalar(size === 4 ? 'sfixed32' : 'sfixed64');

    let allReasonableFloats = chunks.length > 0;
    let anyTopBitSet = false;
    for (const chunk of chunks) {
        const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        const value = size === 4 ? view.getFloat32(0, true) : view.getFloat64(0, true);
        if (!isReasonableFloat(value, size)) allReasonableFloats = false;
        if ((chunk[size - 1]! & 0x80) !== 0) anyTopBitSet = true;
    }

    const asAlt = (type: FieldType): AlternativeType => ({ type, packed: false });
    if (allReasonableFloats) return { type: floatType, alternatives: [asAlt(unsignedType), asAlt(signedType)] };
    if (anyTopBitSet) return { type: signedType, alternatives: [asAlt(unsignedType), asAlt(floatType)] };
    return { type: unsignedType, alternatives: [asAlt(signedType), asAlt(floatType)] };
}

function splitFixed(payloads: readonly Uint8Array[], size: 4 | 8): Uint8Array[] {
    const chunks: Uint8Array[] = [];
    for (const payload of payloads) {
        for (let i = 0; i + size <= payload.length; i += size) chunks.push(payload.subarray(i, i + size));
    }
    return chunks;
}

interface PackedEvidence {
    readonly varint: boolean;
    readonly i32: boolean;
    readonly i64: boolean;
}

/**
 * Combines per-occurrence analyses into an ordered list of candidate
 * readings for the field as a whole. A reading must be possible for every
 * non-empty occurrence, and its score is its worst score among the
 * occurrences that carry evidence, so one convincing occurrence cannot
 * carry an unconvincing one, while neutral ones (such as single-element
 * packed chunks) neither help nor hurt.
 */
function rankCandidates(analyses: readonly LenAnalysis[], evidence: PackedEvidence): Candidate[] {
    const nonEmpty = analyses.filter(a => a.length > 0);
    if (nonEmpty.length === 0) return ['string', 'bytes', 'message'];

    const scores = new Map<Candidate, number>();
    scores.set('bytes', BYTES_SCORE);

    const consider = (candidate: Candidate, get: (a: LenAnalysis) => LenCandidate | undefined, boost: number) => {
        let worst = 1;
        let anyEvidence = false;
        for (const analysis of nonEmpty) {
            const entry = get(analysis);
            if (entry === undefined) return;
            if (entry.neutral) continue;
            worst = Math.min(worst, entry.score);
            anyEvidence = true;
        }
        scores.set(candidate, (anyEvidence ? worst : NEUTRAL_SCORE) + boost);
    };

    consider('message', a => a.message, 0);
    consider('string', a => a.string, 0);
    consider('packedVarint', a => a.packedVarint, evidence.varint ? 0.5 : 0);
    consider('packedI32', a => a.packedI32, evidence.i32 ? 0.5 : 0);
    consider('packedI64', a => a.packedI64, evidence.i64 ? 0.5 : 0);

    return CANDIDATE_ORDER
        .filter(c => scores.has(c))
        .sort((a, b) => scores.get(b)! - scores.get(a)!);
}
