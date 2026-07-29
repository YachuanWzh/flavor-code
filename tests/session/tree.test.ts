import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ContextSnapshot } from "../../src/context/manager.js";
import { SessionHistory } from "../../src/session/tree.js";

const context = (content: string): ContextSnapshot => ({
  messages: [{ role: "user", content }],
});

describe("SessionHistory", () => {
  it("preserves branches when appending after moving the leaf", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-tree-"));
    const history = await SessionHistory.open({ workspace: root, sessionId: "session-test" });
    const rootNode = await history.append({ prompt: "root", context: context("root") });
    const first = await history.append({ prompt: "first", context: context("first") });
    await history.moveTo(rootNode.id);
    const second = await history.append({ prompt: "second", context: context("second") });

    expect(first.parentId).toBe(rootNode.id);
    expect(second.parentId).toBe(rootNode.id);
    expect(history.tree().filter((node) => node.parentId === rootNode.id)).toHaveLength(2);

    const reopened = await SessionHistory.open({ workspace: root, sessionId: "session-test" });
    expect(reopened.leafId).toBe(second.id);
    expect(reopened.tree()).toHaveLength(3);
  });

  it("rewinds files and context and can unrevert", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-tree-rewind-"));
    const file = join(root, "value.txt");
    await writeFile(file, "one");
    const restored: ContextSnapshot[] = [];
    const history = await SessionHistory.open({
      workspace: root,
      sessionId: "session-test",
      restoreContext: (snapshot) => { restored.push(snapshot); },
    });
    const first = await history.append({ prompt: "one", context: context("one") });
    await writeFile(file, "two");
    const second = await history.append({ prompt: "two", context: context("two") });

    await history.rewind(first.id, context("current"));
    expect(await readFile(file, "utf8")).toBe("one");
    expect(restored.at(-1)).toEqual(context("one"));
    expect(history.leafId).toBe(first.id);

    await history.unrevert();
    expect(await readFile(file, "utf8")).toBe("two");
    expect(restored.at(-1)).toEqual(context("current"));
    expect(history.leafId).toBe(second.id);
  });
});
