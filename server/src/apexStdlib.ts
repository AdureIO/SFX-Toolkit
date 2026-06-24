/**
 * A curated slice of the Apex standard library for completion. This is not a full
 * model of the System namespace — it's the high-frequency types, namespaces and
 * static methods that developers reach for constantly (especially in anonymous
 * Apex), so the panel and `.cls` editors offer them even though our JVM-free
 * engine has no semantic type model of Salesforce's built-ins.
 */

export interface StdMember {
    name: string;
    kind: 'method' | 'field';
    /** Signature shown in completion detail, e.g. `void debug(Object msg)`. */
    detail: string;
}

/**
 * Top-level built-in types and namespaces offered as bare identifiers. Mix of
 * namespaces (System, Database…), value types (Integer, String…) and common
 * classes (Http, Pattern…). `List`/`Map`/`Set`/`SObject` are intentionally here
 * too so `new List<…>()` etc. complete.
 */
export const STD_TYPES: string[] = [
    // Namespaces / utility holders
    'System', 'Database', 'Schema', 'Test', 'Limits', 'Math', 'JSON', 'UserInfo',
    'Trigger', 'ApexPages', 'Messaging', 'EncodingUtil', 'Crypto', 'Url', 'Address',
    // Primitive / value types
    'String', 'Integer', 'Decimal', 'Double', 'Long', 'Boolean', 'Id', 'Blob',
    'Date', 'Datetime', 'Time', 'Object',
    // Collections & SObject
    'List', 'Map', 'Set', 'SObject',
    // Reflection / describe
    'Type', 'SObjectType', 'SObjectField', 'DescribeSObjectResult', 'DescribeFieldResult',
    // HTTP / callouts
    'Http', 'HttpRequest', 'HttpResponse', 'RestRequest', 'RestResponse', 'PageReference',
    // Regex
    'Pattern', 'Matcher',
    // Common exceptions
    'Exception', 'DmlException', 'QueryException', 'NullPointerException',
    'CalloutException', 'AuraHandledException',
    // Async / interfaces
    'Savepoint', 'SavePoint', 'Queueable', 'Batchable', 'Schedulable',
];

