import React, { useRef, type Ref } from "react";

import { Box, ScrollBox, Text, useStdout, type ScrollBoxHandle } from "../claude-ink/index.js";
import { useAnimationFrame } from "../claude-ink/hooks/use-animation-frame.js";
import type { TranscriptBlock } from "./transcript.js";
import { statusPresentation } from "./task-progress-model.js";
import { thinkingWindow } from "./thinking-line.js";

export interface TaskStatusLineProps {
  block: Extract<TranscriptBlock, { kind: "status" }>;
  interactive: boolean;
}

export function TaskStatusLine({ block, interactive }: TaskStatusLineProps): React.JSX.Element {
  const running = block.state === "running";
  const { stdout } = useStdout();
  const foreground = interactive && (block.activity === "model" || block.task?.role === "main");
  const [ref, time] = useAnimationFrame(running && foreground ? 120 : null);
  const startedAt = useRef<number | undefined>(undefined);
  const previousState = useRef(block.state);
  if (running && (startedAt.current === undefined || previousState.current !== "running")) startedAt.current = time;
  if (!running) startedAt.current = undefined;
  previousState.current = block.state;
  const elapsed = block.startedAt === undefined
    ? startedAt.current === undefined ? 0 : Math.max(0, time - startedAt.current)
    : Math.max(0, Date.now() - block.startedAt);
  const presentation = statusPresentation(block, elapsed, foreground);

  // Split the text so the status word can be colorized independently.
  const { metaColor, metaLabel, statusLabel, statusColor, text } = presentation;
  let before = text;
  let after = "";
  if (statusLabel !== undefined) {
    const marker = ` · ${statusLabel}`;
    const idx = before.indexOf(marker);
    if (idx >= 0) {
      after = before.slice(idx + marker.length);
      before = before.slice(0, idx);
    }
  }

  // Streaming thinking gets its own fixed-width typewriter line. The shared
  // animation clock drives a rate-limited leftward chase of the newest tail.
  const thinking = block.thinkingText;
  const thinkingVisible = running && block.activity === "model"
    && thinking !== undefined && thinking.length > 0;
  const thinkingScroll = useRef<{ start: number; lastTime: number }>({ start: 0, lastTime: time });
  if (!thinkingVisible) {
    thinkingScroll.current = { start: 0, lastTime: time };
  }
  const thinkingLine = thinkingVisible ? (() => {
    const previous = thinkingScroll.current;
    const state = thinkingWindow(thinking!, previous.start, {
      width: Math.max(8, (stdout.columns ?? 80) - 8),
      dtMs: time - previous.lastTime,
    });
    thinkingScroll.current = { start: state.start, lastTime: time };
    return state.text;
  })() : undefined;

  return <Box flexDirection="column" width="100%">
    <Box ref={ref} flexDirection="row">
      <Text {...(presentation.color === undefined ? {} : { color: presentation.color })}>
        {presentation.glyph}{" "}
      </Text>
      {presentation.badge ? <Text color={presentation.badgeColor}>{presentation.badge} </Text> : null}
      <Text {...(presentation.color === undefined ? {} : { color: presentation.color })}>
        {before}
      </Text>
      {statusLabel !== undefined ? (
        <>
          <Text {...(presentation.color === undefined ? {} : { color: presentation.color })}> · </Text>
          <Text color={statusColor ?? presentation.color}>{statusLabel}</Text>
        </>
      ) : null}
      {after ? <Text {...(presentation.color === undefined ? {} : { color: presentation.color })}>{after}</Text> : null}
      {metaLabel === undefined ? null : <Text color={metaColor ?? "ansi:blackBright"}>  {metaLabel}</Text>}
    </Box>
    {thinkingLine === undefined ? null : <ThinkingLineView text={thinkingLine} />}
  </Box>;
}

const THINKING_RAIL = "#416f84";
const THINKING_TEXT = "#91a0a8";

/**
 * A quiet continuation rail ties the reasoning preview to the active model
 * row. Motion stays in the spinner above; the text remains easy to scan and
 * cannot be mistaken for editable terminal input.
 */
