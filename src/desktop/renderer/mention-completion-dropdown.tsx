import React from "react";
import type { MentionCompletion } from "../../ui/mention-completion.js";

function highlightPath(
  path: string,
  query: string,
): React.JSX.Element {
  if (query.length === 0) return <>{path}</>;
  const normalizedPath = path.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  const ranges: Array<[number, number]> = [];
  let start = 0;
  while (start < normalizedPath.length) {
    const index = normalizedPath.indexOf(normalizedQuery, start);
    if (index < 0) break;
    ranges.push([index, index + normalizedQuery.length]);
    start = index + normalizedQuery.length;
  }
  if (ranges.length === 0) return <>{path}</>;
  const parts: React.JSX.Element[] = [];
  let lastEnd = 0;
  for (const [rangeStart, rangeEnd] of ranges) {
    if (rangeStart > lastEnd) {
      parts.push(
        <span key={`text-${lastEnd}`}>{path.slice(lastEnd, rangeStart)}</span>,
      );
    }
    parts.push(
      <mark key={`mark-${rangeStart}`}>{path.slice(rangeStart, rangeEnd)}</mark>,
    );
    lastEnd = rangeEnd;
  }
  if (lastEnd < path.length) {
    parts.push(
      <span key={`text-${lastEnd}`}>{path.slice(lastEnd)}</span>,
    );
  }
  return <>{parts}</>;
}

export function MentionCompletionDropdown({
  completion,
  onSelect,
  onDismiss,
}: {
  completion: MentionCompletion;
  onSelect(path: string): void;
  onDismiss(): void;
}): React.JSX.Element {
  const visible = completion.items.slice(
    completion.windowStart,
    completion.windowStart + 6,
  );

  return (
    <>
      <div className="mention-dropdown-backdrop" onClick={onDismiss} />
      <div className="mention-dropdown" role="listbox" aria-label="文件补全">
        <div className="mention-dropdown-header">
          <span>项目文件</span>
          <kbd>↑↓ 选择</kbd>
          <kbd>Tab 确认</kbd>
          <kbd>Esc 关闭</kbd>
        </div>
        <div className="mention-dropdown-list">
          {visible.map((path) => {
            const itemIndex = completion.items.indexOf(path);
            const selected = itemIndex === completion.selectedIndex;
            return (
              <button
                key={path}
                className={`mention-item${selected ? " mention-item-selected" : ""}`}
                role="option"
                aria-selected={selected}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(path);
                }}
              >
                <span className="mention-item-marker">
                  {selected ? "›" : " "}
                </span>
                <span className="mention-item-icon">📄</span>
                <span className="mention-item-path">
                  {highlightPath(path, completion.query)}
                </span>
              </button>
            );
          })}
        </div>
        <div className="mention-dropdown-footer">
          {completion.items.length > 6 && (
            <span className="mention-count">
              {completion.selectedIndex + 1} / {completion.items.length}
            </span>
          )}
        </div>
      </div>
    </>
  );
}
