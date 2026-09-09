import React, { useRef, type Ref } from "react";

import { Box, ScrollBox, Text, useStdout, type ScrollBoxHandle } from "../claude-ink/index.js";
import { useAnimationFrame } from "../claude-ink/hooks/use-animation-frame.js";
import { stringWidth } from "../claude-ink/stringWidth.js";
import type { Color } from "../claude-ink/styles.js";
import { getGraphemeSegmenter } from "../utils/intl.js";
import type { TranscriptBlock } from "./transcript.js";
import { statusPresentation } from "./task-progress-model.js";
import { thinkingWindow } from "./thinking-line.js";

export interface TaskStatusLineProps {
  block: Extract<TranscriptBlock, { kind: "status" }>;
  interactive: boolean;
  textWidth?: number;
  maxTextLines?: number;
}

export function TaskStatusLine({
  block, interactive, textWidth, maxTextLines,
}: TaskStatusLineProps): React.JSX.Element {
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

  const textSegments: TaskTextSegment[] = [
    { text: `${presentation.glyph} `, color: presentation.color },
    ...(presentation.badge ? [{ text: `${presentation.badge} `, color: presentation.badgeColor }] : []),
    { text: before, color: presentation.color },
    ...(statusLabel === undefined ? [] : [
      { text: " · ", color: presentation.color },
      { text: statusLabel, color: statusColor ?? presentation.color },
    ]),
    ...(after ? [{ text: after, color: presentation.color }] : []),
    ...(metaLabel === undefined ? [] : [{ text: `  ${metaLabel}`, color: metaColor ?? "ansi:blackBright" as Color }]),
  ];
  const boundedText = textWidth === undefined || maxTextLines === undefined
    ? undefined
    : limitTaskTextSegments(textSegments, textWidth, maxTextLines).segments;

  return <Box flexDirection="column" width="100%">
    <Box ref={ref} flexDirection="row" width="100%">
      {boundedText === undefined ? <>
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
      </> : <Text>{boundedText.map((segment, index) => (
        <Text key={index} {...(segment.color === undefined ? {} : { color: segment.color })}>{segment.text}</Text>
      ))}</Text>}
    </Box>
    {thinkingLine === undefined ? null : <ThinkingLineView text={thinkingLine} />}
  </Box>;
}

export interface TaskTextSegment {
  text: string;
  color?: Color | undefined;
}

export interface LimitedTaskText {
  segments: TaskTextSegment[];
  truncated: boolean;
}

/** Hard-wrap styled task text to a bounded number of terminal rows. */
export function limitTaskTextSegments(
  segments: readonly TaskTextSegment[],
  width: number,
  maxLines = 3,
): LimitedTaskText {
  const lineWidth = Math.max(3, Math.floor(width));
  const lineLimit = Math.max(1, Math.floor(maxLines));
  type Token = { value: string; width: number; segmentIndex: number };
  const lines: Token[][] = [[]];
  const widths = [0];
  let truncated = false;

  outer: for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex]!;
    for (const { segment: grapheme } of getGraphemeSegmenter().segment(segment.text)) {
      if (grapheme === "\n" || grapheme === "\r" || grapheme === "\r\n") {
        if (lines.length >= lineLimit) { truncated = true; break outer; }
        lines.push([]);
        widths.push(0);
        continue;
      }
      const glyphWidth = stringWidth(grapheme);
      const lineIndex = lines.length - 1;
      if (glyphWidth > 0 && widths[lineIndex]! + glyphWidth > lineWidth && lines[lineIndex]!.length > 0) {
        if (lines.length >= lineLimit) { truncated = true; break outer; }
        lines.push([]);
        widths.push(0);
      }
      const target = lines.length - 1;
      lines[target]!.push({ value: grapheme, width: glyphWidth, segmentIndex });
      widths[target] = widths[target]! + glyphWidth;
    }
  }

  if (truncated) {
    const lastIndex = lines.length - 1;
    const last = lines[lastIndex]!;
    while (last.length > 0 && widths[lastIndex]! > lineWidth - 3) {
      widths[lastIndex] = widths[lastIndex]! - last.pop()!.width;
    }
    while (last.length > 0 && /^\s$/u.test(last.at(-1)!.value)) {
      widths[lastIndex] = widths[lastIndex]! - last.pop()!.width;
    }
    last.push({ value: "...", width: 3, segmentIndex: last.at(-1)?.segmentIndex ?? 0 });
  }

  const output: Array<TaskTextSegment & { segmentIndex: number }> = [];
  const append = (value: string, segmentIndex: number): void => {
    const previous = output.at(-1);
    if (previous?.segmentIndex === segmentIndex) previous.text += value;
    else output.push({ text: value, color: segments[segmentIndex]?.color, segmentIndex });
  };
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) append("\n", line[0]?.segmentIndex ?? output.at(-1)?.segmentIndex ?? 0);
    for (const token of line) append(token.value, token.segmentIndex);
  });

  return {
    truncated,
    segments: output.map(({ text, color }) => ({ text, ...(color === undefined ? {} : { color }) })),
  };
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
  mainScrollRef?: Ref<ScrollBoxHandle> | undefined;
  subagentScrollRef?: Ref<ScrollBoxHandle> | undefined;
  onHoverChange?: (track: TaskPanelTrack | null) => void;
}

