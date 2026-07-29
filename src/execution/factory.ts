import type { FlavorConfig } from "../config/schema.js";
import { DockerExecutionEnvironment } from "./docker.js";
import type { ExecutionEnvironment } from "./types.js";

export function createExecutionEnvironment(
  workspace: string,
  config: Pick<FlavorConfig["execution"], "mode"> & Partial<Omit<FlavorConfig["execution"], "mode">>,
): ExecutionEnvironment | undefined {
  if (config.mode === "local") return undefined;
  return new DockerExecutionEnvironment({
    workspace,
    image: config.image ?? "node:24-bookworm-slim",
    network: config.network ?? false,
    memory: config.memory ?? "2g",
    cpus: config.cpus ?? 2,
  });
}
