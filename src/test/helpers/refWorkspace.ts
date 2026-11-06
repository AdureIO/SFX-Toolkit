/**
 * Ground-truth workspace for Find References / rename / LWC→Apex navigation tests.
 *
 * Fixture texts carry inline markers `«spec|text»` that are stripped when the files are
 * written; `spec` is a comma-separated list of
 *   `SYM:cat`   — this span is an expected reference of symbol SYM (category `cat`)
 *   `-SYM:cat`  — this span must NOT be reported for SYM (a tracked negative)
 *   `@anchor`   — a named query position (the start of the span)
 * Anything reported that is neither expected nor a tracked negative still counts as a
 * false positive (category `other`).
 *
 * Symbols: C (class AccountService), GA (@AuraEnabled static getAccounts(Integer)),
 * GA2 (overload getAccounts(String, Integer)), DS (virtual describe(), overridden in
 * PremiumService), ST (property Status), LB (private field label), CC (static field
 * callCount), SI (static field current), INST (static instance()), RES (inner class
 * Result), OK (Result.ok()), LV (inner enum Level), HIGH (Level.HIGH), H (interface
 * Handler), HM (Handler.handle family), UH (Unrelated.handle, not in the family), LOC
 * (param acc), MAX (param max, used in SOQL binds), INV / RUN (@InvocableMethod class +
 * method used by a Flow), EXT / REC / SAVE (Visualforce extension, getter, action), AUR
 * (@AuraEnabled saveRecord used from Aura + LWC).
 *
 * `fillers` adds that many unrelated classes that reuse the same member names
 * (describe / handle / getAccounts) and mention 'AccountService' in strings — the
 * precision and latency stress; every 100th filler really calls AccountService.
 */
import * as fs from "fs";
import * as path from "path";

export interface ExpLoc {
	file: string; // workspace-relative path
	line: number;
	character: number;
	length: number;
	cat: string;
}

export interface RefFixture {
	/** Disk contents (markers stripped). */
	files: Record<string, string>;
	/** Unsaved editor buffers (markers stripped) — open these with didOpen; they override disk. */
	buffers: Record<string, string>;
	/** Expected references per symbol (from the files, with buffer files' disk entries replaced by the buffer's). */
	expected: Map<string, ExpLoc[]>;
	/** Tracked negatives per symbol. */
	negatives: Map<string, ExpLoc[]>;
	anchors: Map<string, ExpLoc>;
}

export const CLS = "force-app/main/default/classes";
export const TRG = "force-app/main/default/triggers";
const LWC = "force-app/main/default/lwc";
const AURA = "force-app/main/default/aura";
const PAGES = "force-app/main/default/pages";
const FLOWS = "force-app/main/default/flows";
const META = (v = "60.0") => `<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>${v}</apiVersion><status>Active</status></ApexClass>\n`;

