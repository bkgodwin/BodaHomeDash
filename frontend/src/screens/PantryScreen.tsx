import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../api";
import { Modal } from "../components/Modal";
import { ProductEntry } from "../components/ProductEntry";
import { Product } from "../types";

interface Props {
  refreshToken: number;
  onToast: (message: string) => void;
}

export function PantryScreen({ refreshToken, onToast }: Props) {
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Product | null>(null);
  const [adding, setAdding] = useState(false);
  const holdTimer = useRef<number>();

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

  const removeLot = async (
    product: Product,
    addToShopping: boolean = false
  ) => {
    const lot = product.lots[0];
    if (!lot) return;
    if (
      !confirm(
        `${addToShopping ? "Remove and add" : "Remove"} one batch of ${product.name}?`
      )
    )
      return;
    await api(
      `/pantry/lots/${lot.id}?add_to_shopping=${addToShopping}`,
      { method: "DELETE" }
    );
    setSelected(null);
    load();
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
              <button
                class={`pantry-row ${expirationClass(product.nearest_expiration)}`}
                onPointerDown={() => {
                  holdTimer.current = window.setTimeout(
                    () => removeLot(product),
                    700
                  );
                }}
                onPointerUp={() => window.clearTimeout(holdTimer.current)}
                onPointerMove={() => window.clearTimeout(holdTimer.current)}
                onClick={() => setSelected(product)}
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
              </button>
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
                  <span>Quantity {lot.quantity}</span>
                  <span>
                    {lot.expires_on
                      ? `Expires ${new Date(`${lot.expires_on}T12:00`).toLocaleDateString()}`
                      : "No expiration date"}
                  </span>
                </div>
              ))}
            </section>
            {selected.nutrition &&
              Object.keys(selected.nutrition).length > 0 && (
                <section>
                  <h3>Nutrition facts</h3>
                  <div class="nutrition-grid">
                    {Object.entries(selected.nutrition)
                      .filter(
                        ([key]) =>
                          [
                            "energy-kcal_100g",
                            "fat_100g",
                            "carbohydrates_100g",
                            "sugars_100g",
                            "proteins_100g",
                            "salt_100g"
                          ].includes(key)
                      )
                      .map(([key, value]) => (
                        <span>
                          <small>{key.replace("_100g", "").replace("-", " ")}</small>
                          <strong>{String(value)}</strong>
                        </span>
                      ))}
                  </div>
                </section>
              )}
            <div class="modal-actions">
              <button
                class="button secondary"
                onClick={() => removeLot(selected, true)}
              >
                Remove and add to shopping
              </button>
              <button class="button danger" onClick={() => removeLot(selected)}>
                Remove batch
              </button>
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
}
