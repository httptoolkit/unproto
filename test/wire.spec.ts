import { expect } from 'chai';
import { decodeWire, readVarint, type WireGroup } from '../src/wire.ts';
import { hex, varint, concat, expectProblem, expectNoProblems } from './test-util.ts';

describe('readVarint', () => {
    it('reads values that need more than 53 bits exactly', () => {
        const value = 2n ** 53n + 1n;
        const bytes = varint(value);
        const result = readVarint(bytes, 0, bytes.length);
        expect(result).to.deep.equal({ value, length: bytes.length, nonCanonical: false, overflow: false });
    });

    it('reads the maximum 64-bit value', () => {
        const bytes = hex('ff ff ff ff ff ff ff ff ff 01');
        const result = readVarint(bytes, 0, bytes.length);
        expect(result).to.deep.equal({ value: 2n ** 64n - 1n, length: 10, nonCanonical: false, overflow: false });
    });

    it('reports truncation', () => {
        expect(readVarint(hex('80'), 0, 1)).to.equal('truncated');
        expect(readVarint(hex('80 80 80 80 80 80 80 80'), 0, 8)).to.equal('truncated');
    });

    it('rejects more than 10 bytes', () => {
        expect(readVarint(hex('80 80 80 80 80 80 80 80 80 80 01'), 0, 11)).to.equal('too-long');
    });

    it('flags non-canonical encodings and tenth-byte overflow', () => {
        expect(readVarint(hex('81 00'), 0, 2)).to.deep.include({ value: 1n, length: 2, nonCanonical: true });
        expect(readVarint(hex('ff ff ff ff ff ff ff ff ff 7f'), 0, 10))
            .to.deep.include({ value: 2n ** 64n - 1n, length: 10, overflow: true });
    });
});

