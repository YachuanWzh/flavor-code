import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PermissionMode } from "../../config/schema.js";
import { createTranscriptState, transcriptReducer, type TranscriptBlock, type TranscriptState, type TranscriptTurn } from "../../ui/transcript.js";
import type { DesktopEvent, DesktopSnapshot, DesktopSessionSummary } from "../contracts.js";
import { applyDesktopOutput, groupSessions, permissionLabel, sessionTitle, STARTER_PROMPTS, workspaceName } from "./view-model.js";
import { MarkdownContent } from "./markdown.js";
import { SlashCompletionDropdown } from "./slash-completion-dropdown.js";
import {
  buildSlashCandidates,
  completeSlashSelection,
  completedSlashTokenLength,
  deriveSlashCompletion,
  moveSlashSelection,
  type SlashCompletion,
} from "../../ui/slash-completion.js";
import { MentionCompletionDropdown } from "./mention-completion-dropdown.js";
import {
  buildMentionCandidates,
  completeMentionSelection,
  deriveMentionCompletion,
  moveMentionSelection,
  type MentionCompletion,
} from "../../ui/mention-completion.js";
import { COMMAND_DESCRIPTIONS, MVP_COMMANDS } from "../../ui/commands.js";
import type { FileChangePresentation, FileDiffLine } from "../../tools/types.js";
import { SkillManagerView } from "./skill-manager.js";

const EMPTY_SNAPSHOT: DesktopSnapshot = { sessions: [], diagnostics: [] };
const PERMISSIONS: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions", "auto", "bubble"];
const BUILTIN_SLASH_CANDIDATES = MVP_COMMANDS.map((name) => ({ name, description: COMMAND_DESCRIPTIONS[name] }));
const SLASH_CANDIDATES = buildSlashCandidates(BUILTIN_SLASH_CANDIDATES, [], []);

