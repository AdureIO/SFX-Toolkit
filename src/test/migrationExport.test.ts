import * as assert from "assert";
import {
  apexLiteral,
  apexString,
  apexVar,
  csvCell,
  resolveKeyFor,
  toApexParts,
  toApexScript,
  toCsvExports,
  toJsonExport,
  type ExportFieldMeta,
  type ExportProfileLike
} from "../utils/migrationExport";

const PROFILE: ExportProfileLike = {
  name: "Accounts and contacts",
  rootSObject: "Account",
  nodes: [
    { sobject: "Account", parentSObject: null, externalIdField: null,
      includeFields: ["Id", "Name", "NumberOfEmployees", "IsExcluded__c", "ParentId", "OwnerId"] },
    { sobject: "Contact", parentSObject: "Account", externalIdField: "Ext_Id__c",
      includeFields: ["Id", "LastName", "AccountId", "Ext_Id__c", "Birthdate"] }
  ]
};

const META: ExportFieldMeta = new Map([
  ["Account", new Map([
    ["Name", { type: "string", referenceTo: [] as string[] }],
    ["NumberOfEmployees", { type: "int", referenceTo: [] as string[] }],
    ["IsExcluded__c", { type: "boolean", referenceTo: [] as string[] }],
    ["ParentId", { type: "reference", referenceTo: ["Account"], relationshipName: "Parent" }],
    ["OwnerId", { type: "reference", referenceTo: ["User"], relationshipName: "Owner" }]
  ])],
  ["Contact", new Map([
    ["LastName", { type: "string", referenceTo: [] as string[] }],
    ["AccountId", { type: "reference", referenceTo: ["Account"], relationshipName: "Account" }],
    ["Ext_Id__c", { type: "string", referenceTo: [] as string[] }],
    ["Birthdate", { type: "date", referenceTo: [] as string[] }]
  ])]
]);

const DATA = [
  {
    sobject: "Account",
    records: [
      { Id: "001S1", Name: "Acme", NumberOfEmployees: "42", IsExcluded__c: "false", ParentId: "", OwnerId: "005U1" },
      { Id: "001S2", Name: "O'Brien & Co", NumberOfEmployees: "", IsExcluded__c: "true", ParentId: "001S1", OwnerId: "005U1" }
    ]
  },
  {
    sobject: "Contact",
    records: [
      { Id: "003S1", LastName: "Vance", AccountId: "001S1", Ext_Id__c: "C-1", Birthdate: "1980-04-01" }
    ]
  }
];

describe("migrationExport.apexLiteral", () => {
  it("omits an empty value so the org's own defaults apply", () => {
    assert.strictEqual(apexLiteral("", "string"), null);
  });

  it("writes numbers unquoted and booleans as keywords", () => {
    assert.strictEqual(apexLiteral("42", "int"), "42");
    assert.strictEqual(apexLiteral("3.5", "currency"), "3.5");
    assert.strictEqual(apexLiteral("true", "boolean"), "true");
    assert.strictEqual(apexLiteral("False", "boolean"), "false");
  });

  it("falls back to a quoted string when a numeric field holds something else", () => {
    assert.strictEqual(apexLiteral("N/A", "int"), "'N/A'");
  });

  it("converts a Salesforce datetime into what valueOfGmt accepts", () => {
    assert.strictEqual(
      apexLiteral("2024-01-31T09:15:00.000+0000", "datetime"),
      "Datetime.valueOfGmt('2024-01-31 09:15:00')"
    );
  });

  it("takes only the date part of a date field", () => {
    assert.strictEqual(apexLiteral("1980-04-01", "date"), "Date.valueOf('1980-04-01')");
  });
});

describe("migrationExport.apexString", () => {
  it("escapes quotes and backslashes so the literal still compiles", () => {
    assert.strictEqual(apexString("O'Brien"), "'O\\'Brien'");
    assert.strictEqual(apexString("a\\b"), "'a\\\\b'");
  });

  it("escapes the backslash before the quote, not after", () => {
    // Getting this order wrong turns \' into \\' and breaks the string.
    assert.strictEqual(apexString("\\'"), "'\\\\\\''");
  });

  it("keeps newlines inside the literal", () => {
    assert.strictEqual(apexString("a\nb"), "'a\\nb'");
  });
});

describe("migrationExport.apexVar", () => {
  it("keeps a valid API name as-is", () => {
    assert.strictEqual(apexVar("My_Object__c"), "My_Object__c");
    assert.strictEqual(apexVar("ns__Thing__c"), "ns__Thing__c");
  });

  it("makes an identifier out of anything else", () => {
    assert.strictEqual(apexVar("9Lives"), "x9Lives");
  });
});

