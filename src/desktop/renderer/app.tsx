import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PermissionMode } from "../../config/schema.js";
import { createTranscriptState, transcriptReducer, type TranscriptBlock, type TranscriptState, type TranscriptTurn } from "../../ui/transcript.js";
import type {
  AddDesktopModelInput,
  DesktopEvent,
  DesktopImageAttachmentInput,
  DesktopModelOption,
  DesktopPermissionProfile,
  DesktopSnapshot,
  DesktopSessionSummary,
} from "../contracts.js";
import { applyDesktopSessionOutput, permissionLabel, reconcileProjectCompletionNotices, sessionTitle, STARTER_PROMPTS, workspaceName, type ProjectActivityState } from "./view-model.js";
import { MarkdownContent } from "./markdown.js";
import { SlashCompletionDropdown } from "./slash-completion-dropdown.js";
import {
  buildSlashCandidates,
  completeSlashSelection,
  completedSlashTokenLength,
  deriveSlashCompletion,
  moveSlashSelection,
  removeCompletedSlashSelection,
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
import { MemoryManagerView } from "./memory-manager.js";
import { McpManagerView } from "./mcp-manager.js";
import { E2eViewer } from "./e2e-viewer.js";
import { GitChangesView } from "./git-changes.js";
import { AgentWorkbench } from "./agent-workbench.js";
import {
  applyD2cAgentProgress,
  applyD2cEngineProgress,
  createD2cPendingTask,
  type D2cPendingTask,
} from "./d2c-progress.js";
import type { ManagedSkillSummary } from "../../skills/manager.js";

const EMPTY_SNAPSHOT: DesktopSnapshot = { sessions: [], diagnostics: [], models: [], jobs: [] };
const PERMISSIONS: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions", "auto", "bubble"];
const BUILTIN_SLASH_CANDIDATES = MVP_COMMANDS.map((name) => ({ name, description: COMMAND_DESCRIPTIONS[name] }));
const MAX_DESKTOP_IMAGES = 5;
const MAX_DESKTOP_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DESKTOP_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const DESKTOP_STREAM_FLUSH_MS = 50;

/** Coalesce only adjacent deltas so tool/model ordering remains exact. */
export function coalesceDesktopEvents(events: readonly DesktopEvent[]): DesktopEvent[] {
  const result: DesktopEvent[] = [];
  for (const event of events) {
    const previous = result.at(-1);
    if (event.type === "session-output"
      && previous?.type === "session-output"
      && event.sessionId === previous.sessionId
      && event.workspace === previous.workspace
      && (event.event.type === "text" || event.event.type === "thinking")
      && previous.event.type === event.event.type) {
      result[result.length - 1] = {
        ...event,
        event: { type: event.event.type, text: previous.event.text + event.event.text },
      };
    } else result.push(event);
  }
  return result;
}

export interface PendingDesktopImage extends DesktopImageAttachmentInput {
  id: string;
  previewUrl: string;
}

export function attachmentTranscriptPrompt(
  prompt: string,
  attachments: readonly Pick<PendingDesktopImage, "id">[],
): string {
  const text = prompt.trim();
  const references = attachments.map((_attachment, index) => `[Image #${index + 1}]`);
  return [text, ...references].filter(Boolean).join("\n");
}

export function DesktopImageAttachmentStrip({ attachments, onRemove }: {
  attachments: readonly PendingDesktopImage[];
  onRemove(id: string): void;
}): React.JSX.Element {
  return <div className="image-attachment-strip" aria-label="待发送图片">
    {attachments.map((attachment, index) => <figure className="image-attachment-chip" key={attachment.id}>
      <img src={attachment.previewUrl} alt={attachment.name} />
      <figcaption><strong>[Image #{index + 1}]</strong><span>{attachment.name}</span></figcaption>
      <button type="button" onClick={() => onRemove(attachment.id)}
        aria-label={`移除 ${attachment.name}`} title="移除图片">×</button>
    </figure>)}
  </div>;
}

export function DesktopApp(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot>(EMPTY_SNAPSHOT);
  const [transcript, setTranscript] = useState<TranscriptState>(createTranscriptState);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<PendingDesktopImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [railOpen, setRailOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [sessionMenu, setSessionMenu] = useState<string>();
  const [pendingDelete, setPendingDelete] = useState<DesktopSessionSummary>();
  const [deletingSession, setDeletingSession] = useState(false);
  const [slashSelection, setSlashSelection] = useState(0);
  const [dismissedSlashInput, setDismissedSlashInput] = useState<string>();
  const [skills, setSkills] = useState<readonly ManagedSkillSummary[]>([]);
  const [mentionCandidates, setMentionCandidates] = useState<string[]>([]);
  const [mentionSelection, setMentionSelection] = useState(0);
  const [dismissedMentionInput, setDismissedMentionInput] = useState<string>();
  const [mentionSpan, setMentionSpan] = useState<{ start: number; end: number; text: string }>();
  const [cursorPos, setCursorPos] = useState(0);
  const [view, setView] = useState<"conversation" | "skills" | "memory" | "mcp" | "e2e" | "activity" | "git" | "workbench">("conversation");
  const [newTaskChooser, setNewTaskChooser] = useState(false);
  const [sessionQuery, setSessionQuery] = useState("");
  const [sessionGroup, setSessionGroup] = useState<"active" | "running" | "unread" | "archived">("active");
  const [projectMenu, setProjectMenu] = useState<string>();
  const [palette, setPalette] = useState<"commands" | "projects">();
  const [paletteQuery, setPaletteQuery] = useState("");
  const [navigation, setNavigation] = useState<{ workspace?: string; sessionId?: string; view: typeof view }[]>([]);
  const [navigationIndex, setNavigationIndex] = useState(-1);
  const [d2cRefreshKey, setD2cRefreshKey] = useState(0);
  const [d2cPending, setD2cPending] = useState<D2cPendingTask>();
  const [completionNotices, setCompletionNotices] = useState<Map<string, string | null>>(() => new Map());
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const activeSessionIdRef = useRef<string | undefined>(undefined);
  const activeWorkspaceRef = useRef<string | undefined>(undefined);
  const transcriptRef = useRef<TranscriptState>(transcript);
  const projectTranscriptsRef = useRef(new Map<string, { sessionId: string | undefined; transcript: TranscriptState }>());
  const sessionTranscriptsRef = useRef(new Map<string, TranscriptState>());
  const projectActivityRef = useRef(new Map<string, ProjectActivityState>());
  const previewUrlsRef = useRef(new Set<string>());
  const userScrolledUp = useRef(false);
  const updateInput = useCallback((value: string) => {
    setInput(value);
    setDismissedSlashInput(undefined);
    setDismissedMentionInput(undefined);
  }, []);

  useEffect(() => { transcriptRef.current = transcript; }, [transcript]);

  const rememberCurrentProject = useCallback(() => {
    const workspace = activeWorkspaceRef.current;
    if (workspace === undefined) return;
    projectTranscriptsRef.current.set(workspace, {
      sessionId: activeSessionIdRef.current,
      transcript: transcriptRef.current,
    });
    if (activeSessionIdRef.current !== undefined) sessionTranscriptsRef.current.set(`${workspace}\u0000${activeSessionIdRef.current}`, transcriptRef.current);
  }, []);

  const acknowledgeProject = useCallback((workspace: string | undefined) => {
    if (workspace === undefined) return;
    setCompletionNotices((current) => {
      if (!current.has(workspace)) return current;
      const next = new Map(current);
      next.delete(workspace);
      return next;
    });
  }, []);

  const activateProjectSnapshot = useCallback((next: DesktopSnapshot) => {
    const workspace = next.workspace;
    activeWorkspaceRef.current = workspace;
    activeSessionIdRef.current = next.activeSession?.sessionId;
    setSnapshot(next);
    const cached = workspace === undefined ? undefined : projectTranscriptsRef.current.get(workspace);
    setTranscript(cached !== undefined && cached.sessionId === next.activeSession?.sessionId
      ? cached.transcript
      : createTranscriptState());
    acknowledgeProject(workspace);
    setView("conversation");
    setRailOpen(false);
  }, [acknowledgeProject]);

  useEffect(() => () => {
    for (const url of previewUrlsRef.current) URL.revokeObjectURL(url);
    previewUrlsRef.current.clear();
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed !== undefined) {
        URL.revokeObjectURL(removed.previewUrl);
        previewUrlsRef.current.delete(removed.previewUrl);
      }
      return current.filter((attachment) => attachment.id !== id);
    });
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments((current) => {
      for (const attachment of current) {
        URL.revokeObjectURL(attachment.previewUrl);
        previewUrlsRef.current.delete(attachment.previewUrl);
      }
      return [];
    });
  }, []);

  const addImageFiles = useCallback(async (files: readonly File[]) => {
    if (files.length === 0) return;
    const remaining = MAX_DESKTOP_IMAGES - attachments.length;
    if (remaining <= 0 || files.length > remaining) {
      setError(`每条消息最多添加 ${MAX_DESKTOP_IMAGES} 张图片。`);
      return;
    }
    const existingBytes = attachments.reduce(
      (sum, attachment) => sum + Math.floor(attachment.dataBase64.length * 3 / 4),
      0,
    );
    if (existingBytes + files.reduce((sum, file) => sum + file.size, 0) > MAX_DESKTOP_TOTAL_IMAGE_BYTES) {
      setError("单条消息的图片总大小不能超过 20 MiB。");
      return;
    }
    try {
      const added = await Promise.all(files.map(readPendingDesktopImage));
      for (const attachment of added) previewUrlsRef.current.add(attachment.previewUrl);
      setAttachments((current) => [...current, ...added].slice(0, MAX_DESKTOP_IMAGES));
      setError(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [attachments]);

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
    const pendingEvents: DesktopEvent[] = [];
    let streamTimer: ReturnType<typeof setTimeout> | undefined;
    const applyEvent = (event: DesktopEvent): void => {
      if (event.type === "snapshot" && event.workspace !== undefined && event.snapshot.workspace === event.workspace) {
        const previous = activeWorkspaceRef.current;
        if (previous !== undefined && previous !== event.workspace) {
          projectTranscriptsRef.current.set(previous, {
            sessionId: activeSessionIdRef.current,
            transcript: transcriptRef.current,
          });
          const cached = projectTranscriptsRef.current.get(event.workspace);
          setTranscript(cached !== undefined && cached.sessionId === event.snapshot.activeSession?.sessionId
            ? cached.transcript
            : createTranscriptState());
          setView("conversation");
          acknowledgeProject(event.workspace);
        }
        activeWorkspaceRef.current = event.workspace;
      } else if (event.workspace !== undefined && (event.workspace !== activeWorkspaceRef.current
          || (event.type === "session-output" && event.sessionId !== activeSessionIdRef.current)
          || (event.type === "session-started" && event.payload.sessionId !== activeSessionIdRef.current))) {
        const cached = projectTranscriptsRef.current.get(event.workspace)
          ?? { sessionId: undefined, transcript: createTranscriptState() };
        if (event.type === "session-started") {
          const restored = transcriptReducer(createTranscriptState(), { type: "restore", state: event.payload.restoredTranscript });
          sessionTranscriptsRef.current.set(`${event.workspace}\u0000${event.payload.sessionId}`, restored);
          projectTranscriptsRef.current.set(event.workspace, {
            sessionId: event.payload.sessionId,
            transcript: restored,
          });
        } else if (event.type === "session-output") {
          const key = `${event.workspace}\u0000${event.sessionId}`;
          const nextTranscript = applyDesktopSessionOutput(sessionTranscriptsRef.current.get(key) ?? createTranscriptState(), event.sessionId, event);
          sessionTranscriptsRef.current.set(key, nextTranscript);
          if (cached.sessionId === event.sessionId) projectTranscriptsRef.current.set(event.workspace, { ...cached, transcript: nextTranscript });
        }
        return;
      }
      if (event.type === "d2c-report") {
        setD2cRefreshKey((key) => key + 1);
        setD2cPending((current) => current !== undefined && current.task === event.payload.task ? undefined : current);
        setView("e2e");
        return;
      }
      if (event.type === "d2c-progress") {
        setD2cPending((current) => current === undefined ? current : applyD2cEngineProgress(current, event.payload));
        return;
      }
      if (event.type === "session-output" && event.sessionId === activeSessionIdRef.current) {
        setD2cPending((current) => current === undefined ? current : applyD2cAgentProgress(current, event.event));
      }
      if ((event.type === "session-output"
          && event.sessionId === activeSessionIdRef.current
          && ["done", "error", "exit"].includes(event.event.type))
        || (event.type === "runtime-error"
          && (event.sessionId === undefined || event.sessionId === activeSessionIdRef.current))) {
        setD2cPending(undefined);
      }
      handleEvent(event, activeSessionIdRef, setSnapshot, setTranscript, setError);
    };
    const flushEvents = (): void => {
      if (streamTimer !== undefined) {
        clearTimeout(streamTimer);
        streamTimer = undefined;
      }
      const batch = coalesceDesktopEvents(pendingEvents.splice(0));
      for (const event of batch) applyEvent(event);
    };
    const unsubscribe = window.flavorDesktop.onEvent((event) => {
      pendingEvents.push(event);
      const stream = event.type === "session-output"
        && (event.event.type === "text" || event.event.type === "thinking");
      if (!stream) {
        flushEvents();
        return;
      }
      streamTimer ??= setTimeout(flushEvents, DESKTOP_STREAM_FLUSH_MS);
    });
    window.flavorDesktop.bootstrap().then((next) => {
      activeWorkspaceRef.current = next.workspace;
      activeSessionIdRef.current = next.activeSession?.sessionId;
      setSnapshot(next);
    }).catch((cause) => setError(errorMessage(cause))).finally(() => setLoading(false));
    return () => {
      if (streamTimer !== undefined) clearTimeout(streamTimer);
      unsubscribe();
    };
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

  useEffect(() => {
    let cancelled = false;
    if (snapshot.workspace === undefined) {
      setSkills([]);
      return () => { cancelled = true; };
    }
    window.flavorDesktop.listSkills().then((entries) => {
      if (!cancelled) setSkills(entries);
    }).catch(() => {
      // Skill discovery diagnostics are surfaced by the runtime; slash commands remain usable.
      if (!cancelled) setSkills([]);
    });
    return () => { cancelled = true; };
  }, [snapshot.workspace, view]);

  const busy = snapshot.activeSession?.busy ?? false;
  const projects = useMemo(() => snapshot.projects ?? (snapshot.workspace === undefined ? [] : [{
    workspace: snapshot.workspace,
    sessions: snapshot.sessions,
    ...(snapshot.activeSession === undefined ? {} : { activeSession: {
      sessionId: snapshot.activeSession.sessionId, busy: snapshot.activeSession.busy,
    } }),
    running: busy || snapshot.jobs.some((job) => job.state === "running"),
  }]), [snapshot.projects, snapshot.workspace, snapshot.sessions, snapshot.activeSession, snapshot.jobs, busy]);
  useEffect(() => {
    setCompletionNotices((current) => {
      const reconciled = reconcileProjectCompletionNotices(projects, projectActivityRef.current, current);
      projectActivityRef.current = reconciled.activity;
      return reconciled.notices;
    });
  }, [projects]);
  const slashCandidates = useMemo(() => buildSlashCandidates(
    BUILTIN_SLASH_CANDIDATES,
    [],
    skills.filter((skill) => skill.enabled),
    snapshot.managedTools ?? [],
  ), [skills, snapshot.managedTools]);
  const slashCompletion = useMemo(() => {
    if (busy || snapshot.approval !== undefined || snapshot.questions !== undefined) return null;
    if (dismissedSlashInput === input) return null;
    return deriveSlashCompletion(input, cursorPos, slashCandidates, slashSelection);
  }, [input, cursorPos, slashSelection, dismissedSlashInput, busy, snapshot.approval, snapshot.questions, slashCandidates]);
  const mentionCompletion = useMemo(() => {
    if (busy || snapshot.approval !== undefined || snapshot.questions !== undefined) return null;
    if (dismissedMentionInput === input) return null;
    if (slashCompletion !== null) return null;
    return deriveMentionCompletion(input, cursorPos, mentionCandidates, mentionSelection);
  }, [input, cursorPos, mentionSelection, dismissedMentionInput, busy, snapshot.approval, snapshot.questions, mentionCandidates, slashCompletion]);
  const completedTokenLen = slashCompletion === null
    ? completedSlashTokenLength(input, slashCandidates, false)
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
    setMentionSpan(next.span === undefined ? undefined : {
      ...next.span,
      text: next.text.slice(next.span.start, next.span.end),
    });
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
      rememberCurrentProject();
      const next = await window.flavorDesktop.chooseWorkspace();
      if (next !== undefined) {
        clearAttachments();
        activateProjectSnapshot(next);
      }
    } catch (cause) { setError(errorMessage(cause)); }
  };

  const switchWorkspace = async (workspace: string): Promise<DesktopSnapshot | undefined> => {
    if (workspace === snapshot.workspace) {
      acknowledgeProject(workspace);
      void window.flavorDesktop.acknowledgeSession().then(setSnapshot).catch(() => undefined);
      setView("conversation");
      setRailOpen(false);
      return snapshot;
    }
    setError(undefined);
    rememberCurrentProject();
    try {
      const next = await window.flavorDesktop.openWorkspace(workspace);
      clearAttachments();
      activateProjectSnapshot(next);
      void window.flavorDesktop.acknowledgeSession().then(setSnapshot).catch(() => undefined);
      return next;
    } catch (cause) {
      setError(errorMessage(cause));
      return undefined;
    }
  };

  const openProjectSession = async (workspace: string, session: DesktopSessionSummary): Promise<void> => {
    const next = await switchWorkspace(workspace);
    if (next === undefined) return;
    if (next.activeSession?.sessionId === session.sessionId) {
      setView("conversation");
      setRailOpen(false);
      return;
    }
    await selectSession(session);
  };

  const selectSession = async (session: DesktopSessionSummary) => {
    setError(undefined);
    try {
      rememberCurrentProject();
      const result = await window.flavorDesktop.selectSession(session.sessionId);
      const cached = result.snapshot.workspace === undefined ? undefined : sessionTranscriptsRef.current.get(`${result.snapshot.workspace}\u0000${result.sessionId}`);
      setSnapshot(result.snapshot); activeWorkspaceRef.current = result.snapshot.workspace; activeSessionIdRef.current = result.sessionId;
      setTranscript(cached ?? transcriptReducer(createTranscriptState(), { type: "restore", state: result.restoredTranscript }));
      setView("conversation"); setRailOpen(false);
    } catch (cause) { setError(errorMessage(cause)); }
  };

  const startSession = async (session?: DesktopSessionSummary, environment?: "local" | "worktree") => {
    setError(undefined);
    try {
      const result = await window.flavorDesktop.startSession(session?.sessionId, environment);
      clearAttachments();
      setSnapshot(result.snapshot);
      activeWorkspaceRef.current = result.snapshot.workspace;
      activeSessionIdRef.current = result.sessionId;
      setTranscript(transcriptReducer(createTranscriptState(), { type: "restore", state: result.restoredTranscript }));
      if (result.snapshot.workspace !== undefined) sessionTranscriptsRef.current.set(`${result.snapshot.workspace}\u0000${result.sessionId}`, transcriptReducer(createTranscriptState(), { type: "restore", state: result.restoredTranscript }));
      setRailOpen(false);
      setView("conversation");
      setTimeout(() => inputRef.current?.focus(), 0);
    } catch (cause) { setError(errorMessage(cause)); }
  };

  const send = async (
    override?: string,
    delivery?: "prompt" | "steer" | "followUp",
    permissionProfile?: DesktopPermissionProfile,
  ): Promise<boolean> => {
    const prompt = (override ?? input).trim();
    const selectedAttachments = override === undefined ? attachments : [];
    if (!prompt && selectedAttachments.length === 0) return false;
    setError(undefined);
    try {
      let current = snapshot;
      if (current.activeSession === undefined) {
        const started = await window.flavorDesktop.startSession();
        current = started.snapshot;
        setSnapshot(current);
        setTranscript(transcriptReducer(createTranscriptState(), { type: "restore", state: started.restoredTranscript }));
      }
      const effectiveDelivery = delivery ?? (busy ? "steer" : "prompt");
      if (selectedAttachments.length > 0 && effectiveDelivery !== "prompt") {
        throw new Error("图片只能随新消息发送，不能作为运行中的引导或后续消息。");
      }
      if (effectiveDelivery === "prompt") {
        setTranscript((state) => transcriptReducer(state, {
          type: "submit",
          prompt: attachmentTranscriptPrompt(prompt, selectedAttachments),
        }));
      }
      if (override === undefined) setInput("");
      await window.flavorDesktop.submit(
        prompt,
        effectiveDelivery,
        selectedAttachments.map(({ name, mediaType, dataBase64 }) => ({ name, mediaType, dataBase64 })),
        permissionProfile,
      );
      if (selectedAttachments.length > 0) clearAttachments();
      return true;
    } catch (cause) {
      const value = errorMessage(cause);
      setError(value);
      setTranscript((state) => transcriptReducer(state, { type: "submit-error", message: value }));
      return false;
    }
  };

  const setPermission = (mode: PermissionMode) => void send(`/permissions ${mode}`);
  const setModel = async (modelId: string): Promise<void> => {
    setError(undefined);
    try { setSnapshot(await window.flavorDesktop.switchModel(modelId)); }
    catch (cause) { setError(errorMessage(cause)); }
  };

  const finishTask = async () => {
    if (busy || snapshot.activeSession === undefined) return;
    setError(undefined);
    try { await window.flavorDesktop.finishTask(); }
    catch (cause) { setError(errorMessage(cause)); }
  };
  const addModel = async (draft: AddDesktopModelInput): Promise<void> => {
    setError(undefined);
    try {
      const result = await window.flavorDesktop.addModel(draft);
      setSnapshot(result.snapshot);
    } catch (cause) {
      setError(errorMessage(cause));
      throw cause;
    }
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

  const updateSessionMeta = async (session: DesktopSessionSummary, changes: { title?: string; pinned?: boolean; archived?: boolean }) => {
    try { setSnapshot(await window.flavorDesktop.updateSession(session.sessionId, changes)); setSessionMenu(undefined); }
    catch (cause) { setError(errorMessage(cause)); }
  };
  const renameSession = (session: DesktopSessionSummary) => {
    const title = window.prompt("任务名称", session.title ?? sessionTitle(session));
    if (title !== null) void updateSessionMeta(session, { title: title.trim() });
  };
  const updateProjectMeta = async (workspace: string, changes: { label?: string; pinned?: boolean }) => {
    try { setSnapshot(await window.flavorDesktop.updateProject(workspace, changes)); setProjectMenu(undefined); }
    catch (cause) { setError(errorMessage(cause)); }
  };
  const renameProject = (workspace: string, current?: string) => {
    const label = window.prompt("项目显示名称", current ?? workspaceName(workspace));
    if (label !== null) void updateProjectMeta(workspace, { label: label.trim() });
  };
  const closeProject = async (workspace: string, running: boolean) => {
    if (running && !window.confirm("项目中有任务正在运行。停止任务并关闭项目？")) return;
    try { activateProjectSnapshot(await window.flavorDesktop.closeProject(workspace, running)); setProjectMenu(undefined); }
    catch (cause) { setError(errorMessage(cause)); }
  };
  const openActivity = async (workspace: string, sessionId?: string) => {
    const next = await switchWorkspace(workspace); if (next === undefined) return;
    if (sessionId !== undefined) {
      const session = next.sessions.find((item) => item.sessionId === sessionId);
      if (session !== undefined) await selectSession(session);
    }
  };

  useEffect(() => {
    const entry = { ...(snapshot.workspace === undefined ? {} : { workspace: snapshot.workspace }), ...(snapshot.activeSession === undefined ? {} : { sessionId: snapshot.activeSession.sessionId }), view };
    setNavigation((current) => {
      const last = current[navigationIndex];
      if (last?.workspace === entry.workspace && last?.sessionId === entry.sessionId && last?.view === entry.view) return current;
      const next = [...current.slice(0, navigationIndex + 1), entry].slice(-50);
      setNavigationIndex(next.length - 1); return next;
    });
  }, [snapshot.workspace, snapshot.activeSession?.sessionId, view]);

  const navigateHistory = async (delta: -1 | 1) => {
    const index = navigationIndex + delta; const entry = navigation[index]; if (entry === undefined) return;
    setNavigationIndex(index);
    if (entry.workspace !== undefined) {
      const next = await window.flavorDesktop.openWorkspace(entry.workspace); activateProjectSnapshot(next);
      if (entry.sessionId !== undefined) {
        const result = await window.flavorDesktop.selectSession(entry.sessionId);
        setSnapshot(result.snapshot); activeSessionIdRef.current = result.sessionId;
        setTranscript(sessionTranscriptsRef.current.get(`${entry.workspace}\u0000${entry.sessionId}`) ?? transcriptReducer(createTranscriptState(), { type: "restore", state: result.restoredTranscript }));
      }
    }
    setView(entry.view);
  };

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "n") { event.preventDefault(); setNewTaskChooser(true); }
      if (key === "p") { event.preventDefault(); setPalette("projects"); setPaletteQuery(""); }
      if (key === "k") { event.preventDefault(); setPalette("commands"); setPaletteQuery(""); }
      if (key === "[") { event.preventDefault(); void navigateHistory(-1); }
      if (key === "]") { event.preventDefault(); void navigateHistory(1); }
    };
    window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
  }, [snapshot.workspace, navigation, navigationIndex]);

  return <div className="app-frame">
    <AppTitleBar railCollapsed={railCollapsed} onToggleRail={() => setRailCollapsed((value) => !value)} onMenu={showAppMenu}
      canBack={navigationIndex > 0} canForward={navigationIndex < navigation.length - 1}
      onBack={() => void navigateHistory(-1)} onForward={() => void navigateHistory(1)} />
    <div className="desktop-shell" data-rail-collapsed={railCollapsed}>
    <button className="rail-scrim" data-open={railOpen} onClick={() => setRailOpen(false)} aria-label="关闭项目栏" />
    <aside className="project-rail" data-open={railOpen}>
      <div className="brand-row">
        <FlavorMark />
        <strong>Flavor Code</strong>
      </div>
      <nav className="primary-actions" aria-label="主要操作">
        <button className="rail-action rail-action-primary" disabled={snapshot.workspace === undefined} onClick={() => setNewTaskChooser(true)}>
          <span className="action-icon"><UiIcon name="plus" /></span><span>新建任务</span><kbd>Ctrl N</kbd>
        </button>
        <button className="rail-action" onClick={() => void chooseWorkspace()}><span className="action-icon"><UiIcon name="folder" /></span><span>打开项目</span></button>
        <button className="rail-action" data-active={view === "skills"} onClick={() => { setView("skills"); setRailOpen(false); }} disabled={snapshot.workspace === undefined}><span className="action-icon"><UiIcon name="sparkles" /></span><span>技能</span></button>
        <button className="rail-action" data-active={view === "memory"} onClick={() => { setView("memory"); setRailOpen(false); }} disabled={snapshot.workspace === undefined}><span className="action-icon"><UiIcon name="database" /></span><span>长期记忆</span></button>
        <button className="rail-action" data-active={view === "mcp"} onClick={() => { setView("mcp"); setRailOpen(false); }} disabled={snapshot.workspace === undefined}><span className="action-icon"><UiIcon name="server" /></span><span>MCP 服务</span></button>
        <button className="rail-action" data-active={view === "e2e"} onClick={() => { setView("e2e"); setRailOpen(false); }} disabled={snapshot.workspace === undefined}><span className="action-icon"><UiIcon name="checklist" /></span><span>E2E</span></button>
        <button className="rail-action" data-active={view === "activity"} onClick={() => { setView("activity"); setRailOpen(false); }}><span className="action-icon"><UiIcon name="bell" /></span><span>活动</span>{(snapshot.activities?.filter((item) => item.unread).length ?? 0) > 0 && <em className="rail-badge">{snapshot.activities!.filter((item) => item.unread).length}</em>}</button>
        <button className="rail-action" data-active={view === "git"} onClick={() => { setView("git"); setRailOpen(false); }} disabled={snapshot.workspace === undefined}><span className="action-icon"><UiIcon name="git" /></span><span>Git 变更</span></button>
        <button className="rail-action" data-active={view === "workbench"} onClick={() => { setView("workbench"); setRailOpen(false); }} disabled={snapshot.workspace === undefined || snapshot.activeSession === undefined}><span className="action-icon"><UiIcon name="checklist" /></span><span>Agent 工作台</span></button>
      </nav>
      <div className="sessions-scroll">
        <div className="rail-section-heading"><span>项目</span><button onClick={() => void chooseWorkspace()} aria-label="打开新项目" title="打开新项目"><UiIcon name="plus" /></button></div>
        {projects.length > 0 && <div className="session-filter">
          <div className="session-search">
            <UiIcon name="search" />
            <input value={sessionQuery} onChange={(event) => setSessionQuery(event.target.value)} placeholder="搜索任务" aria-label="搜索任务" />
            {sessionQuery.length > 0 && <button type="button" onClick={() => setSessionQuery("")} aria-label="清除搜索" title="清除搜索">×</button>}
          </div>
          <div className="session-group-filter">
            <select value={sessionGroup} onChange={(event) => setSessionGroup(event.target.value as typeof sessionGroup)} aria-label="按状态筛选">
              <option value="active">任务</option><option value="running">运行</option><option value="unread">未读</option><option value="archived">归档</option>
            </select>
            <span aria-hidden="true" />
          </div>
        </div>}
        {projects.length === 0
          ? <button className="empty-project" onClick={() => void chooseWorkspace()}>选择一个本地文件夹开始</button>
          : projects.map((project) => {
            const selected = project.workspace === snapshot.workspace;
            const completed = completionNotices.has(project.workspace);
            const completedSessionId = completionNotices.get(project.workspace);
            const expanded = selected || project.running || completed;
            return <section className="project-entry" data-active={selected} key={project.workspace}>
              <div className="project-heading-shell"><button className="project-heading" onClick={() => void switchWorkspace(project.workspace)} title={project.workspace}>
                <span className="folder-icon" aria-hidden="true"><UiIcon name="folder" /></span>
                <span>{project.label || workspaceName(project.workspace)}</span>
                {project.running
                  ? <span className="project-running-dot" title="项目中有任务正在执行" />
                  : (project.unreadCount ?? 0) > 0 && <span className="project-complete-dot" role="status" aria-label="项目有未读活动" />}
              </button><button className="project-more" onClick={() => setProjectMenu((value) => value === project.workspace ? undefined : project.workspace)} aria-label="管理项目">•••</button>
              {projectMenu === project.workspace && <div className="project-menu" role="menu">
                <button onClick={() => renameProject(project.workspace, project.label)}>修改显示名称</button>
                <button onClick={() => void updateProjectMeta(project.workspace, { pinned: !project.pinned })}>{project.pinned ? "取消置顶" : "置顶项目"}</button>
                <button onClick={() => void window.flavorDesktop.revealProject(project.workspace)}>在资源管理器中打开</button>
                <button onClick={() => void window.flavorDesktop.copyProjectPath(project.workspace)}>复制路径</button>
                <button className="danger-item" onClick={() => void closeProject(project.workspace, project.running)}>关闭项目</button>
              </div>}</div>
              {expanded && project.sessions.length === 0 && <p className="no-sessions">还没有任务</p>}
              {expanded && project.sessions.filter((session) => (sessionGroup === "archived" ? session.archived : !session.archived)
                && (sessionGroup !== "running" || project.runningSessions?.includes(session.sessionId))
                && (sessionGroup !== "unread" || session.unread)
                && (!sessionQuery.trim() || sessionTitle(session).toLowerCase().includes(sessionQuery.trim().toLowerCase()))).map((session) => {
                const sessionActive = selected && session.sessionId === snapshot.activeSession?.sessionId;
                const sessionRunning = project.runningSessions?.includes(session.sessionId) ?? (project.running && session.sessionId === project.activeSession?.sessionId);
                const sessionCompleted = session.unread && session.activity === "completed";
                return <div className="session-item-shell" key={session.sessionId}
                onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setSessionMenu(undefined); }}>
                <button className="session-item" data-active={sessionActive} data-running={sessionRunning}
                  disabled={selected && busy && !sessionActive}
                  onClick={() => void openProjectSession(project.workspace, session)}>
                  <span>{session.pinned && <i className="pin-mark">◆</i>}{sessionTitle(session)}</span>
                  {sessionRunning
                    ? <span className="session-spinner" role="status" aria-label="任务正在执行" />
                    : sessionCompleted
                      ? <span className="session-complete-dot" role="status" aria-label="任务已完成，点击查看" />
                      : <time>{formatSessionTime(session.updatedAt)}</time>}
                </button>
                {selected && <button className="session-more" aria-label={`管理会话：${sessionTitle(session)}`} aria-expanded={sessionMenu === session.sessionId}
                  onClick={() => setSessionMenu((current) => current === session.sessionId ? undefined : session.sessionId)}>•••</button>
                }
                {selected && sessionMenu === session.sessionId && <div className="session-menu" role="menu">
                  <button role="menuitem" onClick={() => renameSession(session)}>重命名</button>
                  <button role="menuitem" onClick={() => void updateSessionMeta(session, { pinned: !session.pinned })}>{session.pinned ? "取消置顶" : "置顶"}</button>
                  <button role="menuitem" onClick={() => void updateSessionMeta(session, { archived: !session.archived })}>{session.archived ? "取消归档" : "归档"}</button>
                  <button role="menuitem" className="danger-item"
                    disabled={busy && session.sessionId === snapshot.activeSession?.sessionId}
                    onClick={() => { setPendingDelete(session); setSessionMenu(undefined); }}>删除会话</button>
                </div>}
              </div>;
              })}
            </section>;
          })}
      </div>
      <div className="rail-footer"><span className="avatar">F</span><span>本地工作区</span><button title="帮助">?</button></div>
    </aside>

    <main className="workspace-panel">
      {view === "workbench" && snapshot.workspace !== undefined && snapshot.activeSession !== undefined ? <AgentWorkbench snapshot={snapshot} onClose={() => setView("conversation")} onError={setError} onCompose={(value) => { updateInput(value); setView("conversation"); setTimeout(() => inputRef.current?.focus(), 0); }} />
        : view === "skills" && snapshot.workspace !== undefined ? <SkillManagerView onClose={() => setView("conversation")} onError={setError} />
        : view === "memory" && snapshot.workspace !== undefined ? <MemoryManagerView onClose={() => setView("conversation")} onError={setError} />
          : view === "mcp" && snapshot.workspace !== undefined ? <McpManagerView onClose={() => setView("conversation")} onError={setError} />
            : view === "activity" ? <ActivityCenter activities={snapshot.activities ?? []} onClose={() => setView("conversation")} onOpen={(workspace, sessionId) => void openActivity(workspace, sessionId)} onClear={() => void window.flavorDesktop.acknowledgeSession().then(setSnapshot)} />
              : view === "git" && snapshot.workspace !== undefined ? <GitChangesView onClose={() => setView("conversation")} onError={setError} onReview={() => { setView("conversation"); void send("/review", "prompt"); }} />
          : view === "e2e" && snapshot.workspace !== undefined ? <E2eViewer onClose={() => setView("conversation")} onInterrupt={() => void window.flavorDesktop.interrupt()} onError={setError} refreshKey={d2cRefreshKey}
                    pending={d2cPending}
                    disabled={busy}
                    onLaunch={(task, framework) => setD2cPending(createD2cPendingTask(task, framework))}
                    onStartTask={(prompt) => send(prompt, "prompt", "d2c")} /> : <>
      <header className="workspace-header">
        <button className="mobile-rail-toggle" onClick={() => setRailOpen(true)} aria-label="打开项目栏">☰</button>
        <div className="workspace-breadcrumb">
          <span>{workspaceName(snapshot.workspace)}</span>
        </div>
        <div className="header-actions">
          {snapshot.jobs.some((job) => job.state === "running") && <div className="job-strip" title="后台任务">
            <span className="job-pulse" />{snapshot.jobs.filter((job) => job.state === "running").length} 个后台任务
          </div>}
          <button className="finish-task-button" onClick={() => void finishTask()}
            disabled={busy || snapshot.activeSession === undefined} title="评估并完成当前任务">完成任务</button>
          <button title="更多选项">•••</button>
        </div>
      </header>

      {(snapshot.recoveryItems?.filter((item) => item.workspace === snapshot.workspace).length ?? 0) > 0 && <div className="recovery-banner">
        <div><strong>检测到上次未完成的任务</strong><span>应用异常退出时，这些任务仍在运行。</span></div>
        {snapshot.recoveryItems!.filter((item) => item.workspace === snapshot.workspace).map((item) => <div className="recovery-action" key={item.sessionId}>
          <code>{shortSessionId(item.sessionId)}</code><button onClick={() => { const session = snapshot.sessions.find((entry) => entry.sessionId === item.sessionId); if (session !== undefined) void selectSession(session); }}>恢复 / 查看</button>
          <button onClick={() => void window.flavorDesktop.dismissRecovery(item.sessionId).then(setSnapshot)}>忽略</button>
        </div>)}
      </div>}

      <div className="conversation-scroll" ref={scrollRef}>
        {loading ? <LoadingState /> : snapshot.workspace === undefined ? <OpenProjectState onOpen={chooseWorkspace} />
          : transcript.completed.length === 0 && transcript.active === undefined
            ? <WelcomeState project={workspaceName(snapshot.workspace)} onStart={(prompt) => void send(prompt)} />
            : <div className="conversation-column">
              {transcript.completed.length > 60 && <div className="transcript-window-notice">
                更早的 {transcript.completed.length - 60} 轮仍保存在会话中，已从实时渲染窗口隐藏
              </div>}
              {transcript.completed.slice(-60).map((turn) => <DesktopTurnView key={turn.id} turn={turn} />)}
              {transcript.active !== undefined && <DesktopTurnView turn={transcript.active} active />}
            </div>}
      </div>

      {snapshot.diagnostics.length > 0 && <details className="diagnostics"><summary>{snapshot.diagnostics.length} 条启动提示</summary><pre>{snapshot.diagnostics.join("\n")}</pre></details>}
      <Composer input={input} setInput={updateInput} onSend={(delivery) => void send(undefined, delivery)} busy={busy}
        onInterrupt={() => { setD2cPending(undefined); void window.flavorDesktop.interrupt(); }} inputRef={inputRef} snapshot={snapshot}
        attachments={attachments} onAddImages={(files) => void addImageFiles(files)}
        onRemoveImage={removeAttachment}
        setModel={setModel} addModel={addModel} setPermission={setPermission}
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
      {error !== undefined && <div className="error-toast" role="alert"><span>!</span><p>{error}</p><button onClick={() => setError(undefined)}>×</button></div>}
    </main>
    </div>

    {snapshot.approval !== undefined && <ApprovalSheet approval={snapshot.approval} onResolve={(decision) => void window.flavorDesktop.resolveApproval(decision)} />}
    {snapshot.questions !== undefined && <QuestionSheet questions={snapshot.questions} onAnswer={(answers) => void window.flavorDesktop.answerQuestions(answers)} />}
    {snapshot.memoryReviews !== undefined && snapshot.memoryReviews.length > 0 && <MemoryReviewRail
      reviews={snapshot.memoryReviews}
      autoDismissSeconds={snapshot.memoryAutoDismissSeconds ?? 0}
      onResolve={(id, decision) => {
        void window.flavorDesktop.resolveMemoryReview(id, decision).catch((cause) => setError(errorMessage(cause)));
      }}
    />}
    {pendingDelete !== undefined && <DeleteSessionSheet session={pendingDelete} deleting={deletingSession}
      onCancel={() => setPendingDelete(undefined)} onDelete={() => void deletePendingSession()} />}
    {newTaskChooser && <NewTaskSheet onCancel={() => setNewTaskChooser(false)} onChoose={(environment) => { setNewTaskChooser(false); void startSession(undefined, environment); }} />}
    {palette !== undefined && <CommandPalette mode={palette} query={paletteQuery} setQuery={setPaletteQuery} projects={projects}
      onClose={() => setPalette(undefined)} onProject={(workspace) => { setPalette(undefined); void switchWorkspace(workspace); }}
      onCommand={(command) => {
        setPalette(undefined);
        if (command === "new") setNewTaskChooser(true); else if (command === "open") void chooseWorkspace();
        else if (command === "activity") setView("activity"); else if (command === "git") setView("git");
        else if (command === "skills") setView("skills");
      }} />}
  </div>;
}

