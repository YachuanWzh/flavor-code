import { z } from "zod";

export const HOOK_EVENT_NAMES = [
  "SessionStart", "UserPromptSubmit", "Stop", "SessionEnd",
  "BeforePlan", "AfterPlan", "SubagentStart", "SubagentStop",
  "BeforeModelCall", "AfterModelCall", "PreToolUse", "PermissionRequest",
  "PostToolUse", "PostToolUseFailure", "PreCompact", "PostCompact",
  "PluginLoad", "PluginUnload", "Notification",
] as const;

const PayloadSchema = z.record(z.string(), z.unknown());
const eventSchema = <T extends HookEventName>(type: T) => z.object({
  version: z.literal(1),
  type: z.literal(type),
  payload: PayloadSchema,
});

export const HookEventSchema = z.discriminatedUnion("type", [
  eventSchema("SessionStart"), eventSchema("UserPromptSubmit"),
  eventSchema("Stop"), eventSchema("SessionEnd"),
  eventSchema("BeforePlan"), eventSchema("AfterPlan"),
  eventSchema("SubagentStart"), eventSchema("SubagentStop"),
  eventSchema("BeforeModelCall"), eventSchema("AfterModelCall"),
  eventSchema("PreToolUse"), eventSchema("PermissionRequest"),
  eventSchema("PostToolUse"), eventSchema("PostToolUseFailure"),
  eventSchema("PreCompact"), eventSchema("PostCompact"),
  eventSchema("PluginLoad"), eventSchema("PluginUnload"),
  eventSchema("Notification"),
]);

export const HookDecisionSchema = z.object({
  decision: z.enum(["allow", "deny", "ask"]),
  reason: z.string().optional(),
  updatedInput: z.unknown().optional(),
  additionalContext: z.string().optional(),
});

export type HookEvent = z.infer<typeof HookEventSchema>;
export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];
export type HookDecision = z.infer<typeof HookDecisionSchema>;

export type HookHandler = (event: HookEvent, signal: AbortSignal) =>
  HookDecision | Promise<HookDecision>;

export interface ShellHookHandler {
  command: string;
  args?: readonly string[];
  timeoutMs?: number;
  failurePolicy?: "error" | "allow" | "deny" | "ask";
  env?: Readonly<Record<string, string>>;
}

export interface HookHandlerOptions {
  timeoutMs?: number;
  failurePolicy?: "error" | "allow" | "deny" | "ask";
}
