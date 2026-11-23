// Mocha --require: isolate the unit tests from the developer's real global Salesforce CLI
// config (~/.sf, ~/.sfdx), which the default-org resolution reads as a fallback.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sfx-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