/** Static members keyed by namespace/type, surfaced on `<Type>.` completion. */
export const STD_MEMBERS: Record<string, StdMember[]> = {
    System: [
        { name: 'debug', kind: 'method', detail: 'void debug(Object msg)' },
        { name: 'assert', kind: 'method', detail: 'void assert(Boolean condition, Object msg)' },
        { name: 'assertEquals', kind: 'method', detail: 'void assertEquals(Object expected, Object actual)' },
        { name: 'assertNotEquals', kind: 'method', detail: 'void assertNotEquals(Object expected, Object actual)' },
        { name: 'now', kind: 'method', detail: 'Datetime now()' },
        { name: 'today', kind: 'method', detail: 'Date today()' },
        { name: 'currentTimeMillis', kind: 'method', detail: 'Long currentTimeMillis()' },
        { name: 'currentPageReference', kind: 'method', detail: 'PageReference currentPageReference()' },
        { name: 'runAs', kind: 'method', detail: 'void runAs(User userContext)' },
        { name: 'enqueueJob', kind: 'method', detail: 'Id enqueueJob(Object queueable)' },
        { name: 'schedule', kind: 'method', detail: 'String schedule(String name, String cron, Object job)' },
        { name: 'scheduleBatch', kind: 'method', detail: 'String scheduleBatch(Database.Batchable job, String name, Integer min)' },
        { name: 'abortJob', kind: 'method', detail: 'void abortJob(String jobId)' },
        { name: 'isBatch', kind: 'method', detail: 'Boolean isBatch()' },
        { name: 'isFuture', kind: 'method', detail: 'Boolean isFuture()' },
        { name: 'isScheduled', kind: 'method', detail: 'Boolean isScheduled()' },
    ],
    Database: [
        { name: 'query', kind: 'method', detail: 'List<SObject> query(String soql)' },
        { name: 'queryWithBinds', kind: 'method', detail: 'List<SObject> queryWithBinds(String soql, Map<String,Object> binds, AccessLevel level)' },
        { name: 'getQueryLocator', kind: 'method', detail: 'Database.QueryLocator getQueryLocator(String soql)' },
        { name: 'countQuery', kind: 'method', detail: 'Integer countQuery(String soql)' },
        { name: 'insert', kind: 'method', detail: 'Database.SaveResult[] insert(List<SObject> records, Boolean allOrNone)' },
        { name: 'update', kind: 'method', detail: 'Database.SaveResult[] update(List<SObject> records, Boolean allOrNone)' },
        { name: 'upsert', kind: 'method', detail: 'Database.UpsertResult[] upsert(List<SObject> records, SObjectField extId)' },
        { name: 'delete', kind: 'method', detail: 'Database.DeleteResult[] delete(List<SObject> records, Boolean allOrNone)' },
        { name: 'undelete', kind: 'method', detail: 'Database.UndeleteResult[] undelete(List<SObject> records, Boolean allOrNone)' },
        { name: 'executeBatch', kind: 'method', detail: 'Id executeBatch(Database.Batchable job, Integer scopeSize)' },
        { name: 'setSavepoint', kind: 'method', detail: 'Savepoint setSavepoint()' },
        { name: 'rollback', kind: 'method', detail: 'void rollback(Savepoint sp)' },
        { name: 'convertLead', kind: 'method', detail: 'Database.LeadConvertResult[] convertLead(...)' },
    ],
    Schema: [
        { name: 'getGlobalDescribe', kind: 'method', detail: 'Map<String,SObjectType> getGlobalDescribe()' },
        { name: 'describeSObjects', kind: 'method', detail: 'List<DescribeSObjectResult> describeSObjects(List<String> types)' },
        { name: 'getDescribe', kind: 'method', detail: 'DescribeSObjectResult getDescribe()' },
    ],
    Test: [
        { name: 'startTest', kind: 'method', detail: 'void startTest()' },
        { name: 'stopTest', kind: 'method', detail: 'void stopTest()' },
        { name: 'setMock', kind: 'method', detail: 'void setMock(Type interfaceType, Object instance)' },
        { name: 'loadData', kind: 'method', detail: 'List<SObject> loadData(SObjectType sot, String resourceName)' },
        { name: 'isRunningTest', kind: 'method', detail: 'Boolean isRunningTest()' },
        { name: 'getStandardPricebookId', kind: 'method', detail: 'Id getStandardPricebookId()' },
        { name: 'createStub', kind: 'method', detail: 'Object createStub(Type t, StubProvider provider)' },
    ],
    Limits: [
        { name: 'getQueries', kind: 'method', detail: 'Integer getQueries()' },
        { name: 'getLimitQueries', kind: 'method', detail: 'Integer getLimitQueries()' },
        { name: 'getQueryRows', kind: 'method', detail: 'Integer getQueryRows()' },
        { name: 'getLimitQueryRows', kind: 'method', detail: 'Integer getLimitQueryRows()' },
        { name: 'getDmlStatements', kind: 'method', detail: 'Integer getDmlStatements()' },
        { name: 'getLimitDmlStatements', kind: 'method', detail: 'Integer getLimitDmlStatements()' },
        { name: 'getDmlRows', kind: 'method', detail: 'Integer getDmlRows()' },
        { name: 'getCpuTime', kind: 'method', detail: 'Integer getCpuTime()' },
        { name: 'getLimitCpuTime', kind: 'method', detail: 'Integer getLimitCpuTime()' },
        { name: 'getHeapSize', kind: 'method', detail: 'Integer getHeapSize()' },
        { name: 'getCallouts', kind: 'method', detail: 'Integer getCallouts()' },
    ],
    Math: [
        { name: 'abs', kind: 'method', detail: 'Decimal abs(Decimal d)' },
        { name: 'max', kind: 'method', detail: 'Decimal max(Decimal a, Decimal b)' },
        { name: 'min', kind: 'method', detail: 'Decimal min(Decimal a, Decimal b)' },
        { name: 'round', kind: 'method', detail: 'Long round(Decimal d)' },
        { name: 'ceil', kind: 'method', detail: 'Decimal ceil(Decimal d)' },
        { name: 'floor', kind: 'method', detail: 'Decimal floor(Decimal d)' },
        { name: 'pow', kind: 'method', detail: 'Double pow(Double base, Double exp)' },
        { name: 'sqrt', kind: 'method', detail: 'Double sqrt(Double d)' },
        { name: 'mod', kind: 'method', detail: 'Integer mod(Integer a, Integer b)' },
        { name: 'random', kind: 'method', detail: 'Double random()' },
        { name: 'PI', kind: 'field', detail: 'Double PI' },
    ],
    JSON: [
        { name: 'serialize', kind: 'method', detail: 'String serialize(Object o)' },
        { name: 'serializePretty', kind: 'method', detail: 'String serializePretty(Object o)' },
        { name: 'deserialize', kind: 'method', detail: 'Object deserialize(String json, Type apexType)' },
        { name: 'deserializeUntyped', kind: 'method', detail: 'Object deserializeUntyped(String json)' },
        { name: 'deserializeStrict', kind: 'method', detail: 'Object deserializeStrict(String json, Type apexType)' },
        { name: 'createGenerator', kind: 'method', detail: 'JSONGenerator createGenerator(Boolean pretty)' },
    ],
    UserInfo: [
        { name: 'getUserId', kind: 'method', detail: 'Id getUserId()' },
        { name: 'getName', kind: 'method', detail: 'String getName()' },
        { name: 'getUserName', kind: 'method', detail: 'String getUserName()' },
        { name: 'getUserEmail', kind: 'method', detail: 'String getUserEmail()' },
        { name: 'getProfileId', kind: 'method', detail: 'Id getProfileId()' },
        { name: 'getOrganizationId', kind: 'method', detail: 'Id getOrganizationId()' },
        { name: 'getOrganizationName', kind: 'method', detail: 'String getOrganizationName()' },
        { name: 'getSessionId', kind: 'method', detail: 'String getSessionId()' },
        { name: 'getLocale', kind: 'method', detail: 'String getLocale()' },
        { name: 'isMultiCurrencyOrganization', kind: 'method', detail: 'Boolean isMultiCurrencyOrganization()' },
    ],
    String: [
        { name: 'valueOf', kind: 'method', detail: 'String valueOf(Object o)' },
        { name: 'isBlank', kind: 'method', detail: 'Boolean isBlank(String s)' },
        { name: 'isNotBlank', kind: 'method', detail: 'Boolean isNotBlank(String s)' },
        { name: 'isEmpty', kind: 'method', detail: 'Boolean isEmpty(String s)' },
        { name: 'isNotEmpty', kind: 'method', detail: 'Boolean isNotEmpty(String s)' },
        { name: 'join', kind: 'method', detail: 'String join(Iterable<Object> items, String sep)' },
        { name: 'format', kind: 'method', detail: 'String format(String template, List<String> args)' },
        { name: 'escapeSingleQuotes', kind: 'method', detail: 'String escapeSingleQuotes(String s)' },
    ],
    Date: [
        { name: 'today', kind: 'method', detail: 'Date today()' },
        { name: 'newInstance', kind: 'method', detail: 'Date newInstance(Integer y, Integer m, Integer d)' },
        { name: 'valueOf', kind: 'method', detail: 'Date valueOf(Object o)' },
    ],
    Datetime: [
        { name: 'now', kind: 'method', detail: 'Datetime now()' },
        { name: 'newInstance', kind: 'method', detail: 'Datetime newInstance(Long ms)' },
        { name: 'valueOf', kind: 'method', detail: 'Datetime valueOf(Object o)' },
    ],
};

const STD_TYPE_LC = new Map(STD_TYPES.map((t) => [t.toLowerCase(), t]));
const STD_MEMBER_LC = new Map(Object.keys(STD_MEMBERS).map((k) => [k.toLowerCase(), k]));

/** Canonical type name for a (case-insensitive) built-in, or undefined. */
export function stdTypeName(name: string): string | undefined {
    return STD_TYPE_LC.get(name.toLowerCase());
}

/** Static members for a (case-insensitive) built-in namespace/type, or undefined. */
export function stdMembersFor(name: string): StdMember[] | undefined {
    const key = STD_MEMBER_LC.get(name.toLowerCase());
    return key ? STD_MEMBERS[key] : undefined;
}
