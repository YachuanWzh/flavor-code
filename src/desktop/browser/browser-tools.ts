/**
 * Agent-facing browser tools. Each closure is bound to ONE Browser Space so a
 * background task can never touch the foreground task's pages (spec section
 * 13). Main agent only; subagents get no browser access in the MVP.
 */

import { z } from "zod";

import type { ToolDefinition } from "../../tools/types.js";
import { withToolPresentation } from "../../tools/types.js";
import type { BrowserHost } from "./browser-host.js";
import type { BrowserTabSummary } from "./types.js";

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

  return [browserTabs, browserNavigate, browserControl];
}
