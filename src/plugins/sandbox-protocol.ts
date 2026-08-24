export type SandboxContributionKind = "command" | "tool" | "hook" | "modelAdapter";

export interface SandboxCommandRegistration { name: string; description?: string }
export interface SandboxToolRegistration {
  name: string;
  toolName: string;
  description: string;
  modelInputSchema?: Record<string, unknown>;
  readOnly?: boolean;
}
export interface SandboxHookRegistration {
  name: string;
  options?: { timeoutMs?: number; failurePolicy?: "error" | "allow" | "deny" | "ask" };
}
export interface SandboxSkillRootRegistration { name: string; root: string }
export interface SandboxPluginContributions {
  commands: SandboxCommandRegistration[];
  tools: SandboxToolRegistration[];
  hooks: SandboxHookRegistration[];
  skillRoots: SandboxSkillRootRegistration[];
  modelAdapters: { name: string }[];
}
export interface SandboxedPluginResult {
  ok: boolean;
  name: string;
  version: string;
  registeredTools: string[];
  registeredCommands: string[];
  registeredHooks: string[];
  registeredSkillRoots: string[];
  registeredModelAdapters: string[];
  contributions: SandboxPluginContributions;
  error?: string;
}
export type SandboxParentMessage =
  | { type: "invoke"; id: number; kind: SandboxContributionKind; name: string; argsJson: string }
  | { type: "shutdown" };
export type SandboxWorkerMessage =
  | { type: "ready"; result: SandboxedPluginResult }
  | { type: "response"; id: number; ok: true; valueJson: string }
  | { type: "response"; id: number; ok: false; error: string }
  | { type: "disposed" }
  | { type: "fatal"; error: string };
