/**
 * Stable diagnostic codes for the Apex lint / schema diagnostics. Quick fixes
 * (codeActions.ts) key off these codes (and the `data` payloads below), never off
 * the human-readable messages — treat the values as a public contract.
 */
export const CODE_DEBUG = 'asfx-debug-statement';
export const CODE_HARDCODED_ID = 'asfx-hardcoded-id';
export const CODE_SOQL_IN_LOOP = 'asfx-soql-in-loop';
export const CODE_DML_IN_LOOP = 'asfx-dml-in-loop';
export const CODE_MISSING_SHARING = 'asfx-missing-sharing';
export const CODE_UNKNOWN_FIELD = 'asfx-unknown-field';

/** `data` of a CODE_UNKNOWN_FIELD diagnostic: the SObject (as resolved) and the unknown member. */
export interface UnknownFieldData {
    object: string;
    field: string;
}

/** Parse the schema-validation message `'<member>' is not a field or relationship of <Object>.` */
export function parseUnknownFieldMessage(message: string): UnknownFieldData | undefined {
    const m = /^'([A-Za-z_]\w*)' is not a field or relationship of ([A-Za-z_]\w*)\.$/.exec(message);
    return m ? { field: m[1], object: m[2] } : undefined;
}