describe("migrationExport.toApexScript", () => {
  const script = toApexScript(PROFILE, DATA, META, "2026-08-11T00:00:00Z");

  it("creates parents before children", () => {
    assert.ok(script.indexOf("insert Account_rows;") < script.indexOf("List<Contact>"),
      "Accounts are inserted before Contacts are built");
  });

  it("falls back to the created record when the parent has no external Id to resolve through", () => {
    assert.ok(script.includes("AccountId=Account_byId.get('001S1').Id"));
    assert.ok(!/AccountId='001S1'/.test(script), "a source Id would not resolve in the target org");
  });

  it("upserts on the external Id and plain-inserts without one", () => {
    assert.ok(script.includes("upsert Contact_rows Contact.Ext_Id__c;"));
    assert.ok(script.includes("insert Account_rows;"));
    assert.ok(!script.includes("upsert Account_rows"));
  });

  it("emits records as one list literal, not a variable per row", () => {
    assert.ok(script.includes("List<Account> Account_rows = new List<Account>{"));
    assert.ok(!/Account Account_0 = /.test(script));
  });

  it("links self-references after the insert, not during", () => {
    const insertAt = script.indexOf("insert Account_rows;");
    const linkAt = script.indexOf("Account_byId.get('001S2').ParentId");
    assert.ok(linkAt > insertAt, "ParentId is set once every row has an Id");
    assert.ok(script.indexOf("update Account_rows;") > linkAt);
  });

  it("leaves out a lookup to an object that is not in the migration", () => {
    // OwnerId points at User, which nothing creates — a source Id there would just fail.
    assert.ok(!script.includes("OwnerId"), "no Owner assignment is emitted");
  });

  it("resolves a lookup through the parent's external Id when there is one", () => {
    // No map, no variable, and it still resolves in a separate execution — which is what lets a
    // large script be split at all.
    const keyed: ExportProfileLike = {
      name: "keyed", rootSObject: "Account",
      nodes: [
        { sobject: "Account", parentSObject: null, externalIdField: "Ext__c", includeFields: ["Id", "Name", "Ext__c"] },
        { sobject: "Contact", parentSObject: "Account", externalIdField: null,
          includeFields: ["Id", "LastName", "AccountId"] }
      ]
    };
    const meta: ExportFieldMeta = new Map([
      ["Account", new Map([
        ["Name", { type: "string", referenceTo: [] as string[] }],
        ["Ext__c", { type: "string", referenceTo: [] as string[] }]
      ])],
      ["Contact", new Map([
        ["LastName", { type: "string", referenceTo: [] as string[] }],
        ["AccountId", { type: "reference", referenceTo: ["Account"], relationshipName: "Account" }]
      ])]
    ]);
    const out = toApexScript(keyed, [
      { sobject: "Account", records: [{ Id: "001S1", Name: "Acme", Ext__c: "E1" }] },
      { sobject: "Contact", records: [{ Id: "003S1", LastName: "Vance", AccountId: "001S1" }] }
    ], meta, "2026-08-11T00:00:00Z");
    assert.ok(out.includes("Account=new Account(Ext__c='E1')"));
    assert.ok(!out.includes("Account_byId"), "no lookup map is needed at all");
  });

  it("resolves through any external Id on the parent, not only the chosen upsert key", () => {
    const legacy: ExportProfileLike = {
      name: "legacy", rootSObject: "Account",
      nodes: [
        // No upsert key selected — but Legacy_Id__c is an external Id and is exported.
        { sobject: "Account", parentSObject: null, externalIdField: null,
          includeFields: ["Id", "Name", "Legacy_Id__c"] },
        { sobject: "Contact", parentSObject: "Account", externalIdField: null,
          includeFields: ["Id", "LastName", "AccountId"] }
      ]
    };
    const meta: ExportFieldMeta = new Map([
      ["Account", new Map([
        ["Name", { type: "string", referenceTo: [] as string[] }],
        ["Legacy_Id__c", { type: "string", referenceTo: [] as string[], externalId: true, unique: true }]
      ])],
      ["Contact", new Map([
        ["LastName", { type: "string", referenceTo: [] as string[] }],
        ["AccountId", { type: "reference", referenceTo: ["Account"], relationshipName: "Account" }]
      ])]
    ]);
    const out = toApexScript(legacy, [
      { sobject: "Account", records: [{ Id: "001S1", Name: "Acme", Legacy_Id__c: "L-1" }] },
      { sobject: "Contact", records: [{ Id: "003S1", LastName: "Vance", AccountId: "001S1" }] }
    ], meta, "2026-08-11T00:00:00Z");
    assert.ok(out.includes("Account=new Account(Legacy_Id__c='L-1')"));
    assert.ok(!out.includes("Account_byId"), "still no map — any external Id will resolve the link");
    assert.ok(out.includes("insert Account_rows;"), "and it is still an insert, not an upsert");
  });

  it("drops a lookup whose record was never collected, rather than emitting a get() that throws", () => {
    const junction: ExportProfileLike = {
      name: "junction", rootSObject: "Account",
      nodes: [
        { sobject: "Account", parentSObject: null, externalIdField: null, includeFields: ["Id", "Name"] },
        { sobject: "Deal__c", parentSObject: "Account", externalIdField: null,
          includeFields: ["Id", "Account__c", "Partner__c"] }
      ]
    };
    const meta: ExportFieldMeta = new Map([
      ["Account", new Map([["Name", { type: "string", referenceTo: [] as string[] }]])],
      ["Deal__c", new Map([
        ["Account__c", { type: "reference", referenceTo: ["Account"] }],
        ["Partner__c", { type: "reference", referenceTo: ["Account"] }]
      ])]
    ]);
    const out = toApexScript(junction, [
      { sobject: "Account", records: [{ Id: "001S1", Name: "Acme" }] },
      { sobject: "Deal__c", records: [{ Id: "a01S1", Account__c: "001S1", Partner__c: "001S_ABSENT" }] }
    ], meta, "2026-08-11T00:00:00Z");
    assert.ok(out.includes("Account__c=Account_byId.get('001S1').Id"), "the collected parent is linked");
    assert.ok(!out.includes("001S_ABSENT"), "the uncollected one is left empty, not dereferenced");
  });

  it("omits empty values rather than writing null", () => {
    assert.ok(!script.includes("NumberOfEmployees=null"));
    assert.ok(!script.includes("ParentId=null"));
    assert.ok(script.includes("NumberOfEmployees=42"), "the value that exists is still written");
  });

  it("escapes a value that would otherwise break the literal", () => {
    assert.ok(script.includes("Name='O\\'Brien & Co'"));
  });

  it("says how much it will load, and which objects", () => {
    assert.ok(/3 record\(s\), Account, Contact/.test(script));
  });

  it("warns when the row count exceeds what one transaction can DML", () => {
    const many = [{
      sobject: "Account",
      records: Array.from({ length: 10_001 }, (_, i) => ({ Id: `001S${i}`, Name: `A${i}` }))
    }];
    const big = toApexScript(
      { name: "big", rootSObject: "Account", nodes: [PROFILE.nodes[0]] },
      many, META, "2026-08-11T00:00:00Z"
    );
    assert.ok(/exceeds the 10000-row DML limit/.test(big));
  });
});

