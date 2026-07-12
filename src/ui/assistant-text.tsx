import React from "react";

import { MarkdownView } from "./markdown.js";

/**
 * Claude-style terminal output: Markdown is interpreted for presentation,
 * so control markers are not printed while prose, lists and code remain.
 */
export interface AssistantTextProps { text: string }

function AssistantTextInner({ text }: AssistantTextProps): React.JSX.Element {
  return <MarkdownView text={text} />;
}

export const AssistantText = React.memo(AssistantTextInner);
