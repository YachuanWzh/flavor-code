import React, { useEffect, useMemo, useState } from "react";

import type { DesktopGitFile, DesktopGitStatus } from "../contracts.js";

const EMPTY: DesktopGitStatus = { repository: false, branch: "", head: "", files: [] };
type DiffLayer = "working" | "staged";
export type DiffLineKind = "addition" | "deletion" | "context" | "hunk" | "meta";
export interface PresentedDiffLine {
  kind: DiffLineKind;
  marker: string;
  text: string;
  oldNumber?: number;
  newNumber?: number;
}

export function presentUnifiedDiff(value: string, untracked = false): PresentedDiffLine[] {
  const rawLines = value.replace(/\r\n/g, "\n").split("\n");
  if (rawLines.at(-1) === "") rawLines.pop();
  if (untracked && !rawLines.some((line) => line.startsWith("@@"))) {
    return rawLines.map((text, index) => ({ kind: "addition", marker: "+", text, newNumber: index + 1 }));
  }
  let oldNumber = 0; let newNumber = 0; let insideHunk = false;
  return rawLines.map((line): PresentedDiffLine => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk !== null) {
      oldNumber = Number(hunk[1]); newNumber = Number(hunk[2]); insideHunk = true;
      return { kind: "hunk", marker: "@@", text: hunk[3]?.trim() ?? "" };
    }
    if (!insideHunk || line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      return { kind: "meta", marker: "", text: line };
    }
    if (line.startsWith("+") && !line.startsWith("+++")) return { kind: "addition", marker: "+", text: line.slice(1), newNumber: newNumber++ };
    if (line.startsWith("-") && !line.startsWith("---")) return { kind: "deletion", marker: "−", text: line.slice(1), oldNumber: oldNumber++ };
    if (line.startsWith("\\ No newline")) return { kind: "meta", marker: "", text: line };
    const result = { kind: "context" as const, marker: "", text: line.startsWith(" ") ? line.slice(1) : line, oldNumber, newNumber };
    oldNumber += 1; newNumber += 1; return result;
  });
}

