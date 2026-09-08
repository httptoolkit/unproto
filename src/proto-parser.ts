import type { Problem } from './problem.ts';
import { MAX_FIELD_NUMBER } from './wire.ts';
import {
    isPackable,
    resolveTypeName,
    scalar,
    type Cardinality,
    type EnumValue,
    type ExtensionDecl,
    type FieldDef,
    type FieldType,
    type ImportDecl,
    type MethodDecl,
    type NamedType,
    type NumberRange,
    type OptionDecl,
    type ScalarType,
    type Schema,
    type ServiceDecl
} from './schema.ts';
import {
    editionDefaults,
    featuresFromNames,
    mergeFeatures,
    type FeatureSet,
    type ResolvedFeatures
} from './features.ts';
import { isWellKnownImport, wellKnownTypesFor } from './well-known.ts';

export interface ParseProtoOptions {
    /** Name used in problem messages. Defaults to 'schema.proto'. */
    readonly name?: string;
    /** Stop at the first problem instead of recovering. Defaults to false. */
    readonly strict?: boolean;
}

export interface ParseProtoResult {
    readonly schema: Schema;
    /** Everything that could not be parsed or resolved. Empty for a clean parse. */
    readonly problems: readonly Problem[];
}

const SCALAR_TYPES: ReadonlySet<string> = new Set<ScalarType>([
    'double', 'float', 'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64',
    'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool', 'string', 'bytes'
]);
const LABELS: ReadonlySet<string> = new Set(['optional', 'required', 'repeated']);

/**
 * Parses `.proto` source into a schema. Accepts proto2, proto3 and any
 * edition. Nothing throws: constructs that cannot be parsed or resolved are
 * skipped at the smallest possible granularity and reported as problems, so
 * a file with one bad field still yields everything else.
 */
export function parseProto(source: string, options: ParseProtoOptions = {}): ParseProtoResult {
    const parser = new Parser(source, options);
    return parser.parse();
}

// --- Tokens ---

type TokenKind = 'ident' | 'number' | 'string' | 'punct' | 'eof';

interface Token {
    readonly kind: TokenKind;
    /** Source text, including quotes for strings */
    readonly text: string;
    /** Decoded contents, for strings */
    readonly value: string;
    readonly start: number;
    readonly line: number;
}

// --- Declarations, mutable while parsing ---

interface ParsedOption extends OptionDecl {
    /** The decoded contents, when the value is a single string literal */
    readonly stringValue?: string;
}

/** Drops the parse-only fields, so that stored options are exactly what was written */
function toOptionDecl(option: ParsedOption): OptionDecl {
    return { name: option.name, value: option.value };
}

interface RawField {
    number: number;
    name: string;
    typeText: string;
    label?: 'optional' | 'required' | 'repeated';
    oneof?: string;
    group: boolean;
    features: FeatureSet;
    packedOption?: boolean;
    defaultValue?: string;
    jsonName?: string;
    options: OptionDecl[];
    offset: number;
}

interface RawMessage {
    kind: 'message';
    name: string;
    fullName: string;
    scope: string;
    fields: RawField[];
    oneofs: string[];
    oneofFeatures: Map<string, FeatureSet>;
    reservedRanges: NumberRange[];
    reservedNames: string[];
    extensionRanges: NumberRange[];
    options: OptionDecl[];
    features: FeatureSet;
    mapEntry: boolean;
    messageSet: boolean;
}

interface RawEnum {
    kind: 'enum';
    name: string;
    fullName: string;
    values: EnumValue[];
    reservedRanges: NumberRange[];
    reservedNames: string[];
    options: OptionDecl[];
    features: FeatureSet;
}

type RawType = RawMessage | RawEnum;

class Parser {
    private readonly source: string;
    private readonly fileName: string;
    private readonly strict: boolean;
    private readonly tokens: Token[] = [];
    private readonly problems: Problem[] = [];
    private pos = 0;

    private edition = 'proto2';
    private syntaxSeen = false;
    private packageName = '';
    private readonly imports: ImportDecl[] = [];
    private readonly fileOptions: OptionDecl[] = [];
    private fileFeatures: FeatureSet = {};
    private readonly declarations: RawType[] = [];
    private readonly services: ServiceDecl[] = [];
    private readonly rawExtensions: { extendee: string; scope: string; field: RawField }[] = [];

    constructor(source: string, options: ParseProtoOptions) {
        this.source = source;
        this.fileName = options.name ?? 'schema.proto';
        this.strict = options.strict ?? false;
        this.tokenize();
    }

    parse(): ParseProtoResult {
        this.parseFile();
        return { schema: this.build(), problems: this.problems };
    }

    // --- Lexing ---