function ThinkingLineView({ text }: { text: string }): React.JSX.Element {
  return <Box flexDirection="row">
    <Text color={THINKING_RAIL}>│ </Text>
    <Text color={THINKING_TEXT} wrap="truncate-end">{text}</Text>
  </Box>;
}

export type TaskBlock = Extract<TranscriptBlock, { kind: "status" }>;

export interface TaskProgressPanelProps {
  blocks: TaskBlock[];
  interactive: boolean;
  maxHeight?: number;
  columns?: number;
  scrollRef?: Ref<ScrollBoxHandle>;
  onHoverChange?: (hovered: boolean) => void;
}

const SPLIT_TRACK_MIN_COLUMNS = 72;

export function TaskProgressPanel({
  blocks,
  interactive,
  maxHeight = 8,
  columns = 80,
  scrollRef,
  onHoverChange,
}: TaskProgressPanelProps): React.JSX.Element | null {
  if (blocks.length === 0 || maxHeight <= 0) return null;
  const taskBlocks = blocks.filter((block) => block.task?.role === "main");
  const subagentBlocks = blocks.filter((block) => block.task?.role === "subagent");
  const hasTasks = taskBlocks.length > 0;
  const hasSubagents = subagentBlocks.length > 0;
  const split = hasTasks && hasSubagents && columns >= SPLIT_TRACK_MIN_COLUMNS;

  return <Box
    flexDirection="column"
    flexShrink={0}
    width="100%"
    maxHeight={maxHeight}
    onMouseEnter={() => onHoverChange?.(true)}
    onMouseLeave={() => onHoverChange?.(false)}
  >
    {split ? <SplitTrackHeaders /> : <TrackHeader role={hasTasks ? "main" : "subagent"} />}
    {maxHeight > 1 ? (
      <ScrollBox
        {...(scrollRef === undefined ? {} : { ref: scrollRef })}
        flexDirection="column"
        flexShrink={1}
        width="100%"
        maxHeight={maxHeight - 1}
      >
        {split
          ? pairedTrackRows(taskBlocks, subagentBlocks).map(([task, subagent], index) => (
            <Box key={`${task?.id ?? "task"}:${subagent?.id ?? "subagent"}:${index}`} flexDirection="row" width="100%" columnGap={2}>
              <Box flexBasis={0} flexGrow={1} minWidth={0} flexDirection="column">
                {task === undefined ? null : <TaskStatusLine block={task} interactive={interactive} />}
              </Box>
              <Box flexBasis={0} flexGrow={1} minWidth={0} flexDirection="column">
                {subagent === undefined ? null : <TaskStatusLine block={subagent} interactive={interactive} />}
              </Box>
            </Box>
          ))
          : hasTasks && hasSubagents ? <>
            {taskBlocks.map((block) => (
              <TaskStatusLine key={block.id} block={block} interactive={interactive} />
            ))}
            <TrackHeader role="subagent" />
            {subagentBlocks.map((block) => (
              <TaskStatusLine key={block.id} block={block} interactive={interactive} />
            ))}
          </> : (hasTasks ? taskBlocks : subagentBlocks).map((block) => (
            <TaskStatusLine key={block.id} block={block} interactive={interactive} />
          ))}
      </ScrollBox>
    ) : null}
  </Box>;
}

function TrackHeader({ role }: { role: "main" | "subagent" }): React.JSX.Element {
  return <Text dimColor>── {role === "main" ? "task plan" : "subagent exploration"} ──</Text>;
}

function SplitTrackHeaders(): React.JSX.Element {
  return <Box flexDirection="row" width="100%" columnGap={2}>
    <Box flexBasis={0} flexGrow={1} minWidth={0}><TrackHeader role="main" /></Box>
    <Box flexBasis={0} flexGrow={1} minWidth={0}><TrackHeader role="subagent" /></Box>
  </Box>;
}

function pairedTrackRows(
  tasks: readonly TaskBlock[],
  subagents: readonly TaskBlock[],
): Array<[TaskBlock | undefined, TaskBlock | undefined]> {
  return Array.from({ length: Math.max(tasks.length, subagents.length) }, (_, index) => [tasks[index], subagents[index]]);
}
