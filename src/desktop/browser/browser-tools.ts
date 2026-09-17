/**
 * Agent-facing browser tools. Each closure is bound to ONE Browser Space so a
 * background task can never touch the foreground task's pages (spec section
 * 13). Main agent only; subagents get no browser access in the MVP.
 */

import { z } from "zod";

import type { ToolDefinition } from "../../tools/types.js";
import { withToolPresentation } from "../../tools/types.js";
import { parseLocator } from "./element-resolver.js";
import type { BrowserHost } from "./browser-host.js";
import { BrowserError, type BrowserTabSummary } from "./types.js";

export interface BrowserToolsOptions {
  host: BrowserHost;
  /** The space owned by the task that receives these tools. Never "whichever tab the UI shows". */
  spaceId: string;
}

const BrowserTabsInputSchema = z.object({
  operation: z.enum(["list", "new", "activate", "close"]),
  tabId: z.string().trim().min(1).max(64).optional(),
  url: z.string().trim().min(1).max(2_048).optional(),
}).strict();
type BrowserTabsInput = z.infer<typeof BrowserTabsInputSchema>;

const BrowserNavigateInputSchema = z.object({
  operation: z.enum(["goto", "back", "forward", "reload"]),
  tabId: z.string().trim().min(1).max(64).optional(),
  url: z.string().trim().min(1).max(2_048).optional(),
}).strict();
type BrowserNavigateInput = z.infer<typeof BrowserNavigateInputSchema>;

const BrowserControlInputSchema = z.object({
  operation: z.enum(["status", "handOff"]),
}).strict();
type BrowserControlInput = z.infer<typeof BrowserControlInputSchema>;

const BrowserSnapshotInputSchema = z.object({
  tab: z.string().regex(/^p(?:[1-9]|1[0-9]|20)$/).optional(),
  maxNodes: z.number().int().min(1).max(2_000).optional(),
}).strict();
type BrowserSnapshotInput = z.infer<typeof BrowserSnapshotInputSchema>;

const BrowserActInputSchema = z.object({
  action: z.enum(["click", "dblclick", "fill", "focus", "hover", "press", "select"]),
  tab: z.string().regex(/^p(?:[1-9]|1[0-9]|20)$/).optional(),
  /** Snapshot element reference, e.g. "@12". Take a BrowserSnapshot first. */
  target: z.string().trim().min(1).max(256),
  value: z.string().max(20_000).optional(),
  key: z.string().trim().min(1).max(64).optional(),
}).strict();
type BrowserActInput = z.infer<typeof BrowserActInputSchema>;

const BrowserWaitInputSchema = z.object({
  mode: z.enum(["idle", "timeout"]),
  tab: z.string().regex(/^p(?:[1-9]|1[0-9]|20)$/).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
}).strict();
type BrowserWaitInput = z.infer<typeof BrowserWaitInputSchema>;