    private tokenize(): void {
        const { source } = this;
        let pos = 0;
        let line = 1;
        const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
        const isIdent = (c: string) => /[A-Za-z0-9_]/.test(c);
        const isDigit = (c: string) => /[0-9]/.test(c);

        while (pos < source.length) {
            const char = source[pos]!;
            if (char === '\n') { line++; pos++; continue; }
            if (/\s/.test(char)) { pos++; continue; }

            if (char === '/' && source[pos + 1] === '/') {
                while (pos < source.length && source[pos] !== '\n') pos++;
                continue;
            }
            if (char === '/' && source[pos + 1] === '*') {
                const end = source.indexOf('*/', pos + 2);
                const stop = end === -1 ? source.length : end + 2;
                for (let i = pos; i < stop; i++) if (source[i] === '\n') line++;
                if (end === -1) this.report('parse-error', 'Unterminated block comment', pos, line);
                pos = stop;
                continue;
            }

            const start = pos;
            if (isIdentStart(char)) {
                while (pos < source.length && isIdent(source[pos]!)) pos++;
                const text = source.slice(start, pos);
                this.tokens.push({ kind: 'ident', text, value: text, start, line });
                continue;
            }
            if (isDigit(char) || (char === '.' && isDigit(source[pos + 1] ?? ''))) {
                while (pos < source.length && /[0-9a-fA-FxX.+\-]/.test(source[pos]!)) {
                    // A sign only continues a number directly after an exponent marker
                    if ((source[pos] === '+' || source[pos] === '-') && !/[eE]/.test(source[pos - 1] ?? '')) break;
                    pos++;
                }
                const text = source.slice(start, pos);
                this.tokens.push({ kind: 'number', text, value: text, start, line });
                continue;
            }
            if (char === '"' || char === "'") {
                const { text, value, end, lines } = this.readString(pos, char, line);
                this.tokens.push({ kind: 'string', text, value, start, line });
                line += lines;
                pos = end;
                continue;
            }
            pos++;
            this.tokens.push({ kind: 'punct', text: char, value: char, start, line });
        }
        this.tokens.push({ kind: 'eof', text: '', value: '', start: source.length, line });
        this.joinAdjacentStrings();
    }

    /** Adjacent string literals are one literal, which is how long strings are written */
    private joinAdjacentStrings(): void {
        for (let i = 0; i < this.tokens.length - 1; i++) {
            const token = this.tokens[i]!;
            if (token.kind !== 'string') continue;
            let end = i + 1;
            while (this.tokens[end]?.kind === 'string') end++;
            if (end === i + 1) continue;
            const parts = this.tokens.slice(i, end);
            this.tokens.splice(i, parts.length, {
                kind: 'string',
                text: parts.map(part => part.text).join(' '),
                value: parts.map(part => part.value).join(''),
                start: token.start,
                line: token.line
            });
        }
    }

    private readString(start: number, quote: string, line: number): { text: string; value: string; end: number; lines: number } {
        const { source } = this;
        let pos = start + 1;
        let value = '';
        let lines = 0;
        while (pos < source.length && source[pos] !== quote) {
            const char = source[pos]!;
            if (char === '\n') lines++;
            if (char !== '\\') { value += char; pos++; continue; }
            const escape = source[pos + 1] ?? '';
            pos += 2;
            switch (escape) {
                case 'n': value += '\n'; break;
                case 'r': value += '\r'; break;
                case 't': value += '\t'; break;
                case 'a': value += '\x07'; break;
                case 'b': value += '\b'; break;
                case 'f': value += '\f'; break;
                case 'v': value += '\v'; break;
                case '\\': case "'": case '"': case '?': value += escape; break;
                case 'x': {
                    const hex = /^[0-9a-fA-F]{1,2}/.exec(source.slice(pos))?.[0] ?? '';
                    value += String.fromCharCode(parseInt(hex, 16) || 0);
                    pos += hex.length;
                    break;
                }
                case 'u': case 'U': {
                    const width = escape === 'u' ? 4 : 8;
                    const hex = source.slice(pos, pos + width);
                    value += String.fromCodePoint(parseInt(hex, 16) || 0);
                    pos += hex.length;
                    break;
                }
                default:
                    if (/[0-7]/.test(escape)) {
                        const octal = /^[0-7]{0,2}/.exec(source.slice(pos))?.[0] ?? '';
                        value += String.fromCharCode(parseInt(escape + octal, 8));
                        pos += octal.length;
                    } else {
                        value += escape;
                    }
            }
        }
        if (pos >= source.length) {
            this.report('parse-error', 'Unterminated string literal', start, line);
            return { text: source.slice(start), value, end: pos, lines };
        }
        return { text: source.slice(start, pos + 1), value, end: pos + 1, lines };
    }

    // --- Token helpers ---

    private peek(offset = 0): Token {
        return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
    }

    private next(): Token {
        const token = this.peek();
        if (token.kind !== 'eof') this.pos++;
        return token;
    }

    private at(text: string, offset = 0): boolean {
        return this.peek(offset).text === text;
    }

    private accept(text: string): boolean {
        if (!this.at(text)) return false;
        this.pos++;
        return true;
    }

    private expect(text: string, context: string): boolean {
        if (this.accept(text)) return true;
        const token = this.peek();
        this.report('parse-error', `Expected '${text}' ${context} but found '${token.text || 'end of file'}'`, token.start, token.line);
        return false;
    }

    private report(code: Problem['code'], message: string, offset: number, line: number): void {
        this.problems.push({ code, message: `${this.fileName}:${line}:${this.columnAt(offset)}: ${message}`, offset });
    }

