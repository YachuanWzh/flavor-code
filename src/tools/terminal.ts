import { z } from "zod";
import { resolve } from "node:path";

import type { TerminalService } from "../terminal/service.js";
import { owner } from "./jobs.js";
import type { ToolDefinition } from "./types.js";

const Id = z.string().regex(/^term-[a-f0-9-]+$/);
const OpenInput = z.object({ cwd: z.string().optional(), shell: z.string().optional(), args: z.array(z.string()).optional(), columns: z.coerce.number().int().min(10).max(500).optional(), rows: z.coerce.number().int().min(2).max(300).optional() });
// Accepts booleans and their string forms (weak-typed models emit "true");
// kept transform-free so the schema converts to JSON Schema for providers.
const OptionalBoolean = z.union([z.boolean(), z.string().refine((value) => value === "true" || value === "false")]);
const WriteInput = z.object({ id: Id, data: z.string().max(100_000), enter: OptionalBoolean.optional() });
const ReadInput = z.object({ id: Id, cursor: z.coerce.number().int().min(0).optional() });
const ResizeInput = z.object({ id: Id, columns: z.coerce.number().int().min(10).max(500), rows: z.coerce.number().int().min(2).max(300) });
const CloseInput = z.object({ id: Id });

export function createTerminalTools(terminals: TerminalService, workspace = process.cwd()): ToolDefinition<unknown>[] {
  const tools = [
    {
      name: "TerminalOpen", description: "Open a persistent interactive pseudo-terminal in the workspace",
      inputSchema: OpenInput,
      paths: (input) => [resolve(workspace, input.cwd ?? ".")],
      permissions: (input) => ({ paths: [resolve(workspace, input.cwd ?? ".")], command: input.shell ?? "system-shell", args: input.args ?? [], cwd: resolve(workspace, input.cwd ?? ".") }),
      execute: async (input, _signal, context) => terminals.open({
        owner: owner(context),
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.shell === undefined ? {} : { shell: input.shell }),
        ...(input.args === undefined ? {} : { args: input.args }),
        ...(input.columns === undefined ? {} : { columns: input.columns }),
        ...(input.rows === undefined ? {} : { rows: input.rows }),
      }),
      presentResult: (output) => ({ kind: "terminal", variant: "terminal", title: `Terminal ${(output as { id: string }).id}`, state: "running" }),
    } satisfies ToolDefinition<z.infer<typeof OpenInput>>,
    {
      name: "TerminalWrite", description: "Write text or a command to a persistent terminal",
      inputSchema: WriteInput, paths: () => [],
      permissions: (input) => ({ paths: [], command: input.data, args: [] }),
      execute: async (input, _signal, context) => {
        const enter = input.enter === true || input.enter === "true";
        terminals.write(input.id, owner(context), input.data + (enter ? "\r" : ""));
        return { id: input.id, written: input.data.length + (enter ? 1 : 0) };
      },
    } satisfies ToolDefinition<z.infer<typeof WriteInput>>,
    {
      name: "TerminalRead", description: "Read output produced by a persistent terminal since a cursor",
      inputSchema: ReadInput, paths: () => [],
      execute: async (input, _signal, context) => terminals.read(input.id, owner(context), input.cursor ?? 0),
      renderForModel: (output) => JSON.stringify(output),
      presentResult: (output) => {
        const result = output as { id: string; output: string; state: "running" | "exited" | "closed"; exitCode?: number; truncated: boolean };
        return {
          kind: "terminal" as const, variant: "terminal" as const, title: `Terminal ${result.id}`,
          stdout: result.output, truncated: result.truncated,
          ...(result.exitCode === undefined ? { state: result.state === "closed" ? "cancelled" as const : "running" as const } : {
            exitCode: result.exitCode, state: result.exitCode === 0 ? "completed" as const : "failed" as const,
          }),
        };
      },
    } satisfies ToolDefinition<z.infer<typeof ReadInput>>,
    {
      name: "TerminalResize", description: "Resize a persistent terminal", inputSchema: ResizeInput, paths: () => [],
      execute: async (input, _signal, context) => { terminals.resize(input.id, owner(context), input.columns, input.rows); return { id: input.id, columns: input.columns, rows: input.rows }; },
    } satisfies ToolDefinition<z.infer<typeof ResizeInput>>,
    {
      name: "TerminalClose", description: "Close a persistent terminal", inputSchema: CloseInput, paths: () => [],
      execute: async (input, _signal, context) => { terminals.close(input.id, owner(context)); return { id: input.id, closed: true }; },
    } satisfies ToolDefinition<z.infer<typeof CloseInput>>,
    {
      name: "TerminalList", description: "List persistent terminals owned by this agent", inputSchema: z.object({}), paths: () => [],
      execute: async (_input, _signal, context) => terminals.list(owner(context)),
    } satisfies ToolDefinition<Record<string, never>>,
  ];
  return tools as ToolDefinition<unknown>[];
}
