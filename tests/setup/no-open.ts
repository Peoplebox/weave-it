import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// No test may open a real terminal or app, or read the developer's ~/.weave/settings.yml.
// Tests that exercise opening clear WEAVE_NO_OPEN themselves and inject a recording registry.
process.env.WEAVE_NO_OPEN = "1";
process.env.WEAVE_USER_HOME = mkdtempSync(path.join(os.tmpdir(), "weave-test-home-"));
