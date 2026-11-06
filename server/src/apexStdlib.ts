/**
 * A curated slice of the Apex standard library for completion. This is not a full
 * model of the System namespace — it's the high-frequency types, namespaces and
 * members that developers reach for constantly (especially in anonymous Apex), so the
 * panel and `.cls` editors offer them even though our JVM-free engine has no semantic
 * type model of Salesforce's built-ins.
 *
 * Every class lists its STATIC members (`String.valueOf`, `System.debug`) and its
 * INSTANCE members (`s.length()`, `accs.size()`) separately. Generic collections name
 * their type parameters (`List<T>`, `Map<K,V>`) so member types can be substituted
 * (`Map<Id, Account>.get(k)` → `Account`).
 */

export interface StdMember {
    name: string;
    kind: 'method' | 'field';
    /** Signature shown in completion detail, e.g. `void debug(Object msg)`. */
    detail: string;
    /** Return / field type as written (may mention the class's type parameters). */
    returns?: string;
    /** Methods: the parameter list, e.g. `Object msg`. */
    params?: string;
    static?: boolean;
}

export interface StdClass {
    /** Canonical name, e.g. `String`, `Database.SaveResult`. */
    name: string;
    typeParams?: string[];
    /** `new X()` is meaningful. */
    constructable?: boolean;
    /** A namespace (System, Database…) rather than a class: never an instance type. */
    namespace?: boolean;
    /** Enum: static members are its values. */
    isEnum?: boolean;
    statics: StdMember[];
    instance: StdMember[];
}

/** Parse `ReturnType name(params)` (method) or `Type name` (field). */
function sig(s: string, isStatic: boolean): StdMember {
    const paren = s.indexOf('(');
    if (paren < 0) {
        const sp = s.lastIndexOf(' ');
        const name = s.slice(sp + 1);
        const returns = s.slice(0, sp).trim();
        const m: StdMember = { name, kind: 'field', detail: s, returns };
        if (isStatic) m.static = true;
        return m;
    }
    const head = s.slice(0, paren).trim();
    const sp = head.lastIndexOf(' ');
    const name = head.slice(sp + 1);
    const returns = sp > 0 ? head.slice(0, sp).trim() : 'void';
    const params = s.slice(paren + 1, s.lastIndexOf(')')).trim();
    const m: StdMember = { name, kind: 'method', detail: s, returns, params };
    if (isStatic) m.static = true;
    return m;
}

interface Def {
    tp?: string[];
    ctor?: boolean;
    ns?: boolean;
    enumValues?: string[];
    s?: string[];
    i?: string[];
}

const OBJECT_METHODS = ['Boolean equals(Object obj)', 'Integer hashCode()', 'String toString()'];
const EXCEPTION_METHODS = [
    'String getMessage()', 'Exception getCause()', 'Integer getLineNumber()', 'String getStackTraceString()',
    'String getTypeName()', 'Exception initCause(Exception cause)', 'void setMessage(String message)',
];
const DML_EXCEPTION_METHODS = [
    ...EXCEPTION_METHODS,
    'String getDmlMessage(Integer index)', 'Integer getNumDml()', 'String[] getDmlFieldNames(Integer index)',
    'Id getDmlId(Integer index)', 'Integer getDmlIndex(Integer index)', 'String getDmlStatusCode(Integer index)',
    'System.StatusCode getDmlType(Integer index)', 'Schema.SObjectField[] getDmlFields(Integer index)',
];