export function GitChangesView({ onClose, onReview, onError }: {
  onClose(): void;
  onReview(): void;
  onError(message: string): void;
}): React.JSX.Element {
  const [status, setStatus] = useState(EMPTY);
  const [selected, setSelected] = useState<DesktopGitFile>();
  const [diff, setDiff] = useState("");
  const [diffLayer, setDiffLayer] = useState<DiffLayer>("working");
  const [loading, setLoading] = useState(true);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [message, setMessage] = useState("");

  const lines = useMemo(() => presentUnifiedDiff(diff, selected?.untracked), [diff, selected?.untracked]);
  const additions = lines.filter((line) => line.kind === "addition").length;
  const deletions = lines.filter((line) => line.kind === "deletion").length;
  const stagedCount = status.files.filter((file) => file.staged).length;

  const refresh = async () => {
    try { setStatus(await window.flavorDesktop.gitStatus()); }
    catch (cause) { onError(errorMessage(cause)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);

  const loadDiff = async (file: DesktopGitFile, layer: DiffLayer) => {
    setLoadingDiff(true); setDiff(""); setDiffLayer(layer);
    try { setDiff(await window.flavorDesktop.gitDiff(file.path, layer === "staged")); }
    catch (cause) { const value = errorMessage(cause); setDiff(value); onError(value); }
    finally { setLoadingDiff(false); }
  };
  const choose = async (file: DesktopGitFile) => {
    setSelected(file);
    await loadDiff(file, file.unstaged || file.untracked ? "working" : "staged");
  };
  const mutate = async (operation: "stage" | "unstage" | "discard", file: DesktopGitFile) => {
    if (operation === "discard" && !window.confirm(`确定还原 ${file.path}？此操作无法撤销。`)) return;
    try {
      const next = operation === "stage" ? await window.flavorDesktop.gitStage(file.path)
        : operation === "unstage" ? await window.flavorDesktop.gitUnstage(file.path)
          : await window.flavorDesktop.gitDiscard(file.path);
      setStatus(next);
      const updated = next.files.find((item) => item.path === file.path);
      if (updated === undefined) { setSelected(undefined); setDiff(""); }
      else { setSelected(updated); await loadDiff(updated, updated.unstaged || updated.untracked ? "working" : "staged"); }
    } catch (cause) { onError(errorMessage(cause)); }
  };
  const doCommit = async () => {
    if (!message.trim()) return;
    try {
      const result = await window.flavorDesktop.gitCommit(message.trim());
      setStatus(result.status); setMessage(""); setSelected(undefined); setDiff(""); onError(`已提交 ${result.result}`);
    } catch (cause) { onError(errorMessage(cause)); }
  };

  return <section className="manager-view git-view">
    <header className="manager-header git-header"><div><button className="git-back" onClick={onClose} aria-label="返回">←</button><div><h2>Git 变更</h2><span>审阅并整理本次工作区修改</span></div></div>
      {status.repository && <span className="git-branch"><i />{status.branch}<b>{status.head}</b></span>}</header>
    {loading ? <p className="manager-empty">正在读取工作区…</p>
      : !status.repository ? <p className="manager-empty">当前项目不是 Git 仓库</p>
        : <div className="git-layout">
          <aside className="git-files"><div className="git-toolbar"><div><strong>变更</strong><span>{status.files.length}</span></div><button onClick={() => void refresh()} title="重新读取变更">↻</button></div>
            {status.files.length === 0 ? <div className="git-clean"><i>✓</i><strong>工作区干净</strong><span>没有需要审阅的修改</span></div> : status.files.map((file) => {
              const parts = splitPath(file.path); const state = file.untracked ? "U" : file.index === "A" ? "A" : file.index === "D" || file.worktree === "D" ? "D" : "M";
              return <div className="git-file-row" data-active={selected?.path === file.path} key={file.path}>
                <button className="git-file-name" onClick={() => void choose(file)} title={file.path}><code data-state={state}>{state}</code><span><b>{parts.name}</b>{parts.directory && <small>{parts.directory}</small>}</span></button>
                <div className="git-file-actions">{file.staged ? <button onClick={() => void mutate("unstage", file)}>取消暂存</button> : <button className="stage-action" onClick={() => void mutate("stage", file)}>暂存</button>}
                  {(file.unstaged || file.untracked) && <button className="danger-text" onClick={() => void mutate("discard", file)}>还原</button>}</div>
              </div>;
            })}</aside>
          <article className="git-diff">
            {selected === undefined ? <div className="git-diff-empty"><div><span>−</span><span>+</span></div><strong>选择文件查看差异</strong><p>逐行审阅修改，然后决定暂存或还原。</p></div> : <>
              <header className="git-diff-header"><div className="git-diff-title"><span>{splitPath(selected.path).directory || "项目根目录"}</span><strong>{splitPath(selected.path).name}</strong></div>
                <div className="git-diff-controls">{selected.staged && selected.unstaged && <div className="git-layer-switch"><button data-active={diffLayer === "working"} onClick={() => void loadDiff(selected, "working")}>工作区</button><button data-active={diffLayer === "staged"} onClick={() => void loadDiff(selected, "staged")}>已暂存</button></div>}
                  {!loadingDiff && <div className="git-diff-stats"><span className="add">+{additions}</span><span className="del">−{deletions}</span></div>}</div>
              </header>
              <div className="git-code" aria-label={`${selected.path} 差异`}>
                {loadingDiff ? <div className="git-diff-loading"><i />正在生成差异…</div> : lines.map((line, index) => <div className="git-code-line" data-kind={line.kind} key={`${index}-${line.oldNumber ?? ""}-${line.newNumber ?? ""}`}>
                  <span className="old-line">{line.oldNumber ?? ""}</span><span className="new-line">{line.newNumber ?? ""}</span><span className="change-marker">{line.marker}</span><code>{line.text || " "}</code>
                </div>)}
              </div>
            </>}
          </article>
        </div>}
    {status.repository && <footer className="git-footer"><button className="review-action" onClick={onReview}>交给 /review</button><div className="commit-field"><input value={message} onChange={(event) => setMessage(event.target.value)} placeholder={stagedCount > 0 ? "描述这次提交…" : "暂存文件后即可提交"} /><span>{stagedCount} 个文件已暂存</span></div><button className="commit-action" disabled={!message.trim() || stagedCount === 0} onClick={() => void doCommit()}>提交</button></footer>}
  </section>;
}

function splitPath(path: string): { name: string; directory: string } {
  const normalized = path.replace(/\\/g, "/"); const index = normalized.lastIndexOf("/");
  return index < 0 ? { name: normalized, directory: "" } : { name: normalized.slice(index + 1), directory: normalized.slice(0, index) };
}
function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
