import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_ALIAS_LENGTH = 64;
export const MAX_MESSAGE_BYTES = 32 * 1024;
export const MAX_CONTROL_FRAME_BYTES = 64 * 1024;
export const MAX_PARTICIPANTS = 16;
export const MAX_ACTIVE_PALS = 16;
export const MAX_PLAN_TASKS = 32;
export const MAX_PROJECT_PATH_BYTES = 1024;
export const MAX_PLAN_ENCODED_BYTES = 24 * 1024;
export const MAX_SNAPSHOT_ENCODED_BYTES = 56 * 1024;
export const MAX_COMPLETION_DETAIL_BYTES = 4 * 1024;
export const MAX_COMPLETION_ASSERTIONS_BYTES = 12 * 1024;
export const MIN_UUID_PREFIX_LENGTH = 8;

export function normalizePalIdentity(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

const VersionSchema = z.literal(PROTOCOL_VERSION);
const UuidSchema = z.uuid();
const PrintableIdentitySchema = z.string().trim().min(1).max(MAX_ALIAS_LENGTH).refine(
  (value) => !/[\p{Cc}\uD800-\uDFFF]/u.test(value),
  "Identity must contain only printable non-control Unicode",
);
export const PalAliasSchema = PrintableIdentitySchema;
export const PalTargetSchema = PrintableIdentitySchema;
const BoundedTextSchema = z.string().refine(
  (value) => Buffer.byteLength(value, "utf8") <= MAX_MESSAGE_BYTES,
  `Text must not exceed ${MAX_MESSAGE_BYTES} UTF-8 bytes`,
);
const NonEmptyBoundedTextSchema = BoundedTextSchema.refine((value) => value.length > 0, "Text must not be empty");
const CompletionDetailSchema = z.string().trim().min(1).refine(
  (value) => Buffer.byteLength(value, "utf8") <= MAX_COMPLETION_DETAIL_BYTES,
  `Completion evidence must not exceed ${MAX_COMPLETION_DETAIL_BYTES} UTF-8 bytes`,
);

export const PalPresenceSchema = z.object({
  version: VersionSchema,
  id: UuidSchema,
  alias: PalAliasSchema,
  projectPath: z.string().min(1).refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_PROJECT_PATH_BYTES,
    `Project path must not exceed ${MAX_PROJECT_PATH_BYTES} UTF-8 bytes`,
  ),
  connectedAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
}).strict();
export type PalPresence = z.infer<typeof PalPresenceSchema>;
export const PalPresenceListSchema = z.array(PalPresenceSchema).max(MAX_ACTIVE_PALS);

export const PalTaskMessageSchema = z.object({
  version: VersionSchema,
  type: z.literal("task"),
  messageId: UuidSchema,
  target: PalTargetSchema,
  goal: NonEmptyBoundedTextSchema,
}).strict();
export type PalTaskMessage = z.infer<typeof PalTaskMessageSchema>;

export const PalTaskEventSchema = z.object({
  version: VersionSchema,
  type: z.literal("task-event"),
  messageId: UuidSchema,
  taskId: UuidSchema,
  senderId: UuidSchema,
  recipientId: UuidSchema,
  status: z.enum(["accepted", "started", "progress", "completed", "failed", "cancelled"]),
  detail: BoundedTextSchema.optional(),
}).strict();
export type PalTaskEvent = z.infer<typeof PalTaskEventSchema>;

export const DeliveryReceiptSchema = z.object({
  version: VersionSchema,
  type: z.literal("delivery-receipt"),
  messageId: UuidSchema,
  status: z.enum(["delivered", "duplicate", "rejected"]),
  recipientIds: z.array(UuidSchema).max(MAX_PARTICIPANTS),
  error: BoundedTextSchema.optional(),
}).strict();
export type DeliveryReceipt = z.infer<typeof DeliveryReceiptSchema>;

export const CoWorkParticipantSchema = z.object({
  palId: UuidSchema,
  required: z.boolean(),
}).strict();
export type CoWorkParticipant = z.infer<typeof CoWorkParticipantSchema>;

export const CoWorkProposalParticipantsSchema = z.array(CoWorkParticipantSchema)
  .min(2)
  .max(MAX_PARTICIPANTS)
  .superRefine((participants, context) => {
    const seen = new Set<string>();
    for (const [index, participant] of participants.entries()) {
      const id = participant.palId.toLowerCase();
      if (seen.has(id)) {
        context.addIssue({ code: "custom", path: [index, "palId"], message: "Duplicate participant" });
      }
      seen.add(id);
    }
  });

