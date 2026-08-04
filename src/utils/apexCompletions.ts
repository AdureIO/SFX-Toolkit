/**
 * Shared Apex completion data and context-detection logic.
 * No VS Code dependencies — usable from both the extension host
 * (CompletionItemProvider) and the Execute Apex webview panel.
 */

// ─── Static data ─────────────────────────────────────────────────────────────

export const APEX_KEYWORDS: string[] = [
    'abstract', 'after', 'before', 'break', 'bulk', 'catch', 'class', 'continue',
    'delete', 'do', 'else', 'enum', 'extends', 'final', 'finally', 'for',
    'get', 'global', 'if', 'implements', 'in', 'inner', 'insert', 'instanceof',
    'interface', 'merge', 'new', 'null', 'on', 'override', 'private', 'protected',
    'public', 'return', 'set', 'sharing', 'static', 'super', 'switch',
    'testmethod', 'this', 'throw', 'transient', 'trigger', 'try', 'undelete',
    'update', 'upsert', 'virtual', 'void', 'webservice', 'when', 'while',
    'with', 'without', 'inherited',
];

export const APEX_TYPES: string[] = [
    'Boolean', 'Blob', 'Date', 'Datetime', 'Decimal', 'Double', 'Id', 'Integer',
    'Long', 'Object', 'String', 'Time',
    'List', 'Map', 'Set',
    'SObject',
];

export interface StdlibMethod {
    name: string;
    signature: string;
    detail?: string;
}

export interface StdlibEntry {
    methods: StdlibMethod[];
}