    /** The 1-based column of an offset, for pointing at the problem in an editor */
    private columnAt(offset: number): number {
        const lineStart = this.source.lastIndexOf('\n', offset - 1);
        return offset - lineStart;
    }

    /** Skips to the end of the current statement or block, so one bad declaration does not lose the rest */
    private skipStatement(): void {
        let depth = 0;
        for (;;) {
            const token = this.peek();
            if (token.kind === 'eof') return;
            if (token.text === '{') depth++;
            else if (token.text === '}') {
                if (depth === 0) return;
                this.pos++;
                if (--depth === 0) return;
                continue;
            } else if (token.text === ';' && depth === 0) {
                this.pos++;
                return;
            }
            this.pos++;
        }
    }

    // --- File ---

    private parseFile(): void {
        while (this.peek().kind !== 'eof') {
            const before = this.pos;
            this.parseTopLevel();
            if (this.pos === before) this.pos++;
            if (this.strict && this.problems.length > 0) return;
        }
    }

    private parseTopLevel(): void {
        const token = this.peek();
        if (token.text === ';') { this.pos++; return; }

        switch (token.text) {
            case 'syntax':
            case 'edition':
                this.parseSyntax();
                return;
            case 'package':
                this.parsePackage();
                return;
            case 'import':
                this.parseImport();
                return;
            case 'option':
                this.parseFileOption();
                return;
            case 'message':
                this.pos++;
                this.parseMessage(this.packageName);
                return;
            case 'enum':
                this.pos++;
                this.parseEnum(this.packageName);
                return;
            case 'service':
                this.pos++;
                this.parseService(this.packageName);
                return;
            case 'extend':
                this.pos++;
                this.parseExtend(this.packageName);
                return;
            case 'export':
            case 'local':
                // Edition 2024 symbol visibility, which does not affect decoding
                this.pos++;
                this.parseTopLevel();
                return;
            default:
                this.report('parse-error', `Unexpected '${token.text}' at the top level`, token.start, token.line);
                this.skipStatement();
        }
    }

    private parseSyntax(): void {
        const keyword = this.next().text;
        this.expect('=', `after '${keyword}'`);
        const token = this.next();
        if (token.kind !== 'string') {
            this.report('parse-error', `Expected a quoted value after '${keyword} ='`, token.start, token.line);
        } else if (keyword === 'edition') {
            this.edition = token.value;
        } else if (token.value === 'proto2' || token.value === 'proto3') {
            this.edition = token.value;
        } else {
            this.report('parse-error', `Unknown syntax '${token.value}'; reading the file as proto2`, token.start, token.line);
        }
        this.syntaxSeen = true;
        this.accept(';');
    }

    private parsePackage(): void {
        this.pos++;
        this.packageName = this.parseQualifiedName();
        this.accept(';');
    }

    private parseImport(): void {
        this.pos++;
        let kind: ImportDecl['kind'] = 'default';
        if (this.at('public') || this.at('weak') || this.at('option')) {
            kind = this.next().text as ImportDecl['kind'];
        }
        const token = this.next();
        if (token.kind !== 'string') {
            this.report('parse-error', 'Expected a quoted path after import', token.start, token.line);
            this.skipStatement();
            return;
        }
        this.imports.push({ path: token.value, kind });
        if (kind !== 'default' && kind !== 'public' && !isWellKnownImport(token.value)) {
            this.report('unsupported', `${kind} import of '${token.value}' is not resolved`, token.start, token.line);
        }
        this.accept(';');
    }

    private parseFileOption(): void {
        this.pos++;
        const option = this.parseOptionBody();
        if (!option) return;
        const feature = featureFrom(option.name, option.value);
        if (feature) this.fileFeatures = { ...this.fileFeatures, ...feature };
        else this.fileOptions.push(toOptionDecl(option));
        this.accept(';');
    }

    /** Reads `name = value`, the shared part of every option form */
    private parseOptionBody(): ParsedOption | undefined {
        const name = this.parseOptionName();
        if (name === undefined) return undefined;
        if (!this.expect('=', `after option '${name}'`)) {
            this.skipStatement();
            return undefined;
        }
        return { name, ...this.parseOptionValue() };
    }

    private parseOptionName(): string | undefined {
        let name = '';
        for (;;) {
            if (this.accept('(')) {
                const inner = this.parseQualifiedName();
                this.expect(')', 'to close a custom option name');
                name += `(${inner})`;
            } else if (this.peek().kind === 'ident') {
                name += this.next().text;
            } else {
                const token = this.peek();
                this.report('parse-error', `Expected an option name but found '${token.text}'`, token.start, token.line);
                return undefined;
            }
            if (!this.accept('.')) return name;
            name += '.';
        }
    }

    /**
     * Captures an option value as source text, including aggregate `{ ... }`
     * forms. A plain string literal also keeps its decoded contents, for the
     * options whose value is used rather than merely round-tripped.
     */
    private parseOptionValue(): { value: string; stringValue?: string } {
        if (this.at('{')) return { value: this.captureBalanced('{', '}') };
        if (this.at('[')) return { value: this.captureBalanced('[', ']') };
        let text = '';
        if (this.at('-') || this.at('+')) text += this.next().text;
        const token = this.next();
        text += token.text;
        const isPlainString = text === token.text && token.kind === 'string';
        // A qualified enum or identifier value
        while (this.at('.') && this.peek(1).kind === 'ident') {
            this.pos++;
            text += `.${this.next().text}`;
        }
        return isPlainString && text === token.text
            ? { value: text, stringValue: token.value }
            : { value: text };
    }