export const CoWorkPlanTaskSchema = z.object({
  id: z.string().min(1).max(128),
  assigneeId: UuidSchema,
  description: NonEmptyBoundedTextSchema,
  dependsOn: z.array(z.string().min(1).max(128)).max(MAX_PLAN_TASKS),
}).strict();
export type CoWorkPlanTask = z.infer<typeof CoWorkPlanTaskSchema>;

export const CoWorkPlanSchema = z.object({
  version: VersionSchema,
  coWorkId: UuidSchema,
  epoch: z.number().int().positive(),
  goal: NonEmptyBoundedTextSchema,
  participants: z.array(CoWorkParticipantSchema).min(1).max(MAX_PARTICIPANTS),
  tasks: z.array(CoWorkPlanTaskSchema).min(1).max(MAX_PLAN_TASKS),
}).strict().superRefine((plan, context) => {
  if (Buffer.byteLength(JSON.stringify(plan), "utf8") > MAX_PLAN_ENCODED_BYTES) {
    context.addIssue({ code: "custom", message: `Encoded plan must not exceed ${MAX_PLAN_ENCODED_BYTES} UTF-8 bytes` });
  }
  const participantIds = new Set<string>();
  for (const [index, participant] of plan.participants.entries()) {
    if (participantIds.has(participant.palId)) {
      context.addIssue({ code: "custom", path: ["participants", index, "palId"], message: "Duplicate participant" });
    }
    participantIds.add(participant.palId);
  }
  const taskIds = new Set<string>();
  for (const [index, task] of plan.tasks.entries()) {
    if (taskIds.has(task.id)) {
      context.addIssue({ code: "custom", path: ["tasks", index, "id"], message: "Duplicate task id" });
    }
    taskIds.add(task.id);
    if (!participantIds.has(task.assigneeId)) {
      context.addIssue({ code: "custom", path: ["tasks", index, "assigneeId"], message: "Assignee is not a participant" });
    }
  }
  for (const [index, task] of plan.tasks.entries()) {
    for (const dependency of task.dependsOn) {
      if (!taskIds.has(dependency) || dependency === task.id) {
        context.addIssue({ code: "custom", path: ["tasks", index, "dependsOn"], message: "Invalid task dependency" });
      }
    }
  }
  const dependencies = new Map(plan.tasks.map((task) => [task.id, task.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): boolean => {
    if (visiting.has(taskId)) return true;
    if (visited.has(taskId)) return false;
    visiting.add(taskId);
    for (const dependency of dependencies.get(taskId) ?? []) {
      if (dependencies.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(taskId);
    visited.add(taskId);
    return false;
  };
  for (const [index, task] of plan.tasks.entries()) {
    if (visit(task.id)) {
      context.addIssue({ code: "custom", path: ["tasks", index, "dependsOn"], message: "Task dependencies must be acyclic" });
      break;
    }
  }
});
export type CoWorkPlan = z.infer<typeof CoWorkPlanSchema>;

export const CoWorkPhaseSchema = z.enum([
  "proposed",
  "planning",
  "prepared",
  "running",
  "verifying",
  "completed",
  "failed",
  "cancelled",
]);
export type CoWorkPhase = z.infer<typeof CoWorkPhaseSchema>;

const IntegrationResultSchema = z.object({
  passed: z.boolean(),
  evidence: CompletionDetailSchema,
}).strict();

export const CoWorkCompletionAssertionSchema = z.object({
  participantId: UuidSchema,
  passed: z.boolean(),
  detail: CompletionDetailSchema.optional(),
}).strict();
export type CoWorkCompletionAssertion = z.infer<typeof CoWorkCompletionAssertionSchema>;

export const CoWorkSnapshotSchema = z.object({
  version: VersionSchema,
  coWorkId: UuidSchema,
  epoch: z.number().int().positive(),
  phase: CoWorkPhaseSchema,
  goal: NonEmptyBoundedTextSchema,
  participants: z.array(CoWorkParticipantSchema).min(1).max(MAX_PARTICIPANTS),
  integrationOwnerId: UuidSchema,
  acceptedParticipantIds: z.array(UuidSchema).max(MAX_PARTICIPANTS),
  planHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  plan: CoWorkPlanSchema.nullable(),
  planAcceptedParticipantIds: z.array(UuidSchema).max(MAX_PARTICIPANTS),
  readyParticipantIds: z.array(UuidSchema).max(MAX_PARTICIPANTS),
  completedParticipantIds: z.array(UuidSchema).max(MAX_PARTICIPANTS),
  completionAssertions: z.array(CoWorkCompletionAssertionSchema).max(MAX_PARTICIPANTS),
  integration: IntegrationResultSchema.nullable(),
}).strict().superRefine((snapshot, context) => {
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_SNAPSHOT_ENCODED_BYTES) {
    context.addIssue({ code: "custom", message: `Encoded snapshot must not exceed ${MAX_SNAPSHOT_ENCODED_BYTES} UTF-8 bytes` });
  }
  const participantIds = new Set(snapshot.participants.map(({ palId }) => palId));
  const requiredParticipantIds = new Set(snapshot.participants.filter(({ required }) => required).map(({ palId }) => palId));
  if (!requiredParticipantIds.has(snapshot.integrationOwnerId)) {
    context.addIssue({ code: "custom", path: ["integrationOwnerId"], message: "Integration owner must be a required participant" });
  }
  const assertionIds = new Set<string>();
  let assertionBytes = 0;
  for (const [index, assertion] of snapshot.completionAssertions.entries()) {
    if (!participantIds.has(assertion.participantId)) {
      context.addIssue({ code: "custom", path: ["completionAssertions", index, "participantId"], message: "Assertion owner must be a participant" });
    }
    if (assertionIds.has(assertion.participantId)) {
      context.addIssue({ code: "custom", path: ["completionAssertions", index, "participantId"], message: "Duplicate completion assertion" });
    }
    assertionIds.add(assertion.participantId);
    assertionBytes += Buffer.byteLength(assertion.detail ?? "", "utf8");
  }
  if (assertionBytes > MAX_COMPLETION_ASSERTIONS_BYTES) {
    context.addIssue({ code: "custom", path: ["completionAssertions"], message: `Completion assertions must not exceed ${MAX_COMPLETION_ASSERTIONS_BYTES} UTF-8 bytes in aggregate` });
  }
});
export type CoWorkSnapshot = z.infer<typeof CoWorkSnapshotSchema>;

const RequestBase = {
  version: VersionSchema,
  requestId: UuidSchema,
};

const RegisterRequestSchema = z.object({
  ...RequestBase,
  type: z.literal("register"),
  authToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  presence: PalPresenceSchema,
}).strict();
const HeartbeatRequestSchema = z.object({ ...RequestBase, type: z.literal("heartbeat") }).strict();
const ListRequestSchema = z.object({ ...RequestBase, type: z.literal("list") }).strict();
const DisconnectRequestSchema = z.object({ ...RequestBase, type: z.literal("disconnect") }).strict();
const ChatRequestSchema = z.object({
  ...RequestBase,
  type: z.literal("chat"),
  messageId: UuidSchema,
  target: PalTargetSchema,
  message: NonEmptyBoundedTextSchema,
}).strict();
const TaskRequestSchema = z.object({
  ...RequestBase,
  type: z.literal("task"),
  messageId: UuidSchema,
  target: PalTargetSchema,
  goal: NonEmptyBoundedTextSchema,
}).strict();
const CoWorkProposeRequestSchema = z.object({
  ...RequestBase,
  type: z.literal("cowork-propose"),
  coWorkId: UuidSchema,
  goal: NonEmptyBoundedTextSchema,
  participants: CoWorkProposalParticipantsSchema,
}).strict();
const CoWorkAcceptanceRequestSchema = z.object({
  ...RequestBase,
  type: z.literal("cowork-accept"),
  coWorkId: UuidSchema,
  epoch: z.number().int().positive(),
}).strict();
const CoWorkPlanRequestSchema = z.object({ ...RequestBase, type: z.literal("cowork-plan"), plan: CoWorkPlanSchema }).strict();
const CoWorkPlanAcceptanceRequestSchema = z.object({
  ...RequestBase,
  type: z.literal("cowork-plan-accept"),
  coWorkId: UuidSchema,
  epoch: z.number().int().positive(),
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const CoWorkReadyRequestSchema = z.object({
  ...RequestBase,
  type: z.literal("cowork-ready"),
  coWorkId: UuidSchema,
  epoch: z.number().int().positive(),
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const CoWorkCompleteRequestSchema = z.object({
  ...RequestBase,
  type: z.literal("cowork-complete"),
  coWorkId: UuidSchema,
  epoch: z.number().int().positive(),
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  passed: z.boolean(),
  detail: CompletionDetailSchema.optional(),
}).strict();
const CoWorkIntegrationRequestSchema = z.object({
  ...RequestBase,
  type: z.literal("cowork-integration"),
  coWorkId: UuidSchema,
  epoch: z.number().int().positive(),
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  passed: z.boolean(),
  evidence: CompletionDetailSchema,
}).strict();
const CoWorkGetRequestSchema = z.object({
  ...RequestBase,
  type: z.literal("cowork-get"),
  coWorkId: UuidSchema,
}).strict();
const CoWorkCancelRequestSchema = z.object({
  ...RequestBase,
  type: z.literal("cowork-cancel"),
  coWorkId: UuidSchema,
  reason: NonEmptyBoundedTextSchema,
}).strict();

export const BrokerRequestSchema = z.discriminatedUnion("type", [
  RegisterRequestSchema,
  HeartbeatRequestSchema,
  ListRequestSchema,
  DisconnectRequestSchema,
  ChatRequestSchema,
  TaskRequestSchema,
  CoWorkProposeRequestSchema,
  CoWorkAcceptanceRequestSchema,
  CoWorkPlanRequestSchema,
  CoWorkPlanAcceptanceRequestSchema,
  CoWorkReadyRequestSchema,
  CoWorkCompleteRequestSchema,
  CoWorkIntegrationRequestSchema,
  CoWorkGetRequestSchema,
  CoWorkCancelRequestSchema,
]);
export type BrokerRequest = z.infer<typeof BrokerRequestSchema>;

const BrokerOkResponseSchema = z.object({
  version: VersionSchema,
  type: z.literal("ok"),
  requestId: UuidSchema,
  data: z.unknown(),
}).strict();
const BrokerErrorResponseSchema = z.object({
  version: VersionSchema,
  type: z.literal("error"),
  requestId: UuidSchema,
  code: z.enum(["invalid-request", "authentication-failed", "not-found", "ambiguous-target", "alias-conflict", "invalid-transition", "stale-epoch", "duplicate"]),
  message: BoundedTextSchema,
}).strict();
const ChatEventSchema = z.object({
  version: VersionSchema,
  type: z.literal("chat-event"),
  messageId: UuidSchema,
  senderId: UuidSchema,
  recipientId: UuidSchema,
  message: NonEmptyBoundedTextSchema,
}).strict();
const CoWorkEventSchema = z.object({
  version: VersionSchema,
  type: z.literal("cowork-event"),
  action: z.enum(["PROPOSE", "PLAN", "START", "END", "FAIL", "CANCEL"]),
  actorId: UuidSchema,
  coWorkId: UuidSchema,
  epoch: z.number().int().positive(),
  planHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  snapshot: CoWorkSnapshotSchema,
}).strict();
export const BrokerEventSchema = z.union([ChatEventSchema, PalTaskEventSchema, DeliveryReceiptSchema, CoWorkEventSchema]);
export type BrokerEvent = z.infer<typeof BrokerEventSchema>;
const BrokerEventResponseSchema = z.object({
  version: VersionSchema,
  type: z.literal("event"),
  event: BrokerEventSchema,
}).strict();

export const BrokerResponseSchema = z.discriminatedUnion("type", [
  BrokerOkResponseSchema,
  BrokerErrorResponseSchema,
  BrokerEventResponseSchema,
]);
export type BrokerResponse = z.infer<typeof BrokerResponseSchema>;

export const ControlFrameSchema = z.string().refine(
  (frame) => Buffer.byteLength(frame, "utf8") <= MAX_CONTROL_FRAME_BYTES,
  `Control frame must not exceed ${MAX_CONTROL_FRAME_BYTES} UTF-8 bytes`,
);
export type ControlFrame = z.infer<typeof ControlFrameSchema>;

export function encodeControlFrame(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Control frame cannot encode undefined");
  const parsed = ControlFrameSchema.safeParse(encoded);
  if (!parsed.success) throw new Error(`Control frame is too large (maximum ${MAX_CONTROL_FRAME_BYTES} UTF-8 bytes)`);
  return `${parsed.data}\n`;
}
