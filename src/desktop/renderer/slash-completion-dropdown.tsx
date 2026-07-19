import React from "react";
import type { SlashCandidate, SlashCompletion } from "../../ui/slash-completion.js";
import { matchRanges } from "../../ui/slash-completion.js";

const KIND_LABELS: Record<SlashCandidate["kind"], string> = {
  command: "命令",
  plugin: "插件",
  skill: "技能",
};

const KIND_CLASSES: Record<SlashCandidate["kind"], string> = {
  command: "slash-kind-command",
  plugin: "slash-kind-plugin",
  skill: "slash-kind-skill",
};

export function SlashCompletionDropdown({
  completion,
  onSelect,
  onDismiss,
}: {
  completion: SlashCompletion;
  onSelect(name: string): void;
  onDismiss(): void;
}): React.JSX.Element {
  const visible = completion.items.slice(
    completion.windowStart,
    completion.windowStart + 6,
  );

  return (
    <>
      <div className="slash-dropdown-backdrop" onClick={onDismiss} />
      <div className="slash-dropdown" role="listbox" aria-label="命令补全">
        <div className="slash-dropdown-header">
          <span>可用命令</span>
          <kbd>↑↓ 选择</kbd>
          <kbd>Tab 确认</kbd>
          <kbd>Esc 关闭</kbd>
        </div>
        <div className="slash-dropdown-list">
          {visible.map((item) => {
            const itemIndex = completion.items.indexOf(item);
            const selected = itemIndex === completion.selectedIndex;
            const ranges = matchRanges(item.name, completion.query);
            return (
              <button
                key={item.name}
                className={`slash-item${selected ? " slash-item-selected" : ""}`}
                role="option"
                aria-selected={selected}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(item.name);
                }}
              >
                <span className="slash-item-marker">
                  {selected ? "›" : " "}
                </span>
                <span className={KIND_CLASSES[item.kind]}>
                  {KIND_LABELS[item.kind]}
                </span>
                <span className="slash-item-name">
                  {highlightName(item.name, ranges)}
                </span>
                {item.description && (
                  <span className="slash-item-desc">{item.description}</span>
                )}
              </button>
            );
          })}
        </div>
        <div className="slash-dropdown-footer">
          {completion.items.length > 6 && (
            <span className="slash-count">
              {completion.selectedIndex + 1} / {completion.items.length}
            </span>
          )}
        </div>
      </div>
    </>
  );
}

function highlightName(
  name: string,
  ranges: Array<[number, number]>,
): React.JSX.Element {
  if (ranges.length === 0) return <>{name}</>;
  const parts: React.JSX.Element[] = [];
  let lastEnd = 0;
  for (const [start, end] of ranges) {
    if (start > lastEnd) {
      parts.push(
        <span key={`text-${lastEnd}`}>{name.slice(lastEnd, start)}</span>,
      );
    }
    parts.push(
      <mark key={`mark-${start}`}>{name.slice(start, end)}</mark>,
    );
    lastEnd = end;
  }
  if (lastEnd < name.length) {
    parts.push(
      <span key={`text-${lastEnd}`}>{name.slice(lastEnd)}</span>,
    );
  }
  return <>{parts}</>;
}
