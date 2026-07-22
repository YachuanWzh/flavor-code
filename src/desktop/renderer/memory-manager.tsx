import React, { useEffect, useMemo, useState } from "react";

import type { MemorySnapshot } from "../../memory/manager.js";
import { MEMORY_TYPES, type MemoryCandidate, type MemoryEntry, type MemoryType } from "../../memory/types.js";

interface MemoryManagerViewProps {
  onClose(): void;
  onError(message: string): void;
}

const TYPE_COPY: Record<MemoryType, { label: string; hint: string }> = {
  user: { label: "用户偏好", hint: "长期稳定的角色、表达和工作偏好" },
  feedback: { label: "行为反馈", hint: "希望 Agent 以后持续遵守的纠正" },
  project: { label: "项目约定", hint: "不能只靠代码推导出的规则和决策" },
  reference: { label: "外部引用", hint: "以后仍会用到的文档或系统入口" },
};

const EMPTY_SNAPSHOT: MemorySnapshot = { enabled: true, path: "", entries: [] };
const EMPTY_DRAFT: MemoryCandidate = { type: "project", content: "" };

export function MemoryManagerView({ onClose, onError }: MemoryManagerViewProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<MemorySnapshot>(EMPTY_SNAPSHOT);
  const [selected, setSelected] = useState<MemoryEntry>();
  const [draft, setDraft] = useState<MemoryCandidate>(EMPTY_DRAFT);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MemoryType | "all">("all");
  const [pendingDelete, setPendingDelete] = useState(false);

  const report = (cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause));
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return snapshot.entries.filter((entry) => (filter === "all" || entry.type === filter)
      && (needle.length === 0 || entry.content.toLocaleLowerCase().includes(needle) || entry.id.includes(needle)));
  }, [filter, query, snapshot.entries]);
  const dirty = creating
    ? draft.content.trim().length > 0
    : selected !== undefined && (draft.type !== selected.type || draft.content !== selected.content);

  const applySelection = (next: MemorySnapshot, preferred?: string) => {
    const entry = next.entries.find((item) => item.id === preferred)
      ?? next.entries.find((item) => item.id === selected?.id)
      ?? next.entries[0];
    setSelected(entry);
    if (entry !== undefined) setDraft({ type: entry.type, content: entry.content });
    else setDraft(EMPTY_DRAFT);
  };

  const load = async (preferred?: string) => {
    const next = await window.flavorDesktop.listMemory();
    setSnapshot(next);
    applySelection(next, preferred);
    return next;
  };

  useEffect(() => {
    let active = true;
    window.flavorDesktop.listMemory().then((next) => {
      if (!active) return;
      setSnapshot(next);
      applySelection(next);
    }).catch(report).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const beginCreate = () => {
    setCreating(true);
    setSelected(undefined);
    setDraft(EMPTY_DRAFT);
    setPendingDelete(false);
  };

  const choose = (entry: MemoryEntry) => {
    setCreating(false);
    setSelected(entry);
    setDraft({ type: entry.type, content: entry.content });
    setPendingDelete(false);
  };

  const save = async () => {
    if (saving || draft.content.trim().length === 0) return;
    setSaving(true);
    try {
      const result = creating
        ? await window.flavorDesktop.createMemory(draft)
        : await window.flavorDesktop.updateMemory(selected!.id, draft);
      setCreating(false);
      await load(result.id);
    } catch (cause) { report(cause); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (selected === undefined || saving) return;
    setSaving(true);
    try {
      const deleted = await window.flavorDesktop.deleteMemory(selected.id);
      if (!deleted) throw new Error("这条记忆已不存在，请重新载入后再试。");
      setPendingDelete(false);
      setSelected(undefined);
      setDraft(EMPTY_DRAFT);
      await load();
    } catch (cause) { report(cause); }
    finally { setSaving(false); }
  };

  return <section className="memory-workbench" aria-label="长期记忆管理">
    <header className="memory-workbench-header">
      <div className="memory-heading">
        <button className="memory-back" onClick={onClose} aria-label="返回对话">‹</button>
        <div><p>项目上下文</p><h1>长期记忆</h1></div>
      </div>
      <div className="memory-ledger-status" data-enabled={snapshot.enabled}>
        <i /><span><strong>{snapshot.entries.length}</strong> 条已保存</span>
      </div>
    </header>

    <div className="memory-workbench-body">
      <aside className="memory-catalog">
        <div className="memory-catalog-tools">
          <label><span>⌕</span><input aria-label="搜索记忆" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索记忆" /></label>
          <button className="memory-create" onClick={beginCreate} disabled={!snapshot.enabled}><span>＋</span> 新建记忆</button>
        </div>
        <div className="memory-index" aria-label="按类型筛选">
          <button data-active={filter === "all"} onClick={() => setFilter("all")}><span>全部</span><b>{snapshot.entries.length}</b></button>
          {MEMORY_TYPES.map((type) => <button key={type} data-type={type} data-active={filter === type} onClick={() => setFilter(type)}>
            <span>{TYPE_COPY[type].label}</span><b>{snapshot.entries.filter((entry) => entry.type === type).length}</b>
          </button>)}
        </div>
        <div className="memory-list" aria-busy={loading}>
          {loading && <p className="memory-list-empty">正在读取记忆…</p>}
          {!loading && !snapshot.enabled && <div className="memory-list-empty"><strong>长期记忆已关闭</strong><span>在项目配置中将 memory.enabled 设为 true 后可维护。</span></div>}
          {!loading && snapshot.enabled && visible.length === 0 && <div className="memory-list-empty"><strong>{snapshot.entries.length === 0 ? "还没有长期记忆" : "没有匹配项"}</strong><span>{snapshot.entries.length === 0 ? "新建一条明确、稳定、以后仍有用的信息。" : "尝试其他关键词或类型。"}</span></div>}
          {visible.map((entry) => <button className="memory-card" data-selected={!creating && selected?.id === entry.id} data-type={entry.type} key={entry.id} onClick={() => choose(entry)}>
            <span className="memory-card-tab">{TYPE_COPY[entry.type].label}</span>
            <strong>{entry.content}</strong><code>{entry.id}</code>
          </button>)}
        </div>
        <p className="memory-catalog-note">存储于 <code>{snapshot.path || ".flavor/memory/MEMORY.md"}</code></p>
      </aside>

      <main className="memory-editor">
        {!snapshot.enabled ? <div className="memory-editor-empty"><span>⊘</span><h2>长期记忆没有启用</h2><p>启用后才能读取和修改项目记忆。</p></div>
          : selected === undefined && !creating ? <div className="memory-editor-empty"><span>⌁</span><h2>建立项目的共同记忆</h2><p>保存少量稳定事实。当前指令和仓库内容始终优先。</p><button onClick={beginCreate}>新建第一条记忆</button></div>
            : <>
              <div className="memory-editor-heading">
                <div><p>{creating ? "新记忆" : `记忆 ${selected?.id}`}</p><h2>{creating ? "记录一件以后仍有用的事" : TYPE_COPY[draft.type].label}</h2></div>
                <span className="memory-type-seal" data-type={draft.type}>{draft.type}</span>
              </div>
              <div className="memory-priority-note"><span>i</span><p>记忆是历史背景，不是强制指令。新建或修改后，从下一次模型请求开始生效。</p></div>
              <div className="memory-form">
                <fieldset><legend>记忆类型</legend><div className="memory-type-options">
                  {MEMORY_TYPES.map((type) => <label key={type} data-type={type} data-selected={draft.type === type}>
                    <input type="radio" name="memory-type" value={type} checked={draft.type === type}
                      onChange={() => setDraft({ ...draft, type })} />
                    <span><strong>{TYPE_COPY[type].label}</strong><small>{TYPE_COPY[type].hint}</small></span>
                  </label>)}
                </div></fieldset>
                <label className="memory-content-field"><span>内容 <small>只写一件事，避免密码、Token 和临时任务状态</small></span>
                  <textarea autoFocus value={draft.content} maxLength={20_000} onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                    placeholder="例如：不要在未明确要求时创建 Git 提交。" />
                  <em>{draft.content.length} 字符</em>
                </label>
              </div>
              <footer className="memory-editor-actions">
                {!creating && <button className="memory-delete" onClick={() => setPendingDelete(true)}>删除记忆</button>}
                {creating && <button onClick={() => { setCreating(false); void load(); }}>取消</button>}
                <button className="memory-save" disabled={!dirty || saving || draft.content.trim().length === 0} onClick={() => void save()}>
                  {saving ? "正在保存…" : creating ? "保存记忆" : "保存更改"}</button>
              </footer>
            </>}
      </main>
    </div>

    {pendingDelete && selected !== undefined && <div className="memory-delete-layer"><div className="memory-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-delete-title">
      <span>!</span><div><p>删除长期记忆</p><h2 id="memory-delete-title">删除这条{TYPE_COPY[selected.type].label}？</h2><small>{selected.content}</small>
        <div><button onClick={() => setPendingDelete(false)}>取消</button><button className="danger" disabled={saving} onClick={() => void remove()}>{saving ? "正在删除…" : "删除记忆"}</button></div></div>
    </div></div>}
  </section>;
}
