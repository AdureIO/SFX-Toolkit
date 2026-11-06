/**
 * Ground-truth workspace for Go to Definition tests.
 *
 * Markers `«@anchor|text»` name positions (stripped when the files are written):
 *   `d.KEY`        the declaration NAME that call sites of KEY must land on
 *   `c.KEY.tag`    a use whose definition is `d.KEY`
 *   `x.tag`        a use that must NOT resolve to any workspace declaration
 * Every use sits in a file other than its target, except where noted; target files are
 * never opened by the tests (unopened), except the unsaved buffer `Edited.cls`.
 *
 * `fillers` adds that many unrelated classes (same member names as the targets) for the
 * 2000-class latency / precision run.
 */
import { CLS, TRG, RefFixture, ExpLoc, strip, fillerSource } from "./refWorkspace";

const SOURCES: Record<string, string> = {
	[`${CLS}/Animal.cls`]: `public virtual class «@d.animal|Animal» {
    public String «@d.aname|name»;
    public Integer «@d.aage|Age» { get; set; }
    public static Integer «@d.acount|count» = 0;
    public virtual String «@d.speak|speak»() { return 'generic'; }
    public String «@d.feed|feed»() { return 'fed'; }
    public static Animal «@d.make|make»() { return new Animal(); }
    public static String «@d.kind|kind»() { return 'animal'; }
    public String «@d.over0|over»() { return '0'; }
    public String «@d.over1i|over»(Integer a) { return 'i'; }
    public String «@d.over1s|over»(String a) { return 's'; }
    public String «@d.over1a|over»(Account a) { return 'a'; }
    public String «@d.over2ii|over»(Integer a, Integer b) { return 'ii'; }
    public String «@d.over2si|over»(String a, Integer b) { return 'si'; }
    public String «@d.pickS|pick»(String a) { return 's'; }
    public String «@d.pickI|pick»(Integer a) { return 'i'; }
    public Account «@d.mkacc|mkAccount»() { return new Account(); }
    public String «@d.mkstr|mkText»() { return ''; }
    public void callSelf() {
        this.«@c.feed.self1|feed»();
        «@c.feed.self2|feed»();
        «@c.speak.self3|speak»();
        this.«@c.over1i.self4|over»(1);
    }
}
`,
	[`${CLS}/Dog.cls`]: `public class «@d.dog|Dog» extends Animal {
    public «@d.dctor1|Dog»(String n) { this.name = n; }
    public «@d.dctor2|Dog»(Integer a, Integer b) { }
    public «@d.dctor3|Dog»(Account a) { }
    public override String «@d.dspeak|speak»() { return 'woof'; }
    public String «@d.bark|bark»() { return 'b'; }
    public void run() {
        «@c.dspeak.run1|speak»();
        this.«@c.dspeak.run2|speak»();
        super.«@c.speak.run3|speak»();
        «@c.feed.run4|feed»();
        this.«@c.feed.run5|feed»();
        super.«@c.feed.run6|feed»();
        String s = «@c.aname.run7|name»;
        Integer a = this.«@c.aage.run8|Age»;
    }
}
`,
	[`${CLS}/Puppy.cls`]: `public class «@d.puppy|Puppy» extends Dog {
    public void walk() { }
}
`,
	[`${CLS}/Kitten.cls`]: `public class «@d.kitten|Kitten» extends Animal {
}
`,
	[`${CLS}/Shape.cls`]: `public interface Shape {
    Double «@d.ishape|area»();
}
`,
	[`${CLS}/Circle.cls`]: `public class Circle implements Shape {
    public Double «@d.carea|area»() { return 1; }
}
`,
	[`${CLS}/Holder.cls`]: `public class «@d.holder|Holder» {
    public Animal «@d.hpet|pet»;
    public Dog «@d.hdog|dog» { get; set; }
    public List<Dog> dogs = new List<Dog>();
    public Map<String, Dog> byName = new Map<String, Dog>();
    public Dog «@d.hget|getDog»() { return dog; }
    public Holder «@d.hme|me»() { return this; }
    public class «@d.inner|Nested» {
        public String «@d.itag|tag»;
        public static String «@d.iping|ping»() { return 'p'; }
    }
    public enum «@d.color|Color» { «@d.red|RED», GREEN }
}
`,
	// Same member names, unrelated type: must never be returned for an Animal / Dog receiver.
	[`${CLS}/Decoy.cls`]: `public class «@d.decoy|Decoy» {
    public String name;
    public Integer Age { get; set; }
    public String «@d.decoyspeak|speak»() { return 'decoy'; }
    public String feed() { return 'decoy'; }
    public String bark() { return 'decoy'; }
    public static String kind() { return 'decoy'; }
    public String over(Integer a) { return 'decoy'; }
    public String pick(String a) { return 'decoy'; }
    public Holder getDog() { return null; }
}
`,
	[`${CLS}/Caller.cls`]: `public class Caller {
    private Dog fieldDog;
    public Animal propAnimal { get; set; }
    public Decoy decoy;

    public void go(Dog paramDog, Holder h, List<Dog> dogs, Map<String, Dog> byName, Shape sh, Circle ci, Puppy pup, Animal an, Kitten kit) {
        // constructors
        String str = 'x';
        Integer n = 5;
        Account acc = new Account();
        Dog local = new «@c.dctor1.new1|Dog»('rex');
        Dog l2 = new «@c.dctor2.new2|Dog»(1, 2);
        Dog l3 = new «@c.dctor1.new3|Dog»(str);
        Dog l4 = new «@c.dctor3.new4|Dog»(acc);
        Dog l5 = new «@c.dctor3.new5|Dog»(new Account());
        Puppy p2 = new «@c.puppy.new6|Puppy»();
        Animal a2 = new «@c.animal.new7|Animal»();
        Holder.Nested hi = new Holder.«@c.inner.new8|Nested»();
        // instance receivers: local, param, field, property, this.field
        local.«@c.dspeak.i1|speak»();
        paramDog.«@c.dspeak.i2|speak»();
        fieldDog.«@c.dspeak.i3|speak»();
        this.fieldDog.«@c.dspeak.i4|speak»();
        propAnimal.«@c.speak.i5|speak»();
        decoy.«@c.decoyspeak.i6|speak»();
        local.«@c.dspeak.i7|SPEAK»();
        // inheritance and overrides
        pup.«@c.dspeak.h1|speak»();
        pup.«@c.feed.h2|feed»();
        pup.«@c.bark.h3|bark»();
        kit.«@c.speak.h4|speak»();
        an.«@c.speak.h5|speak»();
        sh.«@c.ishape.h6|area»();
        ci.«@c.carea.h7|area»();
        // chains
        h.«@c.hget.ch1|getDog»().«@c.dspeak.ch2|speak»();
        h.«@c.hme.ch3|me»().«@c.hme.ch4|me»().«@c.hget.ch5|getDog»().«@c.bark.ch6|bark»();
        h.«@c.hdog.ch7|dog».«@c.bark.ch8|bark»();
        dogs[0].«@c.bark.ch9|bark»();
        dogs.get(0).«@c.bark.ch10|bark»();
        byName.get('k').«@c.bark.ch11|bark»();
        for (Dog d : dogs) { d.«@c.bark.ch12|bark»(); }
        for (Dog d2 : h.dogs) { d2.«@c.bark.ch13|bark»(); }
        Animal.«@c.make.ch14|make»().«@c.speak.ch15|speak»();
        h.«@c.hpet.ch16|pet».«@c.speak.ch17|speak»();
        // statics
        Animal.«@c.kind.s1|kind»();
        Dog.«@c.kind.s2|kind»();
        Puppy.«@c.kind.s3|kind»();
        Integer cnt = Animal.«@c.acount.s4|count»;
        myns.Animal.«@c.kind.s5|kind»();
        myns.«@c.animal.s6|Animal».kind();
        «@c.animal.s7|ANIMAL».«@c.kind.s8|KIND»();
        // properties, fields, inner types, enums
        Integer age = local.«@c.aage.p1|Age»;
        String nm = local.«@c.aname.p2|name»;
        Holder.«@c.inner.in1|Nested».«@c.iping.in2|ping»();
        hi.«@c.itag.in3|tag» = 'x';
        Holder.Color col = Holder.«@c.color.e1|Color».«@c.red.e2|RED»;
        Holder.«@c.color.e3|Color» col2 = null;
        // overloads by argument count and by argument types
        an.«@c.over0.o1|over»();
        an.«@c.over1i.o2|over»(1);
        an.«@c.over1s.o3|over»('x');
        an.«@c.over1a.o4|over»(new Account());
        an.«@c.over1i.o5|over»(n);
        an.«@c.over1s.o6|over»(str);
        an.«@c.over1a.o7|over»(acc);
        an.«@c.over1a.o8|over»(an.«@c.mkacc.o9|mkAccount»());
        an.«@c.over1s.o10|over»(an.«@c.mkstr.o11|mkText»());
        an.«@c.over2ii.o12|over»(1, 2);
        an.«@c.over2si.o13|over»('a', 2);
        an.«@c.over2si.o14|over»(str, n);
        an.«@c.pickS.o15|pick»(Mystery.value());
        // SOQL binds and string concatenation
        List<Account> accs = [SELECT Id FROM Account WHERE Name = :local.«@c.aname.q1|name» LIMIT :h.«@c.hget.q2|getDog»().«@c.aage.q3|Age»];
        String msg = 'Dog ' + local.«@c.dspeak.q4|speak»() + ' says ' + h.«@c.hdog.q5|dog».«@c.bark.q6|bark»();
        // unresolvable receivers must not land on a same-named member of another type
        Mystery mys = null;
        mys.«@x.u1|speak»();
        str.«@x.u2|length»();
        // unsaved edits in an open target file
        Edited.«@c.fresh.b1|fresh»();
        Edited.«@c.old.b2|old»();
    }
}
`,
	[`${CLS}/SyntaxErr.cls`]: `public class SyntaxErr {
    public void broken() {
        Integer x = ;
        if ( {
    }
    public void ok(Dog d, Holder h) {
        d.«@c.bark.se1|bark»();
        h.«@c.hget.se2|getDog»().«@c.dspeak.se3|speak»();
    }
}
`,
	[`${CLS}/CallerTest.cls`]: `@IsTest
private class CallerTest {
    @IsTest static void works() {
        Dog d = new «@c.dctor1.t1|Dog»('x');
        d.«@c.dspeak.t2|speak»();
        Animal.«@c.kind.t3|kind»();
        System.assertEquals('x', d.«@c.aname.t4|name»);
    }
}
`,
	[`${TRG}/DefTrigger.trigger`]: `trigger DefTrigger on Account (before insert) {
    Animal.«@c.kind.tr1|kind»();
    Dog dg = new Dog('a');
    dg.«@c.dspeak.tr2|speak»();
}
`,
};

