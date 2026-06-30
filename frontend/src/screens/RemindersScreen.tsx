import { useEffect, useRef, useState } from "preact/hooks";
import { api, jsonBody } from "../api";
import { Modal } from "../components/Modal";
import { TouchKeyboard } from "../components/TouchKeyboard";
import { onScreenKeyboardEnabled } from "../inputPreferences";
import { Reminder } from "../types";

interface Props {
  refreshToken: number;
  onToast: (message: string) => void;
}

export function RemindersScreen({ refreshToken, onToast }: Props) {
  const [items, setItems] = useState<Reminder[]>([]);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemsRef = useRef<Reminder[]>([]);
  const draggingRef = useRef<number | null>(null);
  itemsRef.current = items;
  const load = () =>
    api<Reminder[]>("/reminders")
      .then(setItems)
      .catch((error) => onToast(error.message));
  useEffect(() => {
    load();
  }, [refreshToken]);

  const patch = async (item: Reminder, values: Record<string, boolean>) => {
    const updated = await api<Reminder>(`/reminders/${item.id}`, {
      method: "PATCH",
      ...jsonBody(values)
    });
    setItems((current) =>
      current.map((candidate) => (candidate.id === item.id ? updated : candidate))
    );
    if ("completed" in values) load();
  };

  const move = (sourceId: number, targetId: number) => {
    if (sourceId === targetId) return;
    setItems((current) => {
      const source = current.findIndex((item) => item.id === sourceId);
      const target = current.findIndex((item) => item.id === targetId);
      if (source < 0 || target < 0) return current;
      const next = [...current];
      const [item] = next.splice(source, 1);
      next.splice(target, 0, item);
      return next;
    });
  };

  const saveOrder = async (ordered = itemsRef.current) => {
    const updated = await api<Reminder[]>("/reminders/reorder", {
      method: "POST",
      ...jsonBody({ item_ids: ordered.map((item) => item.id) })
    });
    setItems(updated);
  };

  return (
    <main class="page-screen glass">
      <header class="page-header">
        <div>
          <h1>Reminders</h1>
          <p>{items.filter((item) => !item.completed).length} unfinished</p>
        </div>
        <button class="button primary" onClick={() => setAdding(true)}>
          + Add reminder
        </button>
      </header>
      <div class="large-list">
        {items.length === 0 && <p class="empty large">No reminders yet.</p>}
        {items.map((item) => (
          <article
            class={`reminder-row ${item.completed ? "completed" : ""} ${item.high_priority ? "high-priority" : ""} ${dragging === item.id ? "dragging" : ""}`}
            data-reminder-id={item.id}
            onDragOver={(event) => {
              event.preventDefault();
              if (draggingRef.current != null) move(draggingRef.current, item.id);
            }}
            onDrop={(event) => {
              event.preventDefault();
              draggingRef.current = null;
              setDragging(null);
              window.setTimeout(() => saveOrder(), 0);
            }}
          >
            <button
              class="reminder-drag-handle"
              draggable
              aria-label={`Reorder ${item.text}`}
              onDragStart={() => {
                draggingRef.current = item.id;
                setDragging(item.id);
              }}
              onDragEnd={() => {
                draggingRef.current = null;
                setDragging(null);
                saveOrder();
              }}
              onPointerDown={(event) => {
                draggingRef.current = item.id;
                setDragging(item.id);
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (draggingRef.current !== item.id) return;
                const target = document
                  .elementFromPoint(event.clientX, event.clientY)
                  ?.closest<HTMLElement>("[data-reminder-id]");
                if (target) move(item.id, Number(target.dataset.reminderId));
              }}
              onPointerUp={() => {
                draggingRef.current = null;
                setDragging(null);
                window.setTimeout(() => saveOrder(), 0);
              }}
            >
              ☰
            </button>
            <button class="purchase-toggle" onClick={() => patch(item, { completed: !item.completed })}>
              {item.completed ? "✓" : ""}
            </button>
            <button class="reminder-name" onClick={() => patch(item, { completed: !item.completed })}>
              {item.text}
            </button>
            <button
              class={`priority-button ${item.high_priority ? "active" : ""}`}
              aria-label={item.high_priority ? "Remove high priority" : "Mark high priority"}
              aria-pressed={Boolean(item.high_priority)}
              onClick={() => patch(item, { high_priority: !item.high_priority })}
            >
              !
            </button>
            <button
              class="icon-button danger-text"
              onClick={async () => {
                await api(`/reminders/${item.id}`, { method: "DELETE" });
                load();
              }}
            >
              ×
            </button>
          </article>
        ))}
      </div>
      {adding && (
        <Modal title="Add Reminder" onClose={() => setAdding(false)}>
          <input
            ref={inputRef}
            class="entry-native-input"
            value={text}
            placeholder="Type a reminder…"
            autofocus
            onInput={(event) => setText(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") saveReminder();
            }}
          />
          {onScreenKeyboardEnabled.value && (
            <TouchKeyboard
              value={text}
              onChange={setText}
              targetRef={inputRef}
              onConfirm={saveReminder}
            />
          )}
        </Modal>
      )}
    </main>
  );

  async function saveReminder() {
    if (!text.trim()) return;
    await api("/reminders", {
      method: "POST",
      ...jsonBody({ text })
    });
    setText("");
    setAdding(false);
    load();
  }
}
