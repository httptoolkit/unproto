import { expect } from 'chai';
import { isValidProtobuf } from '../src/index.ts';
import { hex, lenField, utf8 } from './test-util.ts';

describe('isValidProtobuf', () => {
    it('accepts well-formed messages', () => {
        expect(isValidProtobuf(hex('08 01'))).to.equal(true);
        expect(isValidProtobuf(hex('0b 08 01 0c'))).to.equal(true);
        expect(isValidProtobuf(lenField(1, 'hello'))).to.equal(true);
        expect(isValidProtobuf(hex('f8 ff ff ff 0f 01'))).to.equal(true);
    });

    it('rejects empty input', () => {
        expect(isValidProtobuf(new Uint8Array(0))).to.equal(false);
    });

    it('rejects malformed input', () => {
        expect(isValidProtobuf(hex('ff'))).to.equal(false);
        expect(isValidProtobuf(hex('08'))).to.equal(false);
        expect(isValidProtobuf(hex('0c'))).to.equal(false);
        expect(isValidProtobuf(hex('00 01'))).to.equal(false);
        expect(isValidProtobuf(hex('0b 08 01'))).to.equal(false);
        expect(isValidProtobuf(hex('12 05 61'))).to.equal(false);
    });

    it('rejects a gRPC frame passed as a bare message', () => {
        expect(isValidProtobuf(hex('00 00 00 00 02 08 01'))).to.equal(false);
    });

    it('rejects typical text', () => {
        expect(isValidProtobuf(utf8('{"json": true}'))).to.equal(false);
        expect(isValidProtobuf(utf8('<html><body>Hello</body></html>'))).to.equal(false);
    });
});
