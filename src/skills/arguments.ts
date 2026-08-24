/**
 * Expand the portable argument placeholders used by Claude-style Agent Skills.
 * Flavor still passes the original argument text as the user prompt; expansion
 * makes the skill body itself equivalent across hosts and is especially useful
 * when one skill loads another through the Skill tool.
 */
export function expandSkillArguments(body: string, argumentsText: string): string {
  const values = splitSkillArguments(argumentsText);
  const hasPlaceholder = /\$ARGUMENTS(?:\[\d+\])?|\$\d+/.test(body);
  let expanded = body.replace(/\$ARGUMENTS\[(\d+)\]/g, (_match, index: string) => values[Number(index)] ?? "");
  expanded = expanded.replace(/\$(\d+)/g, (_match, index: string) => values[Number(index)] ?? "");
  expanded = expanded.replace(/\$ARGUMENTS/g, argumentsText);
  if (!hasPlaceholder && argumentsText.trim() !== "") {
    expanded = `${expanded.trimEnd()}\n\nARGUMENTS: ${argumentsText}`;
  }
  return expanded;
}

export function splitSkillArguments(input: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let started = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? "";
    const next = input[index + 1];
    if (character === "\\" && quote !== "'" && next !== undefined
      && (/\s/u.test(next) || next === "\\" || next === '"' || (quote === undefined && next === "'"))) {
      current += next;
      index += 1;
      started = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        result.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) result.push(current);
  return result;
}