interface BrowserTabOutput {
  tabId: string;
  label: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

function toOutput(tab: BrowserTabSummary): BrowserTabOutput {
  return {
    tabId: tab.id,
    label: tab.label,
    url: tab.url,
    title: tab.title,
    loading: tab.loading,
    canGoBack: tab.canGoBack,
    canGoForward: tab.canGoForward,
  };
}

export function createBrowserTools(options: BrowserToolsOptions): ToolDefinition<unknown>[] {
  const { host, spaceId } = options;

  const resolveTabId = (tabId: string | undefined): string => {
    if (tabId !== undefined) return tabId;
    const active = host.listTabs(spaceId).activeTabId;
    if (active !== undefined) return active;
    // Opening a fresh anchor tab is cheaper for the model than a two-step call.
    return host.newTab(spaceId).id;
  };

  /** Accepts either a tab id or its p-label (what snapshots show to the model). */
  const resolveTab = (tabRef: string | undefined): string => {
    const summary = host.listTabs(spaceId);
    if (tabRef === undefined) {
      if (summary.activeTabId !== undefined) return summary.activeTabId;
      return host.newTab(spaceId).id;
    }
    const byLabel = summary.tabs.find((tab) => tab.label === tabRef);
    if (byLabel !== undefined) return byLabel.id;
    if (summary.tabs.some((tab) => tab.id === tabRef)) return tabRef;
    throw new BrowserError("unknown-tab", `No tab ${tabRef} in this browser space`);
  };

  const browserTabs: ToolDefinition<BrowserTabsInput> = {
    name: "BrowserTabs",
    description:
      "Manage browser tabs in this task's browser space. list shows all tabs; new opens a tab (optional validated http(s) url); activate/close take a tabId. Tab labels are p1, p2, ...",
    inputSchema: BrowserTabsInputSchema,
    agents: ["main"],
    paths: () => [],
    summarize: (input) => input.operation,
    permissions: (input) => ({
      readOnly: input.operation === "list",
      input: { spaceId, operation: input.operation, url: input.url },
    }),
    renderForModel: (output) => JSON.stringify(output),
    execute: async (input, signal) => {
      signal.throwIfAborted();
      if (input.operation === "list") {
        const summary = host.listTabs(spaceId);
        return withToolPresentation(
          {
            spaceId,
            ownership: summary.ownership,
            activeTabId: summary.activeTabId ?? null,
            tabs: summary.tabs.map(toOutput),
          },
          {
            kind: "generic",
            title: `Browser tabs (${summary.tabs.length})`,
            summary: summary.tabs.map((tab) => `${tab.label} ${tab.url}`).join("\n"),
          },
        );
      }
      host.assertAgentControl(spaceId);
      if (input.operation === "new") {
        const tab = host.newTab(spaceId, input.url);
        return withToolPresentation(toOutput(tab), {
          kind: "web",
          title: `Opened ${tab.label}`,
          url: tab.url,
        });
      }
      if (input.operation === "activate") {
        if (input.tabId === undefined) throw new Error("BrowserTabs activate requires tabId");
        host.activateTab(spaceId, input.tabId);
        const tab = host.tabSummary(spaceId, input.tabId);
        return withToolPresentation(toOutput(tab), { kind: "web", title: `Activated ${tab.label}`, url: tab.url });
      }
      if (input.tabId === undefined) throw new Error("BrowserTabs close requires tabId");
      host.closeTab(spaceId, input.tabId);
      return withToolPresentation(
        { closed: input.tabId, tabs: host.listTabs(spaceId).tabs.map(toOutput) },
        { kind: "generic", title: `Closed ${input.tabId}` },
      );
    },
  };

  const browserNavigate: ToolDefinition<BrowserNavigateInput> = {
    name: "BrowserNavigate",
    description:
      "Navigate a tab in this task's browser space. goto requires a validated http(s) url; back/forward/reload act on the active tab or the given tabId. Returns the resulting url/title and load state.",
    inputSchema: BrowserNavigateInputSchema,
    agents: ["main"],
    paths: () => [],
    summarize: (input) => (input.operation === "goto" ? `goto ${input.url ?? ""}`.trim() : input.operation),
    permissions: (input) => ({
      input: { spaceId, operation: input.operation, url: input.url },
    }),
    renderForModel: (output) => JSON.stringify(output),
    presentCall: (input) => ({
      kind: "web",
      title: `Browser ${input.operation}`,
      ...(input.url === undefined ? {} : { url: input.url }),
    }),
    execute: async (input, signal) => {
      signal.throwIfAborted();
      host.assertAgentControl(spaceId);
      const tabId = resolveTabId(input.tabId);
      if (input.operation === "goto") {
        if (input.url === undefined) throw new Error("BrowserNavigate goto requires url");
        const tab = await host.navigate(spaceId, tabId, input.url);
        return withToolPresentation(toOutput(tab), {
          kind: "web",
          title: `Navigated ${tab.label}`,
          url: tab.url,
          summary: tab.title,
        });
      }
      host.history(spaceId, tabId, input.operation);
      const tab = host.tabSummary(spaceId, tabId);
      return withToolPresentation(toOutput(tab), {
        kind: "web",
        title: `Browser ${input.operation}`,
        url: tab.url,
        summary: tab.title,
      });
    },
  };

  const browserControl: ToolDefinition<BrowserControlInput> = {
    name: "BrowserControl",
    description:
      "Browser control ownership for this task's space. status reports who controls the browser; handOff gives control to the human user (only the user can hand control back, through the app UI).",
    inputSchema: BrowserControlInputSchema,
    agents: ["main"],
    paths: () => [],
    summarize: (input) => input.operation,
    permissions: (input) => ({
      readOnly: input.operation === "status",
      input: { spaceId, operation: input.operation },
    }),
    renderForModel: (output) => JSON.stringify(output),
    execute: async (input) => {
      if (input.operation === "status") {
        return withToolPresentation(
          { spaceId, ownership: host.listTabs(spaceId).ownership },
          { kind: "generic", title: "Browser ownership" },
        );
      }
      host.handOff(spaceId);
      return withToolPresentation(
        {
          spaceId,
          ownership: "user" as const,
          note: "The human user now controls the browser. Stop retrying browser writes and wait for them to hand control back.",
        },
        { kind: "generic", title: "Browser handed to user" },
      );
    },
  };

  const browserSnapshot: ToolDefinition<BrowserSnapshotInput> = {
    name: "BrowserSnapshot",
    description:
      "Take a semantic snapshot of a browser tab in this task's space (default: active tab). Returns compact @-numbered accessibility nodes with URL/title; use the refs as BrowserAct targets. Refs die on navigation.",
    inputSchema: BrowserSnapshotInputSchema,
    agents: ["main"],
    paths: () => [],
    summarize: (input) => `snapshot ${input.tab ?? "active"}`,
    permissions: () => ({
      input: { spaceId, read: "browser-snapshot" },
    }),
    presentCall: (input) => ({ kind: "web", title: `Snapshot ${input.tab ?? "active"}` }),
    renderForModel: (output) => String((output as { text: string }).text),
    presentResult: (output) => {
      const snapshot = output as { label: string; truncated: boolean };
      return {
        kind: "generic",
        title: `Browser snapshot ${snapshot.label}`,
        summary: snapshot.truncated ? "truncated: use a smaller scope or subtree" : "full snapshot",
      };
    },
    execute: async (input, signal) => {
      signal.throwIfAborted();
      // Snapshots can expose freshly typed content, so they are blocked while
      // the user holds control (same gate as writes).
      host.assertAgentControl(spaceId);
      const tabId = resolveTab(input.tab);
      const { tab, snapshot } = await host.capture(spaceId, tabId, {
        ...(input.maxNodes === undefined ? {} : { maxNodes: input.maxNodes }),
        signal,
      });
      return withToolPresentation(
        {
          tabId: tab.id,
          label: tab.label,
          documentId: snapshot.documentId,
          truncated: snapshot.truncated,
          text: snapshot.text,
        },
        { kind: "web", title: `Snapshot ${tab.label}`, url: tab.url, summary: snapshot.text },
      );
    },
  };

  const browserAct: ToolDefinition<BrowserActInput> = {
    name: "BrowserAct",
    description:
      "Act on a snapshotted element by @ref in this task's browser space: click, dblclick, fill (value), focus, hover, press (key), select (value). Requires a current BrowserSnapshot; stale refs return a re-snapshot error.",
    inputSchema: BrowserActInputSchema,
    agents: ["main"],
    paths: () => [],
    summarize: (input) => `${input.action} ${input.target}`,
    permissions: (actInput) => ({
      input: { spaceId, act: actInput.action, target: actInput.target },
    }),
    renderForModel: (output) => JSON.stringify(output),
    execute: async (input, signal) => {
      signal.throwIfAborted();
      host.assertAgentControl(spaceId);
      const locator = parseLocator(input.target);
      if (locator.kind !== "ref") {
        throw new BrowserError(
          "bad-locator",
          "BrowserAct MVP targets snapshot refs (@N); take a BrowserSnapshot and use its refs",
          true,
        );
      }
      const tabId = resolveTab(input.tab);
      const result = await host.act(spaceId, tabId, {
        action: input.action,
        ref: locator.ref,
        ...(input.value === undefined ? {} : { value: input.value }),
        ...(input.key === undefined ? {} : { key: input.key }),
      }, { signal });
      const tab = host.tabSummary(spaceId, tabId);
      return withToolPresentation(
        { ...result, tab: toOutput(tab) },
        { kind: "web", title: `Browser ${input.action} ${input.target}`, url: tab.url, summary: tab.title },
      );
    },
  };

  const browserWait: ToolDefinition<BrowserWaitInput> = {
    name: "BrowserWait",
    description:
      "Wait for a browser tab condition: idle (loading finished and settled) or a fixed timeout. Aborts with the tool signal. No blind sleeping as an outcome — the result reports the observed tab state.",
    inputSchema: BrowserWaitInputSchema,
    agents: ["main"],
    paths: () => [],
    summarize: (input) => `wait ${input.mode}`,
    permissions: (waitInput) => ({
      input: { spaceId, wait: waitInput.mode },
    }),
    renderForModel: (output) => JSON.stringify(output),
    execute: async (input, signal) => {
      host.assertAgentControl(spaceId);
      const tabId = resolveTab(input.tab);
      const deadline = Date.now() + input.timeoutMs;
      let settledSince: number | undefined;
      for (;;) {
        signal.throwIfAborted();
        const tab = host.tabSummary(spaceId, tabId);
        if (input.mode === "timeout") {
          return withToolPresentation(
            { waited: "timeout", tab: toOutput(tab) },
            { kind: "web", title: "Waited", url: tab.url },
          );
        }
        if (!tab.loading) {
          settledSince ??= Date.now();
          if (Date.now() - settledSince >= 250) {
            return withToolPresentation(
              { waited: "idle", tab: toOutput(tab) },
              { kind: "web", title: `Idle ${tab.label}`, url: tab.url },
            );
          }
        } else {
          settledSince = undefined;
        }
        if (Date.now() >= deadline) {
          throw new Error(`BrowserWait timed out after ${input.timeoutMs}ms; tab ${tab.label} state: ${tab.loading ? "loading" : "quiet"}`);
        }
        await delay(Math.min(120, Math.max(10, deadline - Date.now())), signal);
      }
    },
  };

  return [browserTabs, browserNavigate, browserSnapshot, browserAct, browserWait, browserControl];
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("BrowserWait aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
