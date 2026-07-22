import { basename } from "node:path";
import React, { useEffect, useReducer, useRef, useState } from "react";
import {
  Box,
  ScrollBox,
  Text,
  useApp,
  useInput,
  useStdout,
  type Key,
  type ScrollBoxHandle,
} from "../claude-ink/index.js";
import { useAnimationFrame } from "../claude-ink/hooks/use-animation-frame.js";
import { useHasSelection, useSelection } from "../claude-ink/hooks/use-selection.js";
import { useTerminalTitle } from "../claude-ink/hooks/use-terminal-title.js";
import type { ClickEvent } from "../claude-ink/events/click-event.js";

import { createProductionRuntime, type ProductionRuntime } from "../production.js";
import { isDestructiveTool } from "../permissions/engine.js";
import { AssistantText } from "./assistant-text.js";
import type { SessionOutput } from "./session.js";
import type { Question } from "../tools/ask-user-question.js";
import type { MemoryReviewItem } from "../memory/review.js";
import { createSessionInterruptHandler, installSigintHandler } from "./signals.js";
import {
  createTranscriptState,
  transcriptReducer,
  type TranscriptBlock,
  type TranscriptTurn,
} from "./transcript.js";
import { wrapPromptInput } from "./wrap-prompt.js";
import { charWidth } from "./char-width.js";
import { TaskProgressPanel, TaskStatusLine } from "./task-progress.js";
import type { FileChangePresentation, FileDiffLine } from "../tools/types.js";
import { fileDiffLineStyle } from "./file-diff-style.js";
import { COMMAND_DESCRIPTIONS, MVP_COMMANDS } from "./commands.js";
import {
  buildSlashCandidates,
  completeSlashSelection,
  completedSlashTokenLength,
  completedSlashTokenPresentation,
  deriveSlashCompletion,
  matchRanges,
  moveSlashSelection,
  slashCandidatePresentation,
  type SlashCandidate,
  type SlashCompletion,
} from "./slash-completion.js";
import { message } from "../utils/error.js";
import { redactErrorText } from "../utils/redact.js";
import { compactProgressPresentation } from "./compact-progress.js";
import { createGlobTool, type SearchResult } from "../tools/search.js";
import {
  buildMentionCandidates,
  completeMentionSelection,
  deriveMentionCompletion,
  mentionCandidatePresentation,
  moveMentionSelection,
  type MentionCompletion,
} from "./mention-completion.js";
import { WelcomeCard } from "./welcome.js";

export const HISTORY_CAP = 200;
const BUILTIN_SLASH_CANDIDATES = MVP_COMMANDS.map((name) => ({ name, description: COMMAND_DESCRIPTIONS[name] }));
const PROMPT_HORIZONTAL_PADDING = 1;

export interface PastedBlock {
  id: number;
  text: string;
}

export type TerminalInputAction =
  | { type: "scroll"; rows: number }
  | { type: "page"; fraction: number }
  | { type: "history"; direction: "up" | "down" };

export function classifyTerminalInput(key: Pick<Key, "wheelUp" | "wheelDown" | "pageUp" | "pageDown" | "upArrow" | "downArrow">): TerminalInputAction | null {
  if (key.wheelUp) return { type: "scroll", rows: -3 };
  if (key.wheelDown) return { type: "scroll", rows: 3 };
  if (key.pageUp) return { type: "page", fraction: -0.5 };
  if (key.pageDown) return { type: "page", fraction: 0.5 };
  if (key.upArrow) return { type: "history", direction: "up" };
  if (key.downArrow) return { type: "history", direction: "down" };
  return null;
}

export type CompletionKeyAction =
  | { type: "select"; delta: -1 | 1 }
  | { type: "complete" }
  | { type: "dismiss" };

export type SlashKeyAction = CompletionKeyAction;

export function completionKeyAction(
  key: Pick<Key, "upArrow" | "downArrow" | "tab" | "escape">,
  menuOpen: boolean,
): CompletionKeyAction | null {
  if (!menuOpen) return null;
  if (key.upArrow) return { type: "select", delta: -1 };
  if (key.downArrow) return { type: "select", delta: 1 };
  if (key.tab) return { type: "complete" };
  if (key.escape) return { type: "dismiss" };
  return null;
}

export function slashKeyAction(
  key: Pick<Key, "upArrow" | "downArrow" | "tab" | "escape">,
  completion: SlashCompletion | null,
): SlashKeyAction | null {
  return completionKeyAction(key, completion !== null);
}

export interface FlavorAppProps { workspace: string; home?: string; resumeSession?: string | true }