export type TaskPanelTrack = "main" | "subagent";

const SPLIT_TRACK_MIN_COLUMNS = 72;

export function TaskProgressPanel({
  blocks,
  interactive,
  maxHeight = 8,
  columns = 80,
  mainScrollRef,
  subagentScrollRef,
  onHoverChange,
}: TaskProgressPanelProps): React.JSX.Element | null {
  if (blocks.length === 0 || maxHeight <= 0) return null;
  const taskBlocks = blocks.filter((block) => block.task?.role === "main");
  const subagentBlocks = blocks.filter((block) => block.task?.role === "subagent");
  const hasTasks = taskBlocks.length > 0;
  const hasSubagents = subagentBlocks.length > 0;
  const split = hasTasks && hasSubagents && columns >= SPLIT_TRACK_MIN_COLUMNS;

  const hoverProps = (track: TaskPanelTrack) => ({
    onMouseEnter: () => onHoverChange?.(track),
  });

  return <Box
    flexDirection="column"
    flexShrink={0}
    width="100%"
    maxHeight={maxHeight}
    onMouseLeave={() => onHoverChange?.(null)}
  >
    {split ? <SplitTracks
      taskBlocks={taskBlocks}
      subagentBlocks={subagentBlocks}
      interactive={interactive}
      height={maxHeight}
      columns={columns}
      mainScrollRef={mainScrollRef}
      subagentScrollRef={subagentScrollRef}
      hoverProps={hoverProps}
    /> : hasTasks && hasSubagents ? <StackedTracks
      taskBlocks={taskBlocks}
      subagentBlocks={subagentBlocks}
      interactive={interactive}
      height={maxHeight}
      columns={columns}
      mainScrollRef={mainScrollRef}
      subagentScrollRef={subagentScrollRef}
      hoverProps={hoverProps}
    /> : <SingleTrack
      role={hasTasks ? "main" : "subagent"}
      blocks={hasTasks ? taskBlocks : subagentBlocks}
      interactive={interactive}
      height={maxHeight}
      width={columns}
      scrollRef={hasTasks ? mainScrollRef : subagentScrollRef}
      hoverProps={hoverProps}
    />}
  </Box>;
}

interface TrackProps {
  taskBlocks: TaskBlock[];
  subagentBlocks: TaskBlock[];
  interactive: boolean;
  height: number;
  columns: number;
  mainScrollRef?: Ref<ScrollBoxHandle> | undefined;
  subagentScrollRef?: Ref<ScrollBoxHandle> | undefined;
  hoverProps: (track: TaskPanelTrack) => { onMouseEnter: () => void };
}

