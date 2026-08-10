export const D2C_SKILL_NAME = "d2c-pixso";

/**
 * Reference SKILL.md content describing the D2C workflow (Vue or React).
 * The skill itself is imported by the user; the system never writes it
 * into a workspace. Kept here as the test fixture for the documented SOP.
 */
export function d2cSkillContent(): string {
  return `---
name: ${D2C_SKILL_NAME}
description: Convert a Pixso design export into a modular Vue or React implementation, produce one visual comparison, then pause for human review before targeted repair and API integration.
---

# Pixso Design to Code (D2C)

Use this skill when the user wants to turn an imported Pixso design into frontend code and verify the visual fidelity of the result.

## Workflow

1. **Import the design.** Call the \`D2cImport\` tool with the directory the user exported from Pixso and a short kebab-case task name (e.g. \`homepage\`). The tool copies the export into \`.flavor/d2c/<task>/design/\` and reports the entry HTML. If the import fails because no HTML file exists, ask the user to re-export from Pixso with HTML included.
2. **Choose the framework.** Ask the user which framework to implement the design in: Vue 3 or React. If the user already stated one, use it without asking again.
3. **Study the design before writing code.** Read the entry HTML and its referenced CSS. Identify the page structure: layout containers, text nodes, images, colors, font sizes and font families. Keep the original design tokens (exact hex colors, px sizes) instead of rounding or renaming them.
4. **Generate a runnable project.** Create a Vite-based project directory (default location: \`src/d2c-output/<task>/\` unless the user chose another) following the template of the selected framework. Rules:
   - The project must start with plain \`npm install\` + \`npm run dev\`; do not rely on global CLIs or manual steps.
   - Reproduce the design with the same box sizes, spacing and colors; prefer the same font family, size and weight for every text element.
   - Do not introduce CSS frameworks or preprocessors beyond the template below.
   - Split the page into semantic components that can be repaired independently. Every component root must include \`data-d2c-module="<id>"\` and \`data-d2c-source="<comma-separated workspace-relative files>"\`.
   - Write \`d2c.modules.json\` with \`schema: 1\` and a \`modules\` array containing each module's \`id\`, \`label\`, \`sourceFiles\`, and useful \`keywords\`, \`dataNeeds\`, and \`actions\`.

   Vue 3 template:
   - \`package.json\` with dependencies \`vue\` and devDependencies \`vite\`, \`@vitejs/plugin-vue\`; script \`dev: vite\`.
   - \`vite.config.js\` using \`@vitejs/plugin-vue\`; \`index.html\` loading \`/src/main.js\`.
   - \`src/main.js\` mounting \`App.vue\`; \`src/App.vue\` as a single-file component (\`<script setup>\`, scoped CSS) that reproduces the design.

   React template:
   - \`package.json\` with dependencies \`react\`, \`react-dom\` and devDependencies \`vite\`, \`@vitejs/plugin-react\`; script \`dev: vite\`.
   - \`vite.config.js\` using \`@vitejs/plugin-react\`; \`index.html\` loading \`/src/main.jsx\`.
   - \`src/main.jsx\` rendering \`<App />\`; \`src/App.jsx\` as a function component with a plain CSS file that reproduces the design.
5. **Verify once with D2C diff.** Call the \`D2cCompare\` tool with the same task name and the **project directory** as the implementation. The tool installs dependencies if needed, starts the dev server, renders the running page against the design, and shuts the server down again.
6. **Pause for human review.** After the first valid report is created, stop immediately. Do not repair visual differences on your own. The user accepts or rejects each issue in the D2C review panel.
7. **Targeted repair only when requested.** A review action supplies exact issue fingerprints, module ids, source-file allowlists and optional user instructions. Modify only those module files, run one whole-page \`D2cCompare\` to catch regressions, then stop immediately for human review again. Invalid evaluations and build failures may be repaired and retried because no usable review evidence exists. Never modify the design.
8. **API integration after acceptance.** Do not begin Swagger/OpenAPI integration until the review panel reports every current issue accepted. Use the generated Axios client and confirmed binding plan; ask the user about any uncertain mapping instead of guessing.

## Notes

- The design export is the single source of truth. Never edit files under \`.flavor/d2c/<task>/design/\`.
- Comparison needs the desktop app to render pages; \`D2cCompare\` is unavailable in a plain terminal session.
- Human review decisions are authoritative and persisted separately from immutable comparison reports.
- Never retry the same \`D2cCompare\` failure unchanged. First repair the project using the reported capture stage, Renderer diagnostics or Process output. If it cannot be repaired, stop and report the concrete error instead of launching another preview process.
`;
}
