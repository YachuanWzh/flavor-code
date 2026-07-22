import React, { useEffect, useMemo, useState } from "react";

import type { McpServerConfig } from "../../config/schema.js";
import type { ManagedMcpServer } from "../../mcp/config-manager.js";
import type { McpServerDraft } from "../contracts.js";

interface McpManagerViewProps {
  onClose(): void;
  onError(message: string): void;
}

interface FormDraft {
  name: string;
  transport: "stdio" | "http";
  enabled: boolean;
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
  timeoutMs: string;
}

const EMPTY_DRAFT: FormDraft = {
  name: "", transport: "stdio", enabled: true, command: "", args: "", env: "", cwd: "",
  url: "", headers: "", timeoutMs: "60000",
};

export function McpManagerView({ onClose, onError }: McpManagerViewProps): React.JSX.Element {
  const [services, setServices] = useState<readonly ManagedMcpServer[]>([]);
  const [selectedName, setSelectedName] = useState<string>();
  const [draft, setDraft] = useState<FormDraft>(EMPTY_DRAFT);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ManagedMcpServer>();

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle === "" ? services : services.filter((service) =>
      service.name.toLowerCase().includes(needle) || service.transport.includes(needle));
  }, [query, services]);

  const load = async (preferred?: string) => {
    const next = await window.flavorDesktop.listMcpServers();
    setServices(next);
    const selected = next.find((service) => service.name === preferred)
      ?? next.find((service) => service.name === selectedName)
      ?? next[0];
    if (selected !== undefined) {
      setSelectedName(selected.name);
      setDraft(toFormDraft(selected));
    } else if (next.length === 0) {
      setSelectedName(undefined);
    }
  };

  useEffect(() => {
    let cancelled = false;
    window.flavorDesktop.listMcpServers().then((next) => {
      if (cancelled) return;
      setServices(next);
      const first = next[0];
      if (first !== undefined) { setSelectedName(first.name); setDraft(toFormDraft(first)); }
    }).catch((cause) => { if (!cancelled) onError(errorMessage(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const select = (service: ManagedMcpServer) => {
    setCreating(false);
    setSelectedName(service.name);
    setDraft(toFormDraft(service));
  };

  const startCreate = () => {
    setCreating(true);
    setSelectedName(undefined);
    setDraft(EMPTY_DRAFT);
  };

  const save = async () => {
    setSaving(true);
    try {
      const saved = await window.flavorDesktop.saveMcpServer(creating ? undefined : selectedName, toServerDraft(draft));
      setCreating(false);
      setSelectedName(saved.name);
      await load(saved.name);
    } catch (cause) {
      onError(errorMessage(cause));
    } finally { setSaving(false); }
  };

  const toggle = async (service: ManagedMcpServer, enabled: boolean) => {
    try {
      const changed = await window.flavorDesktop.setMcpServerEnabled(service.name, enabled);
      setServices((current) => current.map((item) => item.name === changed.name ? changed : item));
      if (selectedName === changed.name) setDraft(toFormDraft(changed));
    } catch (cause) { onError(errorMessage(cause)); }
  };

  const remove = async () => {
    const service = pendingDelete;
    if (service === undefined) return;
    setSaving(true);
    try {
      await window.flavorDesktop.deleteMcpServer(service.name);
      setPendingDelete(undefined);
      setCreating(false);
      setSelectedName(undefined);
      setDraft(EMPTY_DRAFT);
      await load();
    } catch (cause) { onError(errorMessage(cause)); }
    finally { setSaving(false); }
  };

  const selected = services.find((service) => service.name === selectedName);
  return <section className="mcp-workbench" aria-label="MCP 服务管理">
    <header className="mcp-workbench-header">
      <div className="mcp-heading">
        <button className="mcp-back" onClick={onClose} aria-label="返回对话">‹</button>
        <div><p>PROJECT CONNECTIONS</p><h1>MCP 服务</h1></div>
      </div>
      <div className="mcp-health"><i />项目配置 <strong>{services.filter((item) => item.enabled).length}</strong> 已开启</div>
    </header>
    <div className="mcp-workbench-body">
      <aside className="mcp-catalog">
        <div className="mcp-catalog-tools">
          <label><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索服务" aria-label="搜索服务" /></label>
          <button className="mcp-create" onClick={startCreate}><span>＋</span>添加服务</button>
        </div>
        <div className="mcp-list">
          {loading ? <div className="mcp-list-empty"><strong>正在读取项目配置</strong><span>.flavor/flavor.json</span></div>
            : visible.length === 0 ? <div className="mcp-list-empty"><strong>{query ? "没有匹配的服务" : "还没有项目 MCP 服务"}</strong><span>{query ? "尝试其他名称或传输类型" : "添加 stdio 或 Streamable HTTP 服务"}</span></div>
              : visible.map((service) => <div className="mcp-list-item" key={service.name} data-selected={!creating && selectedName === service.name} data-transport={service.transport} data-enabled={service.enabled}>
                <button className="mcp-select" onClick={() => select(service)}>
                  <span className="mcp-transport-glyph">{service.transport === "stdio" ? ">_" : "↗"}</span>
                  <span><strong>{service.name}</strong><small>{service.transport === "stdio" ? commandSummary(service.config) : urlSummary(service.config)}</small></span>
                </button>
                <label className="mcp-toggle" title={service.enabled ? "关闭服务" : "开启服务"}>
                  <input type="checkbox" checked={service.enabled} onChange={(event) => void toggle(service, event.target.checked)} aria-label={`${service.enabled ? "关闭" : "开启"} ${service.name}`} />
                  <span />
                </label>
              </div>)}
        </div>
        <p className="mcp-catalog-note">仅管理项目配置 <code>.flavor/flavor.json</code></p>
      </aside>

      <article className="mcp-editor">
        {creating || selected !== undefined ? <>
          <div className="mcp-editor-heading">
            <div><p>{creating ? "NEW CONNECTION" : "SERVICE CONFIGURATION"}</p><h2>{creating ? "添加 MCP 服务" : selectedName}</h2></div>
            <span className="mcp-transport-seal" data-transport={draft.transport}>{draft.transport}</span>
          </div>
          <div className="mcp-lifecycle-note"><span>↻</span><div><strong>从下一个任务开始生效</strong><small>现有对话不会因配置更改而中断。</small></div></div>
          <form className="mcp-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <div className="mcp-form-grid">
              <label><span>服务名称 <small>字母、数字、_ 或 -</small></span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required pattern="[A-Za-z0-9_-]+" /></label>
              <label><span>传输方式</span><select value={draft.transport} onChange={(event) => setDraft({ ...draft, transport: event.target.value as FormDraft["transport"] })}>
                <option value="stdio">stdio · 本地进程</option><option value="http">HTTP · 远程服务</option>
              </select></label>
            </div>
            {draft.transport === "stdio" ? <>
              <label><span>启动命令</span><input value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="npx" required /></label>
              <label><span>参数 <small>每行一个参数</small></span><textarea rows={4} value={draft.args} onChange={(event) => setDraft({ ...draft, args: event.target.value })} placeholder={"-y\n@modelcontextprotocol/server-filesystem\n."} /></label>
              <div className="mcp-form-grid">
                <label><span>工作目录 <small>可选</small></span><input value={draft.cwd} onChange={(event) => setDraft({ ...draft, cwd: event.target.value })} placeholder="." /></label>
                <label><span>环境变量 <small>每行 KEY=VALUE</small></span><textarea rows={3} value={draft.env} onChange={(event) => setDraft({ ...draft, env: event.target.value })} placeholder="TOKEN=${MCP_TOKEN}" /></label>
              </div>
            </> : <>
              <label><span>服务 URL</span><input type="url" value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://mcp.example.com/mcp" required /></label>
              <label><span>请求头 <small>每行 KEY=VALUE</small></span><textarea rows={4} value={draft.headers} onChange={(event) => setDraft({ ...draft, headers: event.target.value })} placeholder="Authorization=Bearer ${MCP_TOKEN}" /></label>
            </>}
            <div className="mcp-form-grid mcp-form-grid-compact">
              <label><span>超时 <small>毫秒</small></span><input type="number" min={100} max={1_800_000} value={draft.timeoutMs} onChange={(event) => setDraft({ ...draft, timeoutMs: event.target.value })} required /></label>
              <label className="mcp-enabled-field"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span><strong>保存后开启</strong><small>关闭时配置仍会保留</small></span></label>
            </div>
            <div className="mcp-editor-actions">
              {!creating && selected !== undefined && <button type="button" className="mcp-delete" onClick={() => setPendingDelete(selected)}>删除服务</button>}
              <button type="button" onClick={() => creating ? select(services[0]!) : selected && setDraft(toFormDraft(selected))} disabled={saving || (creating && services.length === 0)}>取消</button>
              <button type="submit" className="mcp-save" disabled={saving}>{saving ? "正在保存…" : "保存配置"}</button>
            </div>
          </form>
        </> : <div className="mcp-editor-empty"><span>◎</span><h2>连接你的工具</h2><p>从左侧选择服务，或添加新的 stdio / HTTP 配置。</p></div>}
      </article>
    </div>
    {pendingDelete !== undefined && <div className="mcp-delete-layer" role="presentation">
      <div className="mcp-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="mcp-delete-title">
        <span>!</span><div><p>REMOVE CONNECTION</p><h2 id="mcp-delete-title">删除 {pendingDelete.name}？</h2><small>这会从项目配置中移除服务。全局配置和其他项目不会受影响。</small>
          <div><button onClick={() => setPendingDelete(undefined)} disabled={saving}>取消</button><button className="danger" onClick={() => void remove()} disabled={saving}>{saving ? "正在删除…" : "删除服务"}</button></div>
        </div>
      </div>
    </div>}
  </section>;
}

function toFormDraft(service: ManagedMcpServer): FormDraft {
  const config = service.config;
  return "command" in config ? {
    name: service.name, transport: "stdio", enabled: service.enabled, command: config.command,
    args: config.args.join("\n"), env: recordLines(config.env), cwd: config.cwd ?? "", url: "", headers: "",
    timeoutMs: String(config.timeoutMs),
  } : {
    name: service.name, transport: "http", enabled: service.enabled, command: "", args: "", env: "", cwd: "",
    url: config.url, headers: recordLines(config.headers), timeoutMs: String(config.timeoutMs),
  };
}

function toServerDraft(draft: FormDraft): McpServerDraft {
  const common = { disabled: !draft.enabled, timeoutMs: Number(draft.timeoutMs) };
  const config: McpServerConfig = draft.transport === "stdio" ? {
    command: draft.command.trim(), args: nonblankLines(draft.args), env: parseRecordLines(draft.env),
    ...(draft.cwd.trim() === "" ? {} : { cwd: draft.cwd.trim() }), ...common,
  } : { url: draft.url.trim(), headers: parseRecordLines(draft.headers), ...common };
  return { name: draft.name.trim(), config };
}

function nonblankLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function parseRecordLines(value: string): Record<string, string> {
  return Object.fromEntries(nonblankLines(value).map((line) => {
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`配置项“${line}”必须使用 KEY=VALUE 格式`);
    return [line.slice(0, separator).trim(), line.slice(separator + 1)];
  }));
}

function recordLines(value: Record<string, string>): string {
  return Object.entries(value).map(([key, item]) => `${key}=${item}`).join("\n");
}

function commandSummary(config: McpServerConfig): string {
  return "command" in config ? [config.command, ...config.args].join(" ") : "";
}

function urlSummary(config: McpServerConfig): string {
  return "url" in config ? config.url : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
