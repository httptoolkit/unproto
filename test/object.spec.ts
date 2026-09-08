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
});