export function App({ workspace, home, resumeSession }: FlavorAppProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [runtime, setRuntime] = useState<ProductionRuntime>();
  const [input, setInput] = useState("");
  const [pastedBlocks, setPastedBlocks] = useState<PastedBlock[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState(0);
  const [promptCursor, setPromptCursor] = useState(0);
  const [slashCandidates, setSlashCandidates] = useState<SlashCandidate[]>(
    () => buildSlashCandidates(BUILTIN_SLASH_CANDIDATES, [], []),
  );
  const [slashSelection, setSlashSelection] = useState(0);
  const [dismissedSlashInput, setDismissedSlashInput] = useState<string>();
  const [mentionCandidates, setMentionCandidates] = useState<string[]>([]);
  const [mentionSelection, setMentionSelection] = useState(0);
  const [dismissedMentionInput, setDismissedMentionInput] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [questionAnswers, setQuestionAnswers] = useState<Record<number, string>>({});
  const [customQuestionActive, setCustomQuestionActive] = useState(false);
  const [columns, setColumns] = useState(stdout?.columns ?? 80);
  const [rows, setRows] = useState(stdout?.rows ?? 24);
  const [transcript, dispatch] = useReducer(transcriptReducer, undefined, createTranscriptState);
  const scrollRef = useRef<ScrollBoxHandle>(null);
  const taskScrollRef = useRef<ScrollBoxHandle>(null);
  const taskPanelHovered = useRef(false);
  const runtimeRef = useRef<ProductionRuntime | undefined>(undefined);
  const closing = useRef(false);
  const textBuf = useRef<{ pending: string; timer: ReturnType<typeof setTimeout> | null }>({ pending: "", timer: null });

  useTerminalTitle("Flavor Code");

  const flushText = (): void => {
    const t = textBuf.current;
    if (t.timer !== null) { clearTimeout(t.timer); t.timer = null; }
    if (t.pending.length > 0) {
      dispatch({ type: "session", event: { type: "text", text: t.pending } });
      t.pending = "";
    }
  };

  const shutdown = async (active: ProductionRuntime | undefined) => {
    if (closing.current) return;
    closing.current = true;
    await shutdownRuntime(active, exit, (error) => {
      dispatch({ type: "submit-error", message: error });
    });
  };
  const shutdownRef = useRef(shutdown);
  shutdownRef.current = shutdown;
  const interruptRef = useRef<(() => void) | undefined>(undefined);
  interruptRef.current ??= createSessionInterruptHandler(
    () => runtimeRef.current?.session,
    () => shutdownRef.current(runtimeRef.current),
  );
  const interrupt = interruptRef.current;

  useEffect(() => {
    let disposed = false;
    const FLUSH_MS = 100;
    const receive = (event: SessionOutput): void => {
      if (event.type === "exit") {
        flushText();
        void shutdownRef.current(runtimeRef.current);
        return;
      }
      if (event.type === "clear") {
        flushText();
        dispatch({ type: "clear" });
        return;
      }
      if (event.type === "text") {
        const t = textBuf.current;
        t.pending += event.text;
        if (t.timer === null) t.timer = setTimeout(flushText, FLUSH_MS);
        return;
      }
      flushText();
      dispatch({ type: "session", event });
    };
    void createProductionRuntime({
      workspace,
      ...(home === undefined ? {} : { home }),
      ...(resumeSession === undefined ? {} : { resumeSession }),
      output: receive,
      onApprovalChange: () => setRevision((value) => value + 1),
    }).then(async (created) => {
      if (disposed) { await created.dispose(); return; }
      dispatch({ type: "restore", state: created.restoredTranscript });
      runtimeRef.current = created;
      setSlashCandidates(buildSlashCandidates(BUILTIN_SLASH_CANDIDATES, created.services.pluginCommands(), []));
      setRuntime(created);
      await created.session.start();
      try {
        const skills = await created.services.skills();
        if (!disposed) {
          setSlashCandidates(buildSlashCandidates(BUILTIN_SLASH_CANDIDATES, created.services.pluginCommands(), skills));
        }
      } catch {
        // Invalid skill files are reported by runtime diagnostics; static candidates remain usable.
      }
    }).catch((error: unknown) => {
      dispatch({ type: "submit", prompt: "startup" });
      dispatch({ type: "submit-error", message: safeUiError(error) });
    });
    return () => {
      disposed = true;
      flushText();
      void closeAndDisposeRuntime(runtimeRef.current, (error) => process.stderr.write(`flavor cleanup: ${error}\n`));
    };
  }, [workspace, home, resumeSession]);

  useEffect(() => installSigintHandler(process, interrupt), [interrupt]);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    void createGlobTool(workspace, { defaultLimit: 10_000 })
      .execute({ pattern: "**", limit: 10_000 }, controller.signal)
      .then((result) => {
        if (!disposed) {
          setMentionCandidates(buildMentionCandidates((result as SearchResult<string>).matches));
        }
      })
      .catch(() => {
        // File completion is optional; discovery failure must not block prompt input.
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [workspace]);

  useEffect(() => {
    if (!stdout || typeof stdout.on !== "function") return;
    const onResize = (): void => {
      setColumns(stdout.columns ?? 80);
      setRows(stdout.rows ?? 24);
    };
    stdout.on("resize", onResize);
    onResize();
    return (): void => { stdout.off("resize", onResize); };
  }, [stdout]);

  const approval = runtime?.approvals.pending;
  const questions = runtime?.services.questions.pending;
  const memoryReviews = runtime?.memoryReviews.pending ?? [];
  useEffect(() => {
    setQuestionIndex(0);
    setQuestionAnswers({});
    setCustomQuestionActive(false);
  }, [questions]);
  const derivedSlashCompletion = deriveSlashCompletion(input, promptCursor, slashCandidates, slashSelection);
  const slashCompletion = dismissedSlashInput === input || transcript.active !== undefined || approval !== undefined || questions !== undefined
    ? null
    : derivedSlashCompletion;
  const derivedMentionCompletion = slashCompletion === null
    ? deriveMentionCompletion(input, promptCursor, mentionCandidates, mentionSelection)
    : null;
  const mentionCompletion = dismissedMentionInput === input || transcript.active !== undefined || approval !== undefined || questions !== undefined
    ? null
    : derivedMentionCompletion;
  const completedTokenLength = completedSlashTokenLength(input, slashCandidates, slashCompletion !== null);
  const selection = useSelection();

  const selectMention = (path: string): void => {
    const next = completeMentionSelection(input, promptCursor, path);
    setInput(next.text);
    setPromptCursor(next.cursor);
    setMentionSelection(0);
    setDismissedMentionInput(next.text);
  };

  useInput((character, key) => {
    const terminalAction = classifyTerminalInput(key);
    if (terminalAction?.type === "scroll") {
      const scroll = selectWheelScrollTarget(scrollRef.current, taskScrollRef.current, taskPanelHovered.current);
      if (scroll !== null) {
        if (terminalAction.rows < 0) scrollUp(scroll, -terminalAction.rows);
        else scrollDown(scroll, terminalAction.rows);
      }
      return;
    }
    if (terminalAction?.type === "page") {
      const scroll = scrollRef.current;
      if (scroll !== null) jumpScroll(scroll, Math.floor(scroll.getViewportHeight() * terminalAction.fraction));
      return;
    }

    const active = runtimeRef.current;
    if (key.ctrl && character === "c") {
      if (selection.hasSelection()) { selection.copySelection(); }
      else { interrupt(); }
      return;
    }
    if (active?.approvals.pending !== undefined) {
      if (character.toLowerCase() === "y") active.approvals.resolve("once");
      if (character.toLowerCase() === "n" || key.escape) active.approvals.resolve("deny");
      if (character.toLowerCase() === "a") {
        if (isDestructiveTool(active.approvals.pending.tool)) {
          active.approvals.resolve("once");
        } else {
          active.approvals.resolve("always");
        }
      }
      return;
    }
    const pendingMemory = active?.memoryReviews.pending[0];
    if (pendingMemory !== undefined && key.ctrl && (character.toLowerCase() === "y" || character.toLowerCase() === "n")) {
      if (character.toLowerCase() === "y") {
        void active!.memoryReviews.accept(pendingMemory.id).catch((error) => {
          dispatch({ type: "submit-error", message: safeUiError(error) });
        });
      } else active!.memoryReviews.dismiss(pendingMemory.id);
      return;
    }
    const qs = active?.services.questions.pending;
    if (qs !== undefined && qs.length > 0) {
      const questionsService = active!.services.questions;
      const currentIndex = Math.min(questionIndex, qs.length - 1);
      const question = qs[currentIndex]!;
      const commitQuestionAnswer = (answer: string): void => {
        const next = { ...questionAnswers, [currentIndex]: answer };
        setInput(""); setPromptCursor(0); setCustomQuestionActive(false);
        if (currentIndex === qs.length - 1) {
          setQuestionAnswers({}); setQuestionIndex(0);
          questionsService.answer(next);
        } else {
          setQuestionAnswers(next); setQuestionIndex(currentIndex + 1);
        }
      };
      if (key.escape) {
        if (customQuestionActive) {
          setCustomQuestionActive(false); setInput(""); setPromptCursor(0);
        } else questionsService.cancel();
        return;
      }
      if (customQuestionActive) {
        if (key.return) {
          const answer = input.trim();
          if (answer) commitQuestionAnswer(answer);
          return;
        }
        // Let the ordinary prompt editor below collect the custom answer.
      } else {
        const digit = parseInt(character, 10);
        if (digit >= 1 && digit <= question.options.length) {
          commitQuestionAnswer(question.options[digit - 1]!.label);
          return;
        }
        if (digit === question.options.length + 1) {
          setCustomQuestionActive(true); setInput(""); setPromptCursor(0);
          return;
        }
        if (!key.ctrl && !key.meta && character) setCustomQuestionActive(true);
        else return;
      }
    }
    const menuAction = slashKeyAction(key, slashCompletion);
    if (menuAction?.type === "select" && slashCompletion !== null) {
      setSlashSelection((value) => moveSlashSelection(value, menuAction.delta, slashCompletion.items.length));
      return;
    }
    if (menuAction?.type === "complete" && slashCompletion !== null) {
      const selected = slashCompletion.items[slashCompletion.selectedIndex];
      if (selected !== undefined) {
        const next = completeSlashSelection(input, promptCursor, selected.name);
        setInput(next.text);
        setPromptCursor(next.cursor);
        setDismissedSlashInput(next.text);
      }
      return;
    }
    if (menuAction?.type === "dismiss") {
      setDismissedSlashInput(input);
      return;
    }
    const mentionAction = completionKeyAction(key, mentionCompletion !== null);
    if (mentionAction?.type === "select" && mentionCompletion !== null) {
      setMentionSelection((value) => moveMentionSelection(value, mentionAction.delta, mentionCompletion.items.length));
      return;
    }
    if (mentionAction?.type === "complete" && mentionCompletion !== null) {
      const selected = mentionCompletion.items[mentionCompletion.selectedIndex];
      if (selected !== undefined) selectMention(selected);
      return;
    }
    if (mentionAction?.type === "dismiss") {
      setDismissedMentionInput(input);
      return;
    }
    if (key.return) {
      const prompt = input.trim();
      if (!prompt || active === undefined || transcript.active !== undefined) return;
      scrollRef.current?.scrollToBottom();
      dispatch({ type: "submit", prompt });
      setHistory((current) => [...current, prompt].slice(-HISTORY_CAP));
      setHistoryCursor(history.length + 1);
      setInput("");
      setPastedBlocks([]);
      setPromptCursor(0);
      setSlashSelection(0);
      setDismissedSlashInput(undefined);
      setMentionSelection(0);
      setDismissedMentionInput(undefined);
      void submitSafely(active.session, prompt, (error) => {
        dispatch({ type: "submit-error", message: error });
      }).finally(() => dispatch({ type: "finish" }));
      return;
    }
    if (key.backspace) {
      const next = editPromptWithPastedBlocks(
        { text: input, cursor: promptCursor },
        { type: "backspace" },
        pastedBlocks,
      );
      setInput(next.text);
      setPromptCursor(next.cursor);
      setPastedBlocks(next.pastedBlocks);
      setSlashSelection(0); setDismissedSlashInput(undefined);
      setMentionSelection(0); setDismissedMentionInput(undefined);
    } else if (key.delete) {
      updatePrompt({ type: "delete" }, input, promptCursor, setInput, setPromptCursor);
      setSlashSelection(0); setDismissedSlashInput(undefined);
      setMentionSelection(0); setDismissedMentionInput(undefined);
    }
    else if (key.leftArrow) setPromptCursor((value) => Math.max(0, value - 1));
    else if (key.rightArrow) setPromptCursor((value) => Math.min([...input].length, value + 1));
    else if (terminalAction?.type === "history" && terminalAction.direction === "up" && history.length) {
      const next = navigateHistory({ history, cursor: historyCursor }, "up");
      setHistoryCursor(next.cursor); setInput(next.input); setPromptCursor(next.promptCursor);
      setSlashSelection(0); setDismissedSlashInput(undefined);
      setMentionSelection(0); setDismissedMentionInput(undefined);
    } else if (terminalAction?.type === "history" && terminalAction.direction === "down" && history.length) {
      const next = navigateHistory({ history, cursor: historyCursor }, "down");
      setHistoryCursor(next.cursor); setInput(next.input); setPromptCursor(next.promptCursor);
      setSlashSelection(0); setDismissedSlashInput(undefined);
      setMentionSelection(0); setDismissedMentionInput(undefined);
    } else if (!key.ctrl && !key.meta && character) {
      updatePrompt({ type: "insert", value: character }, input, promptCursor, setInput, setPromptCursor);
      if (/[\r\n]/u.test(character)) {
        setPastedBlocks((current) => [...current, { id: current.length + 1, text: character }]);
      }
      setSlashSelection(0); setDismissedSlashInput(undefined);
      setMentionSelection(0); setDismissedMentionInput(undefined);
    }
  });

  void revision;
  if (runtime === undefined) return <StartingLayout
    workspaceName={basename(workspace)}
    completed={transcript.completed}
    {...(transcript.active === undefined ? {} : { active: transcript.active })}
    columns={columns}
    rows={rows}
  />;
  return <TerminalLayout
    model={runtime.services.mainModel()}
    workspaceName={basename(workspace)}
    completed={transcript.completed}
    {...(transcript.active === undefined ? {} : { active: transcript.active })}
    input={input}
    pastedBlocks={pastedBlocks}
    promptCursor={promptCursor}
    onPromptCursorChange={setPromptCursor}
    columns={columns}
    rows={rows}
    activeSession={transcript.active !== undefined}
    completedSlashTokenLength={completedTokenLength}
    scrollRef={scrollRef}
    taskScrollRef={taskScrollRef}
    onTaskPanelHoverChange={(hovered) => { taskPanelHovered.current = hovered; }}
    {...(slashCompletion === null ? {} : { completion: slashCompletion })}
    {...(mentionCompletion === null ? {} : { mentionCompletion, onMentionSelect: selectMention })}
    {...(approval === undefined ? {} : { approval })}
    {...(questions === undefined ? {} : { questions })}
    memoryReviews={memoryReviews}
    questionIndex={questionIndex}
    questionAnswers={questionAnswers}
    customQuestionActive={customQuestionActive}
  />;
}

function StartingLayout({
  workspaceName, completed, active, columns, rows,
}: Pick<TerminalLayoutProps, "workspaceName" | "completed" | "active" | "columns"> & { rows: number }): React.JSX.Element {
  return <TerminalLayout
    model="starting"
    workspaceName={workspaceName}
    completed={completed}
    {...(active === undefined ? {} : { active })}
    input=""
    promptCursor={0}
    columns={columns}
    rows={rows}
    activeSession={false}
  />;
}

export interface TerminalLayoutProps {
  model: string;
  workspaceName: string;
  completed: TranscriptTurn[];
  active?: TranscriptTurn;
  input: string;
  pastedBlocks?: readonly PastedBlock[];
  promptCursor: number;
  onPromptCursorChange?: (cursor: number) => void;
  columns: number;
  rows?: number;
  activeSession: boolean;
  completedSlashTokenLength?: number;
  completion?: SlashCompletion;
  mentionCompletion?: MentionCompletion;
  onMentionSelect?: (path: string) => void;
  approval?: { tool: string; reason?: string };
  questions?: readonly Question[];
  memoryReviews?: readonly MemoryReviewItem[];
  questionIndex?: number;
  questionAnswers?: Readonly<Record<number, string>>;
  customQuestionActive?: boolean;
  scrollRef?: React.Ref<ScrollBoxHandle>;
  taskScrollRef?: React.Ref<ScrollBoxHandle>;
  onTaskPanelHoverChange?: (hovered: boolean) => void;
}

export function TerminalLayout({
  model, workspaceName, completed, active, input, pastedBlocks = [], promptCursor, columns, rows = 24, activeSession, approval,
  questions, memoryReviews = [], questionIndex = 0, questionAnswers = {}, customQuestionActive = false,
  completion, mentionCompletion, onMentionSelect, completedSlashTokenLength: tokenLength = 0, scrollRef,
  taskScrollRef, onTaskPanelHoverChange, onPromptCursorChange,
}: TerminalLayoutProps): React.JSX.Element {
  const dividerWidth = Math.max(1, columns - 1);
  const showWelcome = completed.length === 0 && active === undefined;
  const activeCompletion = completion ?? mentionCompletion;
  const menuRows = activeCompletion === undefined ? 0 : Math.min(6, activeCompletion.items.length - activeCompletion.windowStart);

  const activeTaskBlocks = active?.blocks.filter(
    (block): block is Extract<TranscriptBlock, { kind: "status" }> =>
      block.kind === "status" && block.task !== undefined,
  ) ?? [];
  const activeWithoutTasks = active === undefined ? undefined : {
    ...active,
    blocks: active.blocks.filter((block) =>
      !(block.kind === "status" && block.task !== undefined),
    ),
  };

  const questionRows = questions === undefined ? 0
    : 4 + (questions[questionIndex]?.options.length ?? 0) + questions.length * 2;
  const memoryReviewRows = memoryReviews.length === 0 ? 0 : 5;

  const fixedBottomRows = (approval === undefined ? 0 : 3) + questionRows + memoryReviewRows + menuRows + 2;
  const taskPanelRows = taskPanelViewportRows(rows, fixedBottomRows, activeTaskBlocks.length > 0);
  const availableBottomRows = Math.max(1, rows - taskPanelRows - 1);
  const bottomMaxRows = Math.min(availableBottomRows, Math.max(Math.floor(rows / 2), fixedBottomRows + 1));
  const promptMaxLines = Math.max(1, bottomMaxRows - fixedBottomRows);
  return <Box height={rows} width="100%" flexDirection="column" overflow="hidden">
    <ScrollBox {...(scrollRef === undefined ? {} : { ref: scrollRef })} flexGrow={1} flexDirection="column" stickyScroll>
      {showWelcome
        ? <WelcomeCard model={model} workspaceName={workspaceName} columns={columns} />
        : <Text dimColor>{"flavor · "}{model}{" · "}{workspaceName}</Text>}
      <Box height={1} />
      {completed.map((turn, index) => (
        <Box key={turn.id} flexDirection="column">
          {index > 0 ? <TurnSeparator width={columns} /> : null}
          <TurnView turn={turn} interactive={false} />
        </Box>
      ))}
      {activeWithoutTasks === undefined ? null : (
        <Box flexDirection="column">
          {completed.length > 0 ? <TurnSeparator width={columns} /> : null}
          <TurnView turn={activeWithoutTasks} interactive={activeSession} />
        </Box>
      )}
    </ScrollBox>
    <TaskProgressPanel
      blocks={activeTaskBlocks}
      interactive={activeSession}
      maxHeight={taskPanelRows}
      {...(taskScrollRef === undefined ? {} : { scrollRef: taskScrollRef })}
      {...(onTaskPanelHoverChange === undefined ? {} : { onHoverChange: onTaskPanelHoverChange })}
    />
    <Box flexDirection="column" flexShrink={0} maxHeight={bottomMaxRows} width="100%" overflowY="hidden">
      {approval === undefined ? null : <Box flexDirection="column" marginBottom={1}>
        <Text color="magenta">┌─ approval · {approval.tool}</Text>
        <Text wrap="truncate-end" color="magentaBright">│ {approval.reason ?? "This action needs permission."}</Text>
        {isDestructiveTool(approval.tool)
                ? <Text bold color="magenta">└─ Allow? <Text color="green">y</Text>=once / <Text color="red">n</Text>=deny</Text>
                : <Text bold color="magenta">└─ Allow? <Text color="green">y</Text>=once / <Text color="yellow">a</Text>=same-type / <Text color="red">n</Text>=deny</Text>
              }
      </Box>}
      {!questions || questions.length === 0 ? null : (
        <QuestionCards questions={questions} activeIndex={questionIndex} answers={questionAnswers} customActive={customQuestionActive} />
      )}
      {memoryReviews.length === 0 ? null : <MemoryReviewCards reviews={memoryReviews} />}
      {completion === undefined ? null : <SlashMenu completion={completion} />}
      {mentionCompletion === undefined ? null : (
        <MentionMenu completion={mentionCompletion} {...(onMentionSelect === undefined ? {} : { onSelect: onMentionSelect })} />
      )}
      <Text dimColor>{"─".repeat(dividerWidth)}</Text>
      <PromptLine
        input={input}
        pastedBlocks={pastedBlocks}
        cursor={promptCursor}
        columns={columns}
        maxVisibleLines={promptMaxLines}
        completedSlashTokenLength={tokenLength}
        {...(onPromptCursorChange === undefined ? {} : { onCursorChange: onPromptCursorChange })}
      />
      <Text dimColor wrap="truncate-end">{activeSession
        ? "Ctrl+C cancel · Ctrl+C again exit"
        : completion !== undefined
          ? "↑/↓ select · Tab complete · Esc close"
          : mentionCompletion !== undefined
            ? "↑/↓ select · Tab complete · click choose · Esc close"
            : "Enter send · ↑↓ history · Ctrl+C exit"}</Text>
    </Box>
  </Box>;
}

function QuestionCards({ questions, activeIndex, answers, customActive }: {
  questions: readonly Question[];
  activeIndex: number;
  answers: Readonly<Record<number, string>>;
  customActive: boolean;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {questions.map((q, qi) => (
        <Box key={qi} flexDirection="column" marginBottom={qi < questions.length - 1 ? 1 : 0}>
          <Text bold color="cyan">┌─ {q.header}</Text>
          <Text wrap="truncate-end" color="cyanBright">│ {q.question}</Text>
          {qi < activeIndex ? <Text color="green">│  ✓ {answers[qi]}</Text> : qi > activeIndex ? null : q.options.map((opt, oi) => (
            <Text key={oi} color="cyan">
              │  <Text bold color="green">{oi + 1}</Text>. {opt.label}
              <Text dimColor>  {opt.description}</Text>
            </Text>
          ))}
          {qi === activeIndex ? <>
            <Text color="cyan">│  <Text bold color="green">{q.options.length + 1}</Text>. Custom input<Text dimColor>  Type your own answer</Text></Text>
            <Text dimColor color="cyan">└─ {customActive
              ? "Type below and press Enter; Esc returns to choices"
              : `Press 1-${q.options.length + 1} to choose; Esc dismisses`}</Text>
          </> : null}
        </Box>
      ))}
    </Box>
  );
}

function MemoryReviewCards({ reviews }: { reviews: readonly MemoryReviewItem[] }): React.JSX.Element {
  const review = reviews[0]!;
  return <Box flexDirection="column" marginBottom={1}>
    <Text bold color="yellow">┌─ Long-term memory requires confirmation ({reviews.length})</Text>
    <Text color="yellowBright" wrap="truncate-end">│ [{review.type}] {review.content}</Text>
    <Text dimColor>│ Model-generated content is not stored until you approve it.</Text>
    <Text color="yellow">└─ <Text bold>Ctrl+Y</Text> save / <Text bold>Ctrl+N</Text> ignore (conversation remains available)</Text>
  </Box>;
}

function SlashMenu({ completion }: { completion: SlashCompletion }): React.JSX.Element {
  const visible = completion.items.slice(completion.windowStart, completion.windowStart + 6);
  return <Box flexDirection="column" width="100%">
    {visible.map((candidate, visibleIndex) => {
      const index = completion.windowStart + visibleIndex;
      const presentation = slashCandidatePresentation(index === completion.selectedIndex);
      return <Text key={`${candidate.kind}:${candidate.name}`} {...presentation.rowStyle} wrap="truncate-end">
        {presentation.marker}
        <HighlightedName name={candidate.name} query={completion.query} matchStyle={presentation.matchStyle} />
        {candidate.description === undefined ? null : <Text dimColor>{`  ${candidate.description}`}</Text>}
      </Text>;
    })}
  </Box>;
}

export function MentionMenu({
  completion,
  onSelect,
}: {
  completion: MentionCompletion;
  onSelect?: (path: string) => void;
}): React.JSX.Element {
  const visible = completion.items.slice(completion.windowStart, completion.windowStart + 6);
  return <Box flexDirection="column" width="100%">
    {visible.map((path, visibleIndex) => {
      const index = completion.windowStart + visibleIndex;
      const presentation = mentionCandidatePresentation(index === completion.selectedIndex);
      return <Box
        key={path}
        width="100%"
        onClick={(event: ClickEvent) => {
          if (!event.cellIsBlank) onSelect?.(path);
        }}
      >
        <Text {...presentation.textStyle} wrap="truncate-end">
          {presentation.marker}
          {presentation.highlightMatches
            ? <HighlightedName name={path} query={completion.query} matchStyle={presentation.matchStyle} />
            : path}
        </Text>
      </Box>;
    })}
  </Box>;
}

function HighlightedName({
  name, query, matchStyle,
}: {
  name: string;
  query: string;
  matchStyle: { color: "ansi:cyan"; bold: true };
}): React.JSX.Element {
  const ranges = matchRanges(name, query);
  if (ranges.length === 0) return <Text>{name}</Text>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push(name.slice(cursor, start));
    parts.push(<Text key={`${start}:${end}`} {...matchStyle}>{name.slice(start, end)}</Text>);
    cursor = end;
  }
  if (cursor < name.length) parts.push(name.slice(cursor));
  return <Text>{parts}</Text>;
}

function jumpScroll(scroll: ScrollBoxHandle, delta: number): void {
  const maximum = Math.max(0, scroll.getScrollHeight() - scroll.getViewportHeight());
  const target = scroll.getScrollTop() + scroll.getPendingDelta() + delta;
  if (target >= maximum) {
    scroll.scrollTo(maximum);
    scroll.scrollToBottom();
  } else {
    scroll.scrollTo(Math.max(0, target));
  }
}

export function selectWheelScrollTarget(
  transcript: ScrollBoxHandle | null,
  tasks: ScrollBoxHandle | null,
  taskPanelHovered: boolean,
): ScrollBoxHandle | null {
  return taskPanelHovered && tasks !== null ? tasks : transcript;
}

export function taskPanelViewportRows(rows: number, reservedBottomRows: number, hasTasks: boolean): number {
  if (!hasTasks) return 0;
  const terminalRows = Math.max(0, Math.floor(rows));
  const reserved = Math.max(0, Math.floor(reservedBottomRows));
  const available = Math.max(0, terminalRows - reserved - 1);
  return Math.min(8, Math.max(1, Math.floor(terminalRows / 3)), available);
}

function scrollDown(scroll: ScrollBoxHandle, amount: number): void {
  const maximum = Math.max(0, scroll.getScrollHeight() - scroll.getViewportHeight());
  if (scroll.getScrollTop() + scroll.getPendingDelta() + amount >= maximum) scroll.scrollToBottom();
  else scroll.scrollBy(amount);
}

function scrollUp(scroll: ScrollBoxHandle, amount: number): void {
  if (scroll.getScrollTop() + scroll.getPendingDelta() - amount <= 0) scroll.scrollTo(0);
  else scroll.scrollBy(-amount);
}

function TurnSeparator({ width }: { width: number }): React.JSX.Element {
  return <Text dimColor>{"─".repeat(Math.max(1, width - 1))}</Text>;
}

function TurnView({ turn, interactive }: { turn: TranscriptTurn; interactive: boolean }): React.JSX.Element {
  if (turn.kind === "compaction") {
    return <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor="ansi:yellowBright" paddingX={1}>
      <Text color="ansi:yellowBright" bold>{turn.prompt}</Text>
      {turn.blocks.map((block, index) => block.kind === "status"
        ? <StatusBlockView key={block.id} block={block} interactive={interactive} />
        : <Box key={`${turn.id}-text-${index}`}><AssistantText text={block.text} /></Box>)}
    </Box>;
  }
  return <Box flexDirection="column" marginBottom={1}>
    {/* User prompt: left-aligned with white chevron, light gray background */}
    <Box flexDirection="row" backgroundColor="#3a3a3a" paddingX={1} paddingY={0}>
      <Text color="ansi:whiteBright" bold backgroundColor="#3a3a3a">❯</Text>
      <Text color="ansi:whiteBright" bold backgroundColor="#3a3a3a"> {turn.prompt}</Text>
    </Box>
    {/* Model output: indented to create clear visual hierarchy */}
    <Box flexDirection="column" paddingLeft={2} marginTop={1}>
      {turn.blocks.map((block, index) => block.kind === "status"
        ? <StatusBlockView key={block.id} block={block} interactive={interactive} />
        : <Box key={`${turn.id}-text-${index}`} marginBottom={1}><AssistantText text={block.text} /></Box>)}
    </Box>
  </Box>;
}

const DIFF_CONTENT = fileDiffLineStyle("context").contentColor;
const DIFF_REMOVED_MARKER = fileDiffLineStyle("removed").markerColor;
const DIFF_ADDED_MARKER = fileDiffLineStyle("added").markerColor;

function FileDiffView({ presentation }: { presentation: FileChangePresentation }): React.JSX.Element {
  const operation = presentation.operation === "create" ? "Create"
    : presentation.operation === "delete" ? "Delete"
    : "Update";
  if (presentation.operation === "delete") {
    return <Box flexDirection="row">
      <Text color={DIFF_REMOVED_MARKER}>●</Text>
      <Text color={DIFF_CONTENT}> <Text bold>{operation}</Text>({basename(presentation.path)})</Text>
    </Box>;
  }
  const lineWidth = Math.max(1, ...presentation.lines.map((line) => Math.max(line.oldLine ?? 0, line.newLine ?? 0)))
    .toString().length;
  return <Box flexDirection="column" width="100%">
    <Box flexDirection="row">
      <Text color={DIFF_ADDED_MARKER}>●</Text>
      <Text color={DIFF_CONTENT}> <Text bold>{operation}</Text>({basename(presentation.path)})</Text>
    </Box>
    <Text color={DIFF_CONTENT}>  └ Added {lineCount(presentation.added)}, removed {lineCount(presentation.removed)}</Text>
    {presentation.lines.map((line, index) => (
      <FileDiffRow key={`${line.kind}:${line.oldLine ?? ""}:${line.newLine ?? ""}:${index}`} line={line} lineWidth={lineWidth} />
    ))}
  </Box>;
}

function FileDiffRow({ line, lineWidth }: { line: FileDiffLine; lineWidth: number }): React.JSX.Element {
  if (line.kind === "omitted") {
    return <Text color={DIFF_CONTENT} dimColor>{" ".repeat(lineWidth + 4)}{line.text}</Text>;
  }
  const number = line.newLine ?? line.oldLine;
  const marker = line.kind === "removed" ? "-" : line.kind === "added" ? "+" : " ";
  const { backgroundColor, markerColor, contentColor } = fileDiffLineStyle(line.kind);
  const prefix = `${String(number ?? "").padStart(lineWidth)} ${marker}| `;
  return <Box
    flexDirection="row"
    width="100%"
    {...(backgroundColor === undefined ? {} : { backgroundColor })}
  >
    <Text
      color={markerColor}
      {...(line.kind === "context" ? { dimColor: true } : {})}
      {...(backgroundColor === undefined ? {} : { backgroundColor })}
    >{prefix}</Text>
    <Text
      color={contentColor}
      {...(backgroundColor === undefined ? {} : { backgroundColor })}
    >{line.text}</Text>
  </Box>;
}

function lineCount(count: number): string {
  return `${count} ${count === 1 ? "line" : "lines"}`;
}

function StatusLine({ block, interactive }: { block: Extract<TranscriptBlock, { kind: "status" }>; interactive: boolean }): React.JSX.Element {
  if (block.progress !== undefined) return <CompactProgressLine progress={block.progress} />;
  const running = block.state === "running";
  const [ref, time] = useAnimationFrame(running && interactive ? 120 : null);
  const color = statusLineColor(block);
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const spinner = running && interactive ? frames[Math.floor(Math.max(0, time) / 120) % frames.length] + " " : "";
  return <Box ref={ref} flexDirection="row">
    <Text {...(color === undefined ? { dimColor: true } : { color })}>{spinner}{block.text}</Text>
    {block.hint === undefined ? null
      : <Text dimColor wrap="truncate-end"> ({block.hint})</Text>}
  </Box>;
}

export function statusLineColor(
  block: Extract<TranscriptBlock, { kind: "status" }>,
): "ansi:yellowBright" | "ansi:green" | "#d77757" | "#e06c50" | undefined {
  if (block.tone === "retry" || block.tone === "warning") return "ansi:yellowBright";
  if (block.state === "running") return "#d77757";
  if (block.state === "completed") return "ansi:green";
  if (block.state === "failed" || block.state === "cancelled") return "#e06c50";
  return undefined;
}

function CompactProgressLine({ progress }: { progress: number }): React.JSX.Element {
  const presentation = compactProgressPresentation(progress);
  return <Box flexDirection="row">
    <Text>Compacting context </Text>
    {presentation.cells.map((cell, index) => (
      <Text key={index} color={cell.color}>
        ■{index === presentation.cells.length - 1 ? "" : " "}
      </Text>
    ))}
    <Text dimColor> {presentation.progress}%</Text>
  </Box>;
}

export function PromptLine({
  input,
  pastedBlocks,
  cursor,
  columns,
  maxVisibleLines,
  completedSlashTokenLength: tokenLength = 0,
  onCursorChange,
}: {
  input: string;
  pastedBlocks: readonly PastedBlock[];
  cursor: number;
  columns: number;
  maxVisibleLines?: number;
  completedSlashTokenLength?: number;
  onCursorChange?: (cursor: number) => void;
}): React.JSX.Element {
  // The prompt container consumes one column of padding on each side. Feed
  // only its inner width to the wrapper so Yoga does not wrap the Text a
  // second time and leave a phantom row between prompt lines.
  const innerColumns = Math.max(1, columns - PROMPT_HORIZONTAL_PADDING * 2);
  const presentation = pastedDraftPresentation(input, cursor, pastedBlocks);
  const wrap = wrapPromptInput(presentation.text, presentation.cursor, { columns: innerColumns, indent: 2 });
  const visibleCount = Math.max(1, maxVisibleLines ?? wrap.lines.length);
  const windowStart = Math.min(
    Math.max(0, wrap.cursor.line - visibleCount + 1),
    Math.max(0, wrap.lines.length - visibleCount),
  );
  const visibleLines = wrap.lines.slice(windowStart, windowStart + visibleCount);
  const lineStarts: number[] = [];
  let nextLineStart = 0;
  for (const line of wrap.lines) {
    lineStarts.push(nextLineStart);
    nextLineStart += [...line].length;
  }
  return <Box width="100%" flexDirection="column" paddingX={PROMPT_HORIZONTAL_PADDING}>
    {visibleLines.map((line, visibleIndex) => {
      const lineIndex = windowStart + visibleIndex;
      const isCursorLine = lineIndex === wrap.cursor.line;
      const points = [...line];
      const cursorCol = wrap.cursor.column;
      const styledCount = Math.max(0, Math.min(points.length, tokenLength - (lineStarts[lineIndex] ?? 0)));
      return <Box
        key={lineIndex}
        {...(onCursorChange === undefined ? {} : {
          onClick: (event: ClickEvent) => {
            onCursorChange(promptCursorFromClick(input, pastedBlocks, {
              columns: innerColumns,
              lineIndex,
              localColumn: event.localCol,
            }));
            event.stopImmediatePropagation();
          },
        })}
      >
        <Text color="yellow" bold>{lineIndex === 0 ? "❯ " : "  "}</Text>
        <PromptLineContent points={points} cursor={cursorCol} cursorVisible={isCursorLine} styledCount={styledCount} />
      </Box>;
    })}
  </Box>;
}

interface PastedDraftMatch {
  sourceStartPoint: number;
  sourceEndPoint: number;
  displayStartPoint: number;
  displayEndPoint: number;
  label: string;
}

function StatusBlockView({
  block,
  interactive,
}: {
  block: Extract<TranscriptBlock, { kind: "status" }>;
  interactive: boolean;
}): React.JSX.Element {
  const visibleBlock = cliToolTitle(block);
  const outcome = cliToolOutcome(block);
  const primary = visibleBlock.activity === "model" || visibleBlock.task !== undefined
    ? <TaskStatusLine block={visibleBlock} interactive={interactive} />
    : visibleBlock.state === "completed" && visibleBlock.presentation !== undefined
      ? <FileDiffView presentation={visibleBlock.presentation} />
      : <StatusLine block={visibleBlock} interactive={interactive} />;
  return <Box flexDirection="column">
    {primary}
    {outcome === undefined ? null : <Box paddingLeft={2}><Text dimColor>└ {outcome}</Text></Box>}
    {block.details === undefined ? null : <Box paddingLeft={2}><AssistantText text={block.details} /></Box>}
  </Box>;
}

function cliToolTitle(
  block: Extract<TranscriptBlock, { kind: "status" }>,
): Extract<TranscriptBlock, { kind: "status" }> {
  if (block.tool === undefined || block.presentation !== undefined) return block;
  const input = record(block.tool.input);
  const path = typeof input?.path === "string" ? basename(input.path) : undefined;
  if (path === undefined || block.text.includes(path)) return block;
  return { ...block, text: `${block.text} ${path}` };
}

function cliToolOutcome(block: Extract<TranscriptBlock, { kind: "status" }>): string | undefined {
  const result = block.tool?.result;
  if (result === undefined || block.presentation !== undefined) return undefined;
  if (!result.ok) return truncateInline(result.error?.message ?? "Tool call failed");
  const output = record(result.output);
  if (output === undefined) return undefined;
  if (typeof output.exitCode === "number" || output.exitCode === null) {
    const exit = output.exitCode === null ? "no exit code" : `exit ${output.exitCode}`;
    return output.truncated === true ? `${exit} · output truncated` : exit;
  }
  if (typeof output.replacements === "number") return `${output.replacements} replacement${output.replacements === 1 ? "" : "s"}`;
  if (typeof output.bytes === "number") return `${formatBytes(output.bytes)} written`;
  if (Array.isArray(output.matches)) return `${output.matches.length} match${output.matches.length === 1 ? "" : "es"}${output.truncated === true ? " · truncated" : ""}`;
  if (Array.isArray(output.paths)) return `${output.paths.length} file${output.paths.length === 1 ? "" : "s"}${output.truncated === true ? " · truncated" : ""}`;
  if (Array.isArray(output.files)) return `${output.files.length} file${output.files.length === 1 ? "" : "s"} changed`;
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function truncateInline(value: string, maxChars = 180): string {
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

interface PastedDraftModel extends PromptEditState {
  matches: PastedDraftMatch[];
}

function pastedDraftModel(
  input: string,
  cursor: number,
  blocks: readonly PastedBlock[],
): PastedDraftModel {
  const sourceMatches: Array<{
    start: number;
    end: number;
    startPoint: number;
    endPoint: number;
    label: string;
  }> = [];

  for (const block of blocks) {
    const extraLines = block.text.split(/\r\n|\r|\n/u).length - 1;
    if (extraLines === 0 || block.text.length === 0) continue;

    let start = input.indexOf(block.text);
    while (start >= 0) {
      const end = start + block.text.length;
      const overlaps = sourceMatches.some((match) => start < match.end && end > match.start);
      if (!overlaps) {
        sourceMatches.push({
          start,
          end,
          startPoint: [...input.slice(0, start)].length,
          endPoint: [...input.slice(0, end)].length,
          label: `[Pasted text #${block.id} +${extraLines} lines]`,
        });
        break;
      }
      start = input.indexOf(block.text, start + 1);
    }
  }

  if (sourceMatches.length === 0) return { text: input, cursor, matches: [] };
  sourceMatches.sort((left, right) => left.start - right.start);

  let text = "";
  let sourceOffset = 0;
  const matches: PastedDraftMatch[] = [];
  for (const match of sourceMatches) {
    text += input.slice(sourceOffset, match.start);
    const displayStartPoint = [...text].length;
    text += match.label;
    const displayEndPoint = [...text].length;
    matches.push({
      sourceStartPoint: match.startPoint,
      sourceEndPoint: match.endPoint,
      displayStartPoint,
      displayEndPoint,
      label: match.label,
    });
    sourceOffset = match.end;
  }
  text += input.slice(sourceOffset);

  let pointDelta = 0;
  let mappedCursor = cursor;
  for (const match of matches) {
    const labelLength = match.displayEndPoint - match.displayStartPoint;
    if (cursor <= match.sourceStartPoint) break;
    if (cursor < match.sourceEndPoint) {
      mappedCursor = match.displayEndPoint;
      break;
    }
    pointDelta += labelLength - (match.sourceEndPoint - match.sourceStartPoint);
    mappedCursor = cursor + pointDelta;
  }

  return { text, cursor: mappedCursor, matches };
}

export function pastedDraftPresentation(
  input: string,
  cursor: number,
  blocks: readonly PastedBlock[],
): PromptEditState {
  const model = pastedDraftModel(input, cursor, blocks);
  return { text: model.text, cursor: model.cursor };
}

export interface PromptClickPosition {
  columns: number;
  lineIndex: number;
  localColumn: number;
}

function codePointIndexAtVisualColumn(line: string, targetColumn: number): number {
  const points = [...line];
  const target = Math.max(0, targetColumn);
  let visualColumn = 0;

  for (let index = 0; index < points.length; index += 1) {
    const width = charWidth(points[index]!.codePointAt(0) ?? 0);
    if (target <= visualColumn) return index;
    if (target < visualColumn + width) {
      return target - visualColumn < width / 2 ? index : index + 1;
    }
    visualColumn += width;
  }

  return points.length;
}

function sourceCursorFromDisplayed(model: PastedDraftModel, displayedCursor: number): number {
  let sourceOffset = 0;
  let displayOffset = 0;

  for (const match of model.matches) {
    if (displayedCursor < match.displayStartPoint) {
      return sourceOffset + displayedCursor - displayOffset;
    }
    if (displayedCursor <= match.displayEndPoint) return match.sourceEndPoint;
    sourceOffset = match.sourceEndPoint;
    displayOffset = match.displayEndPoint;
  }

  return sourceOffset + displayedCursor - displayOffset;
}

export function promptCursorFromClick(
  input: string,
  blocks: readonly PastedBlock[],
  position: PromptClickPosition,
): number {
  const model = pastedDraftModel(input, 0, blocks);
  const wrap = wrapPromptInput(model.text, 0, { columns: position.columns, indent: 2 });
  const lineIndex = Math.max(0, Math.min(wrap.lines.length - 1, position.lineIndex));
  const beforeLine = wrap.lines
    .slice(0, lineIndex)
    .reduce((total, line) => total + [...line].length, 0);
  const withinLine = codePointIndexAtVisualColumn(
    wrap.lines[lineIndex] ?? "",
    position.localColumn - 2,
  );
  const sourceCursor = sourceCursorFromDisplayed(model, beforeLine + withinLine);
  return Math.max(0, Math.min([...input].length, sourceCursor));
}

function PromptLineContent({
  points, cursor, cursorVisible, styledCount,
}: {
  points: string[];
  cursor: number;
  cursorVisible: boolean;
  styledCount: number;
}): React.JSX.Element {
  const tokenStyle = completedSlashTokenPresentation();
  return <Text>
    {points.map((point, index) => {
      const styled = index < styledCount;
      const caret = cursorVisible && index === cursor;
      return <Text
        key={index}
        {...(styled ? tokenStyle : {})}
        {...(caret ? { inverse: true } : {})}
      >{point}</Text>;
    })}
    {cursorVisible && cursor >= points.length ? <Text inverse>{" "}</Text> : null}
  </Text>;
}

export interface PromptEditState { text: string; cursor: number }
export interface PastedPromptEditState extends PromptEditState { pastedBlocks: PastedBlock[] }
export type PromptEdit = { type: "insert"; value: string } | { type: "backspace" | "delete" | "left" | "right" };
export function editPrompt(state: PromptEditState, edit: PromptEdit): PromptEditState {
  const points = [...state.text];
  const cursor = Math.max(0, Math.min(points.length, state.cursor));
  if (edit.type === "insert") {
    const inserted = [...edit.value]; points.splice(cursor, 0, ...inserted);
    return { text: points.join(""), cursor: cursor + inserted.length };
  }
  if (edit.type === "left") return { text: state.text, cursor: Math.max(0, cursor - 1) };
  if (edit.type === "right") return { text: state.text, cursor: Math.min(points.length, cursor + 1) };
  if (edit.type === "backspace") {
    if (cursor === 0) return { text: state.text, cursor };
    points.splice(cursor - 1, 1); return { text: points.join(""), cursor: cursor - 1 };
  }
  if (edit.type === "delete") { points.splice(cursor, 1); return { text: points.join(""), cursor }; }
  return { text: state.text, cursor };
}

export function editPromptWithPastedBlocks(
  state: PromptEditState,
  edit: PromptEdit,
  pastedBlocks: readonly PastedBlock[],
): PastedPromptEditState {
  const points = [...state.text];
  const cursor = Math.max(0, Math.min(points.length, state.cursor));
  const latest = pastedBlocks.at(-1);

  if (edit.type === "backspace" && latest !== undefined) {
    const pastedPoints = [...latest.text];
    const start = cursor - pastedPoints.length;
    if (start >= 0 && points.slice(start, cursor).join("") === latest.text) {
      points.splice(start, pastedPoints.length);
      return {
        text: points.join(""),
        cursor: start,
        pastedBlocks: pastedBlocks.slice(0, -1),
      };
    }
  }

  return { ...editPrompt({ text: state.text, cursor }, edit), pastedBlocks: [...pastedBlocks] };
}

export interface HistoryNavigationState { history: readonly string[]; cursor: number }
export interface HistoryNavigationResult { cursor: number; input: string; promptCursor: number }
export function navigateHistory(state: HistoryNavigationState, direction: "up" | "down"): HistoryNavigationResult {
  const cursor = direction === "up"
    ? Math.max(0, state.cursor - 1)
    : Math.min(state.history.length, state.cursor + 1);
  const input = state.history[cursor] ?? "";
  return { cursor, input, promptCursor: [...input].length };
}

function updatePrompt(
  edit: PromptEdit, text: string, cursor: number,
  setText: React.Dispatch<React.SetStateAction<string>>, setCursor: React.Dispatch<React.SetStateAction<number>>,
): void {
  const next = editPrompt({ text, cursor }, edit); setText(next.text); setCursor(next.cursor);
}



export async function submitSafely(
  session: Pick<ProductionRuntime["session"], "submit">, prompt: string, report: (message: string) => void,
): Promise<void> {
  try { await session.submit(prompt); }
  catch (error) { safeReport(report, safeUiError(error)); }
}

export async function shutdownRuntime(
  runtime: ProductionRuntime | undefined, exit: () => void, report: (message: string) => void,
): Promise<void> {
  try { await closeAndDisposeRuntime(runtime, report); }
  finally { exit(); }
}

export async function closeAndDisposeRuntime(
  runtime: ProductionRuntime | undefined, report: (message: string) => void,
): Promise<void> {
  if (runtime === undefined) return;
  try { await runtime.session.close(); }
  catch (error) { safeReport(report, safeUiError(error)); }
  finally {
    try { await runtime.dispose(); }
    catch (error) { safeReport(report, safeUiError(error)); }
  }
}

function safeUiError(error: unknown): string {
  return redactErrorText(message(error)).slice(0, 2_000);
}
function safeReport(report: (message: string) => void, value: string): void {
  try { report(value); } catch { /* Cleanup and exit must not depend on diagnostics. */ }
}
