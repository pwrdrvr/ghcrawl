import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseReleaseTag } from "./release-tag.mjs";

const workspaceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = parseReleaseTag(process.argv[2]).version;

const packageJsonPaths = [
  "package.json",
  "apps/cli/package.json",
  "apps/web/package.json",
  "packages/api-contract/package.json",
  "packages/api-core/package.json",
];

for (const relativePath of packageJsonPaths) {
  const absolutePath = path.join(workspaceRoot, relativePath);
  const packageJson = JSON.parse(readFileSync(absolutePath, "utf8"));
  packageJson.version = version;
  writeFileSync(absolutePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  process.stdout.write(`updated ${relativePath} -> ${version}\n`);
}