describe('decodeWire', () => {
    it('reads a single-byte varint field', () => {
        const wire = decodeWire(hex('08 01'));
        expectNoProblems(wire.problems);
        expect(wire.trailing).to.equal(undefined);
        expect(wire.fields).to.deep.equal([{
            kind: 'varint', wireType: 0, number: 1, value: 1n, nonCanonical: false,
            range: { start: 0, end: 2 }, valueRange: { start: 1, end: 2 }
        }]);
    });

    it('reads multi-byte and 64-bit varints', () => {
        expect(decodeWire(hex('08 96 01')).fields[0]).to.deep.include({ value: 150n });
        expect(decodeWire(hex('08 ff ff ff ff ff ff ff ff ff 01')).fields[0]).to.deep.include({ value: 2n ** 64n - 1n });
    });

    it('flags non-canonical varints without rejecting them', () => {
        const wire = decodeWire(hex('08 81 00'));
        expectNoProblems(wire.problems);
        expect(wire.fields[0]).to.deep.include({ value: 1n, nonCanonical: true });
    });

    it('rejects varint values longer than 10 bytes', () => {
        const wire = decodeWire(hex('08 ff ff ff ff ff ff ff ff ff ff 01'));
        expectProblem(wire.problems, 'varint-too-long', 0);
        expect(wire.fields).to.deep.equal([]);
        expect(wire.trailing).to.deep.equal({ start: 0, end: 12 });
    });

    it('reports overflow beyond 64 bits but keeps the field', () => {
        const wire = decodeWire(hex('08 ff ff ff ff ff ff ff ff ff 7f'));
        expectProblem(wire.problems, 'varint-overflow', 1);
        expect(wire.fields[0]).to.deep.include({ value: 2n ** 64n - 1n });
    });

    it('reads large field numbers without sign errors', () => {
        expect(decodeWire(hex('f8 ff ff ff 0f 01')).fields[0]).to.deep.include({ number: 536870911, value: 1n });
        expect(decodeWire(hex('80 80 80 80 08 01')).fields[0]).to.deep.include({ number: 2 ** 28, value: 1n });
        expect(decodeWire(hex('80 01 01')).fields[0]).to.deep.include({ number: 16, value: 1n });
    });

    it('rejects field number 0', () => {
        const wire = decodeWire(hex('00 01'));
        expectProblem(wire.problems, 'invalid-field-number', 0);
        expect(wire.fields).to.deep.equal([]);
    });

    it('rejects wire types 6 and 7', () => {
        expectProblem(decodeWire(hex('0e 01')).problems, 'invalid-wire-type', 0);
        expectProblem(decodeWire(hex('0f 01')).problems, 'invalid-wire-type', 0);
    });

    it('rejects tags that do not fit in 32 bits', () => {
        expectProblem(decodeWire(hex('80 80 80 80 10 01')).problems, 'invalid-tag', 0);
    });

    it('reads fixed-width fields', () => {
        const wire = decodeWire(hex('0d 00 00 80 3f 09 00 00 00 00 00 00 f0 3f'));
        expectNoProblems(wire.problems);
        expect(wire.fields[0]).to.deep.include({ kind: 'i32', number: 1, bytes: hex('00 00 80 3f'), valueRange: { start: 1, end: 5 } });
        expect(wire.fields[1]).to.deep.include({ kind: 'i64', number: 1, bytes: hex('00 00 00 00 00 00 f0 3f'), range: { start: 5, end: 14 } });
    });

    it('reads length-delimited fields', () => {
        const wire = decodeWire(hex('12 03 61 62 63'));
        expectNoProblems(wire.problems);
        expect(wire.fields[0]).to.deep.include({
            kind: 'len', number: 2, bytes: hex('61 62 63'), nonCanonicalLength: false,
            range: { start: 0, end: 5 }, valueRange: { start: 2, end: 5 }
        });
    });

    it('flags a non-canonical length prefix', () => {
        const wire = decodeWire(hex('12 83 00 61 62 63'));
        expectNoProblems(wire.problems);
        expect(wire.fields[0]).to.deep.include({ bytes: hex('61 62 63'), nonCanonicalLength: true });
    });

    it('reports truncation and keeps earlier fields', () => {
        const wire = decodeWire(hex('08 01 12 05 61 62'));
        expectProblem(wire.problems, 'truncated', 2);
        expect(wire.fields.length).to.equal(1);
        expect(wire.trailing).to.deep.equal({ start: 2, end: 6 });
    });

    it('reports truncation mid-tag, mid-varint and inside fixed values', () => {
        expectProblem(decodeWire(hex('80')).problems, 'truncated', 0);
        expectProblem(decodeWire(hex('08 80')).problems, 'truncated', 0);
        expectProblem(decodeWire(hex('0d 01 02')).problems, 'truncated', 0);
        expectProblem(decodeWire(hex('08 01 ff')).problems, 'truncated', 2);
    });

    it('rejects lengths over 2^31 - 1', () => {
        expectProblem(decodeWire(hex('12 80 80 80 80 08')).problems, 'length-too-large', 0);
    });

    it('reads nested groups with their ranges', () => {
        const wire = decodeWire(hex('0b 10 01 1b 08 05 1c 0c'));
        expectNoProblems(wire.problems);
        expect(wire.fields.length).to.equal(1);
        const group = wire.fields[0] as WireGroup;
        expect(group).to.deep.include({ kind: 'group', number: 1, closed: true, range: { start: 0, end: 8 }, valueRange: { start: 1, end: 7 } });
        expect(group.fields[0]).to.deep.include({ kind: 'varint', number: 2, value: 1n });
        const inner = group.fields[1] as WireGroup;
        expect(inner).to.deep.include({ kind: 'group', number: 3, closed: true, range: { start: 3, end: 7 }, valueRange: { start: 4, end: 6 } });
        expect(inner.fields[0]).to.deep.include({ kind: 'varint', number: 1, value: 5n });
    });

    it('handles a group left open at the end of input', () => {
        const wire = decodeWire(hex('0b 10 01'));
        expectProblem(wire.problems, 'unclosed-group', 0);
        expect(wire.fields[0]).to.deep.include({ kind: 'group', number: 1, closed: false, range: { start: 0, end: 3 } });
    });

    it('handles a mismatched end group, leaving an orphan', () => {
        const wire = decodeWire(hex('0b 10 01 1c'));
        expectProblem(wire.problems, 'mismatched-end-group', 3);
        expectProblem(wire.problems, 'unexpected-end-group', 3);
        expect(wire.fields.length).to.equal(2);
        expect(wire.fields[0]).to.deep.include({ kind: 'group', number: 1, closed: false, range: { start: 0, end: 3 } });
        expect(wire.fields[1]).to.deep.include({ kind: 'egroup', number: 3, range: { start: 3, end: 4 } });
    });

    it('closes an outer group with an end tag that an inner group did not match', () => {
        const wire = decodeWire(hex('0b 13 0c'));
        expect(wire.problems.map(p => p.code)).to.deep.equal(['mismatched-end-group']);
        const outer = wire.fields[0] as WireGroup;
        expect(outer).to.deep.include({ number: 1, closed: true, range: { start: 0, end: 3 }, valueRange: { start: 1, end: 2 } });
        expect(outer.fields[0]).to.deep.include({ kind: 'group', number: 2, closed: false, range: { start: 1, end: 2 } });
    });

    it('reports an orphan end group at the top level', () => {
        const wire = decodeWire(hex('0c 08 01'));
        expectProblem(wire.problems, 'unexpected-end-group', 0);
        expect(wire.fields[0]).to.deep.include({ kind: 'egroup', number: 1 });
        expect(wire.fields[1]).to.deep.include({ kind: 'varint', number: 1 });
    });

    it('enforces the group recursion limit', () => {
        const wire = decodeWire(hex('0b 0b 0b 0c 0c 0c'), { recursionLimit: 2 });
        expectProblem(wire.problems, 'recursion-limit', 2);
    });

    it('offsets every range by the given base', () => {
        const wire = decodeWire(hex('08 01 12 01 61'), { offset: 10 });
        expect(wire.fields[0]!.range).to.deep.equal({ start: 10, end: 12 });
        expect(wire.fields[1]!.valueRange).to.deep.equal({ start: 14, end: 15 });
    });

    it('handles empty input', () => {
        const wire = decodeWire(new Uint8Array(0));
        expect(wire).to.deep.equal({ fields: [], trailing: undefined, problems: [] });
    });

    it('does not copy payloads', () => {
        const input = concat(hex('12 03'), hex('61 62 63'));
        const wire = decodeWire(input);
        const field = wire.fields[0]!;
        expect(field.kind === 'len' && field.bytes.buffer).to.equal(input.buffer);
    });

    it('accepts zero-extended tags and lengths as non-canonical', () => {
        const wire = decodeWire(hex('8a 80 80 80 80 80 80 80 80 00 81 80 80 80 80 80 80 00 41'));
        expectNoProblems(wire.problems);
        expect(wire.fields[0]).to.deep.include({ kind: 'len', number: 1, bytes: hex('41'), nonCanonicalLength: true });
    });

    it('reports a truncated long tag or length as truncated, not invalid', () => {
        expectProblem(decodeWire(hex('88 80 80 80 80 80 80 81')).problems, 'truncated', 0);
        expectProblem(decodeWire(hex('0a 80 80 80 80 80 80 80 81')).problems, 'truncated', 0);
    });

    it('rejects tags and lengths whose varints overflow 64 bits', () => {
        const length = decodeWire(hex('0a 80 80 80 80 80 80 80 80 80 02'));
        expectProblem(length.problems, 'length-too-large', 0);
        expect(length.fields).to.deep.equal([]);
        // 2^64 + 8 would read as field 1 if the high bits were dropped
        expectProblem(decodeWire(hex('88 80 80 80 80 80 80 80 80 02 01')).problems, 'invalid-tag', 0);
    });
});
