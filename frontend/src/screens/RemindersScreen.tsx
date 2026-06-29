import { useEffect, useState } from "preact/hooks";
import { api, jsonBody } from "../api";
import { Modal } from "../components/Modal";
import { TouchKeyboard } from "../components/TouchKeyboard";
import { Reminder } from "../types";

interface Props {
  refreshToken: number;
  onToast: (message: string) => void;
}

export function RemindersScreen({ refreshToken, onToast }: Props) {
  const [items, setItems] = useState<Reminder[]>([]);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const load = () =>
    api<Reminder[]>("/reminders")
      .then(setItems)
      .catch((error) => onToast(error.message));
  useEffect(() => {
    load();
  }, [refreshToken]);

  const patch = async (item: Reminder) => {
    const updated = await api<Reminder>(`/reminders/${item.id}`, {
      method: "PATCH",
      ...jsonBody({ completed: !item.completed })
    });
    setItems((current) =>
      current.map((candidate) => (candidate.id === item.id ? updated : candidate))
    );
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
          <article class={`reminder-row ${item.completed ? "completed" : ""}`}>
            <button class="purchase-toggle" onClick={() => patch(item)}>
              {item.completed ? "✓" : ""}
            </button>
            <button class="reminder-name" onClick={() => patch(item)}>
              {item.text}
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
          <div class="entry-preview">{text || "Type a reminder…"}</div>
          <TouchKeyboard
            value={text}
            onChange={setText}
            onConfirm={async () => {
              if (!text.trim()) return;
              await api("/reminders", {
                method: "POST",
                ...jsonBody({ text })
              });
              setText("");
              setAdding(false);
              load();
            }}
          />
        </Modal>
      )}
    </main>
  );
}
