/**
 * Apex Data Factory generator.
 * Converts query results + describe metadata into a deployable Apex class
 * that can seed data in scratch orgs / sandboxes.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FieldTypeDef {
  name: string;
  type: string;
  label: string;
  createable: boolean;
  updateable: boolean;
  referenceTo: string[];
  relationshipName: string | null;
  externalId: boolean;
  unique: boolean;
  length?: number;
}

/** A reference field override: resolve AccountId via Account.External_Id__c using a column from the record. */
export interface RefMapping {
  lookupField: string;    // e.g. "AccountId"
  refSObject: string;     // e.g. "Account"
  extIdField: string;     // e.g. "External_Id__c"
  valueColumn: string;    // column in the record that holds the ext ID value, e.g. "Account_ExtId__c"
}

export interface ApexFactoryOptions {
  className: string;
  sobject: string;
  externalIdField: string | null;   // generates upsert method if set
  skipEmptyFields: boolean;
  generateInsert: boolean;
  generateUpsert: boolean;
  refMappings: RefMapping[];
  /** Full field describe map (name → FieldTypeDef). Pass empty for type-inference-only mode. */
  fieldTypes: Record<string, FieldTypeDef>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SKIP_TYPES = new Set([
  "id", "base64", "encryptedstring", "anytype", "location",
  "address", "complexvalue"
]);

const NUMERIC_TYPES = new Set([
  "int", "integer", "double", "long", "currency", "percent"
]);

const BOOL_TYPES = new Set(["boolean"]);
const DATE_TYPES = new Set(["date"]);
const DATETIME_TYPES = new Set(["datetime", "datetimelocal"]);
const TIME_TYPES = new Set(["time"]);
const REF_TYPES = new Set(["reference"]);

/** System / non-createable fields that are always skipped regardless of describe. */
const ALWAYS_SKIP = new Set([
  "Id", "CreatedDate", "CreatedById", "LastModifiedDate", "LastModifiedById",
  "SystemModstamp", "LastActivityDate", "LastViewedDate", "LastReferencedDate",
  "IsDeleted", "MasterRecordId", "CleanStatus", "JigsawCompanyId",
  "DandbCompanyId", "IndividualId", "PhotoUrl", "Jigsaw",
  // Standard audit / owner defaults that break on insert in scratch orgs
  "OwnerId",   // caller's user — let trigger/default handle it
]);

// ─── Apex escaping and literals ───────────────────────────────────────────────

function escapeApexString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

/**
 * Infer the Salesforce field type from the raw string value when describe is unavailable.
 * Returns a best-guess type string.
 */
function inferType(value: string): string {
  if (value === "true" || value === "false") return "boolean";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return "datetime";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
  if (/^\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/.test(value)) return "time";
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return value.includes(".") ? "double" : "integer";
  }
  // Looks like a Salesforce ID (15 or 18 alphanum starting with 3-char key prefix)
  if (/^[a-zA-Z0-9]{15}$|^[a-zA-Z0-9]{18}$/.test(value)) return "id";
  return "string";
}

/**
 * Produce an Apex literal for a scalar value given a field type.
 * Returns null if the field/value should be omitted.
 */