export function DesktopApp(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot>(EMPTY_SNAPSHOT);
  const [transcript, setTranscript] = useState<TranscriptState>(createTranscriptState);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [railOpen, setRailOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [sessionMenu, setSessionMenu] = useState<string>();
  const [pendingDelete, setPendingDelete] = useState<DesktopSessionSummary>();
  const [deletingSession, setDeletingSession] = useState(false);
  const [modelDraft, setModelDraft] = useState("");
  const [slashSelection, setSlashSelection] = useState(0);
  const [dismissedSlashInput, setDismissedSlashInput] = useState<string>();
  const [mentionCandidates, setMentionCandidates] = useState<string[]>([]);
  const [mentionSelection, setMentionSelection] = useState(0);
  const [dismissedMentionInput, setDismissedMentionInput] = useState<string>();
  const [mentionSpan, setMentionSpan] = useState<{ start: number; end: number }>();
  const [cursorPos, setCursorPos] = useState(0);
  const [view, setView] = useState<"conversation" | "skills">("conversation");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const userScrolledUp = useRef(false);

  // Track wheel scrolling: pause auto-scroll when user scrolls up, resume when they scroll back to bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        userScrolledUp.current = true;
      } else {
        requestAnimationFrame(() => {
          const container = scrollRef.current;
          if (!container) return;
          const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 8;
          if (atBottom) userScrolledUp.current = false;
        });
      }
    };
    el.addEventListener("wheel", handleWheel, { passive: true });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => {
    const unsubscribe = window.flavorDesktop.onEvent((event) => handleEvent(event, setSnapshot, setTranscript, setError));
    window.flavorDesktop.bootstrap().then(setSnapshot).catch((cause) => setError(errorMessage(cause))).finally(() => setLoading(false));
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (userScrolledUp.current) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [transcript]);

  useEffect(() => {
    let cancelled = false;
    window.flavorDesktop.listFiles().then((files) => {
      if (cancelled) return;
      setMentionCandidates(buildMentionCandidates(files));
    }).catch(() => {
      // File discovery is optional; failure must not block the UI.
    });
    return () => { cancelled = true; };
  }, [snapshot.workspace]);

  const busy = snapshot.activeSession?.busy ?? false;
  const groups = useMemo(() => groupSessions(snapshot.sessions), [snapshot.sessions]);
  const slashCompletion = useMemo(() => {
    if (busy || snapshot.approval !== undefined || snapshot.questions !== undefined) return null;
    if (dismissedSlashInput === input) return null;
    return deriveSlashCompletion(input, cursorPos, SLASH_CANDIDATES, slashSelection);
  }, [input, cursorPos, slashSelection, dismissedSlashInput, busy, snapshot.approval, snapshot.questions]);
  const mentionCompletion = useMemo(() => {
    if (busy || snapshot.approval !== undefined || snapshot.questions !== undefined) return null;
    if (dismissedMentionInput === input) return null;
    if (slashCompletion !== null) return null;
    return deriveMentionCompletion(input, cursorPos, mentionCandidates, mentionSelection);
  }, [input, cursorPos, mentionSelection, dismissedMentionInput, busy, snapshot.approval, snapshot.questions, mentionCandidates, slashCompletion]);
  const completedTokenLen = slashCompletion === null
    ? completedSlashTokenLength(input, SLASH_CANDIDATES, false)
    : 0;

  const handleSlashSelect = useCallback((name: string) => {
    const next = completeSlashSelection(input, cursorPos, name);
    setInput(next.text);
    setDismissedSlashInput(next.text);
    setSlashSelection(0);
    setCursorPos(next.cursor);
    setTimeout(() => {
      const el = inputRef.current;
      if (el !== null) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }, 0);
  }, [input, cursorPos]);

  const handleSlashDismiss = useCallback(() => {
    setDismissedSlashInput(input);
  }, [input]);

  const handleSlashMove = useCallback((delta: -1 | 1) => {
    setSlashSelection((value) => {
      const count = slashCompletion?.items.length ?? 0;
      return moveSlashSelection(value, delta, count);
    });
  }, [slashCompletion]);

  const handleMentionSelect = useCallback((path: string) => {
    const next = completeMentionSelection(input, cursorPos, path);
    setInput(next.text);
    setDismissedMentionInput(next.text);
    setMentionSelection(0);
    setMentionSpan(next.span);
    setCursorPos(next.cursor);
    setTimeout(() => {
      const el = inputRef.current;
      if (el !== null) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }, 0);
  }, [input, cursorPos]);

  const handleMentionDismiss = useCallback(() => {
    setDismissedMentionInput(input);
  }, [input]);

  const handleMentionMove = useCallback((delta: -1 | 1) => {
    setMentionSelection((value) => {
      const count = mentionCompletion?.items.length ?? 0;
      return moveMentionSelection(value, delta, count);
    });
  }, [mentionCompletion]);

  const chooseWorkspace = async () => {
    setError(undefined);
    try {
      const next = await window.flavorDesktop.chooseWorkspace();
      if (next !== undefined) {
        setSnapshot(next); setTranscript(createTranscriptState()); setRailOpen(false); setView("conversation");
      }
    } catch (cause) { setError(errorMessage(cause)); }
  };

  const startSession = async (session?: DesktopSessionSummary) => {
    setError(undefined);
    try {
      const result = await window.flavorDesktop.startSession(session?.sessionId);
      setSnapshot(result.snapshot);
      setTranscript(transcriptReducer(createTranscriptState(), { type: "hydrate", messages: result.restoredMessages }));
      setRailOpen(false);
      setView("conversation");
      setTimeout(() => inputRef.current?.focus(), 0);
    } catch (cause) { setError(errorMessage(cause)); }
  };

  const send = async (override?: string) => {
    const prompt = (override ?? input).trim();
    if (!prompt || busy) return;
    setError(undefined);
    try {
      let current = snapshot;
      if (current.activeSession === undefined) {
        const started = await window.flavorDesktop.startSession();
        current = started.snapshot;
        setSnapshot(current);
        setTranscript(transcriptReducer(createTranscriptState(), { type: "hydrate", messages: started.restoredMessages }));
      }
      setTranscript((state) => transcriptReducer(state, { type: "submit", prompt }));
      if (override === undefined) setInput("");
      await window.flavorDesktop.submit(prompt);
    } catch (cause) {
      const value = errorMessage(cause);
      setError(value);
      setTranscript((state) => transcriptReducer(state, { type: "submit-error", message: value }));
    }
  };

  const setPermission = (mode: PermissionMode) => void send(`/permissions ${mode}`);
  const setModel = () => {
    const value = modelDraft.trim();
    if (value.includes(":")) { void send(`/model main ${value}`); setModelDraft(""); }
  };

  const showAppMenu = (menu: "file" | "edit" | "view" | "help", event: React.MouseEvent<HTMLButtonElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    void window.flavorDesktop.showAppMenu(menu, Math.round(bounds.left), Math.round(bounds.bottom));
  };

  const deletePendingSession = async () => {
    if (pendingDelete === undefined || deletingSession) return;
    setDeletingSession(true);
    setError(undefined);
    try {
      const wasActive = pendingDelete.sessionId === snapshot.activeSession?.sessionId;
      const next = await window.flavorDesktop.deleteSession(pendingDelete.sessionId);
      setSnapshot(next);
      if (wasActive) setTranscript(createTranscriptState());
      setPendingDelete(undefined);
      setSessionMenu(undefined);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setDeletingSession(false); }
  };

  return <div className="app-frame">
    <AppTitleBar railCollapsed={railCollapsed} onToggleRail={() => setRailCollapsed((value) => !value)} onMenu={showAppMenu} />
    <div className="desktop-shell" data-rail-collapsed={railCollapsed}>
    <button className="rail-scrim" data-open={railOpen} onClick={() => setRailOpen(false)} aria-label="关闭项目栏" />
    <aside className="project-rail" data-open={railOpen}>
      <div className="brand-row">
        <FlavorMark />
        <strong>Flavor Code</strong>
        <span className="brand-chevron">⌄</span>
      </div>
      <nav className="primary-actions" aria-label="主要操作">
        <button className="rail-action rail-action-primary" disabled={snapshot.workspace === undefined} onClick={() => void startSession()}>
          <span className="action-icon">＋</span><span>新建任务</span><kbd>Ctrl N</kbd>
        </button>
        <button className="rail-action" onClick={() => void chooseWorkspace()}><span className="action-icon">⌂</span><span>打开项目</span></button>
        <button className="rail-action" data-active={view === "skills"} onClick={() => { setView("skills"); setRailOpen(false); }} disabled={snapshot.workspace === undefined}><span className="action-icon">◇</span><span>技能</span></button>
        <button className="rail-action" onClick={() => void send("/mcp status")} disabled={snapshot.activeSession === undefined || busy}><span className="action-icon">◎</span><span>MCP 服务</span></button>
      </nav>
      <div className="sessions-scroll">
        <div className="rail-section-title">项目</div>
        {snapshot.workspace === undefined
          ? <button className="empty-project" onClick={() => void chooseWorkspace()}>选择一个本地文件夹开始</button>
          : <>
            <div className="project-heading"><span className="folder-icon">▱</span><span>{workspaceName(snapshot.workspace)}</span></div>
            {groups.length === 0 && <p className="no-sessions">还没有任务</p>}
            {groups.map((group) => <section className="session-group" key={group.label}>
              <h2>{group.label}</h2>
              {group.sessions.map((session) => <div className="session-item-shell" key={session.sessionId}
                onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setSessionMenu(undefined); }}>
                <button className="session-item" data-active={session.sessionId === snapshot.activeSession?.sessionId}
                  onClick={() => void startSession(session)}>
                  <span>{sessionTitle(session)}</span><time>{formatSessionTime(session.updatedAt)}</time>
                </button>
                <button className="session-more" aria-label={`管理会话：${sessionTitle(session)}`} aria-expanded={sessionMenu === session.sessionId}
                  onClick={() => setSessionMenu((current) => current === session.sessionId ? undefined : session.sessionId)}>•••</button>
                {sessionMenu === session.sessionId && <div className="session-menu" role="menu">
                  <button role="menuitem" className="danger-item"
                    disabled={busy && session.sessionId === snapshot.activeSession?.sessionId}
                    onClick={() => { setPendingDelete(session); setSessionMenu(undefined); }}>删除会话</button>
                </div>}
              </div>)}
            </section>)}
          </>}
      </div>
      <div className="rail-footer"><span className="avatar">F</span><span>本地工作区</span><button title="帮助">?</button></div>
    </aside>

    <main className="workspace-panel">
      {view === "skills" && snapshot.workspace !== undefined ? <SkillManagerView onClose={() => setView("conversation")} onError={setError} /> : <>
      <header className="workspace-header">
        <button className="mobile-rail-toggle" onClick={() => setRailOpen(true)} aria-label="打开项目栏">☰</button>
        <div className="workspace-breadcrumb">
          <span>{workspaceName(snapshot.workspace)}</span>
        </div>
        <div className="header-actions"><button title="更多选项">•••</button></div>
      </header>

      <div className="conversation-scroll" ref={scrollRef}>
        {loading ? <LoadingState /> : snapshot.workspace === undefined ? <OpenProjectState onOpen={chooseWorkspace} />
          : transcript.completed.length === 0 && transcript.active === undefined
            ? <WelcomeState project={workspaceName(snapshot.workspace)} onStart={(prompt) => void send(prompt)} />
            : <div className="conversation-column">
              {transcript.completed.map((turn) => <TurnView key={turn.id} turn={turn} />)}
              {transcript.active !== undefined && <TurnView turn={transcript.active} active />}
            </div>}
      </div>

      {error !== undefined && <div className="error-toast" role="alert"><span>!</span><p>{error}</p><button onClick={() => setError(undefined)}>×</button></div>}
      {snapshot.diagnostics.length > 0 && <details className="diagnostics"><summary>{snapshot.diagnostics.length} 条启动提示</summary><pre>{snapshot.diagnostics.join("\n")}</pre></details>}
      <Composer input={input} setInput={setInput} onSend={() => void send()} busy={busy}
        onInterrupt={() => void window.flavorDesktop.interrupt()} inputRef={inputRef} snapshot={snapshot}
        modelDraft={modelDraft} setModelDraft={setModelDraft} setModel={setModel} setPermission={setPermission}
        slashCompletion={slashCompletion} onSlashSelect={handleSlashSelect}
        onSlashDismiss={handleSlashDismiss}
        onSlashMove={handleSlashMove}
        mentionCompletion={mentionCompletion} onMentionSelect={handleMentionSelect}
        onMentionDismiss={handleMentionDismiss}
        onMentionMove={handleMentionMove}
        mentionSpan={mentionSpan} setMentionSpan={setMentionSpan}
        completedTokenLen={completedTokenLen}
        cursorPos={cursorPos} setCursorPos={setCursorPos} />
      </>}
    </main>
    </div>

    {snapshot.approval !== undefined && <ApprovalSheet approval={snapshot.approval} onResolve={(decision) => void window.flavorDesktop.resolveApproval(decision)} />}
    {snapshot.questions !== undefined && <QuestionSheet questions={snapshot.questions} onAnswer={(answers) => void window.flavorDesktop.answerQuestions(answers)} />}
    {pendingDelete !== undefined && <DeleteSessionSheet session={pendingDelete} deleting={deletingSession}
      onCancel={() => setPendingDelete(undefined)} onDelete={() => void deletePendingSession()} />}
  </div>;
}

