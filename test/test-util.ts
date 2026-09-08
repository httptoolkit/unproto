import { expect } from 'chai';
import type { Problem, ProblemCode } from '../src/index.ts';

/** Builds bytes from a hex string; whitespace is ignored. */
export function hex(input: string): Uint8Array {
    const clean = input.replace(/\s+/g, '');
    if (clean.length % 2 !== 0) throw new Error(`Odd-length hex: ${input}`);
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/** Independent varint encoder for building fixtures */
export function varint(value: bigint | number): Uint8Array {
    let v = BigInt.asUintN(64, BigInt(value));
    const bytes: number[] = [];
    do {
        let b = Number(v & 0x7fn);
        v >>= 7n;
        if (v !== 0n) b |= 0x80;
        bytes.push(b);
    } while (v !== 0n);
    return new Uint8Array(bytes);
}

export function tag(fieldNumber: number, wireType: number): Uint8Array {
    return varint(BigInt(fieldNumber) * 8n + BigInt(wireType));
}

export function utf8(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

/** A length-delimited field with the given payload */
export function lenField(fieldNumber: number, payload: Uint8Array | string): Uint8Array {
    const bytes = typeof payload === 'string' ? utf8(payload) : payload;
    return concat(tag(fieldNumber, 2), varint(bytes.length), bytes);
}

export function varintField(fieldNumber: number, value: bigint | number): Uint8Array {
    return concat(tag(fieldNumber, 0), varint(value));
}

export function expectProblem(problems: readonly Problem[], code: ProblemCode, offset?: number): Problem {
    const found = problems.find(p => p.code === code && (offset === undefined || p.offset === offset));
    expect(found, `expected a ${code} problem${offset === undefined ? '' : ` at ${offset}`} in ${JSON.stringify(problems)}`).to.not.equal(undefined);
    return found!;
}

export function expectNoProblems(problems: readonly Problem[]): void {
    expect(problems, JSON.stringify(problems)).to.deep.equal([]);
}