export const APEX_STDLIB: Record<string, StdlibEntry> = {
    System: { methods: [
        { name: 'debug',            signature: 'debug(Object msg)',                        detail: 'Write to debug log' },
        { name: 'debug',            signature: 'debug(LoggingLevel level, Object msg)',     detail: 'Write to debug log at level' },
        { name: 'assert',           signature: 'assert(Boolean condition)',                 detail: 'Throws AssertException if false' },
        { name: 'assert',           signature: 'assert(Boolean condition, String msg)',     detail: 'Throws AssertException with message' },
        { name: 'assertEquals',     signature: 'assertEquals(Object expected, Object actual)' },
        { name: 'assertNotEquals',  signature: 'assertNotEquals(Object expected, Object actual)' },
        { name: 'today',            signature: 'today() : Date',                           detail: 'Current date in user\'s timezone' },
        { name: 'now',              signature: 'now() : Datetime',                         detail: 'Current datetime (UTC)' },
        { name: 'enqueueJob',       signature: 'enqueueJob(Queueable job) : Id',           detail: 'Submit a Queueable job' },
        { name: 'isFuture',         signature: 'isFuture() : Boolean' },
        { name: 'isBatch',          signature: 'isBatch() : Boolean' },
        { name: 'isScheduled',      signature: 'isScheduled() : Boolean' },
        { name: 'isQueueable',      signature: 'isQueueable() : Boolean' },
        { name: 'runAs',            signature: 'runAs(User user)',                         detail: 'Run block as a specific user (test only)' },
        { name: 'currentPageReference', signature: 'currentPageReference() : PageReference' },
        { name: 'setReadOnlyMode',  signature: 'setReadOnlyMode(Boolean mode)' },
        { name: 'abortJob',         signature: 'abortJob(Id jobId)' },
        { name: 'schedule',         signature: 'schedule(String jobName, String cron, Schedulable job) : Id' },
    ]},
    Database: { methods: [
        { name: 'insert',           signature: 'insert(SObject record) : SaveResult',          detail: 'Insert a single record' },
        { name: 'insert',           signature: 'insert(List<SObject> records) : SaveResult[]', detail: 'Insert a list of records' },
        { name: 'insert',           signature: 'insert(SObject record, Boolean allOrNone)',     detail: 'Insert with partial save option' },
        { name: 'update',           signature: 'update(SObject record) : SaveResult' },
        { name: 'update',           signature: 'update(List<SObject> records) : SaveResult[]' },
        { name: 'upsert',           signature: 'upsert(SObject record) : UpsertResult' },
        { name: 'upsert',           signature: 'upsert(List<SObject> records) : UpsertResult[]' },
        { name: 'delete',           signature: 'delete(SObject record) : DeleteResult' },
        { name: 'delete',           signature: 'delete(List<SObject> records) : DeleteResult[]' },
        { name: 'undelete',         signature: 'undelete(SObject record) : UndeleteResult' },
        { name: 'merge',            signature: 'merge(SObject master, SObject duplicate)' },
        { name: 'query',            signature: 'query(String soql) : SObject[]',               detail: 'Dynamic SOQL query' },
        { name: 'queryWithBinds',   signature: 'queryWithBinds(String soql, Map<String,Object> binds, AccessLevel level) : SObject[]' },
        { name: 'countQuery',       signature: 'countQuery(String soql) : Integer' },
        { name: 'getQueryLocator',  signature: 'getQueryLocator(String soql) : QueryLocator',  detail: 'For use with Batchable' },
        { name: 'setSavepoint',     signature: 'setSavepoint() : Savepoint' },
        { name: 'rollback',         signature: 'rollback(Savepoint sp)' },
        { name: 'executeBatch',     signature: 'executeBatch(Batchable<SObject> job) : Id' },
        { name: 'executeBatch',     signature: 'executeBatch(Batchable<SObject> job, Integer scope) : Id' },
    ]},
    Test: { methods: [
        { name: 'startTest',            signature: 'startTest()',                               detail: 'Reset governor limits' },
        { name: 'stopTest',             signature: 'stopTest()',                                detail: 'Flush async work, restore limits' },
        { name: 'isRunningTest',        signature: 'isRunningTest() : Boolean' },
        { name: 'setMock',              signature: 'setMock(Type type, Object mock)',           detail: 'Register a mock for callouts' },
        { name: 'createStub',           signature: 'createStub(Type type, StubProvider provider) : Object' },
        { name: 'loadData',             signature: 'loadData(SObjectType t, String resourceName) : SObject[]' },
        { name: 'getStandardPricebookId', signature: 'getStandardPricebookId() : Id' },
        { name: 'enableChangeDataCapture', signature: 'enableChangeDataCapture()' },
        { name: 'getEventBus',          signature: 'getEventBus() : EventBus' },
    ]},
    Schema: { methods: [
        { name: 'describeSObjects',     signature: 'describeSObjects(String[] types) : DescribeSObjectResult[]' },
        { name: 'getGlobalDescribe',    signature: 'getGlobalDescribe() : Map<String, SObjectType>' },
        { name: 'describeDataCategory', signature: 'describeDataCategory(String sObjectName, String category) : DataCategoryGroupSobjectTypePair[]' },
    ]},
    Limits: { methods: [
        { name: 'getQueries',       signature: 'getQueries() : Integer' },
        { name: 'getLimitQueries',  signature: 'getLimitQueries() : Integer' },
        { name: 'getDMLRows',       signature: 'getDMLRows() : Integer' },
        { name: 'getLimitDMLRows',  signature: 'getLimitDMLRows() : Integer' },
        { name: 'getDMLStatements', signature: 'getDMLStatements() : Integer' },
        { name: 'getLimitDMLStatements', signature: 'getLimitDMLStatements() : Integer' },
        { name: 'getHeapSize',      signature: 'getHeapSize() : Integer' },
        { name: 'getLimitHeapSize', signature: 'getLimitHeapSize() : Integer' },
        { name: 'getCpuTime',       signature: 'getCpuTime() : Integer' },
        { name: 'getLimitCpuTime',  signature: 'getLimitCpuTime() : Integer' },
        { name: 'getCallouts',      signature: 'getCallouts() : Integer' },
        { name: 'getLimitCallouts', signature: 'getLimitCallouts() : Integer' },
        { name: 'getAggregateQueries',      signature: 'getAggregateQueries() : Integer' },
        { name: 'getLimitAggregateQueries', signature: 'getLimitAggregateQueries() : Integer' },
    ]},
    Math: { methods: [
        { name: 'abs',      signature: 'abs(Decimal d) : Decimal' },
        { name: 'ceil',     signature: 'ceil(Double d) : Double' },
        { name: 'floor',    signature: 'floor(Double d) : Double' },
        { name: 'round',    signature: 'round(Decimal d) : Long' },
        { name: 'sqrt',     signature: 'sqrt(Double d) : Double' },
        { name: 'pow',      signature: 'pow(Double base, Double exp) : Double' },
        { name: 'min',      signature: 'min(Integer a, Integer b) : Integer' },
        { name: 'max',      signature: 'max(Integer a, Integer b) : Integer' },
        { name: 'mod',      signature: 'mod(Integer a, Integer b) : Integer' },
        { name: 'random',   signature: 'random() : Double',       detail: 'Returns 0.0–1.0' },
        { name: 'log',      signature: 'log(Double d) : Double',  detail: 'Natural log' },
        { name: 'log10',    signature: 'log10(Double d) : Double' },
        { name: 'exp',      signature: 'exp(Double d) : Double' },
        { name: 'sin',      signature: 'sin(Double d) : Double' },
        { name: 'cos',      signature: 'cos(Double d) : Double' },
        { name: 'tan',      signature: 'tan(Double d) : Double' },
        { name: 'atan2',    signature: 'atan2(Double y, Double x) : Double' },
    ]},
    JSON: { methods: [
        { name: 'serialize',            signature: 'serialize(Object obj) : String',                               detail: 'Serialize to JSON string' },
        { name: 'serializePretty',      signature: 'serializePretty(Object obj) : String',                        detail: 'Serialize with pretty print' },
        { name: 'deserialize',          signature: 'deserialize(String json, Type type) : Object',                 detail: 'Deserialize to typed object' },
        { name: 'deserializeUntyped',   signature: 'deserializeUntyped(String json) : Object',                    detail: 'Deserialize to Map/List/primitives' },
        { name: 'deserializeStrict',    signature: 'deserializeStrict(String json, Type type) : Object' },
        { name: 'createParser',         signature: 'createParser(String json) : JSONParser' },
        { name: 'createGenerator',      signature: 'createGenerator(Boolean pretty) : JSONGenerator' },
    ]},
    UserInfo: { methods: [
        { name: 'getUserId',            signature: 'getUserId() : Id' },
        { name: 'getUserName',          signature: 'getUserName() : String' },
        { name: 'getName',              signature: 'getName() : String' },
        { name: 'getSessionId',         signature: 'getSessionId() : String' },
        { name: 'getOrganizationId',    signature: 'getOrganizationId() : Id' },
        { name: 'getOrganizationName',  signature: 'getOrganizationName() : String' },
        { name: 'getProfileId',         signature: 'getProfileId() : Id' },
        { name: 'getLanguage',          signature: 'getLanguage() : String' },
        { name: 'getLocale',            signature: 'getLocale() : String' },
        { name: 'getTimeZone',          signature: 'getTimeZone() : TimeZone' },
        { name: 'getUiTheme',           signature: 'getUiTheme() : String' },
        { name: 'getDefaultCurrency',   signature: 'getDefaultCurrency() : String' },
        { name: 'isCurrentUserLicensed', signature: 'isCurrentUserLicensed(String namespace) : Boolean' },
    ]},
    URL: { methods: [
        { name: 'getCurrentRequestUrl',  signature: 'getCurrentRequestUrl() : URL' },
        { name: 'getSalesforceBaseUrl',  signature: 'getSalesforceBaseUrl() : URL' },
        { name: 'getFileFieldURL',       signature: 'getFileFieldURL(String entityId, String fieldName) : URL' },
    ]},
    Blob: { methods: [
        { name: 'valueOf',   signature: 'valueOf(String str) : Blob',   detail: 'Convert String to Blob' },
        { name: 'toString',  signature: 'toString() : String' },
        { name: 'size',      signature: 'size() : Integer' },
        { name: 'toPdf',     signature: 'toPdf(String html) : Blob' },
    ]},
    EncodingUtil: { methods: [
        { name: 'base64Encode',         signature: 'base64Encode(Blob inputBlob) : String' },
        { name: 'base64Decode',         signature: 'base64Decode(String inputString) : Blob' },
        { name: 'urlEncode',            signature: 'urlEncode(String inputString, String charsetName) : String' },
        { name: 'urlDecode',            signature: 'urlDecode(String inputString, String charsetName) : String' },
        { name: 'convertToHex',         signature: 'convertToHex(Blob inputBlob) : String' },
        { name: 'convertFromHex',       signature: 'convertFromHex(String inputString) : Blob' },
        { name: 'generateDigest',       signature: 'generateDigest(String algorithmName, Blob input) : Blob' },
    ]},
    Crypto: { methods: [
        { name: 'generateAesKey',       signature: 'generateAesKey(Integer keySize) : Blob' },
        { name: 'encrypt',              signature: 'encrypt(String algorithmName, Blob key, Blob iv, Blob input) : Blob' },
        { name: 'decrypt',              signature: 'decrypt(String algorithmName, Blob key, Blob iv, Blob input) : Blob' },
        { name: 'generateDigest',       signature: 'generateDigest(String algorithmName, Blob input) : Blob' },
        { name: 'generateMac',          signature: 'generateMac(String algorithmName, Blob input, Blob key) : Blob' },
        { name: 'getRandomInteger',     signature: 'getRandomInteger() : Integer' },
        { name: 'getRandomLong',        signature: 'getRandomLong() : Long' },
    ]},
    HttpRequest: { methods: [
        { name: 'setEndpoint',  signature: 'setEndpoint(String endpoint)' },
        { name: 'setMethod',    signature: 'setMethod(String method)' },
        { name: 'setHeader',    signature: 'setHeader(String key, String value)' },
        { name: 'setBody',      signature: 'setBody(String body)' },
        { name: 'setBodyAsBlob', signature: 'setBodyAsBlob(Blob body)' },
        { name: 'setTimeout',   signature: 'setTimeout(Integer timeout)',   detail: 'Timeout in ms (max 120000)' },
        { name: 'getBody',      signature: 'getBody() : String' },
        { name: 'getStatusCode', signature: 'getStatusCode() : Integer' },
    ]},
    Http: { methods: [
        { name: 'send', signature: 'send(HttpRequest req) : HttpResponse', detail: 'Execute HTTP callout' },
    ]},
    HttpResponse: { methods: [
        { name: 'getBody',       signature: 'getBody() : String' },
        { name: 'getBodyAsBlob', signature: 'getBodyAsBlob() : Blob' },
        { name: 'getHeader',     signature: 'getHeader(String key) : String' },
        { name: 'getHeaderKeys', signature: 'getHeaderKeys() : String[]' },
        { name: 'getStatus',     signature: 'getStatus() : String' },
        { name: 'getStatusCode', signature: 'getStatusCode() : Integer' },
    ]},
    Messaging: { methods: [
        { name: 'sendEmail', signature: 'sendEmail(Messaging.Email[] emails)', detail: 'Send one or more emails' },
        { name: 'reserveSingleEmailCapacity', signature: 'reserveSingleEmailCapacity(Integer count)' },
    ]},
    EventBus: { methods: [
        { name: 'publish',  signature: 'publish(SObject event) : Database.SaveResult',         detail: 'Publish a platform event' },
        { name: 'publish',  signature: 'publish(List<SObject> events) : Database.SaveResult[]' },
    ]},
    FlowInterview: { methods: [
        { name: 'createInterview', signature: 'createInterview(String flowName, Map<String,Object> inputs) : FlowInterview' },
        { name: 'start',           signature: 'start()' },
        { name: 'getVariableValue', signature: 'getVariableValue(String varName) : Object' },
    ]},
};