describe("migrationExport.toApexParts", () => {
  // A keyed parent, so children can be found again after the block they were created in ends.
  const SPLITTABLE: ExportProfileLike = {
    name: "Bulk", rootSObject: "Account",
    nodes: [
      { sobject: "Account", parentSObject: null, externalIdField: "Ext__c", includeFields: ["Id", "Name", "Ext__c"] },
      { sobject: "Contact", parentSObject: "Account", externalIdField: null,
        includeFields: ["Id", "LastName", "AccountId"] }
    ]
  };
  const SPLIT_META: ExportFieldMeta = new Map([
    ["Account", new Map([
      ["Name", { type: "string", referenceTo: [] as string[] }],
      ["Ext__c", { type: "string", referenceTo: [] as string[] }]
    ])],
    ["Contact", new Map([
      ["LastName", { type: "string", referenceTo: [] as string[] }],
      ["AccountId", { type: "reference", referenceTo: ["Account"], relationshipName: "Account" }]
    ])]
  ]);
  const bulk = [
    { sobject: "Account", records: Array.from({ length: 300 }, (_, i) =>
        ({ Id: `001S${i}`, Name: `Account number ${i} with a name long enough to spend characters`, Ext__c: `E${i}` })) },
    { sobject: "Contact", records: Array.from({ length: 300 }, (_, i) =>
        ({ Id: `003S${i}`, LastName: `Contact number ${i} also with a long name`, AccountId: `001S${i}` })) }
  ];

  it("keeps every part inside the budget", () => {
    const parts = toApexParts(SPLITTABLE, bulk, SPLIT_META, "X", 32_000);
    assert.ok(parts.length > 1, "this much data does not fit in one block");
    for (const p of parts) {
      assert.ok(p.chars <= 32_000, `part ${p.index} is ${p.chars} chars`);
      assert.strictEqual(p.oversize, false);
    }
  });

  it("loses no records to the split", () => {
    const parts = toApexParts(SPLITTABLE, bulk, SPLIT_META, "X", 32_000);
    assert.strictEqual(parts.reduce((n, p) => n + p.rows, 0), 600);
  });

  it("tells the reader the parts are ordered", () => {
    const parts = toApexParts(SPLITTABLE, bulk, SPLIT_META, "X", 32_000);
    assert.ok(/part 2 of \d+/.test(parts[1].content));
    assert.ok(/Run the parts in order/.test(parts[1].content));
  });

  it("stays in one part when everything fits", () => {
    const parts = toApexParts(PROFILE, DATA, META, "X", 32_000);
    assert.strictEqual(parts.length, 1);
    assert.ok(!/part 1 of/.test(parts[0].content), "no part numbering on a single script");
  });

  it("says so, and how to run it, when a part cannot be made to fit", () => {
    // Self-linking Accounts cannot be broken up: both rows of a link must be in one execution.
    const selfLinked = [{
      sobject: "Account",
      records: Array.from({ length: 300 }, (_, i) =>
        ({ Id: `001S${i}`, Name: `Account number ${i} with a name long enough to spend characters`,
           ParentId: i > 0 ? "001S0" : "", OwnerId: "" }))
    }];
    const parts = toApexParts(
      { name: "self", rootSObject: "Account", nodes: [PROFILE.nodes[0]] },
      selfLinked, META, "X", 8_000
    );
    assert.strictEqual(parts.length, 1, "it cannot be split");
    assert.ok(parts[0].oversize);
    assert.ok(/sf apex run --file/.test(parts[0].content), "the usable alternative is named");
    assert.ok(/Account/.test(parts[0].oversizeReason ?? ""), "and what pinned it");
  });
});

