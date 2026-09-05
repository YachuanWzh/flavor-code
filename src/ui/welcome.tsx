import React from "react";

import { Box, Text } from "../claude-ink/index.js";
import { packageVersion } from "../utils/version.js";

export interface WelcomeCardProps {
  model: string;
  serviceName?: string;
  workspaceName: string;
  updateTo?: string;
  columns: number;
}

const WIDE_WELCOME_COLUMNS = 72;
const FLAVOR_ACCENT = "#67D4FF";
const FLAVOR_WORDMARK = [
  "┌─┐┬  ┌─┐┬  ┬┌─┐┬─┐",
  "├┤ │  ├─┤└┐┌┘│ │├┬┘",
  "└  ┴─┘┴ ┴ └┘ └─┘┴└─",
].join("\n");

export function WelcomeCard({
  model, serviceName, workspaceName, updateTo, columns,
}: WelcomeCardProps): React.JSX.Element {
  const wide = Math.max(1, Math.floor(columns)) >= WIDE_WELCOME_COLUMNS;
  const updateHint = updateTo === undefined ? null : (
    <Text color="yellowBright" wrap="wrap">
      {"▲ "}Update available: v{packageVersion()} {"\u2192"} v{updateTo}
      {"\nRun: flavor update"}
    </Text>
  );

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
        {serviceName === undefined ? null : <Text color="cyan" wrap="truncate-end">{serviceName}</Text>}
        <Text dimColor wrap="truncate-end">{model}</Text>
        <Text dimColor wrap="truncate-end">{workspaceName}</Text>
        <Text dimColor wrap="truncate-end">{"v"}{packageVersion()}</Text>
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
        {updateHint}
      </Box>
    </Box> : <Box width="100%" flexDirection="column">
      <Text bold color={FLAVOR_ACCENT}>◆ Flavor Code</Text>
      <Text>Welcome back!</Text>
      <Text dimColor wrap="truncate-end">{model}{" · "}{workspaceName}{" · v"}{packageVersion()}</Text>
      <Text><Text color="cyan">/init</Text>{" setup · "}<Text color="cyan">/help</Text>{" commands"}</Text>
      {updateHint}
    </Box>}
  </Box>;
}