// Trigger context properties
export const APEX_TRIGGER_PROPS: StdlibMethod[] = [
    { name: 'new',          signature: 'Trigger.new : List<SObject>',          detail: 'New versions of the records (insert, update)' },
    { name: 'old',          signature: 'Trigger.old : List<SObject>',          detail: 'Old versions of the records (update, delete)' },
    { name: 'newMap',       signature: 'Trigger.newMap : Map<Id,SObject>',     detail: 'Map of Id to new record (insert, update)' },
    { name: 'oldMap',       signature: 'Trigger.oldMap : Map<Id,SObject>',     detail: 'Map of Id to old record (update, delete)' },
    { name: 'isInsert',     signature: 'Trigger.isInsert : Boolean' },
    { name: 'isUpdate',     signature: 'Trigger.isUpdate : Boolean' },
    { name: 'isDelete',     signature: 'Trigger.isDelete : Boolean' },
    { name: 'isUndelete',   signature: 'Trigger.isUndelete : Boolean' },
    { name: 'isBefore',     signature: 'Trigger.isBefore : Boolean' },
    { name: 'isAfter',      signature: 'Trigger.isAfter : Boolean' },
    { name: 'isExecuting',  signature: 'Trigger.isExecuting : Boolean' },
    { name: 'size',         signature: 'Trigger.size : Integer',               detail: 'Number of records in the trigger' },
    { name: 'operationType', signature: 'Trigger.operationType : TriggerOperation' },
];

