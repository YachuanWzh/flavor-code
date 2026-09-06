import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const files = (await readdir("dist", { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
  .map((entry) => join("dist", entry.name));

const forbidden = [
  "logComponentRender",
  "react-reconciler.development",
];

for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const signature of forbidden) {
    if (source.includes(signature)) {
      throw new Error(`Production CLI contains React development profiler signature ${JSON.stringify(signature)} in ${file}`);
    }
  }
}

process.stdout.write(`production-cli-check: ${files.length} bundles contain no React development profiler\n`);