function AppTitleBar({ railCollapsed, onToggleRail, onMenu }: {
  railCollapsed: boolean;
  onToggleRail(): void;
  onMenu(menu: "file" | "edit" | "view" | "help", event: React.MouseEvent<HTMLButtonElement>): void;
}): React.JSX.Element {
  return <header className="window-titlebar">
    <button className="titlebar-icon sidebar-toggle" data-collapsed={railCollapsed} onClick={onToggleRail} aria-label={railCollapsed ? "显示项目栏" : "隐藏项目栏"} title={railCollapsed ? "显示项目栏" : "隐藏项目栏"}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M6 3v10"/></svg>
    </button>
    <button className="titlebar-icon nav-button" disabled aria-label="后退"><span>‹</span></button>
    <button className="titlebar-icon nav-button" disabled aria-label="前进"><span>›</span></button>
    <nav className="titlebar-menus" aria-label="应用菜单">
      <button onClick={(event) => onMenu("file", event)}>文件</button>
      <button onClick={(event) => onMenu("edit", event)}>编辑</button>
      <button onClick={(event) => onMenu("view", event)}>视图</button>
      <button onClick={(event) => onMenu("help", event)}>帮助</button>
    </nav>
  </header>;
}

function handleEvent(event: DesktopEvent, setSnapshot: React.Dispatch<React.SetStateAction<DesktopSnapshot>>,
  setTranscript: React.Dispatch<React.SetStateAction<TranscriptState>>, setError: React.Dispatch<React.SetStateAction<string | undefined>>): void {
  if (event.type === "snapshot") setSnapshot(event.snapshot);
  else if (event.type === "session-started") {
    setSnapshot(event.payload.snapshot);
    setTranscript(transcriptReducer(createTranscriptState(), { type: "hydrate", messages: event.payload.restoredMessages }));
  } else if (event.type === "session-output") setTranscript((state) => applyDesktopOutput(state, event.event));
  else if (event.type === "runtime-error") setError(event.message);
}

