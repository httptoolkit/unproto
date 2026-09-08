import { expect } from 'chai';
import { decode, toObject, schema, messageType, fieldDef, scalar } from '../src/index.ts';
import { hex, concat, lenField, varintField } from './test-util.ts';

describe('toObject', () => {
    const input = concat(varintField(1, 5), lenField(2, 'x'), lenField(3, varintField(1, 1)));
    const named = schema([
        messageType('T', [
            fieldDef({ number: 1, name: 'count', type: scalar('int32') }),
            fieldDef({ number: 2, name: 'label', type: scalar('string') }),
            fieldDef({ number: 3, name: 'inner', type: { kind: 'message', name: 'T' } })
        ])
    ]);

    it('keys inferred fields by number and schema fields by name', () => {
        expect(toObject(decode(input).message)).to.deep.equal({ '1': 5n, '2': 'x', '3': { '1': 1n } });
        expect(toObject(decode(input, { schema: named }).message)).to.deep.equal({ count: 5n, label: 'x', inner: { count: 1n } });
    });

    it('can be forced to numbers or names', () => {
        expect(toObject(decode(input, { schema: named }).message, { keys: 'number' })).to.deep.equal({ '1': 5n, '2': 'x', '3': { '1': 1n } });
        expect(toObject(decode(input).message, { keys: 'name' })).to.deep.equal({ field_1: 5n, field_2: 'x', field_3: { field_1: 1n } });
    });

    it('applies a prefix to every key', () => {
        expect(toObject(decode(input).message, { prefix: 'f' })).to.deep.equal({ f1: 5n, f2: 'x', f3: { f1: 1n } });
    });

    it('produces JSON-friendly values with a bigint-aware replacer', () => {
        const object = toObject(decode(concat(input, lenField(4, hex('ff 00')))).message);
        const json = JSON.stringify(object, (_key, value: unknown) =>
            typeof value === 'bigint' ? value.toString()
            : value instanceof Uint8Array ? `bytes(${value.length})`
            : value);
        expect(JSON.parse(json)).to.deep.equal({ '1': '5', '2': 'x', '3': { '1': '1' }, '4': 'bytes(2)' });
    });

    it('replays oneof members and message merges in wire order', () => {
        const oneofs = schema([
            messageType('T', [
                fieldDef({ number: 1, name: 'a', type: { kind: 'message', name: 'M' }, oneof: 'choice' }),
                fieldDef({ number: 2, name: 'b', type: scalar('int32'), oneof: 'choice' })
            ]),
            messageType('M', [
                fieldDef({ number: 1, name: 'x', type: scalar('int32') }),
                fieldDef({ number: 2, name: 'y', type: scalar('int32') })
            ]),
            messageType('Outer', [fieldDef({ number: 1, name: 't', type: { kind: 'message', name: 'T' } })])
        ]);
        // a = {x: 1}, then b = 1 (clears a), then a = {y: 2} starts afresh
        expect(toObject(decode(hex('0a 02 08 01 10 01 0a 02 10 02'), { schema: oneofs, type: 'T' }).message)).to.deep.equal({ a: { y: 2n } });
        // t = {a: {x: 1}} merged with t = {b: 7}: b clears a inside the merged message
        expect(toObject(decode(hex('0a 04 0a 02 08 01 0a 02 10 07'), { schema: oneofs, type: 'Outer' }).message)).to.deep.equal({ t: { b: 7n } });
    });

    it('keeps only the last-written member of a oneof', () => {
        const choice = schema([messageType('O', [
            fieldDef({ number: 3, name: 'a', type: scalar('int32'), oneof: 'c' }),
            fieldDef({ number: 4, name: 'b', type: scalar('int32'), oneof: 'c' }),
            fieldDef({ number: 5, name: 'other', type: scalar('int32') })
        ])]);
        expect(toObject(decode(hex('18 01 20 02 18 03 28 09'), { schema: choice }).message)).to.deep.equal({ a: 3n, other: 9n });
        expect(toObject(decode(hex('18 01 20 02'), { schema: choice }).message)).to.deep.equal({ b: 2n });
    });
});