const DEFS: Record<string, Def> = {
    // ── Namespaces / utility holders ──
    System: {
        ns: true,
        s: [
            'void debug(Object msg)', 'void assert(Boolean condition, Object msg)', 'void assertEquals(Object expected, Object actual)',
            'void assertNotEquals(Object expected, Object actual)', 'Datetime now()', 'Date today()', 'Long currentTimeMillis()',
            'PageReference currentPageReference()', 'void runAs(User userContext)', 'Id enqueueJob(Object queueable)',
            'String schedule(String name, String cron, Object job)', 'String scheduleBatch(Database.Batchable job, String name, Integer min)',
            'void abortJob(String jobId)', 'Boolean isBatch()', 'Boolean isFuture()', 'Boolean isScheduled()', 'Boolean isQueueable()',
            'Request getQuiddity()', 'void resetPassword(Id userId, Boolean sendEmail)', 'Boolean equals(Object a, Object b)',
            'String getApplicationReadWriteMode()', 'void purgeOldAsyncJobs(Date dt)',
        ],
    },
    Database: {
        ns: true,
        s: [
            'List<SObject> query(String soql)', 'List<SObject> queryWithBinds(String soql, Map<String,Object> binds, AccessLevel level)',
            'Database.QueryLocator getQueryLocator(String soql)', 'Integer countQuery(String soql)',
            'Database.SaveResult[] insert(List<SObject> records, Boolean allOrNone)', 'Database.SaveResult[] update(List<SObject> records, Boolean allOrNone)',
            'Database.UpsertResult[] upsert(List<SObject> records, SObjectField extId)', 'Database.DeleteResult[] delete(List<SObject> records, Boolean allOrNone)',
            'Database.UndeleteResult[] undelete(List<SObject> records, Boolean allOrNone)', 'Id executeBatch(Database.Batchable job, Integer scopeSize)',
            'Savepoint setSavepoint()', 'void rollback(Savepoint sp)', 'Database.LeadConvertResult[] convertLead(List<Database.LeadConvert> leads)',
            'Database.QueryLocatorIterator getQueryLocatorIterator(String soql)', 'void releaseSavepoint(Savepoint sp)',
            'Database.EmptyRecycleBinResult[] emptyRecycleBin(List<SObject> records)', 'Database.MergeResult merge(SObject master, SObject duplicate)',
        ],
    },
    Schema: {
        ns: true,
        s: [
            'Map<String,Schema.SObjectType> getGlobalDescribe()', 'List<Schema.DescribeSObjectResult> describeSObjects(List<String> types)',
            'List<Schema.DescribeTabSetResult> describeTabs()', 'List<Schema.DescribeDataCategoryGroupResult> describeDataCategoryGroups(List<String> sobjects)',
        ],
    },
    Test: {
        ns: true,
        s: [
            'void startTest()', 'void stopTest()', 'void setMock(Type interfaceType, Object instance)',
            'List<SObject> loadData(Schema.SObjectType sot, String resourceName)', 'Boolean isRunningTest()', 'Id getStandardPricebookId()',
            'Object createStub(Type t, StubProvider provider)', 'void setFixedSearchResults(Id[] ids)', 'void setCurrentPage(PageReference page)',
            'void setCreatedDate(Id recordId, Datetime createdDate)', 'void enableChangeDataCapture()', 'void getEventBus()',
        ],
    },
    Assert: {
        ns: true,
        s: [
            'void areEqual(Object expected, Object actual, String msg)', 'void areNotEqual(Object notExpected, Object actual, String msg)',
            'void isTrue(Boolean condition, String msg)', 'void isFalse(Boolean condition, String msg)', 'void isNull(Object value, String msg)',
            'void isNotNull(Object value, String msg)', 'void fail(String msg)', 'void isInstanceOfType(Object instance, Type expectedType, String msg)',
            'void isNotInstanceOfType(Object instance, Type notExpectedType, String msg)',
        ],
    },
    Limits: {
        ns: true,
        s: [
            'Integer getQueries()', 'Integer getLimitQueries()', 'Integer getQueryRows()', 'Integer getLimitQueryRows()',
            'Integer getDmlStatements()', 'Integer getLimitDmlStatements()', 'Integer getDmlRows()', 'Integer getLimitDmlRows()',
            'Integer getCpuTime()', 'Integer getLimitCpuTime()', 'Integer getHeapSize()', 'Integer getLimitHeapSize()',
            'Integer getCallouts()', 'Integer getLimitCallouts()', 'Integer getFutureCalls()', 'Integer getLimitFutureCalls()',
            'Integer getQueueableJobs()', 'Integer getLimitQueueableJobs()',
        ],
    },
    Math: {
        ns: true,
        s: [
            'Decimal abs(Decimal d)', 'Decimal max(Decimal a, Decimal b)', 'Decimal min(Decimal a, Decimal b)', 'Long round(Decimal d)',
            'Decimal ceil(Decimal d)', 'Decimal floor(Decimal d)', 'Double pow(Double base, Double exp)', 'Double sqrt(Double d)',
            'Integer mod(Integer a, Integer b)', 'Double random()', 'Double exp(Double d)', 'Double log(Double d)', 'Double log10(Double d)',
            'Double sin(Double d)', 'Double cos(Double d)', 'Double tan(Double d)', 'Decimal signum(Decimal d)', 'Double PI', 'Double E',
        ],
    },
    JSON: {
        ns: true,
        s: [
            'String serialize(Object o)', 'String serializePretty(Object o)', 'Object deserialize(String json, Type apexType)',
            'Object deserializeUntyped(String json)', 'Object deserializeStrict(String json, Type apexType)',
            'JSONGenerator createGenerator(Boolean pretty)', 'JSONParser createParser(String json)',
        ],
    },
    UserInfo: {
        ns: true,
        s: [
            'Id getUserId()', 'String getName()', 'String getUserName()', 'String getUserEmail()', 'String getFirstName()', 'String getLastName()',
            'Id getProfileId()', 'Id getUserRoleId()', 'Id getOrganizationId()', 'String getOrganizationName()', 'String getSessionId()',
            'String getLocale()', 'String getLanguage()', 'TimeZone getTimeZone()', 'String getUserType()', 'String getDefaultCurrency()',
            'Boolean isMultiCurrencyOrganization()', 'Boolean isCurrentUserLicensed(String namespace)',
        ],
    },
    EncodingUtil: {
        ns: true,
        s: [
            'String base64Encode(Blob b)', 'Blob base64Decode(String s)', 'String urlEncode(String s, String encoding)',
            'String urlDecode(String s, String encoding)', 'String convertToHex(Blob b)', 'Blob convertFromHex(String s)',
        ],
    },
    Crypto: {
        ns: true,
        s: [
            'Blob generateDigest(String algorithm, Blob input)', 'Blob generateMac(String algorithm, Blob input, Blob key)',
            'Integer getRandomInteger()', 'Long getRandomLong()', 'Blob generateAesKey(Integer size)',
            'Blob encryptWithManagedIV(String algorithm, Blob key, Blob data)', 'Blob decryptWithManagedIV(String algorithm, Blob key, Blob data)',
            'Blob sign(String algorithm, Blob input, Blob privateKey)',
        ],
    },
    Messaging: {
        ns: true,
        s: [
            'Messaging.SendEmailResult[] sendEmail(Messaging.Email[] emails, Boolean allOrNone)', 'void reserveSingleEmailCapacity(Integer count)',
            'Messaging.RenderEmailTemplateResult[] renderEmailTemplate(Id whoId, Id whatId, List<String> bodies)',
        ],
    },
    ApexPages: { ns: true, s: ['ApexPages.Message[] getMessages()', 'void addMessage(ApexPages.Message msg)', 'Boolean hasMessages()', 'ApexPages.CurrentPage currentPage()'] },
    Trigger: { ns: true },
    RestContext: { ns: true, s: ['RestRequest request', 'RestResponse response'] },
    Url: {
        ctor: true,
        s: ['Url getOrgDomainUrl()', 'Url getCurrentRequestUrl()', 'String getSalesforceBaseUrl()'],
        i: ['String toExternalForm()', 'String getHost()', 'String getPath()', 'String getProtocol()', 'String getQuery()', 'Integer getPort()'],
    },
    Address: { i: ['String getCity()', 'String getCountry()', 'String getPostalCode()', 'String getState()', 'String getStreet()', 'Double getLatitude()', 'Double getLongitude()'] },

    // ── Primitive / value types ──
    String: {
        s: [
            'String valueOf(Object o)', 'Boolean isBlank(String s)', 'Boolean isNotBlank(String s)', 'Boolean isEmpty(String s)',
            'Boolean isNotEmpty(String s)', 'String join(Iterable<Object> items, String sep)', 'String format(String template, List<Object> args)',
            'String escapeSingleQuotes(String s)', 'String fromCharArray(List<Integer> chars)', 'String valueOfGmt(Datetime dt)',
            'String getCommonPrefix(List<String> strings)',
        ],
        i: [
            'String abbreviate(Integer maxWidth)', 'String capitalize()', 'String center(Integer size)', 'Integer charAt(Integer index)',
            'Integer compareTo(String other)', 'Boolean contains(String s)', 'Boolean containsIgnoreCase(String s)', 'Boolean containsAny(String chars)',
            'Boolean containsNone(String chars)', 'Boolean containsOnly(String chars)', 'Boolean containsWhitespace()', 'Integer countMatches(String sub)',
            'String deleteWhitespace()', 'String difference(String other)', 'Boolean endsWith(String suffix)', 'Boolean endsWithIgnoreCase(String suffix)',
            'Boolean equals(Object other)', 'Boolean equalsIgnoreCase(String other)', 'String escapeCsv()', 'String escapeEcmaScript()',
            'String escapeHtml4()', 'String escapeJava()', 'String escapeUnicode()', 'String escapeXml()', 'List<Integer> getChars()',
            'Integer hashCode()', 'Integer indexOf(String sub)', 'Integer indexOfIgnoreCase(String sub)', 'Integer indexOfAny(String chars)',
            'Boolean isAllLowerCase()', 'Boolean isAllUpperCase()', 'Boolean isAlpha()', 'Boolean isAlphaSpace()', 'Boolean isAlphanumeric()',
            'Boolean isAlphanumericSpace()', 'Boolean isAsciiPrintable()', 'Boolean isNumeric()', 'Boolean isNumericSpace()', 'Boolean isWhitespace()',
            'Integer lastIndexOf(String sub)', 'Integer lastIndexOfIgnoreCase(String sub)', 'String left(Integer length)', 'String leftPad(Integer length, String padStr)',
            'Integer length()', 'String mid(Integer start, Integer length)', 'String normalizeSpace()', 'String remove(String sub)',
            'String removeEnd(String suffix)', 'String removeEndIgnoreCase(String suffix)', 'String removeStart(String prefix)', 'String removeStartIgnoreCase(String prefix)',
            'String repeat(Integer times)', 'String replace(String target, String replacement)', 'String replaceAll(String regex, String replacement)',
            'String replaceFirst(String regex, String replacement)', 'String reverse()', 'String right(Integer length)', 'String rightPad(Integer length, String padStr)',
            'List<String> split(String regex)', 'List<String> splitByCharacterType()', 'Boolean startsWith(String prefix)', 'Boolean startsWithIgnoreCase(String prefix)',
            'String stripHtmlTags()', 'String substring(Integer start, Integer endIndex)', 'String substringAfter(String sep)', 'String substringAfterLast(String sep)',
            'String substringBefore(String sep)', 'String substringBeforeLast(String sep)', 'String substringBetween(String open, String close)', 'String swapCase()',
            'String toLowerCase()', 'String toUpperCase()', 'String trim()', 'String uncapitalize()', 'String unescapeCsv()', 'String unescapeHtml4()',
            'String unescapeJava()', 'String unescapeXml()', 'String toString()',
        ],
    },
    Integer: { s: ['Integer valueOf(Object o)'], i: ['String format()', 'Integer intValue()', 'Long longValue()', 'Decimal doubleValue()', ...OBJECT_METHODS] },
    Long: { s: ['Long valueOf(Object o)'], i: ['String format()', 'Integer intValue()', 'Long longValue()', ...OBJECT_METHODS] },
    Double: { s: ['Double valueOf(Object o)'], i: ['String format()', 'Integer intValue()', 'Long longValue()', 'Long round()', ...OBJECT_METHODS] },
    Decimal: {
        s: ['Decimal valueOf(Object o)'],
        i: [
            'Decimal abs()', 'Decimal divide(Decimal divisor, Integer scale)', 'Double doubleValue()', 'String format()', 'Integer intValue()',
            'Long longValue()', 'Decimal pow(Integer exponent)', 'Integer precision()', 'Long round()', 'Integer scale()',
            'Decimal setScale(Integer scale)', 'Decimal stripTrailingZeros()', 'String toPlainString()', ...OBJECT_METHODS,
        ],
    },
    Boolean: { s: ['Boolean valueOf(Object o)'], i: [...OBJECT_METHODS] },
    Id: {
        s: ['Id valueOf(String s)'],
        i: ['Schema.SObjectType getSObjectType()', 'String to15()', 'void addError(String msg)', ...OBJECT_METHODS],
    },
    Blob: { s: ['Blob valueOf(String s)', 'Blob toPdf(String s)'], i: ['Integer size()', 'String toString()'] },
    Date: {
        s: [
            'Date today()', 'Date newInstance(Integer year, Integer month, Integer day)', 'Date valueOf(Object o)', 'Date parse(String s)',
            'Integer daysInMonth(Integer year, Integer month)', 'Boolean isLeapYear(Integer year)',
        ],
        i: [
            'Date addDays(Integer days)', 'Date addMonths(Integer months)', 'Date addYears(Integer years)', 'Integer day()', 'Integer dayOfYear()',
            'Integer daysBetween(Date other)', 'String format()', 'Boolean isSameDay(Date other)', 'Integer month()', 'Integer monthsBetween(Date other)',
            'Date toStartOfMonth()', 'Date toStartOfWeek()', 'Integer year()', ...OBJECT_METHODS,
        ],
    },
    Datetime: {
        s: [
            'Datetime now()', 'Datetime newInstance(Long ms)', 'Datetime newInstanceGmt(Integer year, Integer month, Integer day)',
            'Datetime valueOf(Object o)', 'Datetime valueOfGmt(String s)', 'Datetime parse(String s)',
        ],
        i: [
            'Datetime addDays(Integer days)', 'Datetime addHours(Integer hours)', 'Datetime addMinutes(Integer minutes)', 'Datetime addMonths(Integer months)',
            'Datetime addSeconds(Integer seconds)', 'Datetime addYears(Integer years)', 'Date date()', 'Date dateGmt()', 'Integer day()', 'Integer dayGmt()',
            'Integer dayOfYear()', 'String format(String pattern)', 'String formatGmt(String pattern)', 'String formatLong()', 'Long getTime()',
            'Integer hour()', 'Integer hourGmt()', 'Boolean isSameDay(Datetime other)', 'Integer millisecond()', 'Integer minute()', 'Integer month()',
            'Integer second()', 'Time time()', 'Time timeGmt()', 'Integer year()', 'Integer yearGmt()', ...OBJECT_METHODS,
        ],
    },
    Time: {
        s: ['Time newInstance(Integer hour, Integer minutes, Integer seconds, Integer ms)'],
        i: [
            'Time addHours(Integer hours)', 'Time addMilliseconds(Integer ms)', 'Time addMinutes(Integer minutes)', 'Time addSeconds(Integer seconds)',
            'Integer hour()', 'Integer millisecond()', 'Integer minute()', 'Integer second()', ...OBJECT_METHODS,
        ],
    },
    Object: { i: [...OBJECT_METHODS] },

    // ── Collections & SObject ──
    List: {
        tp: ['T'],
        ctor: true,
        i: [
            'void add(T element)', 'void addAll(List<T> elements)', 'void clear()', 'List<T> clone()', 'Boolean contains(T element)',
            'List<T> deepClone(Boolean preserveId)', 'Boolean equals(Object other)', 'T get(Integer index)', 'Schema.SObjectType getSObjectType()',
            'Integer hashCode()', 'Integer indexOf(T element)', 'Boolean isEmpty()', 'Iterator<T> iterator()', 'T remove(Integer index)',
            'void set(Integer index, T element)', 'Integer size()', 'void sort()', 'String toString()',
        ],
    },
    Set: {
        tp: ['T'],
        ctor: true,
        i: [
            'Boolean add(T element)', 'Boolean addAll(Set<T> elements)', 'void clear()', 'Set<T> clone()', 'Boolean contains(T element)',
            'Boolean containsAll(Set<T> elements)', 'Boolean equals(Object other)', 'Integer hashCode()', 'Boolean isEmpty()', 'Iterator<T> iterator()',
            'Boolean remove(T element)', 'Boolean removeAll(Set<T> elements)', 'Boolean retainAll(Set<T> elements)', 'Integer size()', 'String toString()',
        ],
    },
    Map: {
        tp: ['K', 'V'],
        ctor: true,
        i: [
            'void clear()', 'Map<K,V> clone()', 'Boolean containsKey(K key)', 'Map<K,V> deepClone()', 'Boolean equals(Object other)', 'V get(K key)',
            'Schema.SObjectType getSObjectType()', 'Integer hashCode()', 'Boolean isEmpty()', 'Set<K> keySet()', 'V put(K key, V value)',
            'void putAll(Map<K,V> other)', 'V remove(K key)', 'Integer size()', 'String toString()', 'List<V> values()',
        ],
    },
    Iterator: { tp: ['T'], i: ['Boolean hasNext()', 'T next()'] },
    SObject: {
        i: [
            'void addError(String msg)', 'void clear()', 'SObject clone(Boolean preserveId, Boolean isDeepClone)', 'Object get(String fieldName)',
            'Id getCloneSourceId()', 'List<Database.Error> getErrors()', 'Map<String,Object> getPopulatedFieldsAsMap()', 'SObject getSObject(String relationshipName)',
            'Schema.SObjectType getSObjectType()', 'List<SObject> getSObjects(String relationshipName)', 'Boolean hasErrors()', 'Boolean isClone()',
            'Boolean isSet(String fieldName)', 'Object put(String fieldName, Object value)', 'SObject putSObject(String relationshipName, SObject value)',
            'void recalculateFormulas()', 'void setOptions(Database.DMLOptions options)', 'Database.DMLOptions getOptions()', 'String getQuickActionName()',
        ],
    },

    // ── Reflection / describe ──
    Type: {
        s: ['Type forName(String fullyQualifiedName)', 'Type forName(String namespace, String name)'],
        i: ['String getName()', 'Object newInstance()', 'Boolean isAssignableFrom(Type source)', ...OBJECT_METHODS],
    },
    'Schema.SObjectType': {
        i: ['Schema.DescribeSObjectResult getDescribe()', 'SObject newSObject()', 'SObject newSObject(Id recordTypeId, Boolean loadDefaults)', ...OBJECT_METHODS],
    },
    'Schema.SObjectField': { i: ['Schema.DescribeFieldResult getDescribe()', ...OBJECT_METHODS] },
    'Schema.DescribeSObjectResult': {
        i: [
            'Schema.FieldSet fieldSets', 'String getName()', 'String getLabel()', 'String getLabelPlural()', 'String getKeyPrefix()',
            'String getLocalName()', 'Boolean isAccessible()', 'Boolean isCreateable()', 'Boolean isUpdateable()', 'Boolean isDeletable()',
            'Boolean isQueryable()', 'Boolean isSearchable()', 'Boolean isCustom()', 'Boolean isCustomSetting()', 'Schema.SObjectType getSObjectType()',
            'List<Schema.ChildRelationship> getChildRelationships()', 'List<Schema.RecordTypeInfo> getRecordTypeInfos()',
            'Map<String,Schema.RecordTypeInfo> getRecordTypeInfosByDeveloperName()', 'Map<Id,Schema.RecordTypeInfo> getRecordTypeInfosById()',
        ],
    },
    'Schema.DescribeFieldResult': {
        i: [
            'String getName()', 'String getLabel()', 'Schema.DisplayType getType()', 'Integer getLength()', 'Boolean isAccessible()',
            'Boolean isCreateable()', 'Boolean isUpdateable()', 'Boolean isNillable()', 'Boolean isCustom()', 'Boolean isUnique()',
            'List<Schema.PicklistEntry> getPicklistValues()', 'List<Schema.SObjectType> getReferenceTo()', 'Object getDefaultValue()',
            'String getInlineHelpText()', 'Schema.SObjectField getSObjectField()', 'String getRelationshipName()', 'Integer getPrecision()', 'Integer getScale()',
        ],
    },
    'Schema.PicklistEntry': { i: ['String getLabel()', 'String getValue()', 'Boolean isActive()', 'Boolean isDefaultValue()'] },
    'Schema.RecordTypeInfo': { i: ['Id getRecordTypeId()', 'String getName()', 'String getDeveloperName()', 'Boolean isActive()', 'Boolean isAvailable()', 'Boolean isDefaultRecordTypeMapping()', 'Boolean isMaster()'] },
    'Schema.ChildRelationship': { i: ['Schema.SObjectType getChildSObject()', 'Schema.SObjectField getField()', 'String getRelationshipName()', 'Boolean isCascadeDelete()'] },

    // ── HTTP / callouts ──
    Http: { ctor: true, i: ['HttpResponse send(HttpRequest request)'] },
    HttpRequest: {
        ctor: true,
        i: [
            'void setEndpoint(String endpoint)', 'void setMethod(String method)', 'void setHeader(String key, String value)', 'void setBody(String body)',
            'void setBodyAsBlob(Blob body)', 'void setTimeout(Integer timeout)', 'void setCompressed(Boolean flag)', 'void setClientCertificateName(String name)',
            'String getEndpoint()', 'String getMethod()', 'String getHeader(String key)', 'String getBody()', 'Blob getBodyAsBlob()', 'Boolean getCompressed()',
            'String toString()',
        ],
    },
    HttpResponse: {
        ctor: true,
        i: [
            'String getBody()', 'Blob getBodyAsBlob()', 'Integer getStatusCode()', 'String getStatus()', 'String getHeader(String key)',
            'String[] getHeaderKeys()', 'void setBody(String body)', 'void setBodyAsBlob(Blob body)', 'void setStatusCode(Integer code)',
            'void setStatus(String status)', 'void setHeader(String key, String value)', 'String toString()',
        ],
    },
    RestRequest: {
        ctor: true,
        i: ['String requestURI', 'String httpMethod', 'Map<String,String> params', 'Blob requestBody', 'Map<String,String> headers', 'String remoteAddress', 'String resourcePath', 'void addHeader(String name, String value)', 'void addParameter(String name, String value)'],
    },
    RestResponse: { ctor: true, i: ['Blob responseBody', 'Integer statusCode', 'Map<String,String> headers', 'void addHeader(String name, String value)'] },
    PageReference: {
        ctor: true,
        i: ['String getUrl()', 'Map<String,String> getParameters()', 'Map<String,String> getHeaders()', 'Boolean getRedirect()', 'PageReference setRedirect(Boolean redirect)', 'Blob getContent()', 'Blob getContentAsPDF()', 'String getAnchor()'],
    },

    // ── Regex ──
    Pattern: {
        s: ['Pattern compile(String regex)', 'Boolean matches(String regex, String input)', 'String quote(String s)'],
        i: ['Matcher matcher(String input)', 'String pattern()', 'List<String> split(String input)'],
    },
    Matcher: {
        i: [
            'Boolean matches()', 'Boolean find()', 'String group()', 'String group(Integer groupIndex)', 'Integer groupCount()', 'Integer start()',
            'Integer end()', 'String replaceAll(String replacement)', 'String replaceFirst(String replacement)', 'Boolean hitEnd()', 'Matcher reset()',
            'Boolean lookingAt()', 'Pattern pattern()',
        ],
    },

    // ── Database results ──
    'Database.SaveResult': { i: ['Id getId()', 'Boolean isSuccess()', 'List<Database.Error> getErrors()'] },
    'Database.UpsertResult': { i: ['Id getId()', 'Boolean isSuccess()', 'Boolean isCreated()', 'List<Database.Error> getErrors()'] },
    'Database.DeleteResult': { i: ['Id getId()', 'Boolean isSuccess()', 'List<Database.Error> getErrors()'] },
    'Database.UndeleteResult': { i: ['Id getId()', 'Boolean isSuccess()', 'List<Database.Error> getErrors()'] },
    'Database.Error': { i: ['String getMessage()', 'System.StatusCode getStatusCode()', 'List<String> getFields()'] },
    'Database.QueryLocator': { i: ['String getQuery()', 'Database.QueryLocatorIterator iterator()'] },
    'Database.BatchableContext': { i: ['Id getJobId()', 'Id getChildJobId()'] },
    'Database.Batchable': { tp: ['T'] },
    'Database.Stateful': {},
    'Database.AllowsCallouts': {},
    'Database.DMLOptions': { ctor: true, i: ['Boolean optAllOrNone', 'Database.DMLOptions.AssignmentRuleHeader assignmentRuleHeader', 'Database.DMLOptions.DuplicateRuleHeader duplicateRuleHeader'] },
    Savepoint: {},
    SavePoint: {},
    QueueableContext: { i: ['Id getJobId()'] },
    SchedulableContext: { i: ['Id getTriggerId()'] },
    Queueable: {},
    Schedulable: {},
    Batchable: {},

    // ── Common exceptions ──
    Exception: { ctor: true, i: EXCEPTION_METHODS },
    DmlException: { ctor: true, i: DML_EXCEPTION_METHODS },
    QueryException: { ctor: true, i: EXCEPTION_METHODS },
    NullPointerException: { ctor: true, i: EXCEPTION_METHODS },
    CalloutException: { ctor: true, i: EXCEPTION_METHODS },
    AuraHandledException: { ctor: true, i: EXCEPTION_METHODS },
    ListException: { ctor: true, i: EXCEPTION_METHODS },
    SObjectException: { ctor: true, i: EXCEPTION_METHODS },
    StringException: { ctor: true, i: EXCEPTION_METHODS },
    TypeException: { ctor: true, i: EXCEPTION_METHODS },
    MathException: { ctor: true, i: EXCEPTION_METHODS },
    JSONException: { ctor: true, i: EXCEPTION_METHODS },
    NoAccessException: { ctor: true, i: EXCEPTION_METHODS },
    LimitException: { i: EXCEPTION_METHODS },
    IllegalArgumentException: { ctor: true, i: EXCEPTION_METHODS },

    // ── Enums ──
    LoggingLevel: { enumValues: ['NONE', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'FINE', 'FINER', 'FINEST'] },
    TriggerOperation: { enumValues: ['BEFORE_INSERT', 'BEFORE_UPDATE', 'BEFORE_DELETE', 'AFTER_INSERT', 'AFTER_UPDATE', 'AFTER_DELETE', 'AFTER_UNDELETE'] },
    AccessLevel: { enumValues: ['USER_MODE', 'SYSTEM_MODE'] },
    'Schema.DisplayType': {
        enumValues: ['ADDRESS', 'ANYTYPE', 'BASE64', 'BOOLEAN', 'COMBOBOX', 'CURRENCY', 'DATACATEGORYGROUPREFERENCE', 'DATE', 'DATETIME', 'DOUBLE', 'EMAIL', 'ENCRYPTEDSTRING', 'ID', 'INTEGER', 'LONG', 'MULTIPICKLIST', 'PERCENT', 'PHONE', 'PICKLIST', 'REFERENCE', 'STRING', 'TEXTAREA', 'TIME', 'URL'],
    },
    'System.StatusCode': { enumValues: ['REQUIRED_FIELD_MISSING', 'DUPLICATE_VALUE', 'FIELD_CUSTOM_VALIDATION_EXCEPTION', 'INVALID_CROSS_REFERENCE_KEY', 'UNABLE_TO_LOCK_ROW', 'ENTITY_IS_DELETED'] },
};