function TurnView({ turn, active = false }: { turn: TranscriptTurn; active?: boolean }): React.JSX.Element {
  return <article className="turn" data-active={active}>
    <div className="user-message"><span>{turn.prompt}</span></div>
    <div className="assistant-message">
      <div className="assistant-avatar"><FlavorMark /></div>
      <div className="turn-content">
        {turn.blocks.map((block, index) => <BlockView block={block} key={block.kind === "status" ? block.id : `text-${index}`} />)}
        {active && turn.blocks.length === 0 && <div className="thinking-line"><i /><span>正在理解任务…</span></div>}
      </div>
    </div>
  </article>;
}

function BlockView({ block }: { block: TranscriptBlock }): React.JSX.Element {
  if (block.kind === "text") return <div className="assistant-copy"><MarkdownContent text={block.text} /></div>;
  const stateSymbol = block.state === "completed" ? "✓" : block.state === "failed" ? "×" : block.state === "cancelled" ? "–" : block.state === "running" ? "" : "·";
  return <div className="activity-card" data-state={block.state} data-tone={block.tone}>
    <span className="activity-node">{stateSymbol}</span>
    <div className="activity-body"><div className="activity-title"><span>{block.text.replace(/^[·✓×]\s*/, "")}</span>{block.hint && <code>{block.hint}</code>}</div>
      {block.progress !== undefined && <div className="progress-track"><i style={{ width: `${block.progress}%` }} /></div>}
      {block.presentation && <DiffPreview presentation={block.presentation} />}
    </div>
  </div>;
}