const SOURCES: Record<string, string> = {
	[`${CLS}/AccountService.cls`]: `/**
 * AccountService — «-C:comment|AccountService».«-GA:comment|getAccounts»(1) in a doc comment must not count.
 */
public with sharing virtual class «C:decl,@C|AccountService» {
    public static Integer «CC:decl,@CC|callCount» = 0;
    private String «LB:decl,@LB|label»;
    public String «ST:decl,@ST|Status» { get; set; }
    public static «C:type|AccountService» «SI:decl,@SI|current»;

    public «C:ctor|AccountService»() {
        «LB:bare|label» = 'default';
        this.«ST:this|Status» = 'New';
    }

    @AuraEnabled(cacheable=true)
    public static List<Account> «GA:decl,@GA|getAccounts»(Integer «MAX:decl,@MAX|max») {
        «CC:bare|callCount»++;
        String «-LB:shadow|label» = 'shadow';
        System.debug(«-LB:shadow|label»);
        return [SELECT Id, Name FROM Account WHERE Name != :«-LB:soql-local|label» LIMIT :«MAX:soql|max»];
    }

    public static List<Account> «GA2:decl,@GA2|getAccounts»(String name, Integer «-MAX:other-param|max») {
        «CC:bare|callCount» += «GA:bare|getAccounts»(«-MAX:other-param|max»).size();
        return [SELECT Id FROM Account WHERE Name = :name LIMIT :«-MAX:other-param|max»];
    }

    @AuraEnabled
    public static void «AUR:decl,@AUR|saveRecord»(Account a) {
        update a;
    }

    public static «C:type|AccountService» «INST:decl,@INST|instance»() {
        if («SI:bare|current» == null) «SI:bare|current» = new «C:new|AccountService»();
        return «SI:bare|current»;
    }

    public virtual String «DS:decl,@DS|describe»() {
        Integer n = [SELECT COUNT() FROM Account WHERE Name = :«LB:soql|label»];
        return «LB:bare|label» + ':' + «ST:bare|Status» + n;
    }

    public void rename(String «-LB:param|label») {
        this.«LB:this|label» = «-LB:param|label»;
        «DS:bare|describe»();
        this.«DS:this|describe»();
    }

    public class «RES:decl,@RES|Result» {
        public Boolean «OK:decl,@OK|ok»() { return true; }
    }

    public «RES:type|Result» check() {
        «RES:type|Result» r = new «RES:new|Result»();
        r.«OK:var|ok»();
        return r;
    }

    public enum «LV:decl,@LV|Level» { LOW, «HIGH:decl,@HIGH|HIGH» }

    public «LV:type|Level» levelOf(Integer n) {
        «LV:type|Level» l = n > 10 ? «LV:static|Level».«HIGH:static|HIGH» : «LV:static|Level».LOW;
        switch on l {
            when «HIGH:when|HIGH» { return l; }
            when else { return «LV:static|Level».LOW; }
        }
    }
}
`,
	[`${CLS}/PremiumService.cls`]: `public class PremiumService extends «C:extends|AccountService» {
    public override String «DS:override,@DS.override|describe»() {
        return 'Premium ' + super.«DS:super|describe»();
    }
    public void bump() {
        «ST:inherited|Status» = 'Premium';
    }
}
`,
	// Overloads that differ only in parameter types (OVS String / OVI Integer / OVA Account).
	[`${CLS}/Overloads.cls`]: `public class Overloads {
    public static String «OVS:decl,@OVS|convert»(String v) { return v; }
    public static String «OVI:decl,@OVI|convert»(Integer v) { return 'i'; }
    public static String «OVA:decl,@OVA|convert»(Account v) { return 'a'; }
    public static Account makeAccount() { return null; }
    public static String label() { return ''; }
    public static Integer count() { return 1; }
    // Overloads that differ only in generic arguments. Apex treats String[] and List<String>
    // as one type, so GLS stands for both spellings.
    public static String «GLS:decl,@GLS|gen»(String[] v) { return 'ls'; }
    public static String «GLI:decl,@GLI|gen»(List<Integer> v) { return 'li'; }
    public static String «GMA:decl,@GMA|gen»(Map<Id, Account> v) { return 'ma'; }
    public static String «GMS:decl,@GMS|gen»(Map<String,Account> v) { return 'ms'; }
    public static String «GQA:decl,@GQA|genq»(List<Account> v) { return 'qa'; }
    public static String «GQC:decl,@GQC|genq»(List<Contact> v) { return 'qc'; }
    public static List<String> names() { return null; }
}
`,
	[`${CLS}/OverloadCaller.cls`]: `public class OverloadCaller {
    private String fieldText = 'f';
    public void go(String ps, Integer pi) {
        Overloads.«OVS:literal,@OVS.literal|convert»('x');
        Overloads.«OVI:literal,@OVI.literal|convert»(42);
        Overloads.«OVA:new|convert»(new Account());
        String ls = 'a';
        Integer li = 1;
        Account la = new Account();
        Overloads.«OVS:local|convert»(ls);
        Overloads.«OVI:local|convert»(li);
        Overloads.«OVA:local,@OVA.local|convert»(la);
        Overloads.«OVS:param|convert»(ps);
        Overloads.«OVI:param|convert»(pi);
        Overloads.«OVS:field|convert»(fieldText);
        Overloads.«OVS:result|convert»(Overloads.label());
        Overloads.«OVI:result|convert»(Overloads.count());
        Overloads.«OVA:result|convert»(Overloads.makeAccount());
        Overloads.«OVS:concat|convert»('a' + ps);
        Overloads.«OVS:undetermined,OVI:undetermined,OVA:undetermined|convert»(Mystery.value());
    }
    private List<Integer> fieldInts = new List<Integer>();
    public void generics(List<String> pls, Map<Id, Account> pmi, Map<String, Account> pms, Account[] pacc) {
        List<Integer> lli = new List<Integer>();
        List<Account> lacc = [SELECT Id FROM Account];
        Overloads.«GLS:param|gen»(pls);
        Overloads.«GLI:local,@GLI.local|gen»(lli);
        Overloads.«GLI:field|gen»(fieldInts);
        Overloads.«GLI:new|gen»(new List<Integer>());
        Overloads.«GLS:array-literal|gen»(new String[]{'a'});
        Overloads.«GLS:list-literal|gen»(new List<String>{'a', 'b'});
        Overloads.«GLS:result|gen»(Overloads.names());
        Overloads.«GMA:param|gen»(pmi);
        Overloads.«GMS:param|gen»(pms);
        Overloads.«GMA:new|gen»(new Map<Id,Account>());
        Overloads.«GQA:soql|genq»([SELECT Id FROM Account WHERE Name != null]);
        Overloads.«GQC:soql|genq»([SELECT Id, (SELECT Id FROM Cases) FROM Contact]);
        Overloads.«GQA:local|genq»(lacc);
        Overloads.«GQA:array-param|genq»(pacc);
        Overloads.«GLS:undetermined,GLI:undetermined,GMA:undetermined,GMS:undetermined|gen»(Mystery.value());
        Overloads.«GQA:undetermined,GQC:undetermined|genq»(Mystery.value());
    }
}
`,
	[`${CLS}/OtherService.cls`]: `public class OtherService {
    public static List<Account> getAccounts(Integer n) { return null; }
    public String describe() { return 'other'; }
    public OtherService make() { return this; }
    public String Status;
    public PageReference save() { return null; }
}
`,
	[`${CLS}/Consumer.cls`]: `public class Consumer {
    // «-C:comment|AccountService».«-GA:comment|getAccounts»(1) in a line comment
    private «C:type|AccountService» svc = new «C:new|AccountService»();
    private List<«C:generic|AccountService»> services = new List<«C:generic|AccountService»>();
    private Map<Id, «C:generic|AccountService»> byId = new Map<Id, «C:generic|AccountService»>();
    private OtherService other = new OtherService();

    public void run(Account «LOC:decl,@LOC|acc») {
        String s = 'AccountService.getAccounts';
        «C:static|AccountService».«GA:static|getAccounts»(5);
        «C:case|accountservice».«GA:case|GETACCOUNTS»(6);
        «C:static|AccountService».«GA2:static|getAccounts»('x', 7);
        myns.«C:ns|AccountService».«GA:ns|getAccounts»(8);
        OtherService.«-GA:other-type|getAccounts»(9);
        svc.«DS:var|describe»();
        «C:static|AccountService».«INST:static|instance»().«DS:chain|describe»();
        new «C:new|AccountService»().«DS:new-chain|describe»();
        services[0].«DS:index|describe»();
        byId.get(«LOC:use|acc».Id).«DS:map-get|describe»();
        for («C:type|AccountService» a : services) { a.«DS:loop|describe»(); }
        other.«-DS:other-type|describe»();
        other.make().«-DS:chain-other|describe»();
        new OtherService().«-DS:other-type|describe»();
        svc.«ST:var|Status» = 'Active';
        String st = svc.«ST:var|Status»;
        other.«-ST:other-type|Status» = 'x';
        «C:static|AccountService».«CC:static|callCount» = 0;
        «LOC:use|acc».Name = svc.«ST:case|status»;
        if («LOC:use|acc» != null) {
            Account acc2 = «LOC:use|acc»;
        }
        Object o = Type.forName('«C:typeforname|AccountService»').newInstance();
        «C:cast|AccountService» cast = («C:cast|AccountService») o;
        System.debug(«C:class|AccountService».class);
        «C:static|AccountService».«RES:inner|Result» res = new «C:static|AccountService».«RES:inner|Result»();
        res.«OK:var|ok»();
        «C:static|AccountService».«LV:inner|Level» lv = «C:static|AccountService».«LV:inner|Level».«HIGH:static|HIGH»;
    }

    public void other(Account «-LOC:other-method|acc») {
        System.debug(«-LOC:other-method|acc»);
    }
}
`,
	[`${CLS}/Handler.cls`]: `public interface «H:decl,@H|Handler» {
    void «HM:decl,@HM|handle»();
}
`,
	[`${CLS}/BaseHandler.cls`]: `public virtual class BaseHandler implements «H:impl|Handler» {
    public virtual void «HM:impl|handle»() {}
}
`,
	[`${CLS}/SpecialHandler.cls`]: `public class SpecialHandler extends BaseHandler {
    public override void «HM:override,@HM.override|handle»() {
        super.«HM:super|handle»();
    }
}
`,
	[`${CLS}/Unrelated.cls`]: `public class Unrelated {
    public void «UH:decl,@UH|handle»() {}
    public void go() {
        «UH:bare|handle»();
        new Unrelated().«UH:new-chain|handle»();
    }
}
`,
	[`${CLS}/HandlerRunner.cls`]: `public class HandlerRunner {
    public static void runAll(List<«H:generic|Handler»> hs) {
        for («H:type|Handler» h : hs) h.«HM:iface-var|handle»();
        BaseHandler b = new SpecialHandler();
        b.«HM:base-var|handle»();
        new SpecialHandler().«HM:new-chain|handle»();
        Unrelated u = new Unrelated();
        u.«-HM:other-type,UH:var|handle»();
    }
}
`,
	[`${TRG}/AccountTrigger.trigger`]: `trigger AccountTrigger on Account (before insert) {
    «C:static|AccountService».«GA:trigger|getAccounts»(1);
    «C:type|AccountService» svc = «C:static|AccountService».«INST:static|instance»();
    svc.«DS:trigger|describe»();
}
`,
	[`${CLS}/AccountServiceTest.cls`]: `@IsTest
private class AccountServiceTest {
    @IsTest
    static void testIt() {
        «C:type|AccountService» s = new «C:new|AccountService»();
        System.assertEquals(0, «C:static|AccountService».«GA:test|getAccounts»(0).size());
        s.«ST:test|Status» = 'x';
        System.assert(s.«DS:test|describe»() != null);
        PremiumService p = new PremiumService();
        p.«DS:subclass-var|describe»();
    }
}
`,
	[`${CLS}/AccountInvocable.cls`]: `public with sharing class «INV:decl,@INV|AccountInvocable» {
    @InvocableMethod(label='Run accounts')
    public static void «RUN:decl,@RUN|run»(List<Id> ids) {
        «C:static|AccountService».«GA:invocable|getAccounts»(ids.size());
    }
}
`,
	[`${CLS}/AccountExt.cls`]: `public with sharing class «EXT:decl,@EXT|AccountExt» {
    public «EXT:ctor|AccountExt»(ApexPages.StandardController sc) {}
    public List<Account> «REC:decl,@REC|getRecent»() { return [SELECT Id FROM Account LIMIT 5]; }
    public PageReference «SAVE:decl,@SAVE|save»() { return null; }
}
`,
	// Unsaved-buffer target: the disk version calls getAccounts (stale), the open buffer doesn't —
	// but calls describe instead (see BUFFERS).
	[`${CLS}/Draft.cls`]: `public class Draft {
    public void go() {
        AccountService.getAccounts(99);
    }
}
`,
	[`${PAGES}/AccountPage.page`]: `<apex:page standardController="Account" extensions="«EXT:vf|AccountExt»">
    <!-- {!«-REC:comment|recent»} in a comment must not count -->
    <apex:form>
        <apex:repeat value="{!«REC:vf|recent»}" var="r">{!r.Name}</apex:repeat>
        <apex:commandButton action="{!«SAVE:vf|save»}" value="Save"/>
    </apex:form>
</apex:page>
`,
	[`${PAGES}/AccountsPage.page`]: `<apex:page controller="«C:vf|AccountService»">
    <apex:outputText value="{!«ST:vf|Status»}"/>
</apex:page>
`,
	[`${PAGES}/OtherPage.page`]: `<apex:page controller="OtherService">
    <apex:form><apex:commandButton action="{!«-SAVE:other-page|save»}"/></apex:form>
</apex:page>
`,
	[`${AURA}/accountList/accountList.cmp`]: `<aura:component controller="«C:aura|AccountService»" implements="flexipage:availableForAllPageTypes">
    <aura:handler name="init" value="{!this}" action="{!c.doInit}"/>
</aura:component>
`,
	[`${AURA}/accountList/accountListController.js`]: `({
    doInit: function (component, event, helper) {
        // component.get('c.«-GA:comment|getAccounts»') in a comment
        var action = component.get("c.«GA:aura|getAccounts»");
        helper.load(component);
    }
})
`,
	[`${AURA}/accountList/accountListHelper.js`]: `({
    load: function (cmp) {
        var a = cmp.get('c.«AUR:aura,@AUR.aura|saveRecord»');
        $A.enqueueAction(a);
    }
})
`,
	[`${AURA}/otherList/otherList.cmp`]: `<aura:component controller="OtherService">
</aura:component>
`,
	[`${AURA}/otherList/otherListController.js`]: `({
    doInit: function (component) {
        var action = component.get("c.«-GA:other-cmp|getAccounts»");
    }
})
`,
	[`${LWC}/accountList/accountList.js`]: `import { LightningElement, wire } from 'lwc';
import «GA:lwc-binding,@GA.lwc.binding|getAccounts» from '@salesforce/apex/«C:lwc|AccountService».«GA:lwc-spec,@GA.lwc.spec|getAccounts»';
import «AUR:lwc-binding|saveRec» from '@salesforce/apex/«C:lwc|AccountService».«AUR:lwc-spec|saveRecord»';

export default class AccountList extends LightningElement {
    @wire(«GA:lwc-wire,@GA.lwc.wire|getAccounts», { max: 10 }) accounts;
    // «-GA:comment|getAccounts»({ max: 1 }) in a comment
    label = 'getAccounts';

    async refresh() {
        const rows = await «GA:lwc-call,@GA.lwc.call|getAccounts»({ max: 5 });
        this.«-GA:lwc-member|getAccounts» = rows;
        await «AUR:lwc-call|saveRec»({ a: rows[0] });
    }
}
`,
	[`${LWC}/nsList/nsList.js`]: `import { LightningElement } from 'lwc';
import «GA:lwc-binding|fetchAccts» from '@salesforce/apex/myns.«C:lwc-ns|AccountService».«GA:lwc-ns,@GA.lwc.ns|getAccounts»';

export default class NsList extends LightningElement {
    connectedCallback() {
        «GA:lwc-call,@GA.lwc.ns.call|fetchAccts»({ max: 1 }).then(() => {});
    }
}
`,
	[`${LWC}/caseList/caseList.js`]: `import { LightningElement } from 'lwc';
import «GA:lwc-binding|getaccts» from '@salesforce/apex/«C:lwc-case|accountservice».«GA:lwc-case,@GA.lwc.case|GETACCOUNTS»';

export default class CaseList extends LightningElement {
    load() { return «GA:lwc-call|getaccts»({ max: 2 }); }
}
`,
	[`${LWC}/otherList/otherList.js`]: `import { LightningElement, wire } from 'lwc';
import «-GA:lwc-other|getAccounts» from '@salesforce/apex/OtherService.«-GA:lwc-other|getAccounts»';

export default class OtherList extends LightningElement {
    @wire(«-GA:lwc-other|getAccounts», { n: 1 }) rows;
}
`,
	[`${FLOWS}/Account_Flow.flow-meta.xml`]: `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <actionCalls>
        <name>Run_Invocable</name>
        <label>Run</label>
        <actionName>«INV:flow,RUN:flow|AccountInvocable»</actionName>
        <actionType>apex</actionType>
    </actionCalls>
    <variables>
        <name>svc</name>
        <apexClass>«C:flow|AccountService»</apexClass>
        <dataType>Apex</dataType>
    </variables>
</Flow>
`,
};

