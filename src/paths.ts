import path from "node:path";

let dataDir = process.env.AI_APPLIER_DATA ?? "./data";

export function setDataDir(dir: string): void {
  dataDir = dir;
}

export const paths = {
  get dataDir() {
    return dataDir;
  },
  get db() {
    return path.join(dataDir, "app.db");
  },
  get records() {
    return path.join(dataDir, "records");
  },
  get browserProfile() {
    return path.join(dataDir, "browser-profile");
  },
  get resume() {
    return path.join(dataDir, "resume.pdf");
  },
};
