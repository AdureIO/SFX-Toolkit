/**
 * Custom request/notification contract with the extension host (see src/languageClient.ts).
 */

// Server → host. Host answers from OrgMetadataCache / SchemaCache for the active org.
export const REQ_OBJECT_LIST = 'sfx/objectList';   // ({ uri }) => string[]
export const REQ_DESCRIBE = 'sfx/describe';        // ({ uri, sobject }) => HostDescribe
export const REQ_PROJECT_INFO = 'sfx/projectInfo'; // ({ uri }) => { namespace: string | null }
export const REQ_OBJECT_INFO = 'sfx/objectInfo';   // ({ uri, sobject }) => { description: string | null }

// Host → server.
export const NOTE_REFRESH = 'sfx/refreshSchema';      // org/schema changed ({ objects? } = targeted)
export const NOTE_EPHEMERAL = 'sfx/ephemeralBuffers'; // docs that must never write stubs