// ─── Context detection ────────────────────────────────────────────────────────

export type CompletionContextType =
    | 'member'      // word.<cursor> — stdlib method or SObject field
    | 'soqlField'   // SELECT <cursor> FROM SObject
    | 'soqlFrom'    // FROM <cursor>
    | 'annotation'  // @<cursor> in declaration position — Apex annotations
    | 'apexPicklist'// obj.PicklistField = '<cursor>  — picklist values in Apex
    | 'bare';       // plain word — keywords, types, SObject names

export type AnnotationTarget = 'class' | 'method' | 'any';

export interface ApexCompletionContext {
    type: CompletionContextType;
    prefix: string;
    /** For 'annotation': what the annotation is attached to, inferred from the following code. */
    annotationTarget?: AnnotationTarget;
    /** For 'apexPicklist': the field whose picklist values we want (last segment of the LHS). */
    pickField?: string;
    /** Resolved for 'member' (the object before the dot). */
    objectName?: string;
    /** SObject name resolved from FROM clause for 'soqlField'. */
    sobjectName?: string;
    /**
     * Parent-relationship hops for 'soqlField' when the field token is a dotted
     * traversal, e.g. `Account__r.Owner.<cursor>` → ['Account__r', 'Owner'].
     * Empty/undefined for a direct field on the FROM object.
     */
    relPath?: string[];
}