function apexLiteral(
  fieldName: string,
  value: string,
  fieldDef: FieldTypeDef | undefined,
  options: ApexFactoryOptions
): string | null {
  // Always-skip fields
  if (ALWAYS_SKIP.has(fieldName)) return null;

  const rawType = (fieldDef?.type ?? inferType(value)).toLowerCase();

  // Non-createable (from describe)
  if (fieldDef && !fieldDef.createable && !fieldDef.updateable) return null;

  // Structural skips
  if (SKIP_TYPES.has(rawType)) return null;

  // Reference fields — handled separately via refMappings
  if (REF_TYPES.has(rawType)) return null;

  // Null / empty
  const isEmpty = value === null || value === undefined || value === "";
  if (isEmpty) {
    return options.skipEmptyFields ? null : "null";
  }

  if (BOOL_TYPES.has(rawType)) {
    return value.toLowerCase() === "true" ? "true" : "false";
  }

  if (NUMERIC_TYPES.has(rawType)) {
    const n = Number(value);
    if (isNaN(n)) return null;
    // Keep decimals for currency/double/percent, strip for int
    if (rawType === "integer" || rawType === "int" || rawType === "long") {
      return String(Math.trunc(n));
    }
    return String(n);
  }

  if (DATE_TYPES.has(rawType)) {
    const iso = value.substring(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return `'${escapeApexString(value)}'`;
    return `Date.valueOf('${iso}')`;
  }

  if (DATETIME_TYPES.has(rawType)) {
    // Normalize: "2024-01-15T10:30:00.000Z" → "2024-01-15 10:30:00"
    const normalized = value
      .replace("T", " ")
      .replace(/\.\d+Z?$/, "")
      .replace("Z", "")
      .substring(0, 19);
    return `DateTime.valueOf('${normalized}')`;
  }

  if (TIME_TYPES.has(rawType)) {
    // "10:30:00.000Z" → Time.newInstance(10, 30, 0, 0)
    const parts = value.replace("Z", "").split(/[:.]/).map(Number);
    const h = parts[0] ?? 0, m = parts[1] ?? 0, s = parts[2] ?? 0, ms = parts[3] ?? 0;
    return `Time.newInstance(${h}, ${m}, ${s}, ${ms})`;
  }

  // String-like: email, phone, url, textarea, picklist, combobox, multipicklist, string
  const escaped = escapeApexString(value);
  // Apex string literal max ~1000 chars for readability
  if (escaped.length > 990) {
    return `'${escaped.substring(0, 990)}' /* truncated */`;
  }
  return `'${escaped}'`;
}

// ─── Reference field resolution ───────────────────────────────────────────────

/**
 * Attempt to resolve a reference field to a relationship initializer.
 * e.g. AccountId → "Account = new Account(External_Id__c = 'ACC-001')"
 * Returns null if no mapping is configured for this lookup field.
 */
function resolveRefField(
  lookupField: string,
  record: Record<string, string>,
  fieldDef: FieldTypeDef | undefined,
  options: ApexFactoryOptions
): string | null {
  // Direct ref mapping configured by user
  const mapping = options.refMappings.find((m) => m.lookupField === lookupField);
  if (mapping) {
    const extIdValue = record[mapping.valueColumn] ?? record[lookupField] ?? "";
    if (!extIdValue || options.skipEmptyFields) return null;
    const relName = fieldDef?.relationshipName ?? mapping.refSObject;
    return `${relName} = new ${mapping.refSObject}(${mapping.extIdField} = '${escapeApexString(extIdValue)}')`;
  }

  // Auto-detect: if the value IS already an external ID format (non SF-Id), use it directly
  // Heuristic: if it doesn't look like a 15/18-char SF Id, treat as external ID
  const rawValue = record[lookupField] ?? "";
  if (!rawValue) return null;
  const looksLikeSfId = /^[a-zA-Z0-9]{15}$|^[a-zA-Z0-9]{18}$/.test(rawValue);
  if (looksLikeSfId) {
    // Can't safely cross-reference without a mapping; emit as a comment
    const refsTo = fieldDef?.referenceTo?.[0] ?? "SObject";
    return `/* ${lookupField} = '${rawValue}' — org-specific ID for ${refsTo}, resolve manually */`;
  }

  return null;
}

// ─── Main generator ───────────────────────────────────────────────────────────

/**
 * Generate a complete Apex data factory class from query results.
 *
 * @param records   Flat record map (field name → string value) from a JSON export.
 * @param options   Generation options including field type map and ref mappings.
 * @returns         Apex source code as a string.
 */
export function generateApexDataFactory(
  records: Record<string, string>[],
  options: ApexFactoryOptions
): string {
  if (records.length === 0) {
    return `// No records to generate — query returned 0 results.\n`;
  }

  const { sobject, className, externalIdField, generateInsert, generateUpsert, fieldTypes } = options;

  // Determine actual field names present in records (skip attributes key)
  const allFieldNames = Object.keys(records[0]).filter((k) => k !== "attributes");

  // Classify fields once
  const scalarFields: string[] = [];
  const refFields: string[] = [];
  for (const fn of allFieldNames) {
    if (ALWAYS_SKIP.has(fn)) continue;
    const def = fieldTypes[fn];
    const type = (def?.type ?? inferType(records[0][fn] ?? "")).toLowerCase();
    if (REF_TYPES.has(type) || (type === "" && fn.endsWith("Id") && fn !== "Id")) {
      refFields.push(fn);
    } else {
      scalarFields.push(fn);
    }
  }

  const lines: string[] = [];
  const now = new Date().toISOString().substring(0, 16).replace("T", " ");

  // ── File header ─────────────────────────────────────────────────────────────
  lines.push(`/**`);
  lines.push(` * Data Factory: ${sobject}`);
  lines.push(` * Generated by Adure SFX Toolkit — ${now}`);
  lines.push(` * Records: ${records.length}`);
  if (externalIdField) lines.push(` * Upsert key: ${externalIdField}`);
  lines.push(` */`);
  lines.push(`public class ${className} {`);
  lines.push(``);

  // ── getRecords() ────────────────────────────────────────────────────────────
  lines.push(`    public static List<${sobject}> getRecords() {`);
  lines.push(`        return new List<${sobject}>{`);

  records.forEach((record, recIdx) => {
    const isLast = recIdx === records.length - 1;
    const fieldLines: string[] = [];

    // Scalar fields
    for (const fn of scalarFields) {
      if (fn === "Id" || ALWAYS_SKIP.has(fn)) continue;
      const def = fieldTypes[fn];
      const lit = apexLiteral(fn, record[fn] ?? "", def, options);
      if (lit === null) continue;
      fieldLines.push(`                ${fn} = ${lit}`);
    }

    // Reference fields
    for (const fn of refFields) {
      const def = fieldTypes[fn];
      const resolved = resolveRefField(fn, record, def, options);
      if (resolved === null) continue;
      fieldLines.push(`                ${resolved}`);
    }

    if (fieldLines.length === 0) {
      lines.push(`            new ${sobject}()${isLast ? "" : ","}`);
      return;
    }

    lines.push(`            new ${sobject}(`);
    fieldLines.forEach((fl, i) => {
      lines.push(fl + (i < fieldLines.length - 1 ? "," : ""));
    });
    lines.push(`            )${isLast ? "" : ","}`);
  });

  lines.push(`        };`);
  lines.push(`    }`);

  // ── insertAll() ─────────────────────────────────────────────────────────────
  if (generateInsert) {
    lines.push(``);
    if (records.length <= 200) {
      lines.push(`    public static void insertAll() {`);
      lines.push(`        insert getRecords();`);
      lines.push(`    }`);
    } else {
      // Chunked insert for > 200 records
      lines.push(`    public static void insertAll() {`);
      lines.push(`        List<${sobject}> all = getRecords();`);
      lines.push(`        for (Integer i = 0; i < all.size(); i += 200) {`);
      lines.push(`            insert all.subList(i, Math.min(i + 200, all.size()));`);
      lines.push(`        }`);
      lines.push(`    }`);
    }
  }

  // ── upsertAll() ─────────────────────────────────────────────────────────────
  if (generateUpsert && externalIdField) {
    lines.push(``);
    if (records.length <= 200) {
      lines.push(`    public static void upsertAll() {`);
      lines.push(`        upsert getRecords() ${sobject}.${externalIdField};`);
      lines.push(`    }`);
    } else {
      lines.push(`    public static void upsertAll() {`);
      lines.push(`        List<${sobject}> all = getRecords();`);
      lines.push(`        for (Integer i = 0; i < all.size(); i += 200) {`);
      lines.push(`            upsert all.subList(i, Math.min(i + 200, all.size())) ${sobject}.${externalIdField};`);
      lines.push(`        }`);
      lines.push(`    }`);
    }
  }

  lines.push(``);
  lines.push(`}`);

  return lines.join("\n");
}

// ─── Field list recommendation ────────────────────────────────────────────────

/**
 * Given a describe result, return the recommended SOQL SELECT field list
 * for a data factory export — includes all createable scalar fields and
 * skips system/reference fields.
 */
export function recommendedSelectFields(fieldTypes: Record<string, FieldTypeDef>): string[] {
  return Object.values(fieldTypes)
    .filter((f) => {
      if (ALWAYS_SKIP.has(f.name)) return false;
      if (SKIP_TYPES.has(f.type.toLowerCase())) return false;
      if (!f.createable && !f.updateable) return false;
      return true;
    })
    .map((f) => f.name);
}
