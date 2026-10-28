import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setDataDir } from "../src/paths.js";

setDataDir(mkdtempSync(path.join(tmpdir(), "ai-applier-test-")));
