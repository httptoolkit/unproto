export type ProblemCode =
    // Wire-level problems
    | 'truncated'
    | 'invalid-tag'
    | 'invalid-field-number'
    | 'invalid-wire-type'
    | 'varint-too-long'
    | 'varint-overflow'
    | 'length-too-large'
    | 'unclosed-group'
    | 'mismatched-end-group'
    | 'unexpected-end-group'
    | 'recursion-limit'
    // Interpretation problems
    | 'unknown-type'
    | 'unknown-field'
    | 'wire-type-mismatch'
    | 'invalid-utf8'
    | 'invalid-packed-data'
    | 'nested-message-problems'
    // Schema problems
    | 'parse-error'
    | 'unsupported'
    | 'unresolved-type'
    | 'duplicate-name'
    | 'invalid-value';

/**
 * A non-fatal issue found while decoding. Decoding never throws for bad
 * input: it returns what it could read alongside a list of these.
 */
export interface Problem {
    readonly code: ProblemCode;
    readonly message: string;
    /** Absolute byte offset into the original input, where known */
    readonly offset?: number;
    /** Field numbers from the root message down to the field concerned */
    readonly path?: readonly number[];
}
