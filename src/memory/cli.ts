import { homedir } from "node:os";
import type { Command } from "commander";

import { createProjectMemoryManager, type MemoryManagerLike } from "./manager.js";
import { MEMORY_TYPES, type MemoryType } from "./types.js";

export interface MemoryCliDependencies {
  open?(options: { workspace: string; home: string }): Promise<MemoryManagerLike>;
  cwd?(): string;
  home?(): string;
  write?(text: string): void;
}

export function registerMemoryCommands(program: Command, dependencies: MemoryCliDependencies = {}): void {
  const open = dependencies.open ?? createProjectMemoryManager;
  const cwd = dependencies.cwd ?? (() => process.cwd());
  const home = dependencies.home ?? homedir;
  const write = dependencies.write ?? ((text: string) => process.stdout.write(text));
  const manager = () => open({ workspace: cwd(), home: home() });
  const memory = program.command("memory").description("Inspect and maintain project long-term memory");

  memory.command("list", { isDefault: true })
    .description("List project memories")
    .option("--json", "print a machine-readable snapshot")
    .action(async (options: { json?: boolean }) => {
      const snapshot = await (await manager()).snapshot();
      if (options.json) {
        write(`${JSON.stringify(snapshot, null, 2)}\n`);
        return;
      }
      write(`Memory file: ${snapshot.path}\n`);
      if (!snapshot.enabled) {
        write("Long-term memory is disabled for this project.\n");
        return;
      }
      if (snapshot.entries.length === 0) {
        write("No long-term memories.\n");
        return;
      }
      for (const entry of snapshot.entries) write(`${entry.id}  ${entry.type}  ${entry.content}\n`);
    });

  memory.command("add")
    .description("Add a memory")
    .argument("<type>", "user, feedback, project, or reference")
    .argument("<text...>", "memory text")
    .action(async (type: string, words: string[]) => {
      const entry = await (await manager()).remember({ type: parseMemoryType(type), content: words.join(" ") });
      write(`Added ${entry.id}  ${entry.type}  ${entry.content}\n`);
    });

  memory.command("update")
    .description("Replace one memory by id")
    .argument("<id>", "12-character memory id")
    .argument("<type>", "user, feedback, project, or reference")
    .argument("<text...>", "replacement text")
    .action(async (id: string, type: string, words: string[]) => {
      const entry = await (await manager()).update(id, { type: parseMemoryType(type), content: words.join(" ") });
      write(`Updated ${id} -> ${entry.id}  ${entry.type}  ${entry.content}\n`);
    });

  memory.command("delete")
    .description("Delete one memory by id")
    .argument("<id>", "12-character memory id")
    .action(async (id: string) => {
      const deleted = await (await manager()).delete(id);
      if (!deleted) throw new Error(`Memory entry not found: ${id}`);
      write(`Deleted ${id}\n`);
    });

  memory.command("path")
    .description("Print the project memory file path")
    .action(async () => write(`${(await (await manager()).snapshot()).path}\n`));
}

function parseMemoryType(value: string): MemoryType {
  if (!(MEMORY_TYPES as readonly string[]).includes(value)) {
    throw new Error(`Unsupported memory type: ${value}. Use ${MEMORY_TYPES.join(", ")}.`);
  }
  return value as MemoryType;
}
