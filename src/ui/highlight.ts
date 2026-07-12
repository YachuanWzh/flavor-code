import chalk from "chalk";

// The highlighter is only useful in a context where the output is rendered
// to a terminal that interprets SGR sequences. Force TrueColor so that the
// hex palettes below are emitted even when tests / pipeline invocations
// strip Chalk's TTY detection.
chalk.level = Math.max(chalk.level, 3) as 0 | 1 | 2 | 3;

/**
 * Lightweight terminal-friendly syntax highlighter.
 *
 * Returns the source code with ANSI escape codes baked in. Designed for
 * rendering as a single string inside an Ink `<Text>` block — no spans, no
 * offsets, no token trees. Adds colour for keywords, strings, comments,
 * numbers, decorators, and function-call identifiers across the most common
 * languages, and gracefully degrades for unknown ones.
 */

type Lang = "javascript" | "typescript" | "python" | "bash" | "json" | "rust" | "go";

const KEYWORD = chalk.hex("#c586c0");
const STRING = chalk.hex("#ce9178");
const COMMENT = chalk.gray.italic;
const NUMBER = chalk.hex("#b5cea8");
const FUNCTION = chalk.hex("#dcdcaa");
const ATTRIBUTE = chalk.hex("#d7ba7d");

const KEYWORDS: Record<Lang, ReadonlySet<string>> = {
  javascript: new Set([
    "await", "async", "break", "case", "catch", "class", "const", "continue",
    "default", "delete", "do", "else", "export", "extends", "finally", "for", "from",
    "function", "if", "import", "in", "instanceof", "let", "new", "of", "return",
    "static", "super", "switch", "this", "throw", "true", "false", "null", "try",
    "typeof", "undefined", "var", "void", "while", "with", "yield",
  ]),
  typescript: new Set([
    "abstract", "any", "as", "async", "await", "boolean", "break", "case", "catch",
    "class", "const", "constructor", "continue", "declare", "default", "delete",
    "do", "else", "enum", "export", "extends", "false", "finally", "for", "from",
    "function", "get", "if", "implements", "import", "in", "instanceof", "interface",
    "is", "keyof", "let", "namespace", "never", "new", "null", "number", "object",
    "of", "private", "protected", "public", "readonly", "return", "set", "static",
    "string", "super", "switch", "this", "throw", "true", "try", "type", "typeof",
    "undefined", "unique", "unknown", "var", "void", "while", "with", "yield",
  ]),
  python: new Set([
    "False", "None", "True", "and", "as", "assert", "async", "await", "break",
    "class", "continue", "def", "del", "elif", "else", "except", "finally",
    "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
    "not", "or", "pass", "raise", "return", "try", "while", "with", "yield", "self",
  ]),
  bash: new Set([
    "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done",
    "case", "esac", "in", "function", "return", "export", "local", "echo",
    "printf", "test",
  ]),
  json: new Set(["true", "false", "null"]),
  rust: new Set([
    "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else",
    "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop",
    "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static",
    "struct", "super", "trait", "true", "type", "unsafe", "use", "where", "while",
  ]),
  go: new Set([
    "break", "case", "chan", "const", "continue", "default", "defer", "else",
    "fallthrough", "for", "func", "go", "goto", "if", "import", "interface", "map",
    "package", "range", "return", "select", "struct", "switch", "type", "var",
    "true", "false", "nil",
  ]),
};

function normalizeLanguage(input: string | undefined): Lang | undefined {
  if (input === undefined) return undefined;
  const lower = input.trim().toLowerCase();
  switch (lower) {
    case "js": case "jsx": case "javascript": return "javascript";
    case "ts": case "tsx": case "typescript": return "typescript";
    case "py": case "python": return "python";
    case "sh": case "shell": case "bash": case "zsh": return "bash";
    case "json": return "json";
    case "rs": case "rust": return "rust";
    case "go": case "golang": return "go";
    default: return undefined;
  }
}

function isIdentifierStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch) || ch === "@";
}

