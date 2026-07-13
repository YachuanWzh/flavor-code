import React, { useRef } from "react";

import { Box, Text } from "../claude-ink/index.js";
import { useAnimationFrame } from "../claude-ink/hooks/use-animation-frame.js";
import type { TranscriptBlock } from "./transcript.js";
import { statusPresentation } from "./task-progress-model.js";

export interface TaskStatusLineProps {
  block: Extract<TranscriptBlock, { kind: "status" }>;
  interactive: boolean;
}

export function TaskStatusLine({ block, interactive }: TaskStatusLineProps): React.JSX.Element {
  const running = block.state === "running";
  const foreground = interactive && block.task?.role === "main";
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

  return <Box ref={ref} flexDirection="row">
    <Text {...(presentation.color === undefined ? {} : { color: presentation.color })}>
      {presentation.glyph} {presentation.text}
    </Text>
  </Box>;
}

export type TaskBlock = Extract<TranscriptBlock, { kind: "status" }>;

export interface TaskProgressPanelProps {
  blocks: TaskBlock[];
  interactive: boolean;
  maxVisible?: number;
}

export function TaskProgressPanel({ blocks, interactive, maxVisible = 8 }: TaskProgressPanelProps): React.JSX.Element | null {
  if (blocks.length === 0) return null;
  const visible = blocks.slice(0, maxVisible);
  const overflow = blocks.length - visible.length;
  return <Box flexDirection="column" flexShrink={0} marginTop={1}>
    <Text dimColor>── task progress ──</Text>
    {visible.map((block) => (
      <TaskStatusLine key={block.id} block={block} interactive={interactive} />
    ))}
    {overflow > 0 ? <Text dimColor>  ... and {overflow} more</Text> : null}
  </Box>;
}
