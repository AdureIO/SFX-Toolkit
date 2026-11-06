/**
 * Custom request/notification contract with the extension host (see src/languageClient.ts).
 */

// Server → host. Host answers from OrgMetadataCache / SchemaCache for the active org.
export const REQ_OBJECT_LIST = 'sfx/objectList';   // ({ uri }) => string[]
export const REQ_DESCRIBE = 'sfx/describe';        // ({ uri, sobject }) => HostDescribe
export const REQ_DESCRIBE_MANY = 'sfx/describeMany'; // ({ names, uri }) => (HostDescribe | null)[] (same order)
export const REQ_PROJECT_INFO = 'sfx/projectInfo'; // ({ uri }) => { namespace: string | null }
export const REQ_OBJECT_INFO = 'sfx/objectInfo';   // ({ uri, sobject }) => { description: string | null }

// Host → server.
// org/schema changed: { objects?, uris?, structural? } — `objects` = only these objects,
// `uris` = only these documents' org contexts, `structural` = object list changed; none = everything.
export const NOTE_REFRESH = 'sfx/refreshSchema';
export const NOTE_EPHEMERAL = 'sfx/ephemeralBuffers'; // docs that must never write stubs

// Host → server requests (LWC / Aura / Visualforce navigation into Apex; see apexLinks.ts).
export const REQ_APEX_DEFINITION = 'sfx/apexDefinition'; // ({ className, member?, prefer? }) => Location | null
export const REQ_APEX_REFERENCES = 'sfx/apexReferences'; // ({ className, member?, prefer?, includeDeclaration? }) => Location[]
