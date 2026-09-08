import { expect } from 'chai';
import { readFile } from 'node:fs/promises';
import { decode, toObject, type PlainValue } from '../src/index.ts';

// Real captured traffic, taken from rawprotoparse's test suite (MIT licensed).

const HARD_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function walk(value: PlainValue, path: string, visit: (path: string, value: PlainValue) => void): void {
    visit(path, value);
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`, visit));
    else if (typeof value === 'object' && !(value instanceof Uint8Array)) {
        for (const [key, v] of Object.entries(value)) walk(v, `${path}.${key}`, visit);
    }
}

function stringsWithControls(object: PlainValue): string[] {
    const found: string[] = [];
    walk(object, '', (path, value) => {
        if (typeof value === 'string' && HARD_CONTROL.test(value)) found.push(path);
    });
    return found;
}

function get(object: PlainValue, path: string): PlainValue {
    let current: PlainValue = object;
    for (const key of path.split('.')) {
        if (typeof current !== 'object' || current instanceof Uint8Array || Array.isArray(current)) throw new Error(`No ${key} in ${path}`);
        current = current[key]!;
    }
    return current;
}

describe('real traffic fixtures', () => {
    for (const name of ['pixelstarships', 'hearthstone']) {
        describe(name, () => {
            it('decodes cleanly without flattening nested messages into strings', async () => {
                const bytes = await readFile(new URL(`./fixtures/${name}.bin`, import.meta.url));
                const result = decode(bytes);
                expect(result.problems).to.deep.equal([]);
                const object = toObject(result.message);
                expect(stringsWithControls(object)).to.deep.equal([]);
            });
        });
    }

    it('reads known values from the Pixel Starships response', async () => {
        const bytes = await readFile(new URL('./fixtures/pixelstarships.bin', import.meta.url));
        const object = toObject(decode(bytes).message);
        expect(get(object, '1.2.4.13.1.68')).to.deep.equal({ '1': 'Savy Soda' });
    });
});