function isIdentifierPart(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isNumberPrefix(line: string, i: number): boolean {
  const ch = line[i] ?? "";
  if (isDigit(ch)) return true;
  if (ch === "." && isDigit(line[i + 1] ?? "")) return true;
  if (ch === "0" && (line[i + 1] === "x" || line[i + 1] === "X")) return true;
  return false;
}

function readNumberToken(line: string, i: number): number {
  let j = i + 1;
  const len = line.length;
  while (j < len) {
    const cj = line[j] ?? "";
    if (isDigit(cj)) { j += 1; continue; }
    if (cj === "." && isDigit(line[j + 1] ?? "")) { j += 1; continue; }
    if (cj === "_") { j += 1; continue; }
    if ((cj === "e" || cj === "E") && /[+\-0-9]/.test(line[j + 1] ?? "")) {
      j += 1;
      if (line[j] === "+" || line[j] === "-") j += 1;
      while (j < len && isDigit(line[j] ?? "")) j += 1;
      continue;
    }
    break;
  }
  return j;
}

function readIdentifierToken(line: string, i: number): number {
  let j = i + 1;
  while (j < line.length && isIdentifierPart(line[j] ?? "")) j += 1;
  return j;
}

function readStringToken(line: string, i: number): number {
  const quote = line[i] ?? "";
  let j = i + 1;
  const len = line.length;
  while (j < len) {
    const cj = line[j] ?? "";
    if (cj === "\\") { j += 2; continue; }
    if (cj === quote) { j += 1; return j; }
    j += 1;
  }
  return j;
}

function readBlockCommentToken(line: string, i: number): number {
  let j = i + 2;
  const len = line.length;
  while (j < len) {
    if (line[j] === "*" && line[j + 1] === "/") return j + 2;
    j += 1;
  }
  return len;
}

function highlightSingleLine(line: string, keywords: ReadonlySet<string>): string {
  const tokens: Array<{ text: string; paint: (s: string) => string }> = [];
  let i = 0;
  const len = line.length;

  // Determine line-comment opener for this language.
  const commentStart = (line[0] === "#");

  while (i < len) {
    const ch = line[i] ?? "";

    // Block comment /* ... */
    if (ch === "/" && line[i + 1] === "*") {
      const end = readBlockCommentToken(line, i);
      tokens.push({ text: line.slice(i, end), paint: COMMENT });
      i = end;
      continue;
    }

    // Line comments.
    if (commentStart && ch === "#") {
      tokens.push({ text: line.slice(i), paint: COMMENT });
      i = len;
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") {
      tokens.push({ text: line.slice(i), paint: COMMENT });
      i = len;
      continue;
    }

    // Strings.
    if (ch === "'" || ch === '"' || ch === "`") {
      const end = readStringToken(line, i);
      tokens.push({ text: line.slice(i, end), paint: STRING });
      i = end;
      continue;
    }

    // Numbers.
    if (isNumberPrefix(line, i)) {
      const end = readNumberToken(line, i);
      tokens.push({ text: line.slice(i, end), paint: NUMBER });
      i = end;
      continue;
    }

    // Identifiers / keywords / decorators.
    if (isIdentifierStart(ch)) {
      const end = readIdentifierToken(line, i);
      const word = line.slice(i, end);
      if (ch === "@") {
        tokens.push({ text: word, paint: ATTRIBUTE });
      } else if (keywords.has(word)) {
        tokens.push({ text: word, paint: KEYWORD });
      } else if (line[end] === "(") {
        tokens.push({ text: word, paint: FUNCTION });
      } else {
        tokens.push({ text: word, paint: (s) => s });
      }
      i = end;
      continue;
    }

    // Single-char punctuation / operator: capture run of similar punctuation.
    let j = i + 1;
    while (j < len) {
      const cj = line[j] ?? "";
      if (isIdentifierStart(cj) || isDigit(cj) || cj === "'" || cj === '"' || cj === "`" || cj === "@" || cj === "/") break;
      j += 1;
    }
    tokens.push({ text: line.slice(i, j), paint: (s) => s });
    i = j;
  }

  let out = "";
  for (const token of tokens) {
    out += token.paint(token.text);
  }
  return out;
}

/**
 * Apply terminal ANSI styling to a code block body. Returns a string with
 * embedded escape codes; pass directly to a terminal renderer.
 */
export function highlightCode(source: string, language: string | undefined = undefined): string {
  if (source.length === 0) return "";
  const lang = normalizeLanguage(language);
  const keywords = lang !== undefined ? KEYWORDS[lang] : KEYWORDS.javascript;
  // For unknown languages we still highlight comments, strings, and numbers
  // (using a JS-flavoured fallback so `//` and quotes still receive colour).
  return source.split("\n").map((line) => highlightSingleLine(line, keywords)).join("\n");
}
