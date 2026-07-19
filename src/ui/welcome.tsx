import React from "react";

import { Box, Text } from "../claude-ink/index.js";

export interface WelcomeCardProps {
  model: string;
  workspaceName: string;
  columns: number;
}

const WIDE_WELCOME_COLUMNS = 72;
const FLAVOR_ACCENT = "#67D4FF";
const FLAVOR_WORDMARK = [
  "┌─┐┬  ┌─┐┬  ┬┌─┐┬─┐",
  "├┤ │  ├─┤└┐┌┘│ │├┬┘",
  "└  ┴─┘┴ ┴ └┘ └─┘┴└─",
].join("\n");

export function WelcomeCard({ model, workspaceName, columns }: WelcomeCardProps): React.JSX.Element {
  const wide = Math.max(1, Math.floor(columns)) >= WIDE_WELCOME_COLUMNS;

  return <Box width="100%" borderStyle="round" borderColor="yellow" paddingX={1}>
    {wide ? <Box width="100%" flexDirection="row">
      <Box
        width="36%"
        flexDirection="column"
        alignItems="center"
        borderStyle="single"
        borderTop={false}
        borderBottom={false}
        borderLeft={false}
        borderColor="yellow"
        paddingRight={1}
      >
        <Text bold color="yellowBright">Welcome back!</Text>
        <Text color={FLAVOR_ACCENT}>{FLAVOR_WORDMARK}</Text>
        <Text dimColor wrap="truncate-end">{model}</Text>
        <Text dimColor wrap="truncate-end">{workspaceName}</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column" paddingLeft={1}>
        <Text bold color="yellowBright">Tips for getting started</Text>
        <Text>Run <Text color="cyan">/init</Text> to create or refresh FLAVOR.md</Text>
        <Text>Type <Text color="cyan">@</Text> to attach a project file</Text>
        <Box height={1} />
        <Text bold color="yellowBright">Quick commands</Text>
        <Text>
          <Text color="cyan">/help</Text>{" · "}
          <Text color="cyan">/config</Text>{" · "}
          <Text color="cyan">/tasks</Text>
        </Text>
      </Box>
    </Box> : <Box width="100%" flexDirection="column">
      <Text bold color={FLAVOR_ACCENT}>◆ Flavor Code</Text>
      <Text>Welcome back!</Text>
      <Text dimColor wrap="truncate-end">{model}{" · "}{workspaceName}</Text>
      <Text><Text color="cyan">/init</Text>{" setup · "}<Text color="cyan">/help</Text>{" commands"}</Text>
    </Box>}
  </Box>;
}
