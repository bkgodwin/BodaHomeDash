import { useEffect, useState } from "preact/hooks";
import { api, jsonBody } from "../api";
import { ProductEntry } from "../components/ProductEntry";
import { ShoppingItem } from "../types";

interface Props {
  refreshToken: number;
  onToast: (message: string) => void;
}

export function ShoppingScreen({ refreshToken, onToast }: Props) {
  const [items, setItems] = useState<ShoppingItem[]>([]);
  const [adding, setAdding] = useState(false);
  const load = () =>
    api<ShoppingItem[]>("/shopping")
      .then(setItems)
      .catch((error) => onToast(error.message));
  useEffect(() => {
    load();
  }, [refreshToken]);

  const patch = async (item: ShoppingItem, values: object) => {
    const updated = await api<ShoppingItem>(`/shopping/${item.id}`, {
      method: "PATCH",
      ...jsonBody(values)
    });
    setItems((current) =>
      current.map((candidate) => (candidate.id === item.id ? updated : candidate))
    );
  };

  return (
    <main class="page-screen glass">
      <header class="page-header">
        <div>
          <h1>Shopping List</h1>
          <p>{items.filter((item) => !item.purchased).length} remaining</p>
        </div>
        <div class="header-actions">
          <button
            class="button secondary"
            disabled={!items.some((item) => item.purchased)}
            onClick={async () => {
              if (confirm("Clear all purchased items?")) {
                await api("/shopping", { method: "DELETE" });
                load();
              }
            }}
          >
            Clear purchased
          </button>
          <button class="button primary" onClick={() => setAdding(true)}>
            + Add item
          </button>
        </div>
      </header>
      <div class="large-list">
        {items.length === 0 && <p class="empty large">The shopping list is empty.</p>}
        {items.map((item) => (
          <article class={`shopping-row ${item.purchased ? "purchased" : ""}`}>
            <button
              class="purchase-toggle"
              onClick={() => patch(item, { purchased: !item.purchased })}
              aria-label={`Mark ${item.name} ${item.purchased ? "not purchased" : "purchased"}`}
            >
              {item.purchased ? "✓" : ""}
            </button>
            <button
              class="shopping-name"
              onClick={() => patch(item, { purchased: !item.purchased })}
            >
              {item.name}
            </button>
            <div class="quantity-control compact">
              <button
                onClick={() => patch(item, { quantity: Math.max(1, item.quantity - 1) })}
              >
                −
              </button>
              <strong>{item.quantity}</strong>
              <button onClick={() => patch(item, { quantity: item.quantity + 1 })}>
                +
              </button>
            </div>
            <button
              class="icon-button danger-text"
              onClick={async () => {
                await api(`/shopping/${item.id}`, { method: "DELETE" });
                load();
              }}
              aria-label={`Delete ${item.name}`}
            >
              ×
            </button>
          </article>
        ))}
      </div>
      {adding && (
        <ProductEntry
          destination="shopping"
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            load();
          }}
        />
      )}
    </main>
  );
}
