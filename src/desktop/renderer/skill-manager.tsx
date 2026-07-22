import React, { useEffect, useMemo, useState } from "react";

import type { ManagedSkill, ManagedSkillSummary, SkillDraft } from "../../skills/manager.js";

interface SkillManagerViewProps {
  onClose(): void;
  onError(message: string): void;
}

const EMPTY_DRAFT: SkillDraft = {
  name: "",
  description: "",
  body: "# Instructions\n\nDescribe when and how the agent should use this skill.",
  disableModelInvocation: false,
};

export function SkillManagerView({ onClose, onError }: SkillManagerViewProps): React.JSX.Element {
  const [skills, setSkills] = useState<readonly ManagedSkillSummary[]>([]);
  const [selected, setSelected] = useState<ManagedSkill>();
  const [draft, setDraft] = useState<SkillDraft>(EMPTY_DRAFT);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState(false);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle.length === 0 ? skills : skills.filter((skill) =>
      skill.name.includes(needle) || skill.description.toLowerCase().includes(needle));
  }, [query, skills]);
  const enabledCount = skills.filter((skill) => skill.enabled).length;
  const dirty = creating
    ? draft.name.trim().length > 0 || draft.description.trim().length > 0 || draft.body !== EMPTY_DRAFT.body
    : selected !== undefined && (draft.description !== selected.description || draft.body !== selected.body
      || Boolean(draft.disableModelInvocation) !== selected.disableModelInvocation);

  const report = (cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause));

  const loadList = async (preferred?: string) => {
    const entries = await window.flavorDesktop.listSkills();
    setSkills(entries);
    const name = preferred ?? selected?.name ?? entries[0]?.name;
    if (name !== undefined && entries.some((skill) => skill.name === name)) await selectSkill(name);
    else if (!creating) { setSelected(undefined); setDraft(EMPTY_DRAFT); }
  };

  const selectSkill = async (name: string) => {
    try {
      const skill = await window.flavorDesktop.getSkill(name);
      setSelected(skill);
      setDraft({ name: skill.name, description: skill.description, body: skill.body,
        disableModelInvocation: skill.disableModelInvocation });
      setCreating(false);
      setPendingDelete(false);
    } catch (cause) { report(cause); }
  };

  useEffect(() => {
    let active = true;
    window.flavorDesktop.listSkills().then(async (entries) => {
      if (!active) return;
      setSkills(entries);
      if (entries[0] !== undefined) await selectSkill(entries[0].name);
    }).catch(report).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const beginCreate = () => {
    setCreating(true);
    setSelected(undefined);
    setDraft(EMPTY_DRAFT);
    setPendingDelete(false);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const result = creating
        ? await window.flavorDesktop.createSkill(draft)
        : await window.flavorDesktop.updateSkill(selected!.name, draft);
      setCreating(false);
      setSelected(result);
      setDraft({ name: result.name, description: result.description, body: result.body,
        disableModelInvocation: result.disableModelInvocation });
      await loadList(result.name);
    } catch (cause) { report(cause); }
    finally { setSaving(false); }
  };

  const toggle = async (skill: ManagedSkillSummary, enabled: boolean) => {
    setSkills((current) => current.map((item) => item.name === skill.name ? { ...item, enabled } : item));
    if (selected?.name === skill.name) setSelected({ ...selected, enabled });
    try { await window.flavorDesktop.setSkillEnabled(skill.name, enabled); }
    catch (cause) {
      setSkills((current) => current.map((item) => item.name === skill.name ? { ...item, enabled: !enabled } : item));
      if (selected?.name === skill.name) setSelected({ ...selected, enabled: !enabled });
      report(cause);
    }
  };

  const remove = async () => {
    if (selected === undefined || saving) return;
    setSaving(true);
    try {
      await window.flavorDesktop.deleteSkill(selected.name);
      setPendingDelete(false);
      setSelected(undefined);
      setDraft(EMPTY_DRAFT);
      const entries = await window.flavorDesktop.listSkills();
      setSkills(entries);
      if (entries[0] !== undefined) await selectSkill(entries[0].name);
    } catch (cause) { report(cause); }
    finally { setSaving(false); }
  };

  return <section className="skill-workbench" aria-label="技能管理">
    <header className="skill-workbench-header">
      <div>
        <button className="skill-back" onClick={onClose} aria-label="返回对话">‹</button>
        <div><p>项目能力</p><h1>技能管理</h1></div>
      </div>
      <div className="skill-health"><i /><span><strong>{enabledCount}</strong> / {skills.length} 已开启</span></div>
    </header>

    <div className="skill-workbench-body">
      <aside className="skill-catalog">
        <div className="skill-catalog-tools">
          <label><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索技能" /></label>
          <button className="skill-create" onClick={beginCreate}><span>＋</span> 新建技能</button>
        </div>
        <div className="skill-list" aria-busy={loading}>
          {loading && <p className="skill-list-empty">正在读取技能…</p>}
          {!loading && visible.length === 0 && <div className="skill-list-empty"><strong>没有匹配的技能</strong><span>创建一个项目技能，或调整搜索词。</span></div>}
          {visible.map((skill) => <article className="skill-list-item" data-selected={!creating && selected?.name === skill.name}
            data-enabled={skill.enabled} key={skill.name}>
            <button className="skill-select" onClick={() => void selectSkill(skill.name)}>
              <span className="skill-glyph">{skill.name.slice(0, 1).toUpperCase()}</span>
              <span><strong>{skill.name}</strong><small>{skill.description}</small></span>
            </button>
            <label className="skill-toggle" title={skill.enabled ? "关闭后 Agent 无法读取" : "开启后 Agent 可以读取"}>
              <input type="checkbox" checked={skill.enabled} onChange={(event) => void toggle(skill, event.target.checked)} />
              <span />
            </label>
          </article>)}
        </div>
        <p className="skill-catalog-note">启停状态保存在 <code>.flavor/flavor.json</code></p>
      </aside>

      <main className="skill-editor">
        {selected === undefined && !creating ? <div className="skill-editor-empty">
          <span>◇</span><h2>选择或创建一个技能</h2><p>技能会在任务匹配时为 Agent 注入专门的工作说明。</p>
        </div> : <>
          <div className="skill-editor-heading">
            <div><p>{creating ? "新建项目技能" : selected?.editable ? "项目技能" : selected?.source === "global" ? "全局技能" : "插件技能"}</p>
              <h2>{creating ? "定义一项新能力" : selected?.name}</h2></div>
            {!creating && selected !== undefined && <span className="skill-status" data-enabled={selected.enabled}><i />{selected.enabled ? "Agent 可读取" : "已隔离"}</span>}
          </div>
          {!creating && selected?.editable === false && <div className="skill-readonly-note">此技能由全局目录或插件提供，在此项目中只读。你仍可以为当前项目开启或关闭它。</div>}
          <div className="skill-form">
            <label><span>名称 <small>小写字母、数字和连字符</small></span><input value={draft.name} disabled={!creating}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="code-review" /></label>
            <label><span>描述 <small>帮助 Agent 判断何时使用</small></span><textarea rows={3} value={draft.description}
              disabled={!creating && !selected?.editable} onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              placeholder="在提交代码前检查正确性、安全性与可维护性" /></label>
            <label className="skill-instructions"><span>SKILL.md 指令 <small>支持 Markdown</small></span><textarea value={draft.body}
              disabled={!creating && !selected?.editable} onChange={(event) => setDraft({ ...draft, body: event.target.value })} spellCheck={false} /></label>
            <label className="manual-invocation"><input type="checkbox" checked={Boolean(draft.disableModelInvocation)}
              disabled={!creating && !selected?.editable} onChange={(event) => setDraft({ ...draft, disableModelInvocation: event.target.checked })} />
              <span><strong>仅允许手动调用</strong><small>开启技能，但不让 Agent 自动匹配；仍可通过 /{draft.name || "skill-name"} 调用。</small></span></label>
          </div>
          <footer className="skill-editor-actions">
            {!creating && selected?.editable && <button className="skill-delete" onClick={() => setPendingDelete(true)}>删除技能</button>}
            {creating && <button onClick={() => { setCreating(false); void loadList(); }}>取消</button>}
            {(creating || selected?.editable) && <button className="skill-save" disabled={!dirty || saving || !draft.name.trim() || !draft.description.trim() || !draft.body.trim()} onClick={() => void save()}>
              {saving ? "正在保存…" : creating ? "创建技能" : "保存更改"}</button>}
          </footer>
        </>}
      </main>
    </div>

    {pendingDelete && selected !== undefined && <div className="skill-delete-layer"><div className="skill-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="skill-delete-title">
      <span>!</span><div><p>删除项目技能</p><h2 id="skill-delete-title">删除“{selected.name}”？</h2><small>技能目录及其中的资源会被永久删除，此操作无法撤销。</small>
        <div><button onClick={() => setPendingDelete(false)}>取消</button><button className="danger" disabled={saving} onClick={() => void remove()}>{saving ? "正在删除…" : "删除技能"}</button></div></div>
    </div></div>}
  </section>;
}
