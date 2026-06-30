import { useEffect, useState } from "preact/hooks";
import { api, jsonBody } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { TouchInput } from "../components/TouchInput";
import { Recipe, RecipeIngredient } from "../types";

interface Props {
  refreshToken: number;
  localDevice: boolean;
  onToast: (message: string) => void;
  onViewingChange: (viewing: boolean) => void;
}

export function RecipesScreen({
  refreshToken,
  localDevice,
  onToast,
  onViewingChange
}: Props) {
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"name" | "ingredient">("name");
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [selected, setSelected] = useState<Recipe | null>(null);
  const [editing, setEditing] = useState<Recipe | null | undefined>(undefined);
  const [deleteRecipe, setDeleteRecipe] = useState<Recipe | null>(null);
  const [checkedIngredients, setCheckedIngredients] = useState<number[]>([]);
  const [checkedSteps, setCheckedSteps] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);

  const load = async (search = query, mode = searchMode) => {
    setLoading(true);
    try {
      const result = await api<{ recipes: Recipe[]; offline: boolean }>(
        `/recipes/search?query=${encodeURIComponent(search)}&mode=${mode}`
      );
      setRecipes(result.recipes);
      setOffline(result.offline);
    } catch (error: any) {
      onToast(error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(
      () => load(query, searchMode),
      query ? 400 : 0
    );
    return () => window.clearTimeout(timer);
  }, [query, searchMode, refreshToken]);

  useEffect(() => {
    if (!selected) {
      onViewingChange(false);
      return;
    }
    setCheckedIngredients([]);
    setCheckedSteps([]);
    onViewingChange(true);
    return () => onViewingChange(false);
  }, [selected?.recipe_id]);

  const openRecipe = async (recipe: Recipe) => {
    try {
      const detail = await api<Recipe>(
        `/recipes/${encodeURIComponent(recipe.recipe_id)}`
      );
      setSelected(detail);
    } catch (error: any) {
      onToast(error.message);
    }
  };

  const favorite = async (recipe: Recipe) => {
    try {
      const updated = await api<Recipe>(
        `/recipes/${encodeURIComponent(recipe.recipe_id)}/favorite?favorite=${!recipe.favorite}`,
        { method: "PUT" }
      );
      setRecipes((items) =>
        items.map((item) => item.recipe_id === updated.recipe_id ? updated : item)
      );
      setSelected((current) =>
        current?.recipe_id === updated.recipe_id ? updated : current
      );
      onToast(updated.favorite ? "Recipe saved to favorites" : "Recipe removed from favorites");
    } catch (error: any) {
      onToast(error.message);
    }
  };

  if (selected) {
    const image = selected.image_data || selected.image_url;
    return (
      <main class="page-screen glass recipe-detail-screen">
        <header class="page-header recipe-detail-header">
          <button class="button secondary" onClick={() => setSelected(null)}>← Recipes</button>
          <div>
            <h1>{selected.title}</h1>
            <p>{[selected.category, selected.area].filter(Boolean).join(" · ") || "Custom recipe"}</p>
          </div>
          <div class="recipe-detail-actions">
            <button
              class={`favorite-button ${selected.favorite ? "active" : ""}`}
              onClick={() => favorite(selected)}
              aria-label={selected.favorite ? "Remove favorite" : "Add favorite"}
            >
              ★
            </button>
            {selected.custom && (
              <>
                <button class="button secondary" onClick={() => setEditing(selected)}>Edit</button>
                <button class="button danger" onClick={() => setDeleteRecipe(selected)}>Delete</button>
              </>
            )}
          </div>
        </header>
        <div class="recipe-detail-content">
          <aside class="recipe-hero-card">
            {image ? <img src={image} alt={selected.title} /> : <div class="recipe-image-placeholder">🍽</div>}
            <div>
              <strong>{selected.ingredients.length} ingredients</strong>
              <span>{selected.steps.length} steps</span>
              {localDevice && <small>Display will remain awake while this recipe is open.</small>}
            </div>
          </aside>
          <section class="recipe-checklist">
            <h2>Ingredients</h2>
            {selected.ingredients.map((ingredient, index) => (
              <article class={checkedIngredients.includes(index) ? "checked" : ""}>
                <label>
                  <input
                    type="checkbox"
                    checked={checkedIngredients.includes(index)}
                    onChange={() =>
                      setCheckedIngredients((values) =>
                        values.includes(index)
                          ? values.filter((value) => value !== index)
                          : [...values, index]
                      )
                    }
                  />
                  <span><strong>{ingredient.name}</strong><small>{ingredient.measure}</small></span>
                </label>
                <button
                  class="ingredient-cart"
                  onClick={async () => {
                    try {
                      await api("/shopping", {
                        method: "POST",
                        ...jsonBody({
                          name: [ingredient.measure, ingredient.name].filter(Boolean).join(" "),
                          quantity: 1
                        })
                      });
                      onToast(`${ingredient.name} added to shopping list`);
                    } catch (error: any) {
                      onToast(error.message);
                    }
                  }}
                  aria-label={`Add ${ingredient.name} to shopping list`}
                >
                  🛒
                </button>
              </article>
            ))}
          </section>
          <section class="recipe-checklist recipe-steps">
            <h2>Instructions</h2>
            {selected.steps.map((step, index) => (
              <label class={checkedSteps.includes(index) ? "checked" : ""}>
                <input
                  type="checkbox"
                  checked={checkedSteps.includes(index)}
                  onChange={() =>
                    setCheckedSteps((values) =>
                      values.includes(index)
                        ? values.filter((value) => value !== index)
                        : [...values, index]
                    )
                  }
                />
                <span><b>{index + 1}</b>{step}</span>
              </label>
            ))}
          </section>
        </div>
        {editing !== undefined && (
          <RecipeEditor
            recipe={editing}
            localDevice={localDevice}
            onError={onToast}
            onClose={() => setEditing(undefined)}
            onSaved={(updated) => {
              setEditing(undefined);
              setSelected(updated);
              load();
              onToast("Recipe saved");
            }}
          />
        )}
        {deleteRecipe && (
          <ConfirmDialog
            title="Delete custom recipe?"
            message={`Delete ${deleteRecipe.title}? This cannot be undone.`}
            confirmLabel="Delete recipe"
            cancelLabel="Keep recipe"
            onCancel={() => setDeleteRecipe(null)}
            onConfirm={async () => {
              await api(
                `/recipes/custom/${encodeURIComponent(deleteRecipe.recipe_id)}`,
                { method: "DELETE" }
              );
              setDeleteRecipe(null);
              setSelected(null);
              load();
              onToast("Custom recipe deleted");
            }}
          />
        )}
      </main>
    );
  }

  return (
    <main class={`page-screen glass recipes-screen ${localDevice ? "kiosk-recipes" : ""}`}>
      <header class="page-header">
        <div>
          <h1>Recipes</h1>
          <p>Search TheMealDB or open saved household recipes</p>
        </div>
        <button class="button primary" onClick={() => setEditing(null)}>+ Custom recipe</button>
      </header>
      <div class="recipe-search-bar">
        <div class="recipe-search-mode" role="group" aria-label="Recipe search type">
          <button
            class={searchMode === "name" ? "active" : ""}
            onClick={() => setSearchMode("name")}
          >
            Recipe name
          </button>
          <button
            class={searchMode === "ingredient" ? "active" : ""}
            onClick={() => setSearchMode("ingredient")}
          >
            Ingredients
          </button>
        </div>
        <input
          type="search"
          value={query}
          placeholder={
            searchMode === "name"
              ? "Search recipes by name"
              : "Chicken, garlic, rice"
          }
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        {query && <button onClick={() => setQuery("")}>Clear</button>}
      </div>
      {searchMode === "ingredient" && (
        <p class="recipe-search-hint">
          Separate multiple ingredients with commas. Results must contain every ingredient.
        </p>
      )}
      {offline && <p class="recipe-offline">TheMealDB is offline. Showing cached favorites and custom recipes.</p>}
      <div class="recipe-grid">
        {loading && <p class="empty large">Finding recipes…</p>}
        {!loading && recipes.length === 0 && (
          <p class="empty large">
            {query ? "No matching recipes found." : "Search for a recipe or add your own."}
          </p>
        )}
        {!loading && recipes.map((recipe) => {
          const image = recipe.image_data || recipe.image_url;
          return (
            <article class="recipe-card" onClick={() => openRecipe(recipe)}>
              {image ? <img src={image} alt="" loading="lazy" /> : <div class="recipe-image-placeholder">🍽</div>}
              <div>
                <small>{[recipe.category, recipe.area].filter(Boolean).join(" · ") || "Custom"}</small>
                <strong>{recipe.title}</strong>
                <span>{recipe.ingredients.length} ingredients</span>
                <ul class="recipe-card-ingredients">
                  {recipe.ingredients.slice(0, 8).map((ingredient) => (
                    <li>
                      {ingredient.measure && <b>{ingredient.measure}</b>}
                      {ingredient.name}
                    </li>
                  ))}
                  {recipe.ingredients.length > 8 && (
                    <li class="more">+{recipe.ingredients.length - 8} more</li>
                  )}
                </ul>
              </div>
              <button
                class={`favorite-button ${recipe.favorite ? "active" : ""}`}
                onClick={(event) => {
                  event.stopPropagation();
                  favorite(recipe);
                }}
                aria-label={recipe.favorite ? "Remove favorite" : "Add favorite"}
              >
                ★
              </button>
            </article>
          );
        })}
      </div>
      {editing !== undefined && (
        <RecipeEditor
          recipe={editing}
          localDevice={localDevice}
          onError={onToast}
          onClose={() => setEditing(undefined)}
          onSaved={(updated) => {
            setEditing(undefined);
            load();
            openRecipe(updated);
            onToast("Custom recipe saved");
          }}
        />
      )}
    </main>
  );
}