/** The disk copy of the buffered file differs from the editor buffer (unsaved edits). */
const DISK_EDITED = `public class Edited {
    public static String old() { return ''; }
}
`;

const BUFFERS: Record<string, string> = {
	[`${CLS}/Edited.cls`]: `// an unsaved edit pushes everything down
// by two lines
public class Edited {
    public static String «@d.old|old»() { return ''; }
    public static String «@d.fresh|fresh»() { return 'new'; }
}
`,
};

/**
 * Definition ground truth. Fillers reuse member names (describe / handle / getAccounts)
 * of other types; `realEvery` is huge so none of them touches the targets.
 */
export function buildDefFixture(opts: { fillers?: number } = {}): RefFixture {
	const fx: RefFixture = { files: {}, buffers: {}, expected: new Map(), negatives: new Map(), anchors: new Map() };
	const sources: Record<string, string> = { ...SOURCES };
	const n = opts.fillers ?? 0;
	for (let i = 0; i < n; i++) sources[`${CLS}/fillers/Filler${i}.cls`] = fillerSource(i, n, 1_000_000_000, 0);
	for (const [file, src] of Object.entries(sources)) fx.files[file] = strip(file, src, fx);
	fx.files[`${CLS}/Edited.cls`] = DISK_EDITED;
	for (const [file, src] of Object.entries(BUFFERS)) fx.buffers[file] = strip(file, src, fx);
	return fx;
}

/** Expected declaration (name span) for a use anchor `c.KEY.tag`. */
export function targetOf(fx: RefFixture, anchor: string): ExpLoc | undefined {
	const key = anchor.split(".")[1];
	return fx.anchors.get(`d.${key}`);
}