function DiffPreview({ presentation }: { presentation: FileChangePresentation }): React.JSX.Element {
  const isDelete = presentation.operation === "delete";
  const operatorLabel = presentation.operation === "create" ? "新建" : presentation.operation === "delete" ? "删除" : "修改";
  const fileName = presentation.path.replace(/^.*[/\\]/, "");
  const lineWidth = isDelete
    ? 1
    : Math.max(1, ...presentation.lines.map((line) => Math.max(line.oldLine ?? 0, line.newLine ?? 0)))
      .toString().length;

  return <details className="diff-preview">
    <summary>
      <span className={`diff-marker ${isDelete ? "diff-delete" : "diff-add"}`}>{isDelete ? "●" : "●"}</span>
      <span className="diff-label">{operatorLabel}</span>
      <span className="diff-path">{fileName}</span>
      <span className="diff-counts">
        {!isDelete && <span className="diff-added-count">+{presentation.added}</span>}
        {!isDelete && presentation.removed > 0 && <span className="diff-removed-count"> −{presentation.removed}</span>}
        {isDelete && <span className="diff-removed-count">−{presentation.removed}</span>}
      </span>
    </summary>
    {isDelete ? null : <div className="diff-body">
      {presentation.lines.map((line, index) => <DiffRow key={index} line={line} lineWidth={lineWidth} />)}
    </div>}
  </details>;
}

function DiffRow({ line, lineWidth }: { line: FileDiffLine; lineWidth: number }): React.JSX.Element {
  const number = line.kind === "removed" || line.kind === "context" ? line.oldLine : line.newLine;
  const marker = line.kind === "removed" ? "-" : line.kind === "added" ? "+" : line.kind === "omitted" ? "…" : " ";
  const rowClass = line.kind === "added" ? "diff-row-added"
    : line.kind === "removed" ? "diff-row-removed"
    : line.kind === "omitted" ? "diff-row-omitted"
    : "diff-row-context";

  return <div className={`diff-row ${rowClass}`}>
    <span className="diff-line-number">{String(number ?? "").padStart(lineWidth)}</span>
    <span className="diff-line-marker">{marker}</span>
    <span className="diff-line-text">{line.text}</span>
  </div>;
}

interface ComposerProps {
  input: string; setInput(value: string): void; onSend(): void; busy: boolean; onInterrupt(): void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>; snapshot: DesktopSnapshot;
  modelDraft: string; setModelDraft(value: string): void; setModel(): void; setPermission(mode: PermissionMode): void;
  slashCompletion: SlashCompletion | null;
  onSlashSelect(name: string): void;
  onSlashDismiss(): void;
  onSlashMove(delta: -1 | 1): void;
  mentionCompletion: MentionCompletion | null;
  onMentionSelect(path: string): void;
  onMentionDismiss(): void;
  onMentionMove(delta: -1 | 1): void;
  mentionSpan?: { start: number; end: number } | undefined;
  setMentionSpan(value: { start: number; end: number } | undefined): void;
  completedTokenLen: number;
  cursorPos: number;
  setCursorPos(value: number): void;
}