/**
 * Parse the context at the cursor.
 * @param textUpToCursor  The text of the current line up to (not including) the cursor character.
 * @param surroundingText Optional multi-line text window around the cursor. Used to locate the
 *                        FROM SObject, which sits *after* the field list being completed.
 * @param beforeCursor    Optional multi-line text from the top of the window up to the cursor.
 *                        Lets us detect a SELECT (and relationship paths) that began on an earlier
 *                        line. Falls back to textUpToCursor when omitted.
 */
/** Infer whether an annotation being typed applies to a class or a method, from the code after it. */
export function annotationTargetFrom(afterText?: string): AnnotationTarget {
    if (!afterText) return 'any';
    const clsIdx = afterText.search(/\b(class|interface|enum)\b/i);
    const parenIdx = afterText.indexOf('(');
    // A class/interface/enum keyword before any '(' → class declaration.
    if (clsIdx >= 0 && (parenIdx < 0 || clsIdx < parenIdx)) return 'class';
    // A '(' → a method signature; a bare `Type name;`/`Type name =` → a property/field.
    if (parenIdx >= 0) return 'method';
    if (/\b[A-Za-z_][\w<>,.\][ ]*\s+[A-Za-z_]\w*\s*[;=]/.test(afterText)) return 'method';
    return 'any';
}

