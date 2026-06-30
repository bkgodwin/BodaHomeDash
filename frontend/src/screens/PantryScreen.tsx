import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";
import { Modal } from "../components/Modal";
import { ProductEntry } from "../components/ProductEntry";
import { Product } from "../types";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { TouchInput } from "../components/TouchInput";
import { nutritionFacts } from "../nutrition";

interface Props {
  refreshToken: number;
  onToast: (message: string) => void;
}

export function PantryScreen({ refreshToken, onToast }: Props) {
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Product | null>(null);
  const [adding, setAdding] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<{
    product: Product;
    addToShopping: boolean;
  } | null>(null);
  const [selectedLots, setSelectedLots] = useState<number[]>([]);
  const [editingLot, setEditingLot] = useState<number | null>(null);
  const [lotNotes, setLotNotes] = useState("");

  const load = () =>
    api<Product[]>("/pantry")
      .then(setProducts)
      .catch((error) => onToast(error.message));

  useEffect(() => {
    load();
  }, [refreshToken]);

  const filtered = useMemo(() => {
    const needle = search.toLowerCase();
    return products.filter(
      (product) =>
        product.name.toLowerCase().includes(needle) ||
        product.brand.toLowerCase().includes(needle)
    );
  }, [products, search]);

  const jumpTo = (letter: string) => {
    document
      .getElementById(`pantry-${letter}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const removeLots = async (
    product: Product,
    addToShopping: boolean = false
  ) => {
    if (!selectedLots.length) return;
    await api("/pantry/lots/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lot_ids: selectedLots,
        add_to_shopping: addToShopping
      })
    });
    setSelected(null);
    setSelectedLots([]);
    load();
  };

  const consumeOne = async (product: Product) => {
    const result = await api<{ quantity: number }>(
      `/pantry/${product.id}/consume`,
      { method: "POST" }
    );
    setProducts((items) =>
      result.quantity
        ? items.map((item) =>
            item.id === product.id
              ? { ...item, total_quantity: result.quantity }
              : item
          )
        : items.filter((item) => item.id !== product.id)
    );
    onToast(`Used one ${product.name}`);
  };

  const expirationClass = (value: string | null) => {
    if (!value) return "";
    const days = Math.floor(
      (new Date(`${value}T12:00`).getTime() - Date.now()) / 86400000
    );
    return days < 0 ? "expired" : days <= 7 ? "expiring" : "";
  };

  return (
    <main class="page-screen glass">
      <header class="page-header">
        <div>
          <h1>Pantry</h1>
          <p>{products.length} products in stock</p>
        </div>
        <button class="button primary" onClick={() => setAdding(true)}>
          + Add product
        </button>
      </header>
      <div class="pantry-tools">
        <input
          class="search-box"
          type="search"
          placeholder="Search pantry"
          value={search}
          onInput={(event) =>
            setSearch((event.currentTarget as HTMLInputElement).value)
          }
        />
        <div class="alphabet-strip">
          {"ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => (
            <button onClick={() => jumpTo(letter)}>{letter}</button>
          ))}
        </div>
      </div>
      <div class="pantry-list">
        {filtered.length === 0 && <p class="empty large">No matching products.</p>}
        {filtered.map((product, index) => {
          const firstLetter = product.name[0]?.toUpperCase() || "#";
          const previous = filtered[index - 1]?.name[0]?.toUpperCase();
          return (
            <>
              {firstLetter !== previous && (
                <h2 id={`pantry-${firstLetter}`} class="letter-heading">
                  {firstLetter}
                </h2>
              )}
              <div
                class={`pantry-row ${expirationClass(product.nearest_expiration)}`}
                role="button"
                tabIndex={0}
                onClick={() => {
                  setSelectedLots([]);
                  setSelected(product);
                }}
              >
                <span class="product-avatar">
                  {product.image_url ? (
                    <img src={product.image_url} alt="" loading="lazy" />
                  ) : (
                    product.name[0]
                  )}
                </span>
                <span class="product-summary">
                  <strong>{product.name}</strong>
                  <small>
                    {[product.brand, product.package_size]
                      .filter(Boolean)
                      .join(" · ") || "Manually entered"}
                  </small>
                </span>
                <span class="stock-count">×{product.total_quantity}</span>
                <span class="expiration-label">
                  {product.nearest_expiration
                    ? `Nearest: ${new Date(`${product.nearest_expiration}T12:00`).toLocaleDateString()}`
                    : "No expiration"}
                </span>
                <button
                  class="pantry-minus"
                  aria-label={`Use one ${product.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    consumeOne(product).catch((error) => onToast(error.message));
                  }}
                >
                  −
                </button>
              </div>
            </>
          );
        })}
      </div>

      {adding && (
        <ProductEntry
          destination="pantry"
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            load();
          }}
        />
      )}

      {selected && (
        <Modal title={selected.name} onClose={() => setSelected(null)} wide>
          <div class="product-detail">
            <div>
              <p>
                <strong>Brand:</strong> {selected.brand || "Not recorded"}
              </p>
              <p>
                <strong>Category:</strong> {selected.category || "Not recorded"}
              </p>
              <p>
                <strong>Package:</strong>{" "}
                {selected.package_size || "Not recorded"}
              </p>
              <p>
                <strong>Barcode:</strong>{" "}
                {typeof selected.barcodes === "string"
                  ? selected.barcodes
                  : "None"}
              </p>
            </div>
            <section>
              <h3>Inventory batches</h3>
              {selected.lots.map((lot) => (
                <div class={`lot-row ${expirationClass(lot.expires_on)}`}>
                  <label class="lot-selector">
                    <input
                      type="checkbox"
                      checked={selectedLots.includes(lot.id)}
                      onChange={() =>
                        setSelectedLots((ids) =>
                          ids.includes(lot.id)
                            ? ids.filter((id) => id !== lot.id)
                            : [...ids, lot.id]
                        )
                      }
                    />
                    <span>
                      <strong>Quantity {lot.quantity}</strong>
                      <small>
                        {lot.expires_on
                          ? `Expires ${new Date(`${lot.expires_on}T12:00`).toLocaleDateString()}`
                          : "No expiration date"}
                      </small>
                      <small>
                        Added {new Date(lot.added_at).toLocaleDateString()}
                      </small>
                      {lot.notes && <em>{lot.notes}</em>}
                    </span>
                  </label>
                  <button
                    class="button secondary lot-note-button"
                    onClick={() => {
                      setEditingLot(lot.id);
                      setLotNotes(lot.notes || "");
                    }}
                  >
                    {lot.notes ? "Edit notes" : "Add notes"}
                  </button>
                </div>
              ))}
            </section>
            {selected.nutrition &&
              Object.keys(selected.nutrition).length > 0 && (
                <section>
                  <h3>Nutrition facts</h3>
                  <div class="nutrition-grid">
                    {nutritionFacts(selected.nutrition).map((fact) => (
                        <span>
                          <small>{fact.label}</small>
                          <strong>{fact.value}</strong>
                          <em>{fact.basis}</em>
                        </span>
                    ))}
                  </div>
                </section>
              )}
            {selected.ingredients && (
              <section class="product-copy">
                <h3>Ingredients</h3>
                <p>{selected.ingredients}</p>
              </section>
            )}
            {selected.allergens && (
              <section class="product-copy">
                <h3>Allergens</h3>
                <p>{selected.allergens}</p>
              </section>
            )}
            {selected.notes && (
              <section class="product-copy">
                <h3>Product notes</h3>
                <p>{selected.notes}</p>
              </section>
            )}
            <div class="modal-actions">
              <button
                class="button secondary"
                disabled={!selectedLots.length}
                onClick={() =>
                  setPendingRemoval({
                    product: selected,
                    addToShopping: true
                  })
                }
              >
                Remove and add to shopping
              </button>
              <button
                class="button danger"
                disabled={!selectedLots.length}
                onClick={() =>
                  setPendingRemoval({
                    product: selected,
                    addToShopping: false
                  })
                }
              >
                Remove batch
              </button>
            </div>
          </div>
        </Modal>
      )}
      {pendingRemoval && (
        <ConfirmDialog
          title="Remove pantry batch?"
          message={`${
            pendingRemoval.addToShopping ? "Remove and add" : "Remove"
          } ${selectedLots.length} selected batch${selectedLots.length === 1 ? "" : "es"} of ${pendingRemoval.product.name}?`}
          confirmLabel={
            pendingRemoval.addToShopping
              ? "Confirm and add"
              : "Confirm removal"
          }
          cancelLabel="No, keep it"
          onCancel={() => setPendingRemoval(null)}
          onConfirm={async () => {
            await removeLots(
              pendingRemoval.product,
              pendingRemoval.addToShopping
            );
            setPendingRemoval(null);
          }}
        />
      )}
      {editingLot !== null && (
        <Modal title="Batch notes" onClose={() => setEditingLot(null)}>
          <TouchInput
            label="Notes"
            value={lotNotes}
            multiline
            onChange={setLotNotes}
          />
          <button
            class="button primary full-width"
            onClick={async () => {
              const product = await api<Product>(`/pantry/lots/${editingLot}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ notes: lotNotes })
              });
              setSelected(product);
              setEditingLot(null);
              load();
            }}
          >
            Save notes
          </button>
        </Modal>
      )}
    </main>
  );
}
