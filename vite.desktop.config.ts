import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve("src/desktop/renderer"),
  base: "./",
  server: { host: "127.0.0.1", port: 5177, strictPort: true },
  build: {
    outDir: resolve("dist/desktop-renderer"),
    emptyOutDir: true,
    sourcemap: true,
  },
});

