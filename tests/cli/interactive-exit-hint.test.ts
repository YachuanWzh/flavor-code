import { describe, expect, it, vi, afterEach } from "vitest";
import chalk from "chalk";

vi.mock("../../src/claude-ink/index.js", () => ({
  render: vi.fn(),
  AlternateScreen: function AlternateScreen(props: { children?: unknown }): unknown { return props.children; },
}));

vi.mock("../../src/ui/app.js", () => ({
  App: function App(): null { return null; },
}));

import { createProgram } from "../../src/cli.js";
import { render } from "../../src/claude-ink/index.js";

interface RenderedElement {
  props: { children?: { props: { onSessionEnd?: (sessionId: string) => void } } };
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, "");

describe("runInteractiveCli session-end hint", () => {
  afterEach(() => {
    vi.mocked(render).mockReset();
    vi.restoreAllMocks();
  });

  it("prints the resume hint with the session id after the interactive UI exits", async () => {
    let capturedOnSessionEnd: ((sessionId: string) => void) | undefined;
    vi.mocked(render).mockImplementation((async (element: unknown) => {
      capturedOnSessionEnd = (element as RenderedElement).props.children?.props.onSessionEnd;
      return {
        waitUntilExit: async () => {
          capturedOnSessionEnd?.("session-test-123");
        },
      };
    }) as never);

    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const program = createProgram({ isTTY: () => true, randomUUID: () => "instance-id" });
    await program.parseAsync(["node", "flavor"]);

    expect(capturedOnSessionEnd).toBeTypeOf("function");
    const output = write.mock.calls.map((call) => String(call[0])).join("");
    expect(stripAnsi(output)).toContain("Resume later with: flavor --resume session-test-123");
    expect(stripAnsi(output)).not.toContain("Session saved:");
    if (chalk.level > 0) {
      expect(output).toContain(chalk.cyan("flavor --resume session-test-123"));
    }
  });

  it("does not print anything when the runtime never produced a session id", async () => {
    vi.mocked(render).mockImplementation((async () => ({
      waitUntilExit: async () => undefined,
    })) as never);

    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const program = createProgram({ isTTY: () => true, randomUUID: () => "instance-id" });
    await program.parseAsync(["node", "flavor"]);

    const output = write.mock.calls.map((call) => String(call[0])).join("");
    expect(output).not.toContain("Resume later with:");
  });
});
