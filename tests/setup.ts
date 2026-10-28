import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setDataDir } from "../src/paths.js";

// Forms are filled at full speed in tests (see src/forms/pace.ts).
process.env.AI_APPLIER_PACE = "off";

setDataDir(mkdtempSync(path.join(tmpdir(), "ai-applier-test-")));