const ENUM_INSTANCE = ['String name()', 'Integer ordinal()', 'Boolean equals(Object other)', 'Integer hashCode()'];

function build(name: string, d: Def): StdClass {
    const statics = (d.s ?? []).map((x) => sig(x, true));
    if (d.enumValues) {
        for (const v of d.enumValues) statics.push({ name: v, kind: 'field', detail: `${name} ${v}`, returns: name, static: true });
        statics.push(sig(`List<${name}> values()`, true), sig(`${name} valueOf(String name)`, true));
    }
    const cls: StdClass = {
        name,
        statics,
        instance: (d.enumValues ? ENUM_INSTANCE : d.i ?? []).map((x) => sig(x, false)),
    };
    if (d.tp) cls.typeParams = d.tp;
    if (d.ctor) cls.constructable = true;
    if (d.ns) cls.namespace = true;
    if (d.enumValues) cls.isEnum = true;
    return cls;
}

const CLASSES = new Map<string, StdClass>();
for (const [name, d] of Object.entries(DEFS)) CLASSES.set(name.toLowerCase(), build(name, d));

/** Instance methods every enum value has (`st.name()`, `st.ordinal()`…). */
export const ENUM_INSTANCE_MEMBERS: StdMember[] = ENUM_INSTANCE.map((x) => sig(x, false));
/** Static methods every enum type has (`Status.values()`, `Status.valueOf('A')`). */
export function enumStaticMethods(enumName: string): StdMember[] {
    return [sig(`List<${enumName}> values()`, true), sig(`${enumName} valueOf(String name)`, true)];
}