    private captureBalanced(open: string, close: string): string {
        const start = this.peek().start;
        let depth = 0;
        for (;;) {
            const token = this.peek();
            if (token.kind === 'eof') break;
            if (token.text === open) depth++;
            if (token.text === close) {
                this.pos++;
                if (--depth === 0) break;
                continue;
            }
            this.pos++;
        }
        const end = this.peek().start;
        return this.source.slice(start, end).trim();
    }

    private parseQualifiedName(): string {
        let name = '';
        if (this.accept('.')) name = '.';
        for (;;) {
            const token = this.peek();
            if (token.kind !== 'ident') {
                this.report('parse-error', `Expected a name but found '${token.text}'`, token.start, token.line);
                return name;
            }
            name += this.next().text;
            if (!this.at('.') || this.peek(1).kind !== 'ident') return name;
            this.pos++;
            name += '.';
        }
    }

    // --- Messages ---

    private parseMessage(scope: string): RawMessage | undefined {
        const nameToken = this.next();
        if (nameToken.kind !== 'ident') {
            this.report('parse-error', `Expected a message name but found '${nameToken.text}'`, nameToken.start, nameToken.line);
            this.skipStatement();
            return undefined;
        }
        const name = nameToken.text;
        const fullName = scope === '' ? name : `${scope}.${name}`;
        const message: RawMessage = {
            kind: 'message', name, fullName, scope,
            fields: [], oneofs: [], oneofFeatures: new Map(),
            reservedRanges: [], reservedNames: [], extensionRanges: [],
            options: [], features: {}, mapEntry: false, messageSet: false
        };
        this.declarations.push(message);

        if (!this.expect('{', `to open message ${name}`)) return message;
        while (!this.at('}') && this.peek().kind !== 'eof') {
            const before = this.pos;
            this.parseMessageMember(message);
            if (this.pos === before) this.pos++;
        }
        this.expect('}', `to close message ${name}`);
        return message;
    }

    private parseMessageMember(message: RawMessage): void {
        const token = this.peek();
        if (token.text === ';') { this.pos++; return; }

        switch (token.text) {
            case 'message':
                this.pos++;
                this.parseMessage(message.fullName);
                return;
            case 'enum':
                this.pos++;
                this.parseEnum(message.fullName);
                return;
            case 'extend':
                this.pos++;
                this.parseExtend(message.fullName);
                return;
            case 'oneof':
                this.pos++;
                this.parseOneof(message);
                return;
            case 'reserved':
                this.pos++;
                this.parseReserved(message.reservedRanges, message.reservedNames);
                return;
            case 'extensions':
                this.pos++;
                this.parseRanges(message.extensionRanges);
                this.accept(';');
                return;
            case 'option': {
                this.pos++;
                const option = this.parseOptionBody();
                if (option) {
                    const feature = featureFrom(option.name, option.value);
                    if (feature) message.features = { ...message.features, ...feature };
                    else if (option.name === 'map_entry') message.mapEntry = option.value === 'true';
                    else if (option.name === 'message_set_wire_format') message.messageSet = option.value === 'true';
                    else message.options.push(toOptionDecl(option));
                }
                this.accept(';');
                return;
            }
            case 'export':
            case 'local':
                this.pos++;
                this.parseMessageMember(message);
                return;
            default: {
                const field = this.parseField(message.fullName);
                if (field) message.fields.push(field);
            }
        }
    }

    private parseOneof(message: RawMessage): void {
        const nameToken = this.next();
        if (nameToken.kind !== 'ident') {
            this.report('parse-error', `Expected a oneof name but found '${nameToken.text}'`, nameToken.start, nameToken.line);
            this.skipStatement();
            return;
        }
        const name = nameToken.text;
        message.oneofs.push(name);
        if (!this.expect('{', `to open oneof ${name}`)) return;

        while (!this.at('}') && this.peek().kind !== 'eof') {
            const before = this.pos;
            if (this.accept(';')) continue;
            if (this.at('option')) {
                this.pos++;
                const option = this.parseOptionBody();
                if (option) {
                    const feature = featureFrom(option.name, option.value);
                    if (feature) message.oneofFeatures.set(name, { ...message.oneofFeatures.get(name), ...feature });
                }
                this.accept(';');
                continue;
            }
            const field = this.parseField(message.fullName, name);
            if (field) message.fields.push(field);
            if (this.pos === before) this.pos++;
        }
        this.expect('}', `to close oneof ${name}`);
    }

