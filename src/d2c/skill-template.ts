import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const D2C_SKILL_NAME = "d2c-pixso";

/** Full SKILL.md content guiding the Pixso design-to-Vue workflow. */
export function d2cSkillContent(): string {
  return `---
name: ${D2C_SKILL_NAME}
description: Convert a Pixso design export (HTML) into a pixel-faithful Vue implementation, then verify visual fidelity with the D2C diff engine and repair deviations until the similarity score passes.
---

# Pixso Design to Vue (D2C)

Use this skill when the user wants to turn an imported Pixso design into Vue code and verify the visual fidelity of the result.

## Workflow

1. **Import the design.** Call the \`D2cImport\` tool with the directory the user exported from Pixso and a short kebab-case task name (e.g. \`homepage\`). The tool copies the export into \`.flavor/d2c/<task>/design/\` and reports the entry HTML. If the import fails because no HTML file exists, ask the user to re-export from Pixso with HTML included.
2. **Study the design before writing code.** Read the entry HTML and its referenced CSS. Identify the page structure: layout containers, text nodes, images, colors, font sizes and font families. Keep the original design tokens (exact hex colors, px sizes) instead of rounding or renaming them.
3. **Generate Vue code.** Produce a Vue 3 single-file component (Composition API, \`<script setup>\`) that reproduces the design. Rules:
   - Use scoped CSS; keep the same box sizes, spacing and colors as the design export.
   - Prefer the same font family, size and weight as the design for every text element.
   - Place generated files under the project location the user chose (default: \`src/d2c-output/<task>/\`), with an \`index.html\` that mounts the component so the page can be rendered standalone.
   - Do not introduce CSS frameworks or preprocessors that the project does not already use.
4. **Verify with D2C diff.** Call the \`D2cCompare\` tool with the same task name and the path (or localhost URL) of the rendered implementation. The tool returns a similarity score plus a structured list of offsets, color deviations, font mismatches, missing and extra elements.
5. **Repair loop.** For every reported issue, fix the Vue code (never the design) and re-run \`D2cCompare\`. Repeat until the total score reaches at least 90 (grade 优秀 or better) or the user accepts the current state. Focus on major issues first.
6. **Report.** Summarize the final score, grade and any remaining accepted deviations to the user.

## Notes

- The design export is the single source of truth. Never edit files under \`.flavor/d2c/<task>/design/\`.
- Comparison needs the desktop app to render pages; \`D2cCompare\` is unavailable in a plain terminal session.
- Keep each repair cycle small: fix the reported issues, re-compare, then move on.
`;
}

export interface EnsureD2cSkillResult {
  /** False when the skill file already matched the current template. */
  installed: boolean;
  path: string;
}

/** Idempotently installs the D2C skill into the workspace skill root. */
export async function ensureD2cSkill(workspace: string): Promise<EnsureD2cSkillResult> {
  const path = join(workspace, ".flavor", "skills", D2C_SKILL_NAME, "SKILL.md");
  const content = d2cSkillContent();
  try {
    if ((await readFile(path, "utf8")) === content) return { installed: false, path };
  } catch {
    // Missing or unreadable file: (re)install below.
  }
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
  return { installed: true, path };
}