function ActivityCenter({ activities, onClose, onOpen, onClear }: {
  activities: NonNullable<DesktopSnapshot["activities"]>;
  onClose(): void;
  onOpen(workspace: string, sessionId?: string): void;
  onClear(): void;
}): React.JSX.Element {
  return <section className="manager-view activity-center"><header className="manager-header"><div><button onClick={onClose}>←</button><h2>活动</h2></div><button onClick={onClear}>全部标为已读</button></header>
    <div className="activity-list">{activities.length === 0 ? <p className="manager-empty">还没有任务活动</p> : activities.map((item) => <button className="activity-row" data-kind={item.kind} data-unread={item.unread} key={item.id} onClick={() => onOpen(item.workspace, item.sessionId)}>
      <i /><div><strong>{item.title}</strong><span>{workspaceName(item.workspace)}{item.detail ? ` · ${item.detail}` : ""}</span></div><time>{formatSessionTime(item.createdAt)}</time>
    </button>)}</div>
  </section>;
}

function NewTaskSheet({ onCancel, onChoose }: { onCancel(): void; onChoose(environment: "local" | "worktree"): void }): React.JSX.Element {
  return <div className="modal-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}><section className="new-task-sheet" role="dialog" aria-modal="true" aria-labelledby="new-task-title">
    <header><p>NEW TASK</p><h2 id="new-task-title">选择任务运行环境</h2><span>隔离只影响 Electron 任务，不改变 CLI 默认行为。</span></header>
    <div><button onClick={() => onChoose("worktree")}><i>◇</i><strong>隔离工作树</strong><span>新建 flavor/desktop-* 分支，在应用目录中独立运行。</span><em>推荐</em></button><button onClick={() => onChoose("local")}><i>⌂</i><strong>当前检出</strong><span>直接使用项目当前目录，适合快速查看和轻量操作。</span></button></div>
    <footer><button onClick={onCancel}>取消</button></footer>
  </section></div>;
}