    private parseField(scope: string, oneof?: string): RawField | undefined {
        const first = this.peek();
        let label: RawField['label'];
        if (LABELS.has(first.text) && isTypeStart(this.peek(1))) {
            label = this.next().text as RawField['label'];
        }

        if (this.at('group') && this.peek(1).kind === 'ident' && this.at('=', 2)) {
            return this.parseGroup(scope, label, oneof);
        }

        const typeText = this.parseFieldType();
        if (typeText === undefined) {
            this.skipStatement();
            return undefined;
        }
        const nameToken = this.next();
        if (nameToken.kind !== 'ident') {
            this.report('parse-error', `Expected a field name but found '${nameToken.text}'`, nameToken.start, nameToken.line);
            this.skipStatement();
            return undefined;
        }
        if (!this.expect('=', `after field '${nameToken.text}'`)) {
            this.skipStatement();
            return undefined;
        }
        const number = this.parseFieldNumber(nameToken.text);
        if (number === undefined) {
            this.skipStatement();
            return undefined;
        }
        const field: RawField = {
            number,
            name: nameToken.text,
            typeText,
            group: false,
            features: {},
            options: [],
            offset: first.start,
            ...(label !== undefined ? { label } : {}),
            ...(oneof !== undefined ? { oneof } : {})
        };
        this.parseFieldOptions(field);
        this.accept(';');
        return field;
    }

    private parseGroup(scope: string, label: RawField['label'], oneof?: string): RawField | undefined {
        const groupToken = this.next();
        const nameToken = this.next();
        const name = nameToken.text;
        this.expect('=', `after group ${name}`);
        const number = this.parseFieldNumber(name);
        if (number === undefined) this.skipStatement();

        const message: RawMessage = {
            kind: 'message', name, fullName: scope === '' ? name : `${scope}.${name}`, scope,
            fields: [], oneofs: [], oneofFeatures: new Map(),
            reservedRanges: [], reservedNames: [], extensionRanges: [],
            options: [], features: {}, mapEntry: false, messageSet: false
        };
        this.declarations.push(message);

        const field: RawField = {
            number: number ?? 0,
            // The field takes the lowercased group name, as protoc does
            name: name.toLowerCase(),
            typeText: message.fullName,
            group: true,
            features: {},
            options: [],
            offset: groupToken.start,
            ...(label !== undefined ? { label } : {}),
            ...(oneof !== undefined ? { oneof } : {})
        };
        this.parseFieldOptions(field);

        if (this.expect('{', `to open group ${name}`)) {
            while (!this.at('}') && this.peek().kind !== 'eof') {
                const before = this.pos;
                this.parseMessageMember(message);
                if (this.pos === before) this.pos++;
            }
            this.expect('}', `to close group ${name}`);
        }
        return number === undefined ? undefined : field;
    }

    private parseFieldType(): string | undefined {
        if (this.at('map') && this.at('<', 1)) {
            this.pos += 2;
            const key = this.parseQualifiedName();
            this.expect(',', 'between map key and value types');
            const value = this.parseFieldType() ?? 'bytes';
            this.expect('>', 'to close a map type');
            return `map<${key},${value}>`;
        }
        const token = this.peek();
        if (token.kind !== 'ident' && token.text !== '.') {
            this.report('parse-error', `Expected a field type but found '${token.text}'`, token.start, token.line);
            return undefined;
        }
        return this.parseQualifiedName();
    }

    /** Leaves the token in place when it is not a number, so that recovery can see the statement's end */
    private parseFieldNumber(fieldName: string): number | undefined {
        const token = this.peek();
        const value = parseIntLiteral(token.text);
        if (value === undefined || value < 1 || value > MAX_FIELD_NUMBER) {
            this.report('parse-error', `Field '${fieldName}' has an invalid number '${token.text}'`, token.start, token.line);
            return undefined;
        }
        this.pos++;
        return value;
    }

    private parseFieldOptions(field: RawField): void {
        if (!this.accept('[')) return;
        while (!this.at(']') && this.peek().kind !== 'eof') {
            const option = this.parseOptionBody();
            if (!option) break;
            const feature = featureFrom(option.name, option.value);
            if (feature) field.features = { ...field.features, ...feature };
            else if (option.name === 'packed') field.packedOption = option.value === 'true';
            else if (option.name === 'default') field.defaultValue = option.value;
            else if (option.name === 'json_name') field.jsonName = option.stringValue ?? unquote(option.value);
            else field.options.push(toOptionDecl(option));
            if (!this.accept(',')) break;
        }
        this.expect(']', 'to close field options');
    }

    private parseReserved(ranges: NumberRange[], names: string[]): void {
        for (;;) {
            const token = this.peek();
            if (token.kind === 'string') {
                names.push(this.next().value);
            } else if (token.kind === 'ident' && !this.at('to', 1)) {
                // Editions spell reserved names without quotes
                names.push(this.next().text);
            } else if (token.kind === 'number' || token.kind === 'ident' || token.text === '-' || token.text === '+') {
                // Enum values, and so their reserved ranges, may be negative
                const range = this.parseRange();
                if (range) ranges.push(range);
            } else {
                this.report('parse-error', `Unexpected '${token.text}' in a reserved statement`, token.start, token.line);
                this.skipStatement();
                return;
            }
            if (!this.accept(',')) break;
        }
        this.accept(';');
    }