const BUFFERS: Record<string, string> = {
	[`${CLS}/Draft.cls`]: `public class Draft {
    public void go() {
        «C:unsaved|AccountService» svc = new «C:unsaved|AccountService»();
        svc.«DS:unsaved|describe»();
    }
}
`,
};

export function fillerSource(i: number, n: number, realEvery: number, bulk: number): string {
	const next = (i + 1) % n;
	const j = (i + 7) % n;
	const real = i % realEvery === Math.floor(realEvery / 2);
	// Realistic bulk: methods with locals, loops, SOQL and calls on unrelated types.
	let extra = "";
	for (let k = 0; k < bulk; k++) {
		extra += `
    public List<Account> bulk${k}(Integer limitTo, String label) {
        List<Account> rows = [SELECT Id, Name FROM Account WHERE Name LIKE :label LIMIT :limitTo];
        Map<Id, Account> byId = new Map<Id, Account>(rows);
        for (Account a : rows) {
            if (a.Name != null && byId.containsKey(a.Id)) {
                a.Name = a.Name.trim() + ' ${k}';
            }
        }
        Filler${j} other = new Filler${j}();
        other.describe();
        return rows;
    }
`;
	}
	return `public class Filler${i} {
    private Filler${next} next;
    public String describe() { return 'f${i}'; }
    public void handle() {}
    public Integer getAccounts(Integer x) { return x; }
    public String Status;
    public void work() {
        Filler${j} f = new Filler${j}();
        f.describe();
        this.describe();
        describe();
        handle();
        next.getAccounts(1);
        Status = 'AccountService';
        String s = 'AccountService' + f.Status;${
			real
				? `
        «C:filler|AccountService» svc = «C:filler|AccountService».«INST:filler|instance»();
        svc.«DS:filler|describe»();
        «C:filler|AccountService».«GA:filler|getAccounts»(${i});`
				: ""
		}
    }${extra}
}
`;
}