describe("migrationExport.resolveKeyFor", () => {
  const fields: ExportFieldMeta = new Map([["Account", new Map([
    ["Chosen__c", { type: "string", referenceTo: [] as string[], externalId: true, unique: true }],
    ["Loose__c", { type: "string", referenceTo: [] as string[], externalId: true, unique: false }],
    ["Tight__c", { type: "string", referenceTo: [] as string[], externalId: true, unique: true }],
    ["Name", { type: "string", referenceTo: [] as string[] }]
  ])]]);
  const node = (externalIdField: string | null, includeFields: string[]) =>
    ({ sobject: "Account", parentSObject: null, externalIdField, includeFields });

  it("prefers the chosen upsert key", () => {
    assert.strictEqual(resolveKeyFor(node("Chosen__c", ["Chosen__c", "Loose__c"]), fields), "Chosen__c");
  });

  it("falls back to a unique external Id over a non-unique one", () => {
    // A non-unique external Id makes the foreign key ambiguous and the DML rejects it.
    assert.strictEqual(resolveKeyFor(node(null, ["Name", "Loose__c", "Tight__c"]), fields), "Tight__c");
  });

  it("will not name a field the export does not write", () => {
    // The stub only resolves if the value is actually in the org, so the field has to be exported.
    assert.strictEqual(resolveKeyFor(node(null, ["Name"]), fields), null);
  });

  it("returns nothing when the object has no external Id at all", () => {
    assert.strictEqual(resolveKeyFor(node(null, ["Name"]), new Map()), null);
  });
});

describe("migrationExport.csvCell", () => {
  it("quotes only what needs quoting", () => {
    assert.strictEqual(csvCell("plain"), "plain");
    assert.strictEqual(csvCell("a,b"), '"a,b"');
    assert.strictEqual(csvCell('say "hi"'), '"say ""hi"""');
    assert.strictEqual(csvCell("line\nbreak"), '"line\nbreak"');
  });
});

describe("migrationExport.toCsvExports", () => {
  const files = toCsvExports(DATA, (s) => (s === "Account" ? ["Id", "Name"] : ["Id", "LastName"]));

  it("writes one file per object, named after it", () => {
    assert.deepStrictEqual(files.map((f) => f.fileName), ["Account.csv", "Contact.csv"]);
  });

  it("leads with the header row and keeps the source Id", () => {
    assert.ok(files[0].content.startsWith("Id,Name\r\n"));
    assert.ok(files[0].content.includes("001S1,Acme"));
  });
});

describe("migrationExport.toJsonExport", () => {
  const parsed = JSON.parse(toJsonExport(PROFILE, DATA, "2026-08-11T00:00:00Z"));

  it("records the upsert key alongside the records", () => {
    const contact = parsed.objects.find((o: { sobject: string }) => o.sobject === "Contact");
    assert.strictEqual(contact.externalIdField, "Ext_Id__c");
    assert.strictEqual(contact.count, 1);
  });

  it("keeps the objects in migration order", () => {
    assert.deepStrictEqual(parsed.objects.map((o: { sobject: string }) => o.sobject), ["Account", "Contact"]);
  });
});