    private parseRanges(ranges: NumberRange[]): void {
        for (;;) {
            const range = this.parseRange();
            if (range) ranges.push(range);
            if (!this.accept(',')) break;
        }
        // Extension ranges may carry declarations or options, which do not affect decoding
        if (this.at('[')) this.captureBalanced('[', ']');
    }

    private parseRange(): NumberRange | undefined {
        const token = this.peek();
        const start = this.parseSignedInt();
        if (start === undefined) {
            this.report('parse-error', `Expected a number but found '${token.text}'`, token.start, token.line);
            this.pos++;
            return undefined;
        }
        if (!this.accept('to')) return { start, end: start };
        if (this.accept('max')) return { start, end: MAX_FIELD_NUMBER };
        const endToken = this.peek();
        const end = this.parseSignedInt();
        if (end === undefined) {
            this.report('parse-error', `Expected a number or 'max' but found '${endToken.text}'`, endToken.start, endToken.line);
            return { start, end: start };
        }
        return { start, end };
    }

    /** Reads an integer literal, which the lexer splits from any sign in front of it */
    private parseSignedInt(): number | undefined {
        const negative = this.at('-');
        if (negative || this.at('+')) this.pos++;
        const value = parseIntLiteral(this.peek().text);
        if (value === undefined) {
            if (negative) this.pos--;
            return undefined;
        }
        this.pos++;
        return negative ? -value : value;
    }

    // --- Enums, services, extends ---

    private parseEnum(scope: string): void {
        const nameToken = this.next();
        if (nameToken.kind !== 'ident') {
            this.report('parse-error', `Expected an enum name but found '${nameToken.text}'`, nameToken.start, nameToken.line);
            this.skipStatement();
            return;
        }
        const name = nameToken.text;
        const declaration: RawEnum = {
            kind: 'enum', name, fullName: scope === '' ? name : `${scope}.${name}`,
            values: [], reservedRanges: [], reservedNames: [], options: [], features: {}
        };
        this.declarations.push(declaration);
        if (!this.expect('{', `to open enum ${name}`)) return;

        while (!this.at('}') && this.peek().kind !== 'eof') {
            const before = this.pos;
            if (this.accept(';')) continue;
            if (this.at('option')) {
                this.pos++;
                const option = this.parseOptionBody();
                if (option) {
                    const feature = featureFrom(option.name, option.value);
                    if (feature) declaration.features = { ...declaration.features, ...feature };
                    else declaration.options.push(toOptionDecl(option));
                }
                this.accept(';');
                continue;
            }
            if (this.at('reserved')) {
                this.pos++;
                this.parseReserved(declaration.reservedRanges, declaration.reservedNames);
                continue;
            }
            const valueName = this.next();
            if (valueName.kind !== 'ident' || !this.expect('=', `after enum value '${valueName.text}'`)) {
                this.skipStatement();
                if (this.pos === before) this.pos++;
                continue;
            }
            const numberToken = this.peek();
            const number = this.parseSignedInt();
            if (number === undefined) {
                this.report('parse-error', `Enum value '${valueName.text}' has an invalid number '${numberToken.text}'`, numberToken.start, numberToken.line);
                this.skipStatement();
                continue;
            }
            declaration.values.push({ name: valueName.text, number });
            if (this.at('[')) this.captureBalanced('[', ']');
            this.accept(';');
        }
        this.expect('}', `to close enum ${name}`);
    }

    private parseService(scope: string): void {
        const nameToken = this.next();
        if (nameToken.kind !== 'ident') {
            this.report('parse-error', `Expected a service name but found '${nameToken.text}'`, nameToken.start, nameToken.line);
            this.skipStatement();
            return;
        }
        const name = nameToken.text;
        const methods: MethodDecl[] = [];
        if (!this.expect('{', `to open service ${name}`)) return;

        while (!this.at('}') && this.peek().kind !== 'eof') {
            const before = this.pos;
            if (this.accept(';')) continue;
            if (this.at('option')) {
                this.pos++;
                this.parseOptionBody();
                this.accept(';');
                continue;
            }
            if (!this.accept('rpc')) {
                const token = this.peek();
                this.report('parse-error', `Unexpected '${token.text}' in service ${name}`, token.start, token.line);
                this.skipStatement();
                if (this.pos === before) this.pos++;
                continue;
            }
            const method = this.parseMethod();
            if (method) methods.push(method);
            if (this.pos === before) this.pos++;
        }
        this.expect('}', `to close service ${name}`);
        this.services.push({ name, fullName: scope === '' ? name : `${scope}.${name}`, methods });
    }

    private parseMethod(): MethodDecl | undefined {
        const nameToken = this.next();
        if (nameToken.kind !== 'ident') {
            this.report('parse-error', `Expected a method name but found '${nameToken.text}'`, nameToken.start, nameToken.line);
            this.skipStatement();
            return undefined;
        }
        const input = this.parseMethodType();
        if (!this.expect('returns', `after the request type of ${nameToken.text}`)) {
            this.skipStatement();
            return undefined;
        }
        const output = this.parseMethodType();
        if (this.at('{')) this.captureBalanced('{', '}');
        else this.accept(';');
        return {
            name: nameToken.text,
            inputType: input.type,
            outputType: output.type,
            clientStreaming: input.streaming,
            serverStreaming: output.streaming
        };
    }

