import { describe, expect, it } from "vitest";

import * as sdk from "../../src/sdk/index.js";

describe("public SDK", () => {
  it("exports runtime, session, RPC, trace, history, and execution primitives", () => {
    expect(sdk.createProductionRuntime).toBeTypeOf("function");
    expect(sdk.createFlavorRuntime).toBe(sdk.createProductionRuntime);
    expect(sdk.AgentMessageQueue).toBeTypeOf("function");
    expect(sdk.FlavorSession).toBeTypeOf("function");
    expect(sdk.FlavorRpcServer).toBeTypeOf("function");
    expect(sdk.TraceRecorder).toBeTypeOf("function");
    expect(sdk.SessionHistory).toBeTypeOf("function");
    expect(sdk.DockerExecutionEnvironment).toBeTypeOf("function");
  });
});