function SplitTracks({
  taskBlocks, subagentBlocks, interactive, height, columns,
  mainScrollRef, subagentScrollRef, hoverProps,
}: TrackProps): React.JSX.Element {
  const contentHeight = Math.max(0, height - 1);
  const leftWidth = Math.max(1, Math.floor((columns - 1) / 2));
  const rightWidth = Math.max(1, columns - leftWidth - 1);
  return <>
    <Box flexDirection="row" width="100%">
      <Box width={leftWidth} {...hoverProps("main")}><TrackHeader role="main" width={leftWidth} /></Box>
      <Text color="ansi:white">┬</Text>
      <Box width={rightWidth} {...hoverProps("subagent")}><TrackHeader role="subagent" width={rightWidth} /></Box>
    </Box>
    {contentHeight <= 0 ? null : <Box flexDirection="row" width="100%" height={contentHeight}>
      <Box width={leftWidth} minWidth={0} flexDirection="column" {...hoverProps("main")}>
        <TrackScrollBox ref={mainScrollRef} blocks={taskBlocks} interactive={interactive}
          height={contentHeight} width={leftWidth} />
      </Box>
      <TrackDivider height={contentHeight} />
      <Box width={rightWidth} minWidth={0} flexDirection="column" {...hoverProps("subagent")}>
        <TrackScrollBox ref={subagentScrollRef} blocks={subagentBlocks} interactive={interactive}
          height={contentHeight} width={rightWidth} />
      </Box>
    </Box>}
  </>;
}

function StackedTracks({
  taskBlocks, subagentBlocks, interactive, height, columns,
  mainScrollRef, subagentScrollRef, hoverProps,
}: TrackProps): React.JSX.Element {
  if (height <= 1) {
    return <Box {...hoverProps("main")}><TrackHeader role="main" width={columns} /></Box>;
  }
  const mainHeight = Math.ceil(height / 2);
  const subagentHeight = Math.floor(height / 2);
  return <>
    <SingleTrack role="main" blocks={taskBlocks} interactive={interactive} height={mainHeight}
      width={columns} scrollRef={mainScrollRef} hoverProps={hoverProps} />
    <SingleTrack role="subagent" blocks={subagentBlocks} interactive={interactive} height={subagentHeight}
      width={columns} scrollRef={subagentScrollRef} hoverProps={hoverProps} />
  </>;
}

function SingleTrack({
  role, blocks, interactive, height, width, scrollRef, hoverProps,
}: {
  role: TaskPanelTrack;
  blocks: TaskBlock[];
  interactive: boolean;
  height: number;
  width: number;
  scrollRef?: Ref<ScrollBoxHandle> | undefined;
  hoverProps: (track: TaskPanelTrack) => { onMouseEnter: () => void };
}): React.JSX.Element {
  const contentHeight = Math.max(0, height - 1);
  return <Box flexDirection="column" width="100%" height={height} {...hoverProps(role)}>
    <TrackHeader role={role} width={width} />
    {contentHeight <= 0 ? null : <TrackScrollBox ref={scrollRef} blocks={blocks}
      interactive={interactive} height={contentHeight} width={width} />}
  </Box>;
}

function TrackScrollBox({
  ref, blocks, interactive, height, width,
}: {
  ref?: Ref<ScrollBoxHandle> | undefined;
  blocks: TaskBlock[];
  interactive: boolean;
  height: number;
  width: number;
}): React.JSX.Element {
  return <ScrollBox
    {...(ref === undefined ? {} : { ref })}
    flexDirection="column"
    flexShrink={1}
    width="100%"
    height={height}
    maxHeight={height}
  >
    {blocks.map((block) => <TaskStatusLine key={block.id} block={block} interactive={interactive}
      textWidth={width} maxTextLines={3} />)}
  </ScrollBox>;
}

function TrackHeader({ role, width }: { role: TaskPanelTrack; width: number }): React.JSX.Element {
  const label = role === "main" ? "task plan" : "subagent exploration";
  const prefix = `── ${label} `;
  const line = prefix.length >= width ? prefix.slice(0, Math.max(0, width)) : `${prefix}${"─".repeat(width - prefix.length)}`;
  return <Text color="ansi:white" wrap="truncate-end">{line}</Text>;
}

function TrackDivider({ height }: { height: number }): React.JSX.Element {
  return <Box flexDirection="column" width={1} flexShrink={0}>
    {Array.from({ length: height }, (_, index) => <Text key={index} color="ansi:white">│</Text>)}
  </Box>;
}