    private parseMethodType(): { type: string; streaming: boolean } {
        this.expect('(', 'to open an rpc type');
        const streaming = this.accept('stream');
        const type = this.parseQualifiedName();
        this.expect(')', 'to close an rpc type');
        return { type, streaming };
    }

    private parseExtend(scope: string): void {
        const extendee = this.parseQualifiedName();
        if (!this.expect('{', `to open extend ${extendee}`)) return;
        while (!this.at('}') && this.peek().kind !== 'eof') {
            const before = this.pos;
            if (this.accept(';')) continue;
            const field = this.parseField(scope);
            if (field) this.rawExtensions.push({ extendee, scope, field });
            if (this.pos === before) this.pos++;
        }
        this.expect('}', `to close extend ${extendee}`);
    }

    // --- Building the schema ---

    private build(): Schema {
        if (!this.syntaxSeen) {
            this.problems.push({
                code: 'unsupported',
                message: `${this.fileName}:1:1: no syntax or edition statement; reading the file as proto2`,
                offset: 0
            });
        }

        const declared = new Set(this.declarations.map(d => d.fullName));
        const imported = new Map<string, NamedType>();
        for (const decl of this.imports) {
            for (const type of wellKnownTypesFor(decl.path)) imported.set(type.fullName, type);
        }
        for (const name of imported.keys()) declared.add(name);

        const fileFeatures = mergeFeatures(editionDefaults(this.edition), this.fileFeatures);
        const messages = new Map(this.declarations.flatMap(d => d.kind === 'message' ? [[d.fullName, d]] : []));
        const enums = new Map(this.declarations.flatMap(d => d.kind === 'enum' ? [[d.fullName, d]] : []));

        // Features inherit down the declaration tree, which nesting encodes in the full names
        const resolvedFeatures = new Map<string, ResolvedFeatures>();
        const featuresOf = (declaration: RawType): ResolvedFeatures => {
            const cached = resolvedFeatures.get(declaration.fullName);
            if (cached) return cached;
            const parentName = declaration.kind === 'message' ? declaration.scope : parentOf(declaration.fullName);
            const parent = messages.get(parentName);
            const base = parent ? featuresOf(parent) : fileFeatures;
            const merged = mergeFeatures(base, declaration.features);
            resolvedFeatures.set(declaration.fullName, merged);
            return merged;
        };

        const types = new Map<string, NamedType>(imported);
        for (const declaration of this.declarations) {
            if (declaration.kind === 'enum') {
                const features = featuresOf(declaration);
                types.set(declaration.fullName, {
                    kind: 'enum',
                    name: declaration.name,
                    fullName: declaration.fullName,
                    values: declaration.values,
                    open: features.enumType === 'OPEN',
                    ...listOf('reservedRanges', declaration.reservedRanges),
                    ...listOf('reservedNames', declaration.reservedNames),
                    ...listOf('options', declaration.options)
                });
                continue;
            }

            const features = featuresOf(declaration);
            const fields = new Map<number, FieldDef>();
            for (const raw of declaration.fields) {
                const scopeFeatures = raw.oneof !== undefined
                    ? mergeFeatures(features, declaration.oneofFeatures.get(raw.oneof))
                    : features;
                const field = this.buildField(raw, declaration.fullName, scopeFeatures, declared, messages, enums);
                if (fields.has(field.number)) {
                    this.report('duplicate-name', `${declaration.fullName} has two fields numbered ${field.number}`, raw.offset, this.lineAt(raw.offset));
                }
                fields.set(field.number, field);
            }
            types.set(declaration.fullName, {
                kind: 'message',
                name: declaration.name,
                fullName: declaration.fullName,
                fields,
                oneofs: declaration.oneofs,
                mapEntry: declaration.mapEntry,
                messageSet: declaration.messageSet,
                ...listOf('reservedRanges', declaration.reservedRanges),
                ...listOf('reservedNames', declaration.reservedNames),
                ...listOf('extensionRanges', declaration.extensionRanges),
                ...listOf('options', declaration.options)
            });
        }

        const extensions: ExtensionDecl[] = this.rawExtensions.map(({ extendee, scope, field }) => ({
            extendee: this.resolveName(extendee, scope, declared, field.offset) ?? stripDot(extendee),
            field: this.buildField(field, scope, fileFeatures, declared, messages, enums)
        }));

        const syntax = this.edition === 'proto2' || this.edition === 'proto3' ? this.edition : 'editions';
        return {
            syntax,
            ...(syntax === 'editions' ? { edition: this.edition } : {}),
            ...(this.packageName !== '' ? { package: this.packageName } : {}),
            types,
            ...listOf('imports', this.imports),
            ...listOf('services', this.services),
            ...listOf('extensions', extensions),
            ...listOf('options', this.fileOptions)
        };
    }

