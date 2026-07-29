import { describe, expect, it, vi } from "vitest";

import { DockerExecutionEnvironment, buildDockerInvocation } from "../../src/execution/docker.js";

describe("DockerExecutionEnvironment", () => {
  it("builds a fail-closed, injection-safe invocation with default isolation", () => {
    const invocation = buildDockerInvocation({
      workspace: "C:\\work\\demo",
      image: "node:24-bookworm-slim",
      request: { command: "npm", args: ["test", "--", "a; rm -rf /"], cwd: "C:\\work\\demo\\src" },
    });
    expect(invocation.command).toBe("docker");
    expect(invocation.args).toContain("--network");
    expect(invocation.args).toContain("none");
    expect(invocation.args).toContain("--read-only");
    expect(invocation.args).toContain("no-new-privileges");
    expect(invocation.args).toContain("type=bind,source=C:\\work\\demo,target=/workspace");
    expect(invocation.args).toContain("/workspace/src");
    expect(invocation.args.slice(-4)).toEqual(["npm", "test", "--", "a; rm -rf /"]);
  });

  it("removes only the network-none restriction when network is enabled", () => {
    const invocation = buildDockerInvocation({
      workspace: "/work", image: "node:24", network: true,
      request: { command: "npm", args: ["view", "react"], cwd: "/work" },
    });
    expect(invocation.args).not.toContain("none");
    expect(invocation.args).toContain("--cap-drop");
  });

  it("never falls back to local execution when docker is unavailable", async () => {
    const run = vi.fn(async () => ({
      exitCode: 127, signal: null, stdout: "", stderr: "docker missing", terminationReason: null,
    }));
    const environment = new DockerExecutionEnvironment({ workspace: "/work", image: "node:24", run });
    const result = await environment.exec({ command: "npm", args: ["test"], cwd: "/work" });
    expect(run).toHaveBeenCalledOnce();
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("docker missing");
  });
});