function Composer(props: ComposerProps): React.JSX.Element {
  const disabled = props.snapshot.workspace === undefined;
  const slashMenuOpen = props.slashCompletion !== null;
  const mentionMenuOpen = props.mentionCompletion !== null;
  const menuOpen = slashMenuOpen || mentionMenuOpen;
  const hasSlashTag = props.completedTokenLen > 0;
  const slashTagText = hasSlashTag
    ? props.input.slice(0, props.completedTokenLen)
    : undefined;
  const slashTagDisplay = slashTagText?.startsWith("/") ? slashTagText.slice(1).trim() : slashTagText?.trim();

  // Compute mention tag segments
  const span = hasSlashTag ? undefined : props.mentionSpan;
  const hasMentionTag = span !== undefined
    && span.start >= 0 && span.end > span.start
    && span.start < props.input.length && span.end <= props.input.length
    && props.input.slice(span.start, span.end) === props.input.slice(span.start, span.end);
  const mentionBefore = hasMentionTag ? props.input.slice(0, span!.start) : "";
  const mentionTagText = hasMentionTag ? props.input.slice(span!.start, span!.end) : "";
  const mentionAfter = hasMentionTag ? props.input.slice(span!.end) : "";
  const mentionTagDisplay = mentionTagText.startsWith("@") ? mentionTagText.slice(1).trim() : mentionTagText;

  // textarea value: after slash tag / after mention tag / full input
  const textareaValue = hasSlashTag
    ? props.input.slice(props.completedTokenLen)
    : hasMentionTag
      ? mentionAfter
      : props.input;

  // Calculate the prefix length (text before textarea) for cursor mapping
  const textareaPrefixLen = hasSlashTag
    ? slashTagText!.length
    : hasMentionTag
      ? span!.start + mentionTagText.length
      : 0;

  const fullCursorFromTextarea = (textareaPos: number): number =>
    textareaPrefixLen + textareaPos;

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMenuOpen) {
      if (event.key === "ArrowDown") { event.preventDefault(); props.onSlashMove(1); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); props.onSlashMove(-1); return; }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        const selected = props.slashCompletion?.items[props.slashCompletion?.selectedIndex ?? 0];
        if (selected !== undefined) props.onSlashSelect(selected.name);
        return;
      }
      if (event.key === "Escape") { event.preventDefault(); props.onSlashDismiss(); return; }
    }
    if (mentionMenuOpen) {
      if (event.key === "ArrowDown") { event.preventDefault(); props.onMentionMove(1); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); props.onMentionMove(-1); return; }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        const selected = props.mentionCompletion?.items[props.mentionCompletion?.selectedIndex ?? 0];
        if (selected !== undefined) props.onMentionSelect(selected);
        return;
      }
      if (event.key === "Escape") { event.preventDefault(); props.onMentionDismiss(); return; }
    }
    // Remove tag on backspace at textarea boundary
    const target = event.target as HTMLTextAreaElement;
    const selStart = target.selectionStart;
    const selEnd = target.selectionEnd;
    if (event.key === "Backspace" && selStart === 0 && selStart === selEnd && !menuOpen) {
      if (hasSlashTag) {
        event.preventDefault();
        props.setInput(props.input.slice(props.completedTokenLen));
        props.setCursorPos(0);
        return;
      }
      if (hasMentionTag) {
        event.preventDefault();
        const newInput = mentionBefore + mentionAfter;
        props.setInput(newInput);
        props.setMentionSpan(undefined);
        props.setCursorPos(mentionBefore.length);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); props.onSend(); }
  };

  const handleTextareaChange = (val: string, selStart: number) => {
    let full: string;
    if (hasSlashTag) {
      full = slashTagText! + val;
    } else if (hasMentionTag) {
      full = mentionBefore + mentionTagText + val;
    } else {
      full = val;
    }
    // If user edited into the mention span, dissolve the tag
    if (hasMentionTag) {
      const expectedPrefix = mentionBefore + mentionTagText;
      if (!full.startsWith(expectedPrefix)) {
        props.setMentionSpan(undefined);
      }
    }
    props.setInput(full);
    props.setCursorPos(fullCursorFromTextarea(selStart));
  };

  const handleTextareaSelect = (selStart: number) => {
    props.setCursorPos(fullCursorFromTextarea(selStart));
  };

  const textarea = (
    <textarea
      ref={props.inputRef}
      className="composer-textarea"
      value={textareaValue}
      onChange={(event) => handleTextareaChange(event.target.value, event.target.selectionStart)}
      onSelect={(event) => handleTextareaSelect((event.target as HTMLTextAreaElement).selectionStart)}
      onKeyDown={onKeyDown}
      onClick={(event) => handleTextareaSelect((event.target as HTMLTextAreaElement).selectionStart)}
      placeholder={disabled ? "先打开一个项目" : (hasSlashTag || hasMentionTag) ? "" : "给 Flavor 一个任务，或输入 / 查看命令"}
      disabled={disabled}
      rows={1}
    />
  );

  const inputRow = hasSlashTag
    ? (
      <div className="composer-input-row">
        <span className="slash-tag">{slashTagDisplay}</span>
        {textarea}
      </div>
    )
    : hasMentionTag
      ? (
        <div className="composer-input-row">
          {mentionBefore.length > 0 && <span className="composer-plain-text">{mentionBefore}</span>}
          <span className="mention-tag">{mentionTagDisplay}</span>
          {textarea}
        </div>
      )
      : textarea;

  return <div className="composer-wrap">
    {slashMenuOpen && <SlashCompletionDropdown
      completion={props.slashCompletion!}
      onSelect={props.onSlashSelect}
      onDismiss={props.onSlashDismiss}
    />}
    {mentionMenuOpen && <MentionCompletionDropdown
      completion={props.mentionCompletion!}
      onSelect={props.onMentionSelect}
      onDismiss={props.onMentionDismiss}
    />}
    <div className={`composer${hasSlashTag || hasMentionTag ? " has-tag" : ""}`} data-busy={props.busy}>
      {inputRow}
    <div className="composer-tools">
      <button className="attach-button" title="在提示中输入 @ 引用项目文件"
        onClick={() => {
          props.setInput(`${props.input}${props.input ? " " : ""}@`);
          setTimeout(() => {
            const el = props.inputRef.current;
            if (el !== null) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
          }, 0);
        }} disabled={disabled}>＋</button>
      <div className="composer-context"><span className="context-item">▱ {workspaceName(props.snapshot.workspace)}</span><span className="context-item">▣ 本地</span></div>
      <div className="composer-controls">
        <details className="model-menu"><summary>{shortModel(props.snapshot.activeSession?.mainModel)}⌄</summary><div className="popover">
          <label>主模型 ID</label><div className="model-input"><input placeholder="provider:model" value={props.modelDraft} onChange={(event) => props.setModelDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") props.setModel(); }} /><button onClick={props.setModel}>切换</button></div>
          <p>例如 openai:gpt-5</p>
        </div></details>
        <select aria-label="权限模式" value={props.snapshot.activeSession?.permissionMode ?? "default"} disabled={props.busy || props.snapshot.activeSession === undefined}
          onChange={(event) => props.setPermission(event.target.value as PermissionMode)}>{PERMISSIONS.map((mode) => <option value={mode} key={mode}>{permissionLabel(mode)}</option>)}</select>
        {props.busy ? <button className="send-button stop-button" onClick={props.onInterrupt} title="停止任务"><span /></button>
          : <button className="send-button" onClick={props.onSend} disabled={disabled || !props.input.trim()} title="发送"><span>↑</span></button>}
      </div>
    </div>
  </div><p className="composer-hint">Enter 发送 · Shift Enter 换行 · @ 引用文件 · / 调用命令</p></div>;
}