const MARK = /«([^|»]*)\|([^»]*)»/g;

export function strip(file: string, src: string, fx: { expected: Map<string, ExpLoc[]>; negatives: Map<string, ExpLoc[]>; anchors: Map<string, ExpLoc> }): string {
	const lines = src.split("\n");
	const out: string[] = [];
	lines.forEach((line, lineNo) => {
		let result = "";
		let last = 0;
		for (const m of line.matchAll(MARK)) {
			result += line.slice(last, m.index);
			const character = result.length;
			const text = m[2];
			for (const raw of m[1].split(",")) {
				const spec = raw.trim();
				if (!spec) continue;
				if (spec.startsWith("@")) {
					fx.anchors.set(spec.slice(1), { file, line: lineNo, character, length: text.length, cat: "anchor" });
					continue;
				}
				const neg = spec.startsWith("-");
				const [sym, cat] = (neg ? spec.slice(1) : spec).split(":");
				const map = neg ? fx.negatives : fx.expected;
				const list = map.get(sym) ?? [];
				list.push({ file, line: lineNo, character, length: text.length, cat: cat ?? "?" });
				map.set(sym, list);
			}
			result += text;
			last = (m.index ?? 0) + m[0].length;
		}
		out.push(result + line.slice(last));
	});
	return out.join("\n");
}

