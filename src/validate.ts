import { decodeWire, type DecodeWireOptions } from './wire.ts';

/**
 * Whether the input is well-formed protobuf at the wire level: every byte
 * is accounted for by a valid field, groups balance, and there is at least
 * one field. Says nothing about what the fields mean.
 */
export function isValidProtobuf(input: Uint8Array, options: DecodeWireOptions = {}): boolean {
    const wire = decodeWire(input, options);
    return wire.problems.length === 0 && wire.fields.length > 0;
}
