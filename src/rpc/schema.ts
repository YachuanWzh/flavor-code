import { z } from "zod";

const base = { id: z.string().min(1).max(128).optional() };
export const RpcCommandSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("prompt"), message: z.string().trim().min(1).max(1_000_000) }).strict(),
  z.object({ ...base, type: z.literal("steer"), message: z.string().trim().min(1).max(1_000_000) }).strict(),
  z.object({ ...base, type: z.literal("follow_up"), message: z.string().trim().min(1).max(1_000_000) }).strict(),
  z.object({ ...base, type: z.literal("abort") }).strict(),
  z.object({ ...base, type: z.literal("get_state") }).strict(),
  z.object({ ...base, type: z.literal("get_queue") }).strict(),
  z.object({ ...base, type: z.literal("clear_queue") }).strict(),
  z.object({ ...base, type: z.literal("approval_decision"), approvalId: z.string().min(1).max(128), decision: z.enum(["once", "always", "deny"]) }).strict(),
  z.object({ ...base, type: z.literal("checkpoint"), label: z.string().trim().min(1).max(256).optional() }).strict(),
  z.object({ ...base, type: z.literal("get_tree") }).strict(),
  z.object({ ...base, type: z.literal("rewind"), nodeId: z.string().min(1).max(256) }).strict(),
  z.object({ ...base, type: z.literal("unrevert") }).strict(),
  z.object({ ...base, type: z.literal("fork"), nodeId: z.string().min(1).max(256) }).strict(),
  z.object({ ...base, type: z.literal("shutdown") }).strict(),
]);
export type RpcCommand = z.infer<typeof RpcCommandSchema>;