/**
 * `fillers`: number of filler classes; `realEvery`: every n-th filler really uses
 * AccountService (default 100); `bulk`: extra realistic methods per filler (default 0).
 */
export function buildRefFixture(opts: { fillers?: number; realEvery?: number; bulk?: number } = {}): RefFixture {
	const fx: RefFixture = { files: {}, buffers: {}, expected: new Map(), negatives: new Map(), anchors: new Map() };
	const sources: Record<string, string> = { ...SOURCES };
	const n = opts.fillers ?? 0;
	for (let i = 0; i < n; i++) sources[`${CLS}/fillers/Filler${i}.cls`] = fillerSource(i, n, opts.realEvery ?? 100, opts.bulk ?? 0);
	for (const [file, src] of Object.entries(sources)) {
		// A file with an unsaved buffer contributes its expectations from the buffer only.
		if (BUFFERS[file] !== undefined) fx.files[file] = src.replace(MARK, "$2");
		else fx.files[file] = strip(file, src, fx);
	}
	for (const [file, src] of Object.entries(BUFFERS)) fx.buffers[file] = strip(file, src, fx);
	return fx;
}

export function writeRefFixture(root: string, fx: RefFixture): void {
	const metaFor = (rel: string): string | undefined => {
		if (rel.endsWith(".cls")) return META();
		if (rel.endsWith(".trigger")) return META().replace(/ApexClass/g, "ApexTrigger");
		return undefined;
	};
	fs.writeFileSync(
		path.join(root, "sfdx-project.json"),
		JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }], namespace: "myns", sourceApiVersion: "60.0" }, null, 2),
	);
	for (const [rel, text] of Object.entries(fx.files)) {
		const full = path.join(root, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, text);
		const meta = metaFor(rel);
		if (meta) fs.writeFileSync(full + "-meta.xml", meta);
	}
}