function DeleteSessionSheet({ session, deleting, onCancel, onDelete }: {
  session: DesktopSessionSummary;
  deleting: boolean;
  onCancel(): void;
  onDelete(): void;
}): React.JSX.Element {
  return <div className="modal-layer"><section className="decision-sheet delete-session-sheet" role="dialog" aria-modal="true" aria-labelledby="delete-session-title">
    <div className="sheet-icon danger">×</div><div>
      <p className="sheet-kicker">删除历史会话</p>
      <h2 id="delete-session-title">删除“{sessionTitle(session)}”？</h2>
      <p>此会话的消息和任务记录将从当前项目中永久删除，此操作无法撤销。</p>
      <div className="sheet-actions"><button disabled={deleting} onClick={onCancel}>取消</button>
        <button className="danger" disabled={deleting} onClick={onDelete}>{deleting ? "正在删除…" : "删除会话"}</button></div>
    </div>
  </section></div>;
}

const DESTRUCTIVE_TOOLS = new Set(["Delete", "Move"]);

function ApprovalSheet({ approval, onResolve }: { approval: NonNullable<DesktopSnapshot["approval"]>; onResolve(decision: "allow" | "deny" | "always"): void }): React.JSX.Element {
  const isDestructive = DESTRUCTIVE_TOOLS.has(approval.tool);
  return <div className="modal-layer"><section className="decision-sheet" role="dialog" aria-modal="true" aria-labelledby="approval-title">
    <div className="sheet-icon warning">!</div><div><p className="sheet-kicker">权限确认 · {approval.agent === "main" ? "主 Agent" : "子 Agent"}</p><h2 id="approval-title">允许执行 {approval.tool}？</h2>
      <p>{approval.reason ?? "这项操作需要你的确认。"}</p>
      {(approval.command || approval.paths?.length) && <pre>{approval.command ?? approval.paths?.join("\n")}{approval.args?.length ? ` ${approval.args.join(" ")}` : ""}</pre>}
      <div className="sheet-actions"><button onClick={() => onResolve("deny")}>拒绝</button>{!isDestructive && <button onClick={() => onResolve("always")}>始终允许同类操作</button>}<button className="primary" onClick={() => onResolve("allow")}>允许一次</button></div>
    </div>
  </section></div>;
}