function RecipeEditor({
  recipe,
  localDevice,
  onClose,
  onSaved,
  onError
}: {
  recipe: Recipe | null;
  localDevice: boolean;
  onClose: () => void;
  onSaved: (recipe: Recipe) => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState(recipe?.title || "");
  const [category, setCategory] = useState(recipe?.category || "");
  const [area, setArea] = useState(recipe?.area || "");
  const [imageData, setImageData] = useState(recipe?.image_data || "");
  const [ingredients, setIngredients] = useState<RecipeIngredient[]>(
    recipe?.ingredients?.length ? recipe.ingredients : [{ name: "", measure: "" }]
  );
  const [steps, setSteps] = useState<string[]>(
    recipe?.steps?.length ? recipe.steps : [""]
  );
  const [saving, setSaving] = useState(false);

  const updateIngredient = (index: number, field: keyof RecipeIngredient, value: string) =>
    setIngredients((items) =>
      items.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: value } : item
      )
    );

  return (
    <Modal title={recipe ? "Edit Custom Recipe" : "Add Custom Recipe"} onClose={onClose} wide>
      <div class="recipe-editor">
        <div class="recipe-editor-basics">
          <TouchInput label="Recipe name" value={title} onChange={setTitle} />
          <TouchInput label="Category" value={category} onChange={setCategory} />
          <TouchInput label="Cuisine or region" value={area} onChange={setArea} />
          {!localDevice && (
            <label class="recipe-image-input">
              <span>Dish photo</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                capture="environment"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (!file) return;
                  if (file.size > 15_000_000) {
                    onError("Recipe photos must be smaller than 15 MB");
                    return;
                  }
                  const url = URL.createObjectURL(file);
                  const image = new Image();
                  image.onload = () => {
                    const scale = Math.min(
                      1,
                      1200 / Math.max(image.naturalWidth, image.naturalHeight)
                    );
                    const canvas = document.createElement("canvas");
                    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
                    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
                    canvas.getContext("2d")?.drawImage(
                      image,
                      0,
                      0,
                      canvas.width,
                      canvas.height
                    );
                    setImageData(canvas.toDataURL("image/jpeg", 0.82));
                    URL.revokeObjectURL(url);
                  };
                  image.onerror = () => {
                    URL.revokeObjectURL(url);
                    onError("This photo format could not be read");
                  };
                  image.src = url;
                }}
              />
              <small>JPEG, PNG, or WebP · automatically optimized</small>
            </label>
          )}
          {imageData && (
            <img class="recipe-editor-image-preview" src={imageData} alt="Custom recipe preview" />
          )}
        </div>
        <section>
          <header><h3>Ingredients</h3><button onClick={() => setIngredients([...ingredients, { name: "", measure: "" }])}>+ Ingredient</button></header>
          <div class="recipe-editor-list">
            {ingredients.map((ingredient, index) => (
              <div class="recipe-editor-row ingredient">
                <TouchInput label={`Ingredient ${index + 1}`} value={ingredient.name} onChange={(value) => updateIngredient(index, "name", value)} />
                <TouchInput label="Amount" value={ingredient.measure} onChange={(value) => updateIngredient(index, "measure", value)} />
                <button
                  class="icon-button danger"
                  disabled={ingredients.length === 1}
                  onClick={() => setIngredients(ingredients.filter((_, itemIndex) => itemIndex !== index))}
                  aria-label="Remove ingredient"
                >×</button>
              </div>
            ))}
          </div>
        </section>
        <section>
          <header><h3>Instructions</h3><button onClick={() => setSteps([...steps, ""])}>+ Step</button></header>
          <div class="recipe-editor-list">
            {steps.map((step, index) => (
              <div class="recipe-editor-row step">
                <b>{index + 1}</b>
                <TouchInput label={`Step ${index + 1}`} value={step} multiline onChange={(value) => setSteps(steps.map((item, itemIndex) => itemIndex === index ? value : item))} />
                <button
                  class="icon-button danger"
                  disabled={steps.length === 1}
                  onClick={() => setSteps(steps.filter((_, itemIndex) => itemIndex !== index))}
                  aria-label="Remove step"
                >×</button>
              </div>
            ))}
          </div>
        </section>
        <button
          class="button primary full-width"
          disabled={saving || !title.trim() || !ingredients.some((item) => item.name.trim()) || !steps.some((step) => step.trim())}
          onClick={async () => {
            setSaving(true);
            try {
              const payload = {
                title,
                category,
                area,
                image_data: imageData,
                ingredients: ingredients.filter((item) => item.name.trim()),
                steps: steps.filter((step) => step.trim())
              };
              const updated = await api<Recipe>(
                recipe
                  ? `/recipes/custom/${encodeURIComponent(recipe.recipe_id)}`
                  : "/recipes/custom",
                {
                  method: recipe ? "PUT" : "POST",
                  ...jsonBody(payload)
                }
              );
              onSaved(updated);
            } catch (error: any) {
              onError(error.message);
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Saving…" : "Save recipe"}
        </button>
      </div>
    </Modal>
  );
}