/** Key for comparing locations: `file:line:char:len`. */
export function locKey(file: string, line: number, character: number, length: number): string {
	return `${file}:${line}:${character}:${length}`;
}

export interface CatScore {
	expected: number;
	found: number;
	falsePositives: number;
}

/** Score one result list against the ground truth of `sym`: per-category recall + FP counts. */
export function scoreRefs(
	fx: RefFixture,
	sym: string,
	got: { file: string; line: number; character: number; length: number }[],
): { cats: Map<string, CatScore>; missing: ExpLoc[]; extra: { file: string; line: number; character: number; length: number; cat: string }[] } {
	const exp = fx.expected.get(sym) ?? [];
	const neg = new Map((fx.negatives.get(sym) ?? []).map((n) => [locKey(n.file, n.line, n.character, n.length), n] as const));
	const gotKeys = new Set(got.map((g) => locKey(g.file, g.line, g.character, g.length)));
	const expKeys = new Set(exp.map((e) => locKey(e.file, e.line, e.character, e.length)));
	const cats = new Map<string, CatScore>();
	const cat = (c: string) => {
		let s = cats.get(c);
		if (!s) cats.set(c, (s = { expected: 0, found: 0, falsePositives: 0 }));
		return s;
	};
	const missing: ExpLoc[] = [];
	for (const e of exp) {
		const s = cat(e.cat);
		s.expected++;
		if (gotKeys.has(locKey(e.file, e.line, e.character, e.length))) s.found++;
		else missing.push(e);
	}
	const extra: { file: string; line: number; character: number; length: number; cat: string }[] = [];
	const seen = new Set<string>();
	for (const g of got) {
		const k = locKey(g.file, g.line, g.character, g.length);
		if (expKeys.has(k) || seen.has(k)) continue;
		seen.add(k);
		const n = neg.get(k);
		const c = n ? n.cat : "other";
		cat(c).falsePositives++;
		extra.push({ ...g, cat: c });
	}
	return { cats, missing, extra };
}
