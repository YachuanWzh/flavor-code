/**
 * Zod schemas shared by browser IPC channels and agent browser tools.
 * Every union uses an explicit discriminator; nothing unvalidated reaches the
 * BrowserHost. See md_docs/todo.md sections 5 and 9.
 */

import { z } from "zod";

export const BROWSER_SPACE_ID_MAX = 64;
export const BROWSER_URL_MAX = 2_048;
export const BROWSER_TARGET_MAX = 2_048;

/** Renderer-supplied bounds are untrusted: non-negative, capped DIPs only. */
export const BROWSER_BOUNDS_MAX_XY = 100_000;
export const BROWSER_BOUNDS_MAX_SIZE = 30_000;

export const BrowserSpaceIdSchema = z
  .string()
  .regex(/^bspace-[A-Za-z0-9._-]{1,64}$/, "Invalid browser space id");
export const BrowserTabIdSchema = z
  .string()
  .regex(/^btab-[A-Za-z0-9._-]{1,64}$/, "Invalid browser tab id");
export const BrowserTabLabelSchema = z
  .string()
  .regex(/^p(?:[1-9]|1[0-9]|20)$/, "Invalid browser tab label");
export const BrowserUrlSchema = z.string().trim().min(1).max(BROWSER_URL_MAX);
export const BrowserOwnershipSchema = z.enum(["agent", "user"]);

export const BrowserBoundsSchema = z
  .object({
    x: z.number().int().min(0).max(BROWSER_BOUNDS_MAX_XY),
    y: z.number().int().min(0).max(BROWSER_BOUNDS_MAX_XY),
    width: z.number().int().min(0).max(BROWSER_BOUNDS_MAX_SIZE),
    height: z.number().int().min(0).max(BROWSER_BOUNDS_MAX_SIZE),
  })
  .strict();

export const BrowserEmptyInputSchema = z.object({}).strict();

export const BrowserNewTabInputSchema = z
  .object({
    spaceId: BrowserSpaceIdSchema,
    url: BrowserUrlSchema.optional(),
  })
  .strict();

export const BrowserTabTargetInputSchema = z
  .object({
    spaceId: BrowserSpaceIdSchema,
    tabId: BrowserTabIdSchema,
  })
  .strict();

export const BrowserActivateTabInputSchema = BrowserTabTargetInputSchema;
export const BrowserCloseTabInputSchema = BrowserTabTargetInputSchema;

export const BrowserNavigateInputSchema = BrowserTabTargetInputSchema.extend({
  url: BrowserUrlSchema,
}).strict();

export const BrowserReloadInputSchema = BrowserTabTargetInputSchema;
export const BrowserHistoryInputSchema = BrowserTabTargetInputSchema;

export const BrowserSetBoundsInputSchema = z
  .object({
    spaceId: BrowserSpaceIdSchema,
    bounds: BrowserBoundsSchema,
  })
  .strict();

export const BrowserSetVisibleInputSchema = z
  .object({
    spaceId: BrowserSpaceIdSchema,
    visible: z.boolean(),
  })
  .strict();

export const BrowserOwnershipControlInputSchema = z
  .object({
    spaceId: BrowserSpaceIdSchema,
  })
  .strict();

/** Lightweight push events; never raw page content, always size-capped. */
export const BrowserTabsChangedEventSchema = z
  .object({
    kind: z.literal("tabs-changed"),
    spaceId: BrowserSpaceIdSchema,
  })
  .strict();

export const BrowserTabStateEventSchema = z
  .object({
    kind: z.literal("tab-state"),
    spaceId: BrowserSpaceIdSchema,
    tabId: BrowserTabIdSchema,
    url: BrowserUrlSchema,
    title: z.string().max(300),
    loading: z.boolean(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    crashed: z.boolean().optional(),
  })
  .strict();

export const BrowserOwnershipEventSchema = z
  .object({
    kind: z.literal("ownership-changed"),
    spaceId: BrowserSpaceIdSchema,
    ownership: BrowserOwnershipSchema,
  })
  .strict();

export const BrowserEventSchema = z.discriminatedUnion("kind", [
  BrowserTabsChangedEventSchema,
  BrowserTabStateEventSchema,
  BrowserOwnershipEventSchema,
]);
export type BrowserEvent = z.infer<typeof BrowserEventSchema>;

/** Locator accepted by agent tools: @N, ref=N, loc=..., text=..., xpath=..., or raw CSS. */
export const BrowserTargetSchema = z
  .string()
  .trim()
  .min(1)
  .max(BROWSER_TARGET_MAX);

const BrowserActBase = { spaceId: BrowserSpaceIdSchema, tabId: BrowserTabIdSchema };

export const BrowserClickActionSchema = z
  .object({ ...BrowserActBase, action: z.literal("click"), target: BrowserTargetSchema })
  .strict();
export const BrowserDoubleClickActionSchema = z
  .object({ ...BrowserActBase, action: z.literal("dblclick"), target: BrowserTargetSchema })
  .strict();
export const BrowserFillActionSchema = z
  .object({
    ...BrowserActBase,
    action: z.literal("fill"),
    target: BrowserTargetSchema,
    value: z.string().max(20_000),
  })
  .strict();
export const BrowserFocusActionSchema = z
  .object({ ...BrowserActBase, action: z.literal("focus"), target: BrowserTargetSchema })
  .strict();
export const BrowserHoverActionSchema = z
  .object({ ...BrowserActBase, action: z.literal("hover"), target: BrowserTargetSchema })
  .strict();
export const BrowserSelectActionSchema = z
  .object({
    ...BrowserActBase,
    action: z.literal("select"),
    target: BrowserTargetSchema,
    value: z.string().max(4_000),
  })
  .strict();
export const BrowserPressActionSchema = z
  .object({
    ...BrowserActBase,
    action: z.literal("press"),
    key: z.string().trim().min(1).max(64),
  })
  .strict();
export const BrowserScrollActionSchema = z
  .object({
    ...BrowserActBase,
    action: z.literal("scroll"),
    target: BrowserTargetSchema.optional(),
    deltaX: z.number().int().min(-10_000).max(10_000).optional(),
    deltaY: z.number().int().min(-10_000).max(10_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasDelta = value.deltaX !== undefined || value.deltaY !== undefined;
    if (!value.target && !hasDelta) {
      context.addIssue({
        code: "custom",
        message: "scroll requires either target or a delta",
      });
    }
  });

export const BrowserActSchema = z.discriminatedUnion("action", [
  BrowserClickActionSchema,
  BrowserDoubleClickActionSchema,
  BrowserFillActionSchema,
  BrowserFocusActionSchema,
  BrowserHoverActionSchema,
  BrowserSelectActionSchema,
  BrowserPressActionSchema,
  BrowserScrollActionSchema,
]);
export type BrowserActInput = z.infer<typeof BrowserActSchema>;

export const BrowserSnapshotScopeSchema = z.enum(["viewport", "full_page", "subtree"]);

export const BrowserSnapshotInputSchema = z
  .object({
    spaceId: BrowserSpaceIdSchema,
    tab: BrowserTabLabelSchema.optional(),
    scope: BrowserSnapshotScopeSchema.optional(),
    root: BrowserTargetSchema.optional(),
    maxNodes: z.number().int().min(1).max(2_000).optional(),
  })
  .strict();