function QuestionSheet({ questions, onAnswer }: { questions: NonNullable<DesktopSnapshot["questions"]>; onAnswer(answers: Record<number, string>): void }): React.JSX.Element {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const ready = questions.every((_question, index) => answers[index]);
  return <div className="modal-layer"><section className="question-sheet" role="dialog" aria-modal="true"><p className="sheet-kicker">Flavor 需要确认</p>
    {questions.map((question, index) => <fieldset key={`${question.header}-${index}`}><legend>{question.header}</legend><p>{question.question}</p><div className="question-options">
      {question.options.map((option) => <button data-selected={answers[index] === option.label} key={option.label} onClick={() => setAnswers((current) => ({ ...current, [index]: option.label }))}>
        <strong>{option.label}</strong><span>{option.description}</span>
      </button>)}</div></fieldset>)}
    <div className="sheet-actions"><button className="primary" disabled={!ready} onClick={() => onAnswer(answers)}>继续</button></div>
  </section></div>;
}

function WelcomeState({ project, onStart }: { project: string; onStart(prompt: string): void }): React.JSX.Element {
  return <section className="welcome-state"><div className="welcome-mark"><FlavorMark /></div><p>已连接本地项目</p><h1>我们应该在 <u>{project}</u> 中构建什么？</h1>
    <div className="starter-grid">{STARTER_PROMPTS.map((prompt) => <button key={prompt} onClick={() => onStart(prompt)}>{prompt}</button>)}</div>
  </section>;
}

function OpenProjectState({ onOpen }: { onOpen(): void }): React.JSX.Element {
  return <section className="open-state"><div className="welcome-mark"><FlavorMark /></div><h1>从一个本地项目开始</h1><p>Flavor 会在你选择的文件夹范围内阅读、修改和运行代码。</p><button onClick={onOpen}>打开项目</button></section>;
}

function LoadingState(): React.JSX.Element { return <div className="loading-state"><FlavorMark /><span>正在准备桌面工作区…</span></div>; }

function FlavorMark(): React.JSX.Element {
  return (
    <svg className="flavor-mark" viewBox="0 0 36 36" aria-hidden="true">
      <path d="M8 17.5C8 11.7 12.5 7 18 7s10 4.7 10 10.5c0 2.7-1 5.1-2.7 7l1 3.8-4-1.2A9.5 9.5 0 0 1 18 28c-5.5 0-10-4.7-10-10.5Z"/>
      {/* Left eye: < */}
      <path d="M16 15l-2 2l2 2" fill="none" stroke="#1979c9" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      {/* Right eye: > */}
      <path d="M20 15l2 2l-2 2" fill="none" stroke="#1979c9" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      {/* Smile */}
      <path className="mark-smile" d="M14 23c2.5 1.5 5.5 1.5 8 0"/>
      {/* Tongue */}
      <ellipse cx="22" cy="24" rx="1.2" ry="0.9" fill="#f472b6" stroke="#ec4899" strokeWidth="0.3" transform="rotate(15 22 24)"/>
    </svg>
  );
}

function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function shortSessionId(id: string): string { return id.replace(/^session-/, "").slice(0, 17); }
function shortModel(model?: string): string { if (!model) return "选择模型"; return model.split(":").at(-1) ?? model; }
function formatSessionTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }); }
