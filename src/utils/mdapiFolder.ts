import * as fs from 'fs';
import * as path from 'path';

const MDAPI_PACKAGE_XMLNS = /<Package\s[^>]*xmlns\s*=\s*["']http:\/\/soap\.sforce\.com\/2006\/04\/metadata["']/;

/** True when `dir` or any ancestor contains sfdx-project.json. */
export function hasSfdxProjectUpward(dir: string): boolean {
    let d = dir;
    for (let i = 0; i < 100; i++) {
        if (fs.existsSync(path.join(d, 'sfdx-project.json'))) return true;
        const parent = path.dirname(d);
        if (parent === d) break;
        d = parent;
    }
    return false;
}

/**
 * A legacy Metadata API (MDAPI) project folder: `<dir>/src/package.xml` is a Metadata
 * `<Package xmlns="http://soap.sforce.com/2006/04/metadata">` and there is no
 * sfdx-project.json in `dir` or any ancestor.
 */
export function isMdapiFolder(dir: string): boolean {
    try {
        const pkg = path.join(dir, 'src', 'package.xml');
        if (!fs.existsSync(pkg)) return false;
        const fd = fs.openSync(pkg, 'r');
        let head: string;
        try {
            const buf = Buffer.alloc(4096);
            const n = fs.readSync(fd, buf, 0, buf.length, 0);
            head = buf.toString('utf8', 0, n);
        } finally {
            fs.closeSync(fd);
        }
        if (!MDAPI_PACKAGE_XMLNS.test(head)) return false;
        return !hasSfdxProjectUpward(dir);
    } catch {
        return false;
    }
}