export function parseContext(
    textUpToCursor: string,
    surroundingText?: string,
    beforeCursor?: string,
    afterText?: string
): ApexCompletionContext {
    const before = beforeCursor && beforeCursor.length ? beforeCursor : textUpToCursor;

    // 0. Annotation position: the current line is only whitespace + `@word` (not an email/expression).
    if (/^\s*@\w*$/.test(textUpToCursor)) {
        const prefix = (textUpToCursor.match(/@(\w*)$/) || ['', ''])[1];
        return { type: 'annotation', prefix, annotationTarget: annotationTargetFrom(afterText) };
    }

    // 1. SOQL SELECT field list (checked before Apex dot-access so relationship
    //    traversals like `Account__r.Name` aren't mistaken for member access).
    //    Find the nearest SELECT before the cursor that has not yet been closed
    //    by its FROM, a subquery/statement end (']' / ';').
    let lastSelect = -1;
    const selRe = /\bSELECT\b/gi;
    let sm: RegExpExecArray | null;
    while ((sm = selRe.exec(before)) !== null) lastSelect = sm.index;

    if (lastSelect >= 0) {
        const seg = before.slice(lastSelect);
        const inSelectList = !/\bFROM\b/i.test(seg) && !/[\];]/.test(seg);
        if (inSelectList) {
            const sobjFromMatch = (surroundingText || textUpToCursor).match(/\bFROM\s+(\w+)/i);
            if (sobjFromMatch) {
                const token = (textUpToCursor.match(/[\w.]*$/) || [''])[0];
                const dot = token.lastIndexOf('.');
                if (dot >= 0) {
                    const relPath = token.slice(0, dot).split('.').filter(Boolean);
                    return { type: 'soqlField', sobjectName: sobjFromMatch[1], prefix: token.slice(dot + 1), relPath };
                }
                return { type: 'soqlField', sobjectName: sobjFromMatch[1], prefix: token };
            }
        }
    }

    // 1b. Apex picklist value: `obj.Field = '<cursor>` (or ==, !=). The LHS must be dotted so we
    //     can resolve the object; a bare `Field = '…'` (no receiver) is left to SOQL handling.
    const pick = textUpToCursor.match(/([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)\s*[=!<>]=?\s*'([^']*)$/);
    if (pick) {
        const segs = pick[1].split('.');
        const pickField = segs[segs.length - 1];
        return { type: 'apexPicklist', objectName: segs[0], relPath: segs.slice(1, -1), pickField, prefix: pick[2] };
    }

    // 2. Apex dot-access, possibly a relationship drill on an SObject instance:
    //    root.hop1.hop2.prefix  (e.g. `account.Contact.Na` → root=account, hops=[Contact]).
    //    root carries the variable/type; hops are parent-relationship names to walk.
    const chain = textUpToCursor.match(/([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.(\w*)$/);
    if (chain) {
        const segs = chain[1].split('.');
        return { type: 'member', objectName: segs[0], relPath: segs.slice(1), prefix: chain[2] };
    }

    // 3. SOQL FROM clause: cursor is after FROM
    const fromMatch = textUpToCursor.match(/\bFROM\s+(\w*)$/i);
    if (fromMatch) {
        return { type: 'soqlFrom', prefix: fromMatch[1] };
    }

    // 4. Default: bare word
    const wordMatch = textUpToCursor.match(/(\w+)$/);
    return { type: 'bare', prefix: wordMatch ? wordMatch[1] : '' };
}

// ─── Completion item types ────────────────────────────────────────────────────

/** Kind values align with vscode.CompletionItemKind so webview can use them directly. */
export const CompletionKind = {
    Keyword:    13,
    Class:       6,
    Method:      1,
    Field:       4,
    Variable:    5,
    Text:        0,
    Snippet:    14,
    Value:      11,
} as const;

export type CompletionKindValue = typeof CompletionKind[keyof typeof CompletionKind];

export interface RawCompletionItem {
    label: string;
    detail?: string;
    documentation?: string;
    /** When true, `documentation` is Markdown (e.g. carries the ASFX provenance footer). */
    docIsMarkdown?: boolean;
    kind: CompletionKindValue;
    insertText?: string;
    /** When true, `insertText` is a snippet (may contain ${1:…} tab stops). */
    isSnippet?: boolean;
    sortText?: string;
}

/** Provenance footer so users can see a suggestion comes from this extension (matches the LS). */
export const ASFX_FOOTER = '_— ASFX Toolkit_';

// ─── Apex annotations ─────────────────────────────────────────────────────────

interface AnnotationDef {
    name: string;            // without the leading @
    targets: AnnotationTarget[]; // 'class' | 'method' | 'any'
    snippet?: string;        // insert text (without @); may contain ${1:…}
    doc: string;
}

/** Common Apex annotations, tagged with where they belong. */
export const APEX_ANNOTATIONS: AnnotationDef[] = [
    { name: 'IsTest', targets: ['class', 'method'], doc: 'Marks a class or method as an Apex test (excluded from org code size).' },
    { name: 'IsTest(SeeAllData=true)', targets: ['class', 'method'], doc: 'Test that can access existing org data.' },
    { name: 'TestSetup', targets: ['method'], doc: 'Creates common test records once for every test method in the class.' },
    { name: 'TestVisible', targets: ['method'], doc: 'Lets test methods see otherwise private/protected members.' },
    { name: 'AuraEnabled', targets: ['method'], doc: 'Exposes a method or property to Aura/LWC.' },
    { name: 'AuraEnabled(cacheable=true)', targets: ['method'], doc: 'Client-cacheable Aura/LWC method (read-only).' },
    { name: 'InvocableMethod', targets: ['method'], snippet: "InvocableMethod(label='${1:Label}' description='${2:Description}')", doc: 'Exposes a static method to Flow / REST as an invocable action.' },
    { name: 'InvocableVariable', targets: ['method'], snippet: "InvocableVariable(label='${1:Label}' required=${2:true})", doc: 'Marks a class member as an invocable action input/output.' },
    { name: 'Future', targets: ['method'], doc: 'Runs the static method asynchronously.' },
    { name: 'Future(callout=true)', targets: ['method'], doc: 'Async method that may make callouts.' },
    { name: 'HttpGet', targets: ['method'], doc: 'REST resource: handle GET.' },
    { name: 'HttpPost', targets: ['method'], doc: 'REST resource: handle POST.' },
    { name: 'HttpPut', targets: ['method'], doc: 'REST resource: handle PUT.' },
    { name: 'HttpPatch', targets: ['method'], doc: 'REST resource: handle PATCH.' },
    { name: 'HttpDelete', targets: ['method'], doc: 'REST resource: handle DELETE.' },
    { name: 'RemoteAction', targets: ['method'], doc: 'Visualforce JavaScript remoting endpoint.' },
    { name: 'ReadOnly', targets: ['method'], doc: 'Relaxes query row limits for a read-only request.' },
    { name: 'RestResource', targets: ['class'], snippet: "RestResource(urlMapping='/${1:path}')", doc: 'Exposes the class as a REST resource at a URL.' },
    { name: 'SuppressWarnings', targets: ['class', 'method'], snippet: "SuppressWarnings('${1:PMD}')", doc: 'Suppresses analysis warnings for the annotated code.' },
    { name: 'Deprecated', targets: ['class', 'method'], doc: 'Marks the item as deprecated (managed packages).' },
    { name: 'NamespaceAccessible', targets: ['class', 'method'], doc: 'Managed package: makes the item accessible from other namespaces.' },
    { name: 'JsonAccess', targets: ['class'], snippet: "JsonAccess(serializable='${1:allowed}' deserializable='${2:allowed}')", doc: 'Controls JSON (de)serialization across namespaces.' },
];

// ─── Static completion generation ────────────────────────────────────────────

/**
 * Returns static completions (no org API call needed).
 * Dynamic items (SObject names, fields) are added by the caller after an async cache lookup.
 */
export function getStaticItems(ctx: ApexCompletionContext): RawCompletionItem[] {
    const { type, prefix, objectName } = ctx;
    const lp = prefix.toLowerCase();
    const items: RawCompletionItem[] = [];

    if (type === 'member' && objectName) {
        const className = objectName.charAt(0).toUpperCase() + objectName.slice(1);

        if (className === 'Trigger') {
            return APEX_TRIGGER_PROPS
                .filter(p => p.name.toLowerCase().startsWith(lp))
                .map(p => ({
                    label: p.name,
                    detail: p.signature,
                    documentation: p.detail,
                    kind: CompletionKind.Field,
                    sortText: p.name,
                }));
        }

        const entry = APEX_STDLIB[className] ?? APEX_STDLIB[objectName];
        if (entry) {
            const seen = new Set<string>();
            return entry.methods
                .filter(m => m.name.toLowerCase().startsWith(lp))
                .map(m => {
                    const key = m.name;
                    const firstOccurrence = !seen.has(key);
                    seen.add(key);
                    return {
                        label: m.name,
                        detail: m.signature,
                        documentation: m.detail,
                        kind: CompletionKind.Method,
                        sortText: m.name + (firstOccurrence ? '0' : '1'),
                    } as RawCompletionItem;
                });
        }

        // Unknown object — no static completions (caller adds fields from describe)
        return [];
    }

    if (type === 'annotation') {
        // `@` already typed → insert the name only (no leading @). Filter by prefix, and rank
        // annotations valid for the detected target (class vs method) first.
        const target = ctx.annotationTarget ?? 'any';
        return APEX_ANNOTATIONS
            .filter(a => a.name.toLowerCase().startsWith(lp))
            .map(a => {
                const applies = target === 'any' || a.targets.includes(target);
                return {
                    label: '@' + a.name,
                    detail: a.targets.join('/') + ' annotation',
                    documentation: `${a.doc}\n\n${ASFX_FOOTER}`,
                    docIsMarkdown: true,
                    kind: CompletionKind.Snippet,
                    insertText: a.snippet ?? a.name,
                    isSnippet: !!a.snippet,
                    sortText: (applies ? '0' : '1') + a.name.toLowerCase(),
                } as RawCompletionItem;
            });
    }

    if (type === 'apexPicklist') {
        // Picklist values are resolved from the org schema by the caller — nothing static.
        return [];
    }

    if (type === 'soqlFrom') {
        // SObject names added dynamically by caller — return nothing static here
        return [];
    }

    if (type === 'soqlField') {
        // Field names added dynamically by caller — return nothing static here
        return [];
    }

    // type === 'bare': keywords + types + stdlib class names
    if (lp.length >= 1) {
        APEX_KEYWORDS
            .filter(k => k.startsWith(lp))
            .forEach(k => items.push({
                label: k,
                kind: CompletionKind.Keyword,
                sortText: '3' + k,
            }));

        APEX_TYPES
            .filter(t => t.toLowerCase().startsWith(lp))
            .forEach(t => items.push({
                label: t,
                kind: CompletionKind.Class,
                sortText: '2' + t,
            }));

        Object.keys(APEX_STDLIB)
            .filter(cls => cls.toLowerCase().startsWith(lp))
            .forEach(cls => items.push({
                label: cls,
                detail: 'Apex class',
                kind: CompletionKind.Class,
                sortText: '1' + cls,
            }));
    }

    return items;
}

/**
 * Wrap SObject names into RawCompletionItems.
 * Called by both the CompletionItemProvider and the webview message handler.
 */
export function sobjectItems(names: string[], prefix: string): RawCompletionItem[] {
    const lp = prefix.toLowerCase();
    return names
        .filter(n => n.toLowerCase().startsWith(lp))
        .map(n => ({
            label: n,
            detail: 'SObject',
            kind: CompletionKind.Class,
            sortText: '0' + n,
        }));
}

/**
 * Wrap field names into RawCompletionItems.
 */
export function fieldItems(names: string[], prefix: string): RawCompletionItem[] {
    const lp = prefix.toLowerCase();
    return names
        .filter(n => n.toLowerCase().startsWith(lp))
        .map(n => ({
            label: n,
            detail: 'Field',
            kind: CompletionKind.Field,
            sortText: n,
        }));
}

/** One entry from OrgMetadataCache.getFieldsAndRelations. */
export interface FieldOrRelation {
    name: string;
    type?: string;
    /** True for a parent-relationship pseudo-field (e.g. `Account`, `MyLookup__r`). */
    rel?: boolean;
    /** Target SObject API name for a relationship entry. */
    target?: string;
}

/**
 * Wrap fields AND parent-relationship pseudo-fields into RawCompletionItems.
 * Relationships (standard like `Owner`/`Account` and custom `__r`) are surfaced
 * so inline SOQL in Apex offers the same traversals as the SOQL builder.
 * Fields sort first, relationships after (both alphabetical within their group).
 */
export function fieldAndRelationItems(entries: FieldOrRelation[], prefix: string): RawCompletionItem[] {
    const lp = prefix.toLowerCase();
    return entries
        .filter(e => e.name.toLowerCase().startsWith(lp))
        .map(e => e.rel
            ? {
                label: e.name,
                detail: e.target ? `Relationship → ${e.target}` : 'Relationship',
                kind: CompletionKind.Class,
                sortText: '1' + e.name,
            }
            : {
                label: e.name,
                detail: e.type ? `Field (${e.type})` : 'Field',
                kind: CompletionKind.Field,
                sortText: '0' + e.name,
            });
}