    private buildField(
        raw: RawField,
        scope: string,
        inherited: ResolvedFeatures,
        declared: ReadonlySet<string>,
        messages: ReadonlyMap<string, RawMessage>,
        enums: ReadonlyMap<string, RawEnum>
    ): FieldDef {
        const features = mergeFeatures(inherited, raw.features);
        const type = this.resolveType(raw.typeText, scope, declared, messages, enums, raw.offset);
        // A map field is a repeated entry field, however it is spelled
        const repeated = raw.label === 'repeated' || type.kind === 'map';

        let cardinality: Cardinality = repeated ? 'repeated' : 'optional';
        if (!repeated && (raw.label === 'required' || features.fieldPresence === 'LEGACY_REQUIRED')) cardinality = 'required';

        // proto3 spells explicit presence with the `optional` label
        const explicit = raw.oneof !== undefined
            || cardinality === 'required'
            || (this.edition === 'proto3' && raw.label === 'optional')
            || type.kind === 'message'
            || type.kind === 'map'
            || features.fieldPresence !== 'IMPLICIT';

        return {
            number: raw.number,
            name: raw.name,
            type,
            cardinality,
            presence: !repeated && explicit ? 'explicit' : 'implicit',
            packed: repeated && isPackable(type) && (raw.packedOption ?? features.repeatedFieldEncoding === 'PACKED'),
            delimited: raw.group || features.messageEncoding === 'DELIMITED',
            ...(raw.oneof !== undefined ? { oneof: raw.oneof } : {}),
            ...(raw.jsonName !== undefined ? { jsonName: raw.jsonName } : {}),
            ...(raw.defaultValue !== undefined ? { defaultValue: raw.defaultValue } : {}),
            ...listOf('options', raw.options)
        };
    }

    private resolveType(
        text: string,
        scope: string,
        declared: ReadonlySet<string>,
        messages: ReadonlyMap<string, RawMessage>,
        enums: ReadonlyMap<string, RawEnum>,
        offset: number
    ): FieldType {
        if (text.startsWith('map<')) {
            const [keyText, valueText] = splitMap(text);
            const key = SCALAR_TYPES.has(keyText) ? keyText as ScalarType : 'string';
            if (!SCALAR_TYPES.has(keyText)) {
                this.report('unsupported', `map key type '${keyText}' is not a scalar`, offset, this.lineAt(offset));
            }
            return { kind: 'map', key, value: this.resolveType(valueText, scope, declared, messages, enums, offset) };
        }
        if (SCALAR_TYPES.has(text)) return scalar(text as ScalarType);

        const resolved = this.resolveName(text, scope, declared, offset);
        if (resolved === undefined) return { kind: 'message', name: stripDot(text) };
        if (enums.has(resolved)) return { kind: 'enum', name: resolved };
        if (messages.has(resolved)) return { kind: 'message', name: resolved };
        // An imported well-known type
        return { kind: 'message', name: resolved };
    }

    private resolveName(text: string, scope: string, declared: ReadonlySet<string>, offset: number): string | undefined {
        const resolved = resolveTypeName(text, scope, declared);
        if (resolved === undefined) this.reportUnresolved(text, offset);
        return resolved;
    }

    private reportUnresolved(text: string, offset: number): void {
        this.report('unresolved-type', `type '${text}' is not defined in this file or a bundled import`, offset, this.lineAt(offset));
    }

    /** The 1-based line of an offset, for problems raised after tokenizing */
    private lineAt(offset: number): number {
        let line = 1;
        for (let i = 0; i < offset && i < this.source.length; i++) {
            if (this.source[i] === '\n') line++;
        }
        return line;
    }
}

// --- Helpers ---

function isTypeStart(token: Token): boolean {
    return token.kind === 'ident' || token.text === '.';
}

function parentOf(fullName: string): string {
    const index = fullName.lastIndexOf('.');
    return index === -1 ? '' : fullName.slice(0, index);
}

function stripDot(name: string): string {
    return name.startsWith('.') ? name.slice(1) : name;
}

function splitMap(text: string): [string, string] {
    const inner = text.slice(4, -1);
    let depth = 0;
    for (let i = 0; i < inner.length; i++) {
        const char = inner[i]!;
        if (char === '<') depth++;
        else if (char === '>') depth--;
        else if (char === ',' && depth === 0) return [inner.slice(0, i), inner.slice(i + 1)];
    }
    return [inner, 'bytes'];
}

function featureFrom(name: string, value: string): FeatureSet | undefined {
    if (!name.startsWith('features.')) return undefined;
    const feature = featuresFromNames(name.slice('features.'.length), value);
    return Object.values(feature).some(v => v !== undefined) ? feature : {};
}

function parseIntLiteral(text: string): number | undefined {
    if (/^-?0[xX][0-9a-fA-F]+$/.test(text)) return parseInt(text, 16);
    if (/^-?0[0-7]+$/.test(text)) return parseInt(text.replace(/^(-?)0/, '$1'), 8);
    if (/^-?\d+$/.test(text)) return parseInt(text, 10);
    return undefined;
}

function unquote(text: string): string {
    return /^["'].*["']$/.test(text) ? text.slice(1, -1) : text;
}

function listOf<K extends string, T>(key: K, values: readonly T[]): Partial<Record<K, readonly T[]>> {
    return values.length === 0 ? {} : { [key]: values } as Partial<Record<K, readonly T[]>>;
}
