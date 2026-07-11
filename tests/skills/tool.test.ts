import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { HookBus } from "../../src/hooks/bus.js";
import { PermissionEngine } from "../../src/permissions/engine.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { createSkillResourceTool } from "../../src/skills/tool.js";
import { ToolRuntime } from "../../src/tools/runtime.js";

describe("SkillResource tool", () => {
  it("reads only explicitly referenced text/binary resources and works for children", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-skill-tool-"));
    const root = join(workspace, ".flavor", "skills", "cook");
    await mkdir(join(root, "references"), { recursive: true }); await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "SKILL.md"), `---\nname: cook\ndescription: cooking help\n---\n[text](references/info.txt) ![bin](assets/pic.bin)`);
    await writeFile(join(root, "references", "info.txt"), "saffron");
    await writeFile(join(root, "references", "hidden.txt"), "secret");
    await writeFile(join(root, "assets", "pic.bin"), Buffer.from([0xff, 0x00, 0xfe]));
    const registry = new SkillRegistry({ projectRoots: [join(workspace, ".flavor", "skills")], authorizeResource: async () => true });
    const runtime = new ToolRuntime({ tools: [createSkillResourceTool(registry)], hooks: new HookBus(),
      permissions: new PermissionEngine({ workspace }) });
    await expect(runtime.execute({ name: "SkillResource", input: { skill: "cook", reference: "references/info.txt" } }, { agent: "subagent" }))
      .resolves.toMatchObject({ ok: true, output: { encoding: "utf8", content: "saffron" } });
    await expect(runtime.execute({ name: "SkillResource", input: { skill: "cook", reference: "assets/pic.bin" } }, { agent: "main" }))
      .resolves.toMatchObject({ ok: true, output: { encoding: "base64", content: "/wD+", size: 3 } });
    await expect(runtime.execute({ name: "SkillResource", input: { skill: "cook", reference: "references/hidden.txt" } }, { agent: "main" }))
      .resolves.toMatchObject({ ok: false });
  });
});
