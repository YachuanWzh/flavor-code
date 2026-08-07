import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Usage file logging is always on; keep test output out of the workspace.
process.env.FLAVOR_USAGE_FILE ??= join(tmpdir(), "flavor-test-usage.jsonl");

export default defineConfig({
  resolve: {
    alias: {
      src: fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    restoreMocks: true,
    exclude: [...configDefaults.exclude, "**/.worktrees/**"],
  },
});
