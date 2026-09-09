import React, { useRef, useState } from 'react';
import { useTabs } from './tabs.js';
import type { Tab } from './tabs.js';
import { IconChat, IconClose, IconFile, IconPreview, IconTasks, IconTerminal } from './Icons.js';

/** A small glyph per tab kind, so the strip is scannable without reading. */
function TabIcon({ tab }: { tab: Tab }) {
  const size = 13;
  switch (tab.kind) {
    case 'terminal':
      return <IconTerminal size={size} />;
    case 'preview':
      return <IconPreview size={size} />;
    case 'chat':
      return <IconChat size={size} />;
    case 'tasks':
    case 'inbox':
      return <IconTasks size={size} />;
    case 'editor':
    case 'diff':
      return <IconFile size={size} />;
    default:
      return null;
  }
}

export function TabStrip() {
  const { tabs, activeId, activate, close, move, setDirty } = useTabs();
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  if (!tabs.length) return null;

  const onDrop = () => {
    if (dragIndex !== null && dropIndex !== null) move(dragIndex, dropIndex);
    setDragIndex(null);
    setDropIndex(null);
  };

  return (
    <div className="tabstrip" role="tablist" aria-label="Open tabs" ref={stripRef}>
      {tabs.map((tab, index) => (
        <div
          key={tab.id}
          role="tab"
          tabIndex={tab.id === activeId ? 0 : -1}
          aria-selected={tab.id === activeId}
          className="tab"
          data-transient={tab.transient}
          data-dragging={dragIndex === index}
          data-drop-target={dropIndex === index && dragIndex !== index}
          title={tab.target ?? tab.title}
          draggable
          onDragStart={() => setDragIndex(index)}
          onDragOver={(event) => {
            event.preventDefault();
            setDropIndex(index);
          }}
          onDrop={onDrop}
          onDragEnd={onDrop}
          onClick={() => activate(tab.id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              activate(tab.id);
            }
          }}
          // Middle-click closes, the same as every browser.
          onAuxClick={(event) => {
            if (event.button === 1) {
              event.preventDefault();
              close(tab.id);
            }
          }}
        >
          <TabIcon tab={tab} />
          <span className="tab__label">{tab.title}</span>

          {tab.dirty ? (
            <span
              className="tab__dirty"
              title="Unsaved changes"
              aria-label="Unsaved changes"
              onClick={(event) => {
                event.stopPropagation();
                // Clicking the dot is a discard: the editor re-reads from disk.
                setDirty(tab.id, false);
              }}
            />
          ) : (
            <button
              type="button"
              className="tab__close"
              aria-label={`Close ${tab.title}`}
              onClick={(event) => {
                event.stopPropagation();
                close(tab.id);
              }}
            >
              <IconClose size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
