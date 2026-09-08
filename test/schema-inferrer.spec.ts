import { expect } from 'chai';
import { SchemaInferrer, inferSchema, schema, messageType, fieldDef, scalar, type MessageType } from '../src/index.ts';
import { hex, concat, lenField, varintField, expectProblem } from './test-util.ts';

function message(s: ReturnType<typeof inferSchema>, name: string): MessageType {
    const type = s.types.get(name);
    expect(type?.kind, `${name} in ${[...s.types.keys()].join(', ')}`).to.equal('message');
    return type as MessageType;
}

describe('SchemaInferrer', () => {
    it('infers from several messages of one type', () => {
        const inferrer = new SchemaInferrer()
            .add(concat(varintField(1, 1), lenField(2, 'a')))
            .add(concat(varintField(1, 2), lenField(2, 'b'), varintField(3, 0)))
            .add(varintField(1, 3));
        expect(inferrer.size).to.equal(3);
        const root = message(inferrer.schema(), 'Message');
        expect([...root.fields.keys()]).to.deep.equal([1, 2, 3]);
        expect(root.fields.get(1)!.inferred).to.deep.include({ presentIn: 3, samples: 3 });
        expect(root.fields.get(2)!.inferred).to.deep.include({ presentIn: 2, samples: 3 });
        expect(root.fields.get(3)!.inferred).to.deep.include({ presentIn: 1, samples: 3 });
        expect(root.fields.get(3)!.presence).to.equal('explicit');
        expect(root.fields.get(1)!.presence).to.equal('implicit');
    });

    it('marks a field repeated once any message repeats it', () => {
        const inferrer = new SchemaInferrer().add(lenField(1, 'x')).add(concat(lenField(1, 'y'), lenField(1, 'z')));
        expect(message(inferrer.schema(), 'Message').fields.get(1)!.cardinality).to.equal('repeated');
    });

    it('pools type evidence across messages', () => {
        const s = inferSchema([lenField(1, 'hello'), lenField(1, hex('ff fe'))]);
        expect(message(s, 'Message').fields.get(1)!.type).to.deep.equal(scalar('bytes'));

        const packed = inferSchema([varintField(1, 5), hex('0a 02 06 07')]);
        expect(message(packed, 'Message').fields.get(1)!).to.deep.include({ type: scalar('int64'), packed: true, cardinality: 'repeated' });
    });

    it('merges nested message fields across messages', () => {
        const s = inferSchema([
            lenField(3, varintField(1, 7)),
            lenField(3, lenField(2, 'name'))
        ]);
        const nested = message(s, 'Message.Field3');
        expect([...nested.fields.keys()]).to.deep.equal([1, 2]);
        expect(nested.fields.get(1)!.inferred).to.deep.include({ presentIn: 1, samples: 2 });
    });

    it('extends a supplied schema with the fields it lacks', () => {
        const base = schema([messageType('app.Person', [fieldDef({ number: 1, name: 'id', type: scalar('int32') })])], { package: 'app' });
        const inferrer = new SchemaInferrer({ base })
            .add(concat(varintField(1, 1), lenField(2, 'Jane')))
            .add(concat(varintField(1, 2), lenField(3, varintField(1, 9))))
            .add(concat(varintField(1, 3), lenField(3, lenField(2, 'x'))));
        const extended = inferrer.schema();

        const person = message(extended, 'app.Person');
        expect(person.fields.get(1)!.name).to.equal('id');
        expect(person.fields.get(2)!).to.deep.include({ name: 'field_2', type: scalar('string') });
        expect(person.fields.get(3)!.type).to.deep.equal({ kind: 'message', name: 'app.Person.Field3' });
        expect([...message(extended, 'app.Person.Field3').fields.keys()]).to.deep.equal([1, 2]);
        expect(extended.package).to.equal('app');
        expect(inferrer.problems()).to.deep.equal([]);

        expect((base.types.get('app.Person') as MessageType).fields.has(2)).to.equal(false);
        expect(base.types.has('app.Person.Field3')).to.equal(false);
    });

    it('reports wire problems in samples and a missing base type', () => {
        const inferrer = new SchemaInferrer().add(hex('08 01')).add(hex('08'));
        expectProblem(inferrer.problems(), 'truncated');

        const base = schema([messageType('A', []), messageType('B', [])]);
        expectProblem(new SchemaInferrer({ base }).add(hex('08 01')).problems(), 'unknown-type');
    });

    it('recomputes when messages are added', () => {
        const inferrer = new SchemaInferrer().add(varintField(1, 1));
        const before = inferrer.schema();
        expect(inferrer.schema()).to.equal(before);
        inferrer.add(lenField(2, 'x'));
        expect(inferrer.schema()).to.not.equal(before);
        expect(message(inferrer.schema(), 'Message').fields.has(2)).to.equal(true);
    });

    it('switches to edition 2023 when groups are seen', () => {
        expect(inferSchema([hex('0b 08 01 0c')]).syntax).to.equal('editions');
        expect(inferSchema([hex('08 01')]).syntax).to.equal('proto3');
    });
});