/** The standard class for a (case-insensitive, optionally `System.`/`Schema.`-qualified) name. */
export function stdClass(name: string): StdClass | undefined {
    const lc = name.replace(/\s+/g, '').toLowerCase();
    const hit = CLASSES.get(lc);
    if (hit) return hit;
    if (lc.startsWith('system.')) return CLASSES.get(lc.slice(7));
    if (lc.startsWith('schema.')) return CLASSES.get(lc.slice(7));
    // `SObjectType` / `DescribeSObjectResult` written without the Schema prefix.
    return CLASSES.get('schema.' + lc);
}

/**
 * Top-level built-in types and namespaces offered as bare identifiers. Mix of
 * namespaces (System, Database…), value types (Integer, String…) and common
 * classes (Http, Pattern…). `List`/`Map`/`Set`/`SObject` are intentionally here
 * too so `new List<…>()` etc. complete.
 */
export const STD_TYPES: string[] = [
    // Namespaces / utility holders
    'System', 'Database', 'Schema', 'Test', 'Assert', 'Limits', 'Math', 'JSON', 'UserInfo',
    'Trigger', 'ApexPages', 'Messaging', 'EncodingUtil', 'Crypto', 'Url', 'Address', 'RestContext',
    // Primitive / value types
    'String', 'Integer', 'Decimal', 'Double', 'Long', 'Boolean', 'Id', 'Blob',
    'Date', 'Datetime', 'Time', 'Object',
    // Collections & SObject
    'List', 'Map', 'Set', 'SObject', 'Iterator',
    // Reflection / describe
    'Type', 'SObjectType', 'SObjectField', 'DescribeSObjectResult', 'DescribeFieldResult',
    // HTTP / callouts
    'Http', 'HttpRequest', 'HttpResponse', 'RestRequest', 'RestResponse', 'PageReference',
    // Regex
    'Pattern', 'Matcher',
    // Common exceptions
    'Exception', 'DmlException', 'QueryException', 'NullPointerException',
    'CalloutException', 'AuraHandledException', 'IllegalArgumentException',
    // Async / interfaces
    'Savepoint', 'SavePoint', 'Queueable', 'Batchable', 'Schedulable', 'QueueableContext', 'SchedulableContext',
    // Enums
    'LoggingLevel', 'TriggerOperation', 'AccessLevel',
];

/** Static members keyed by namespace/type, surfaced on `<Type>.` completion (kept for existing callers). */
export const STD_MEMBERS: Record<string, StdMember[]> = Object.fromEntries(
    [...CLASSES.values()].filter((c) => c.statics.length && !c.name.includes('.')).map((c) => [c.name, c.statics]),
);

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

/** Nested standard types of a namespace (`Database.` → SaveResult, QueryLocator, …). */
export function stdNestedTypes(namespace: string): StdClass[] {
    const prefix = namespace.toLowerCase() + '.';
    return [...CLASSES.values()].filter((c) => c.name.toLowerCase().startsWith(prefix));
}

/** Standard types `new X()` makes sense for (List/Set/Map, HttpRequest, exceptions…). */
export function stdConstructableTypes(): string[] {
    return [...CLASSES.values()].filter((c) => c.constructable).map((c) => c.name);
}

/** Apex primitives / value types: never SObjects, never `new`-able. */
export const APEX_PRIMITIVES = new Set([
    'string', 'integer', 'long', 'decimal', 'double', 'boolean', 'id', 'blob', 'date', 'datetime', 'time', 'object', 'void',
]);
