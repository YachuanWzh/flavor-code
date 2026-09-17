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
    // An inherited NODE_ENV=production (e.g. running tests from a packaged
    // agent shell) would load React's production internals while dev/act
    // paths in react-reconciler still expect actQueue; pin the test default.
    env: { NODE_ENV: "test" },
    // Windows process creation, Git worktrees and Electron-adjacent fixtures
    // routinely exceed Vitest's 5s default when the full suite runs in parallel.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    exclude: [...configDefaults.exclude, "**/.worktrees/**"],
  },
});
