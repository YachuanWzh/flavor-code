# VS Code Sequence Title and Sky-Blue Welcome Design

## Goal

Make the VS Code terminal tab for Flavor display `flavor` instead of `node`, and recolor the Flavor wordmark with a clear sky-blue accent.

## Root Cause

Flavor already sends an OSC title sequence and assigns `process.title = "flavor"`. VS Code's default terminal tab template uses the foreground executable process, which remains `node.exe` on Windows. Node's logical process-title assignment does not rename that executable identity.

## Terminal Title Design

Add a project-scoped `.vscode/settings.json` containing:

```json
{
  "terminal.integrated.tabs.title": "${sequence}"
}
```

Flavor's existing OSC title hook remains the runtime source of `flavor`. The setting tells VS Code to render that sequence title instead of the foreground executable name. This is intentionally workspace-scoped: it fixes the current project without mutating the user's global VS Code preferences.

The prior `process.title` assignment remains as a harmless fallback for process viewers and terminals that consume it. A native `flavor.exe` launcher is outside scope because it would add cross-platform binary packaging and release work.

## Welcome Accent Design

Use the truecolor value `#67D4FF` for the three-line `FLAVOR` wordmark and the compact `◆ Flavor Code` label. Keep the card border, tips, metadata, and command hierarchy unchanged so the accent has a single focal point and remains readable in dark VS Code themes.

## Testing

- Verify the project VS Code setting selects `${sequence}`.
- Verify wide and compact welcome renderings emit the sky-blue truecolor ANSI sequence.
- Re-run existing welcome visibility and narrow-width tests.
- Build the CLI and verify the existing OSC title path remains present.

## Operational Note

VS Code applies the workspace title template to newly created terminals. After the change, close the existing `node` terminal and start a new Flavor terminal; a window reload may be required if VS Code has not reloaded workspace settings.

## Non-goals

- Modifying global VS Code user settings.
- Shipping a native executable launcher.
- Recoloring the full welcome card or changing its layout and copy.
