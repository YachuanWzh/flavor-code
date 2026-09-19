import { PassThrough } from "node:stream";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";

import Box from "../../src/claude-ink/components/Box.js";
import Text from "../../src/claude-ink/components/Text.js";
import Ink from "../../src/claude-ink/ink.js";
import type { Frame } from "../../src/claude-ink/frame.js";

type MutableWriteStream = NodeJS.WriteStream & {
  columns: number;
  rows: number;
  isTTY: boolean;
};

type InspectableInk = {
  render: Ink["render"];
  unmount: Ink["unmount"];
  setAltScreenActive: Ink["setAltScreenActive"];
  dispatchHover: Ink["dispatchHover"];
  frontFrame: Frame;
  onRender: () => void;
};

const mounted: Ink[] = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
});

function createInk(): InspectableInk {
  const stdout = new PassThrough() as unknown as MutableWriteStream;
  stdout.columns = 40;
  stdout.rows = 10;
  stdout.isTTY = false;
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  const ink = new Ink({ stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false });
  mounted.push(ink);
  return ink as unknown as InspectableInk;
}

function Panel({ show, onEnter, onLeave }: {
  show: boolean;
  onEnter: () => void;
  onLeave: () => void;
}): React.JSX.Element {
  return (
    <Box width={40} height={10}>
      {show
        ? <Box key="panel" width={20} height={5} onMouseEnter={onEnter} onMouseLeave={onLeave}>
            <Text>panel</Text>
          </Box>
        : <Box key="placeholder" width={20} height={5} />}
    </Box>
  );
}

describe("hover cleanup on detach", () => {
  it("fires onMouseLeave when the hovered node is unmounted before the next pointer move", () => {
    const ink = createInk();
    const events: string[] = [];
    ink.render(<Panel show onEnter={() => events.push("enter")} onLeave={() => events.push("leave")} />);
    ink.setAltScreenActive(true, false);
    ink.onRender();

    // Pointer moves onto the panel → enter fires.
    ink.dispatchHover(2, 2);
    expect(events).toEqual(["enter"]);

    // Panel unmounts while the pointer sits still (task panel layout flip).
    ink.render(<Panel show={false} onEnter={() => events.push("enter")} onLeave={() => events.push("leave")} />);
    ink.onRender();

    // Any later pointer motion must clear the stale hover state — even
    // though the hovered node is already detached from the tree.
    ink.dispatchHover(5, 5);
    expect(events).toEqual(["enter", "leave"]);
  });
});
