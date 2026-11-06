import * as assert from "assert";
import { FileEventBatcher, mergeFileChange, FILE_CREATED, FILE_CHANGED, FILE_DELETED } from "../utils/fileEventBatcher";

describe("FileEventBatcher (watcher dedupe)", () => {
	it("keeps one event per URI instead of truncating a huge burst", () => {
		const b = new FileEventBatcher();
		for (let round = 0; round < 3; round++) {
			for (let i = 0; i < 20000; i++) b.add(`file:///p/C${i}.cls`, FILE_CHANGED);
		}
		assert.strictEqual(b.size, 20000);
		const out = b.drain();
		assert.strictEqual(out.length, 20000, "no file is dropped");
		assert.ok(out.some((e) => e.uri === "file:///p/C0.cls"), "the oldest files survive");
		assert.strictEqual(b.size, 0);
	});

	it("merges consecutive change types into the net effect", () => {
		assert.strictEqual(mergeFileChange(undefined, FILE_DELETED), FILE_DELETED);
		assert.strictEqual(mergeFileChange(FILE_CREATED, FILE_CHANGED), FILE_CREATED);
		assert.strictEqual(mergeFileChange(FILE_CREATED, FILE_DELETED), FILE_DELETED);
		assert.strictEqual(mergeFileChange(FILE_CHANGED, FILE_DELETED), FILE_DELETED);
		assert.strictEqual(mergeFileChange(FILE_DELETED, FILE_CREATED), FILE_CHANGED);
	});

	it("reports the last net change per file", () => {
		const b = new FileEventBatcher();
		b.add("file:///a.cls", FILE_CREATED);
		b.add("file:///b.cls", FILE_CHANGED);
		b.add("file:///a.cls", FILE_CHANGED);
		b.add("file:///b.cls", FILE_DELETED);
		const out = new Map(b.drain().map((e) => [e.uri, e.type]));
		assert.strictEqual(out.get("file:///a.cls"), FILE_CREATED);
		assert.strictEqual(out.get("file:///b.cls"), FILE_DELETED);
	});
});
