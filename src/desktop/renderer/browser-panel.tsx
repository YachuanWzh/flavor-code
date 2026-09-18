/**
 * Embedded browser panel for the desktop renderer.
 *
 * The native WebContentsView lives in the main process (BrowserHost); this
 * component only draws the chrome (tab bar, toolbar) and keeps a DOM hole
 * whose bounds it reports to the host so the native view sits exactly over
 * that region. Rendering the panel means the panel is visible; unmounting or
 * closing it hides the native view. See md_docs/todo.md sections 5-8.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";

import type { BrowserSpaceSummary, BrowserTabSummary } from "../browser/types.js";

interface ActivityEntry {
  id: number;
  action: string;
  label: string;
}

const ACTIVITY_ICONS: Record<string, string> = {
  click: "◉", dblclick: "◎", fill: "✎", focus: "⌖", hover: "✧", press: "⏎", select: "▾", navigate: "⤳",
  type: "⌨", scroll: "↕", move: "➤", drag: "⤧", wheel: "↛",
};
let activitySequence = 0;

function normalizeBrowserUrl(raw: string): string | undefined {
  const value = raw.trim();
  if (value === "") return undefined;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) ? value : `https://${value}`;
}

export function BrowserPanel({ open, setOpen, fullscreen, setFullscreen, onWidth }: {
  open: boolean;
  setOpen(next: boolean): void;
  fullscreen: boolean;
  setFullscreen(next: boolean): void;
  onWidth(width: number | undefined): void;
}): React.JSX.Element | null {
  const [space, setSpace] = useState<BrowserSpaceSummary | undefined>(undefined);
  const [urlDraft, setUrlDraft] = useState("");
  const [panelError, setPanelError] = useState<string | undefined>(undefined);
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const spaceRef = useRef<BrowserSpaceSummary | undefined>(undefined);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const refresh = useCallback(async (): Promise<BrowserSpaceSummary | undefined> => {
    try {
      const next = await window.flavorDesktop.browserListTabs();
      spaceRef.current = next;
      setSpace(next);
      return next;
    } catch {
      // No workspace / no running task: the panel simply has nothing to show.
      spaceRef.current = undefined;
      setSpace(undefined);
      return undefined;
    }
  }, []);

  // Agent activity drives the panel: a newly created tab auto-opens it so the
  // user always sees the page the agent is operating on.
  useEffect(() => {
    void refresh();
    return window.flavorDesktop.onBrowserEvent((event) => {
      if (event.kind === "activity") {
        const entry = { id: ++activitySequence, action: event.action, label: event.label };
        setActivities((current) => [entry, ...current].slice(0, 4));
        // Agent is operating: wake a hidden panel so the action is always seen.
        if (!openRef.current) setOpen(true);
        return;
      }
      if (event.kind === "ownership-changed" && event.ownership === "user") {
        setActivities([]);
      }
      const previousIds = new Set((spaceRef.current?.tabs ?? []).map((tab) => tab.id));
      void window.flavorDesktop.browserListTabs().then((next) => {
        spaceRef.current = next;
        setSpace(next);
        if (event.kind === "tabs-changed" && next !== undefined && !openRef.current) {
          const hasNewTab = next.tabs.some((tab) => !previousIds.has(tab.id));
          const hadTabsBefore = previousIds.size > 0;
          if (hasNewTab || !hadTabsBefore) setOpen(true);
        }
      }).catch(() => { /* renderer raced a task switch; next event refreshes */ });
    });
  }, [refresh, setOpen]);

  const activeTab: BrowserTabSummary | undefined = space === undefined ? undefined
    : space.tabs.find((tab) => tab.id === space.activeTabId) ?? space.tabs[0];

  // Keep the address bar in sync when the visible tab changes (including when
  // the agent navigates); never fight the user mid-typing for the same tab.
  const syncedTabRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (activeTab === undefined) return;
    if (syncedTabRef.current !== activeTab.id) {
      syncedTabRef.current = activeTab.id;
      setUrlDraft(activeTab.url);
    } else if (!activeTab.loading && document.activeElement?.tagName !== "INPUT") {
      setUrlDraft(activeTab.url);
    }
  }, [activeTab]);

  const draggingRef = useRef(false);

  const reportBounds = useCallback(async (): Promise<boolean> => {
    const element = viewportRef.current;
    if (element === null) return false;
    const rect = element.getBoundingClientRect();
    const bounds = {
      x: Math.max(0, Math.round(rect.left)),
      y: Math.max(0, Math.round(rect.top)),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    if (bounds.width < 2 || bounds.height < 2) return false;
    await window.flavorDesktop.browserSetBounds(bounds);
    return true;
  }, []);

  // Native view geometry: report the DOM hole to the host and (re)show it.
  useEffect(() => {
    const hide = () => { void window.flavorDesktop.browserSetVisible(false).catch(() => undefined); };
    if (!open) { hide(); return; }
    let cancelled = false;
    const sync = () => {
      void reportBounds()
        .then((ok) => {
          if (ok && !cancelled && !draggingRef.current) {
            return window.flavorDesktop.browserSetVisible(true);
          }
          return undefined;
        })
        .catch(() => undefined);
    };
    const frame = requestAnimationFrame(sync);
    const observer = new ResizeObserver(sync);
    if (viewportRef.current !== null) observer.observe(viewportRef.current);
    window.addEventListener("resize", sync);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", sync);
      hide();
    };
  }, [open, reportBounds]);

  // Width dragging: hide the native view for the duration of the gesture,
  // otherwise pointer moves over the page region never reach the DOM.
  const startWidthDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (fullscreen) return;
    event.preventDefault();
    const row = viewportRef.current?.closest<HTMLElement>(".conversation-row");
    if (row === null || row === undefined) return;
    const rowRect = row.getBoundingClientRect();
    const min = 320;
    const max = Math.max(min + 120, Math.round(rowRect.width - 420));
    draggingRef.current = true;
    void window.flavorDesktop.browserSetVisible(false).catch(() => undefined);
    document.body.classList.add("browser-resizing");
    const move = (moveEvent: PointerEvent): void => {
      onWidth(Math.max(min, Math.min(max, Math.round(rowRect.right - moveEvent.clientX))));
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.classList.remove("browser-resizing");
      draggingRef.current = false;
      // One frame later the new flex width has settled; re-show at the new bounds.
      requestAnimationFrame(() => {
        void reportBounds()
          .then((ok) => (ok ? window.flavorDesktop.browserSetVisible(true) : undefined))
          .catch(() => undefined);
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };

  const run = useCallback((action: Promise<unknown>, label: string) => {
    setPanelError(undefined);
    action.then(() => void refresh()).catch((cause: unknown) => {
      setPanelError(cause instanceof Error ? cause.message : `${label}失败`);
    });
  }, [refresh]);

  if (!open) return null;
  const agentControls = space?.ownership === "agent";
  const statusHint = activeTab?.loading === true ? "页面加载中…"
    : space === undefined ? ""
      : agentControls ? "等待助手操作…" : "你正在控制浏览器";

  return <>
    <div className="browser-splitter" role="separator" aria-orientation="vertical"
      title="拖拽调整浏览器面板宽度" onPointerDown={startWidthDrag} />
    <aside className="browser-panel" data-fullscreen={fullscreen} aria-label="内嵌浏览器">
    <header className="browser-toolbar">
      <button title="后退" disabled={activeTab === undefined || !activeTab.canGoBack}
        onClick={() => activeTab !== undefined && run(window.flavorDesktop.browserHistory(activeTab.id, "back"), "后退")}>&larr;</button>
      <button title="前进" disabled={activeTab === undefined || !activeTab.canGoForward}
        onClick={() => activeTab !== undefined && run(window.flavorDesktop.browserHistory(activeTab.id, "forward"), "前进")}>&rarr;</button>
      <button title="刷新" disabled={activeTab === undefined}
        onClick={() => activeTab !== undefined && run(window.flavorDesktop.browserHistory(activeTab.id, "reload"), "刷新")}>&#x21bb;</button>
      <form className="browser-address" onSubmit={(event) => {
        event.preventDefault();
        if (activeTab === undefined) {
          const url = normalizeBrowserUrl(urlDraft);
          if (url !== undefined) run(window.flavorDesktop.browserNewTab(url), "打开页面");
          return;
        }
        const url = normalizeBrowserUrl(urlDraft);
        if (url !== undefined) run(window.flavorDesktop.browserNavigate(activeTab.id, url), "打开页面");
      }}>
        <input value={urlDraft} onChange={(event) => { setUrlDraft(event.target.value); syncedTabRef.current = activeTab?.id; }}
          placeholder={activeTab === undefined ? "输入网址，打开新标签页" : "输入网址后回车"} spellCheck={false} />
      </form>
      <button title="新标签页" className="browser-new-tab"
        onClick={() => run(window.flavorDesktop.browserNewTab(), "新建标签页")}>+</button>
      <button className="browser-ownership" data-agent={agentControls}
        title={agentControls ? "助手正在操作页面；接管后你可以手动浏览" : "把控制权交还给助手"}
        onClick={() => run(agentControls ? window.flavorDesktop.browserTakeControl() : window.flavorDesktop.browserHandOff(), "切换控制权")}>
        {agentControls ? "我来操作" : "交还控制"}
      </button>
      <button className="browser-fullscreen" title={fullscreen ? "退出全屏" : "浏览器面板全屏"}
        onClick={() => { if (!fullscreen) onWidth(undefined); setFullscreen(!fullscreen); }}>
        {fullscreen ? "退出全屏" : "⛶ 全屏"}
      </button>
      <button title="关闭浏览器面板" className="browser-close" onClick={() => setOpen(false)}>&times;</button>
    </header>
    <nav className="browser-tabbar" aria-label="浏览器标签页">
      {(space?.tabs ?? []).map((tab) => <div key={tab.id} className="browser-tab-shell">
        <button className="browser-tab" data-active={tab.id === activeTab?.id} title={tab.url || tab.label}
          onClick={() => run(window.flavorDesktop.browserActivateTab(tab.id), "切换标签页")}>
          <span className="browser-tab-label">{tab.label}</span>
          <span className="browser-tab-title">{tab.loading ? "加载中…" : tab.crashed === true ? "（已崩溃）" : ""}{tab.title || tab.url || "空白页"}</span>
        </button>
        <button className="browser-tab-close" title={`关闭 ${tab.label}`} aria-label={`关闭标签页 ${tab.label}`}
          onClick={() => run(window.flavorDesktop.browserCloseTab(tab.id), "关闭标签页")}>&times;</button>
      </div>)}
    </nav>
    {panelError !== undefined && <div className="browser-error" role="alert">{panelError}</div>}
    <div className="browser-status" data-live={agentControls}>
      {activities.length === 0
        ? <span className="browser-status-hint">{statusHint}</span>
        : activities.map((entry, index) => <div key={entry.id} className="browser-activity" data-index={index}>
          <span className="browser-activity-icon">{ACTIVITY_ICONS[entry.action] ?? "•"}</span>
          <span className="browser-activity-label">{entry.label}</span>
          {index === 0 && <span className="browser-activity-dot" aria-label="助手正在操作" />}
        </div>)}
    </div>
    <div className="browser-viewport" ref={viewportRef}>
      {space === undefined && <div className="browser-empty">当前项目还没有运行中的任务，启动任务后浏览器面板会跟随该任务。</div>}
      {space !== undefined && (space.tabs.length === 0 || activeTab?.url === "") &&
        <div className="browser-empty">浏览器已就绪。助手打开页面，或你在上方输入网址，页面会显示在这里。</div>}
    </div>
    </aside>
  </>;
}
