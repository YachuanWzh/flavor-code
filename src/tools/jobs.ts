import { z } from "zod";

import type { JobReadResult, JobRegistry, JobSnapshot } from "../jobs/registry.js";
import type { JobToolPresentation, ToolContext, ToolDefinition } from "./types.js";

const JobId = z.string().regex(/^job-[a-f0-9-]+$/);
const ReadInput = z.object({ id: JobId, cursor: z.coerce.number().int().min(0).optional() });
const IdInput = z.object({ id: JobId });

export function createJobTools(registry: JobRegistry): ToolDefinition<unknown>[] {
  const tools = [
    {
      name: "JobList", description: "List background jobs owned by this agent", inputSchema: z.object({}), paths: () => [],
      execute: async (_input, _signal, context) => registry.list(owner(context)),
      presentResult: (output) => jobListPresentation(output as readonly JobSnapshot[]),
    } satisfies ToolDefinition<Record<string, never>>,
    {
      name: "JobRead", description: "Read incremental output from an owned background job", inputSchema: ReadInput, paths: () => [],
      execute: async (input, _signal, context) => registry.read(input.id, owner(context), input.cursor ?? 0),
      renderForModel: (output) => JSON.stringify(output),
      presentResult: (output) => jobPresentation("read", output as JobReadResult),
    } satisfies ToolDefinition<z.infer<typeof ReadInput>>,
    {
      name: "JobWait", description: "Wait for an owned background job to finish", inputSchema: IdInput, paths: () => [],
      execute: async (input, signal, context) => registry.wait(input.id, owner(context), signal),
      presentResult: (output) => jobPresentation("wait", output as JobSnapshot),
    } satisfies ToolDefinition<z.infer<typeof IdInput>>,
    {
      name: "JobKill", description: "Cancel an owned background job and its process tree", inputSchema: IdInput, paths: () => [],
      execute: async (input, _signal, context) => { await registry.kill(input.id, owner(context)); return registry.read(input.id, owner(context)); },
      presentResult: (output) => jobPresentation("kill", output as JobReadResult),
    } satisfies ToolDefinition<z.infer<typeof IdInput>>,
  ];
  return tools as ToolDefinition<unknown>[];
}

function jobPresentation(action: JobToolPresentation["action"], job: JobSnapshot | JobReadResult): JobToolPresentation {
  const read = "output" in job ? job : undefined;
  return {
    kind: "job", action, id: job.id, jobKind: job.kind, label: job.label, state: job.state,
    ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
    ...(job.error === undefined ? {} : { error: job.error }),
    ...(read === undefined ? {} : { output: read.output, cursor: read.cursor }),
    ...(job.truncated ? { truncated: true } : {}),
  };
}

function jobListPresentation(jobs: readonly JobSnapshot[]): JobToolPresentation {
  return {
    kind: "job", action: "list",
    jobs: jobs.map((job) => ({
      id: job.id, kind: job.kind, label: job.label, state: job.state,
      ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
    })),
  };
}

export function owner(context?: ToolContext): string { return context?.ownerId ?? context?.agent ?? "main"; }