function CommandPalette({ mode, query, setQuery, projects, onClose, onProject, onCommand }: {
  mode: "commands" | "projects";
  query: string;
  setQuery(value: string): void;
  projects: NonNullable<DesktopSnapshot["projects"]>;
  onClose(): void;
  onProject(workspace: string): void;
  onCommand(command: "new" | "open" | "activity" | "git" | "skills"): void;
}): React.JSX.Element {
  const commands = [
    { id: "new" as const, label: "新建任务", hint: "Ctrl N" }, { id: "open" as const, label: "打开项目", hint: "Ctrl O" },
    { id: "activity" as const, label: "查看活动", hint: "" }, { id: "git" as const, label: "打开 Git 变更", hint: "" }, { id: "skills" as const, label: "管理技能", hint: "" },
  ].filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));
  const filteredProjects = projects.filter((project) => `${project.label ?? ""} ${workspaceName(project.workspace)} ${project.workspace}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="palette-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="command-palette" role="dialog" aria-modal="true">
    <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") onClose(); }} placeholder={mode === "projects" ? "切换到项目…" : "键入命令…"} />
    <div>{mode === "projects" ? filteredProjects.map((project) => <button key={project.workspace} onClick={() => onProject(project.workspace)}><UiIcon name="folder" /><span>{project.label || workspaceName(project.workspace)}</span><small>{project.workspace}</small></button>)
      : commands.map((command) => <button key={command.id} onClick={() => onCommand(command.id)}><span>{command.label}</span><kbd>{command.hint}</kbd></button>)}</div>
  </section></div>;
}

function AppTitleBar({ railCollapsed, onToggleRail, onMenu, canBack, canForward, onBack, onForward }: {
  railCollapsed: boolean;
  onToggleRail(): void;
  onMenu(menu: "file" | "edit" | "view" | "help", event: React.MouseEvent<HTMLButtonElement>): void;
  canBack: boolean;
  canForward: boolean;
  onBack(): void;
  onForward(): void;
}): React.JSX.Element {
  return <header className="window-titlebar">
    <button className="titlebar-icon sidebar-toggle" data-collapsed={railCollapsed} onClick={onToggleRail} aria-label={railCollapsed ? "显示项目栏" : "隐藏项目栏"} title={railCollapsed ? "显示项目栏" : "隐藏项目栏"}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M6 3v10"/></svg>
    </button>
    <button className="titlebar-icon nav-button" disabled={!canBack} onClick={onBack} aria-label="后退" title="后退 (Ctrl+[)"><span>‹</span></button>
    <button className="titlebar-icon nav-button" disabled={!canForward} onClick={onForward} aria-label="前进" title="前进 (Ctrl+])"><span>›</span></button>
    <nav className="titlebar-menus" aria-label="应用菜单">
      <button onClick={(event) => onMenu("file", event)}>文件</button>
      <button onClick={(event) => onMenu("edit", event)}>编辑</button>
      <button onClick={(event) => onMenu("view", event)}>视图</button>
      <button onClick={(event) => onMenu("help", event)}>帮助</button>
    </nav>
  </header>;
}

function handleEvent(event: DesktopEvent, activeSessionId: React.MutableRefObject<string | undefined>,
  setSnapshot: React.Dispatch<React.SetStateAction<DesktopSnapshot>>,
  setTranscript: React.Dispatch<React.SetStateAction<TranscriptState>>, setError: React.Dispatch<React.SetStateAction<string | undefined>>): void {
  if (event.type === "snapshot") {
    activeSessionId.current = event.snapshot.activeSession?.sessionId;
    setSnapshot(event.snapshot);
  }
  else if (event.type === "session-started") {
    activeSessionId.current = event.payload.sessionId;
    setSnapshot(event.payload.snapshot);
    setTranscript(transcriptReducer(createTranscriptState(), { type: "restore", state: event.payload.restoredTranscript }));
  } else if (event.type === "session-output") {
    setTranscript((state) => applyDesktopSessionOutput(state, activeSessionId.current, event));
  }
  else if (event.type === "runtime-error"
    && (event.sessionId === undefined || event.sessionId === activeSessionId.current)) {
    setError(event.message);
  }
}

function DesktopTurnViewInner({ turn, active = false }: { turn: TranscriptTurn; active?: boolean }): React.JSX.Element {
  const allBlocks = active
    ? turn.blocks
    : turn.blocks.filter((block) => block.kind !== "status" || block.task === undefined);
  const hiddenBlocks = Math.max(0, allBlocks.length - 200);
  const blocks = allBlocks.slice(-200);
  return <article className="turn" data-active={active} data-kind={turn.kind ?? "conversation"}>
    <div className="user-message"><span>{boundedDesktopText(turn.prompt, 16_000)}</span></div>
    <div className="assistant-message">
      <div className="assistant-avatar"><FlavorMark /></div>
      <div className="turn-content">
        {hiddenBlocks > 0 && <div className="transcript-window-notice">更早的 {hiddenBlocks} 条任务输出已从实时渲染窗口隐藏</div>}
        {blocks.map((block, index) => <BlockView block={block} key={block.kind === "status" ? block.id : `text-${index}`} />)}
        {active && blocks.length === 0 && <div className="thinking-line" role="status"><i /><span><strong>Flavoring</strong><small>正在理解任务</small></span></div>}
      </div>
    </div>
  </article>;
}

export const DesktopTurnView = React.memo(DesktopTurnViewInner);

function BlockView({ block }: { block: TranscriptBlock }): React.JSX.Element {
  if (block.kind === "text") return <div className="assistant-copy"><MarkdownContent text={boundedDesktopText(block.text)} /></div>;
  const stateSymbol = block.state === "completed" ? "✓" : block.state === "failed" ? "×" : block.state === "cancelled" ? "–" : block.state === "running" ? "" : "·";
  const modelActivity = block.activity === "model";
  const thinkingPreview = modelActivity && block.thinkingText ? desktopThinkingPreview(block.thinkingText) : undefined;
  return <div className="activity-card" data-state={block.state} data-tone={block.tone} data-activity={block.activity}>
    <span className="activity-node">{stateSymbol}</span>
    <div className="activity-body"><div className="activity-title"><span>{block.text.replace(/^[·✓×]\s*/, "")}</span>{modelActivity && block.state === "running" && <small>正在思考</small>}{block.hint && <code>{block.hint}</code>}</div>
      {thinkingPreview && <div className="reasoning-preview">{thinkingPreview}</div>}
      {block.progress !== undefined && <div className="progress-track"><i style={{ width: `${block.progress}%` }} /></div>}
      {block.presentation?.kind === "file-change" && <DiffPreview presentation={block.presentation} />}
      {block.presentation?.kind === "generic" && <div className="tool-presentation"><strong>{block.presentation.title}</strong>{block.presentation.summary && <span>{block.presentation.summary}</span>}</div>}
      {block.presentation?.kind === "terminal" && <div className="tool-presentation terminal-presentation"><strong>{block.presentation.title}</strong>{block.presentation.stdout && <><small>OUTPUT</small><pre data-stream="stdout">{boundedDesktopText(block.presentation.stdout)}</pre></>}{block.presentation.stderr && <><small>ERROR</small><pre data-stream="stderr">{boundedDesktopText(block.presentation.stderr)}</pre></>}{block.presentation.diagnostic && <span className="terminal-diagnostic">{block.presentation.diagnostic}</span>}</div>}
      {block.presentation?.kind === "web" && <div className="tool-presentation"><strong>{block.presentation.title}</strong>{block.presentation.summary && <span>{block.presentation.summary}</span>}</div>}
      {block.tool && <details className="tool-details"><summary>调用详情</summary>
        <label>Input</label><pre>{boundedJson(block.tool.input)}</pre>
        {block.tool.result === undefined ? null : <><label>Result</label><pre>{boundedJson(block.tool.result)}</pre></>}
      </details>}
      {block.details && <details className="timeline-details"><summary>压缩摘要</summary><MarkdownContent text={boundedDesktopText(block.details)} /></details>}
    </div>
  </div>;
}

function boundedDesktopText(text: string, maxChars = 32_000): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 64) / 2);
  return `${text.slice(0, half)}\n\n… ${text.length - half * 2} 个字符已隐藏 …\n\n${text.slice(-half)}`;
}

export function desktopThinkingPreview(text: string, maxChars = 280): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  const limit = Math.max(1, Math.floor(maxChars));
  const characters = [...normalized];
  return characters.length <= limit ? normalized : `…${characters.slice(-limit).join("")}`;
}

function boundedJson(value: unknown, maxChars = 10_000): string {
  let text: string;
  try { text = JSON.stringify(value, null, 2) ?? "undefined"; }
  catch { text = String(value); }
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
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
  input: string; setInput(value: string): void; onSend(delivery?: "steer" | "followUp"): void; busy: boolean; onInterrupt(): void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>; snapshot: DesktopSnapshot;
  attachments: readonly PendingDesktopImage[];
  onAddImages(files: readonly File[]): void;
  onRemoveImage(id: string): void;
  setModel(modelId: string): void | Promise<void>; addModel(input: AddDesktopModelInput): Promise<void>; setPermission(mode: PermissionMode): void;
  slashCompletion: SlashCompletion | null;
  onSlashSelect(name: string): void;
  onSlashDismiss(): void;
  onSlashMove(delta: -1 | 1): void;
  mentionCompletion: MentionCompletion | null;
  onMentionSelect(path: string): void;
  onMentionDismiss(): void;
  onMentionMove(delta: -1 | 1): void;
  mentionSpan?: { start: number; end: number; text: string } | undefined;
  setMentionSpan(value: { start: number; end: number; text: string } | undefined): void;
  completedTokenLen: number;
  cursorPos: number;
  setCursorPos(value: number): void;
}

function Composer(props: ComposerProps): React.JSX.Element {
  const disabled = props.snapshot.workspace === undefined;
  const [draggingImages, setDraggingImages] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
    && props.input.slice(span.start, span.end) === span.text;
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
    // Remove a completed slash tag when only its separator whitespace precedes the cursor.
    const target = event.target as HTMLTextAreaElement;
    const selStart = target.selectionStart;
    const selEnd = target.selectionEnd;
    if (event.key === "Backspace" && selStart === selEnd && !menuOpen) {
      if (hasSlashTag) {
        const next = removeCompletedSlashSelection(
          props.input,
          props.completedTokenLen,
          fullCursorFromTextarea(selStart),
        );
        if (next !== null) {
          event.preventDefault();
          props.setInput(next.text);
          props.setCursorPos(next.cursor);
          return;
        }
      }
      if (hasMentionTag && selStart === 0) {
        event.preventDefault();
        const newInput = mentionBefore + mentionAfter;
        props.setInput(newInput);
        props.setMentionSpan(undefined);
        props.setCursorPos(mentionBefore.length);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      props.onSend(event.altKey ? "followUp" : props.busy ? "steer" : undefined);
    }
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
      onPaste={(event) => {
        const images = imageFiles(event.clipboardData.files);
        if (images.length === 0) return;
        event.preventDefault();
        props.onAddImages(images);
      }}
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

  return <div className="composer-wrap"
    onDragEnter={(event) => {
      if (hasImageFiles(event.dataTransfer)) {
        event.preventDefault();
        setDraggingImages(true);
      }
    }}
    onDragOver={(event) => {
      if (hasImageFiles(event.dataTransfer)) event.preventDefault();
    }}
    onDragLeave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingImages(false);
    }}
    onDrop={(event) => {
      const images = imageFiles(event.dataTransfer.files);
      if (images.length === 0) return;
      event.preventDefault();
      setDraggingImages(false);
      props.onAddImages(images);
    }}>
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
    <div className={`composer${hasSlashTag || hasMentionTag ? " has-tag" : ""}`}
      data-busy={props.busy} data-image-drag={draggingImages}>
      {props.attachments.length > 0
        && <DesktopImageAttachmentStrip attachments={props.attachments} onRemove={props.onRemoveImage} />}
      {inputRow}
    <div className="composer-tools">
      <input ref={fileInputRef} className="image-file-input" type="file"
        accept="image/png,image/jpeg,image/webp" multiple
        onChange={(event) => {
          props.onAddImages(imageFiles(event.target.files));
          event.target.value = "";
        }} />
      <button type="button" className="attach-button attach-button-labeled image-attach-button"
        title="添加图片（也可粘贴或拖入）" aria-label="添加图片"
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled || props.busy || props.attachments.length >= MAX_DESKTOP_IMAGES}><UiIcon name="image" /><span>图片</span></button>
      <button className="attach-button attach-button-labeled" title="在提示中输入 @ 引用项目文件"
        onClick={() => {
          props.setInput(`${props.input}${props.input ? " " : ""}@`);
          setTimeout(() => {
            const el = props.inputRef.current;
            if (el !== null) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
          }, 0);
        }} disabled={disabled}><UiIcon name="at" /><span>文件</span></button>
      <div className="composer-context">
        <span className="context-item" title={props.snapshot.workspace}><UiIcon name="folder" /><span>{workspaceName(props.snapshot.workspace)}</span></span>
        <span className="context-item"><UiIcon name="monitor" /><span>本地</span></span>
      </div>
      <div className="composer-controls">
        <ModelMenu models={props.snapshot.models} activeModel={props.snapshot.activeSession?.mainModel} busy={props.busy}
          onSelect={props.setModel} onAdd={props.addModel} />
        <select aria-label="权限模式" value={props.snapshot.activeSession?.permissionMode ?? "default"} disabled={props.busy || props.snapshot.activeSession === undefined}
          onChange={(event) => props.setPermission(event.target.value as PermissionMode)}>{PERMISSIONS.map((mode) => <option value={mode} key={mode}>{permissionLabel(mode)}</option>)}</select>
        {props.busy && <span className="queue-count" title="引导 + 后续消息">
          {props.snapshot.activeSession?.queue.steering.length ?? 0}+{props.snapshot.activeSession?.queue.followUp.length ?? 0}
        </span>}
        <button className="send-button" onClick={() => props.onSend(props.busy ? "steer" : undefined)}
          disabled={disabled || (!props.input.trim() && props.attachments.length === 0)}
          title={props.busy ? "发送引导消息" : "发送"}><span>↑</span></button>
        {props.busy && <button className="send-button stop-button" onClick={props.onInterrupt} title="停止任务"><span /></button>}
      </div>
    </div>
  </div><p className="composer-hint">Enter 发送 · Shift Enter 换行 · 粘贴/拖入图片 · @ 引用文件 · / 调用命令</p></div>;
}

function imageFiles(files: FileList | null): File[] {
  if (files === null) return [];
  return Array.from(files).filter((file) => file.type.startsWith("image/"));
}

function hasImageFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.items).some((item) =>
    item.kind === "file" && item.type.startsWith("image/"));
}

async function readPendingDesktopImage(file: File): Promise<PendingDesktopImage> {
  if (!IMAGE_MEDIA_TYPES.has(file.type)) {
    throw new Error(`不支持 ${file.type || "未知格式"}；请选择 PNG、JPEG 或 WebP 图片。`);
  }
  if (file.size <= 0) throw new Error(`${file.name} 是空文件。`);
  if (file.size > MAX_DESKTOP_IMAGE_BYTES) {
    throw new Error(`${file.name} 超过单图 5 MiB 限制。`);
  }
  const dataBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
  const previewUrl = URL.createObjectURL(file);
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    name: file.name,
    mediaType: file.type as DesktopImageAttachmentInput["mediaType"],
    dataBase64,
    previewUrl,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
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

const DESTRUCTIVE_TOOLS = new Set(["Delete", "Move", "RemoveTool"]);

function ApprovalSheet({ approval, onResolve }: { approval: NonNullable<DesktopSnapshot["approval"]>; onResolve(decision: "allow" | "deny" | "always"): void }): React.JSX.Element {
  const isDestructive = DESTRUCTIVE_TOOLS.has(approval.tool) || approval.allowAlways === false;
  return <div className="modal-layer"><section className="decision-sheet" role="dialog" aria-modal="true" aria-labelledby="approval-title">
    <div className="sheet-icon warning">!</div><div><p className="sheet-kicker">权限确认 · {approval.agent === "main" ? "主 Agent" : "子 Agent"}</p><h2 id="approval-title">允许执行 {approval.tool}？</h2>
      <p>{approval.reason ?? "这项操作需要你的确认。"}</p>
      {(approval.command || approval.paths?.length) && <pre>{approval.command ?? approval.paths?.join("\n")}{approval.args?.length ? ` ${approval.args.join(" ")}` : ""}</pre>}
      <div className="sheet-actions"><button onClick={() => onResolve("deny")}>拒绝</button>{!isDestructive && <button onClick={() => onResolve("always")}>始终允许同类操作</button>}<button className="primary" onClick={() => onResolve("allow")}>允许一次</button></div>
    </div>
  </section></div>;
}

export function QuestionSheet({ questions, onAnswer }: { questions: NonNullable<DesktopSnapshot["questions"]>; onAnswer(answers: Record<number, string>): void }): React.JSX.Element {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [custom, setCustom] = useState<Record<number, boolean>>({});
  const ready = questions.every((_question, index) => Boolean(answers[index]?.trim()));
  return <div className="modal-layer"><section className="question-sheet" role="dialog" aria-modal="true"><p className="sheet-kicker">Flavor 需要确认</p>
    {questions.map((question, index) => <fieldset key={`${question.header}-${index}`}><legend>{question.header}</legend><p>{question.question}</p><div className="question-options">
      {question.options.map((option) => <button data-selected={!custom[index] && answers[index] === option.label} key={option.label} onClick={() => {
        setCustom((current) => ({ ...current, [index]: false }));
        setAnswers((current) => ({ ...current, [index]: option.label }));
      }}>
        <strong>{option.label}</strong><span>{option.description}</span>
      </button>)}
      <button data-selected={custom[index] === true} onClick={() => {
        setCustom((current) => ({ ...current, [index]: true }));
        setAnswers((current) => ({ ...current, [index]: "" }));
      }}><strong>其他（自定义输入）</strong><span>键入你自己的回答</span></button>
      {custom[index] === true && <input className="question-custom-input" autoFocus value={answers[index] ?? ""}
        onChange={(event) => setAnswers((current) => ({ ...current, [index]: event.target.value }))}
        placeholder="请输入回答" aria-label={`${question.header} 自定义回答`} />}
    </div></fieldset>)}
    <div className="sheet-actions"><button className="primary" disabled={!ready} onClick={() => onAnswer(answers)}>继续</button></div>
  </section></div>;
}

export function MemoryReviewRail({ reviews, autoDismissSeconds, onResolve }: {
  reviews: NonNullable<DesktopSnapshot["memoryReviews"]>;
  autoDismissSeconds: number;
  onResolve(id: string, decision: "accept" | "dismiss"): void;
}): React.JSX.Element {
  return <aside className="memory-review-rail" aria-label="长期记忆写入确认">
    <header><div><p>待确认</p><h2>长期记忆候选</h2></div><span>{reviews.length}</span></header>
    <p className="memory-review-warning">以下内容由模型生成，确认前不会写入长期记忆，也不会影响后续会话。</p>
    <div className="memory-review-list">{reviews.map((review) => <article key={review.id}>
      <small>{review.type}</small><p>{review.content}</p>
      <MemoryReviewCountdown seconds={autoDismissSeconds} />
      <div><button onClick={() => onResolve(review.id, "dismiss")}>忽略</button><button className="primary" onClick={() => onResolve(review.id, "accept")}>保存</button></div>
    </article>)}</div>
  </aside>;
}

function MemoryReviewCountdown({ seconds }: { seconds: number }): React.JSX.Element | null {
  const [remaining, setRemaining] = useState(seconds);
  useEffect(() => {
    if (seconds <= 0) return;
    setRemaining(seconds);
    const timer = setInterval(() => setRemaining((current) => Math.max(0, current - 1)), 1_000);
    return (): void => clearInterval(timer);
  }, [seconds]);
  if (seconds <= 0) return null;
  return <small className="memory-review-countdown">未操作将在 {remaining}s 后自动忽略</small>;
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

// 应用内品牌图标优先使用主进程下发的 assets/icon.png data URL，
// 多个 FlavorMark 实例共享同一次 IPC 请求；加载失败时回退到内置 SVG。
let appIconPromise: Promise<string | undefined> | undefined;
function loadAppIcon(): Promise<string | undefined> {
  appIconPromise ??= window.flavorDesktop.appIcon().catch(() => undefined);
  return appIconPromise;
}

function useAppIcon(): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void loadAppIcon().then((next) => { if (!cancelled) setUrl(next); });
    return () => { cancelled = true; };
  }, []);
  return url;
}

type UiIconName = "plus" | "folder" | "sparkles" | "database" | "server" | "checklist" | "image" | "at" | "monitor" | "bell" | "git" | "search";

function UiIcon({ name }: { name: UiIconName }): React.JSX.Element {
  let content: React.JSX.Element;
  switch (name) {
    case "plus": content = <path d="M10 4v12M4 10h12" />; break;
    case "folder": content = <path d="M2.75 6.25h5l1.5 1.75h8v7.25a1.5 1.5 0 0 1-1.5 1.5h-12a1.5 1.5 0 0 1-1.5-1.5v-7.5a1.5 1.5 0 0 1 1.5-1.5Z" />; break;
    case "sparkles": content = <><path d="M8.25 3.25c.4 2.4 1.6 3.6 4 4-2.4.4-3.6 1.6-4 4-.4-2.4-1.6-3.6-4-4 2.4-.4 3.6-1.6 4-4Z" /><path d="M14.5 11.5c.25 1.45 1.05 2.25 2.5 2.5-1.45.25-2.25 1.05-2.5 2.5-.25-1.45-1.05-2.25-2.5-2.5 1.45-.25 2.25-1.05 2.5-2.5Z" /></>; break;
    case "database": content = <><ellipse cx="10" cy="5" rx="6.25" ry="2.5" /><path d="M3.75 5v5c0 1.38 2.8 2.5 6.25 2.5s6.25-1.12 6.25-2.5V5M3.75 10v5c0 1.38 2.8 2.5 6.25 2.5s6.25-1.12 6.25-2.5v-5" /></>; break;
    case "server": content = <><rect x="3" y="3.5" width="14" height="5" rx="1.5" /><rect x="3" y="11.5" width="14" height="5" rx="1.5" /><path d="M6 6h.01M6 14h.01M9 6h5M9 14h5" /></>; break;
    case "checklist": content = <><rect x="3.25" y="2.75" width="13.5" height="14.5" rx="2" /><path d="m6.25 7 1.25 1.25L10 5.75M11.75 7h2M6.25 12h1.5M10 12h4" /></>; break;
    case "image": content = <><rect x="2.75" y="3.25" width="14.5" height="13.5" rx="2" /><circle cx="7" cy="7.25" r="1.25" /><path d="m4.75 14 3.5-3.5 2.25 2.25 2.25-2.5 2.5 3.75" /></>; break;
    case "at": content = <><circle cx="9.5" cy="10" r="3" /><path d="M12.5 10v1.25c0 1.15.8 1.75 1.75 1.75 1.4 0 2.25-1.2 2.25-3a6.5 6.5 0 1 0-2.1 4.78" /></>; break;
    case "monitor": content = <><rect x="2.75" y="3.5" width="14.5" height="10.5" rx="2" /><path d="M7 17h6M10 14v3" /></>; break;
    case "bell": content = <><path d="M5.25 8.5a4.75 4.75 0 0 1 9.5 0c0 5 2 5.5 2 5.5H3.25s2-.5 2-5.5Z" /><path d="M8 16a2.25 2.25 0 0 0 4 0" /></>; break;
    case "git": content = <><circle cx="5" cy="4" r="1.75" /><circle cx="15" cy="6.5" r="1.75" /><circle cx="5" cy="16" r="1.75" /><path d="M5 5.75v8.5M6.75 7.5C11 7.5 10.5 6.5 13.25 6.5" /></>; break;
    case "search": content = <><circle cx="8.75" cy="8.75" r="5.25" /><path d="m12.5 12.5 4 4" /></>; break;
  }
  return <svg className="ui-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">{content}</svg>;
}

function FlavorMark(): React.JSX.Element {
  const appIcon = useAppIcon();
  if (appIcon !== undefined) {
    return <img className="flavor-mark" src={appIcon} alt="" aria-hidden="true" />;
  }
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

export function ModelMenu({ models, activeModel, busy, onSelect, onAdd }: {
  models: readonly DesktopModelOption[];
  activeModel?: string | undefined;
  busy: boolean;
  onSelect(modelId: string): void | Promise<void>;
  onAdd(input: AddDesktopModelInput): Promise<void>;
}): React.JSX.Element {
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [draft, setDraft] = useState<AddDesktopModelInput>({
    provider: "", model: "", baseURL: "", apiKey: "", protocol: "openai-compatible",
  });
  const effectiveModel = activeModel ?? models[0]?.id;
  const selectedModel = models.find((model) => model.id === effectiveModel);
  const modelLabel = selectedModel?.label ?? shortModel(effectiveModel);
  const update = <Key extends keyof AddDesktopModelInput>(key: Key, value: AddDesktopModelInput[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setFormError(undefined);
  };
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const form = event.currentTarget;
    setSaving(true);
    setFormError(undefined);
    try {
      await onAdd(draft);
      setAdding(false);
      setDraft({ provider: "", model: "", baseURL: "", apiKey: "", protocol: "openai-compatible" });
      form.closest("details")?.removeAttribute("open");
    } catch (cause) { setFormError(errorMessage(cause)); }
    finally { setSaving(false); }
  };

  return <details className="model-menu"><summary aria-label={`主模型：${modelLabel}`} title="切换主模型">
    <span className="model-status-dot" data-configured={selectedModel !== undefined} />
    <span className="model-summary-label">{modelLabel}</span>
    <span className="model-summary-chevron" aria-hidden="true" />
  </summary><div className="popover model-popover">
    <div className="model-popover-heading"><div><strong>{adding ? "添加厂商模型" : "切换主模型"}</strong><span>{adding ? "连接 OpenAI 兼容或 Anthropic 服务" : "DeepSeek 默认可用，也可接入其他厂商"}</span></div>
      {!adding && <button type="button" onClick={() => setAdding(true)} disabled={busy}>＋ 新增</button>}
    </div>
    {adding ? <form className="model-provider-form" onSubmit={(event) => void submit(event)}>
      <div className="model-form-grid">
        <label><span>厂商名称 / ID</span><input required maxLength={64} placeholder="例如 siliconflow" value={draft.provider}
          onChange={(event) => update("provider", event.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9_-]*" /></label>
        <label><span>模型名称</span><input required maxLength={256} placeholder="例如 qwen3-coder" value={draft.model}
          onChange={(event) => update("model", event.target.value)} /></label>
      </div>
      <label><span>接口协议</span><select value={draft.protocol} onChange={(event) => update("protocol", event.target.value as AddDesktopModelInput["protocol"])}>
        <option value="openai-compatible">OpenAI 兼容 API</option><option value="anthropic">Anthropic API</option>
      </select></label>
      <label><span>Base URL</span><input required type="url" maxLength={2048} placeholder="https://api.example.com/v1" value={draft.baseURL}
        onChange={(event) => update("baseURL", event.target.value)} /></label>
      <label><span>API Key</span><input required type="password" autoComplete="off" maxLength={16384} placeholder="输入服务密钥" value={draft.apiKey}
        onChange={(event) => update("apiKey", event.target.value)} /></label>
      <p className="model-security-note"><span>◆</span> 配置同步到当前项目，密钥只加密保存在本机。保存后会新建会话。</p>
      {formError !== undefined && <p className="model-form-error" role="alert">{formError}</p>}
      <div className="model-form-actions"><button type="button" onClick={() => { setAdding(false); setFormError(undefined); }} disabled={saving}>取消</button>
        <button type="submit" className="primary" disabled={saving || busy}>{saving ? "正在连接…" : "保存并切换"}</button></div>
    </form> : <div className="model-options" role="listbox" aria-label="主模型">
      {models.map((model) => {
        const selected = effectiveModel === model.id;
        return <button type="button" role="option" aria-selected={selected} className="model-option" key={model.id}
          disabled={busy || selected}
          onClick={(event) => {
            void onSelect(model.id);
            event.currentTarget.closest("details")?.removeAttribute("open");
          }}>
          <span className="model-option-copy"><strong>{model.label}</strong><small>{model.description}</small></span>
          {model.source === "custom" && <span className="model-option-badge">自定义</span>}
          <span className="model-option-state" aria-hidden="true">{selected ? "✓" : "→"}</span>
        </button>;
      })}
    </div>}
  </div></details>;
}
function formatSessionTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }); }
