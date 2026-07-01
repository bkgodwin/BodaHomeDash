import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, jsonBody } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { TouchKeyboard } from "../components/TouchKeyboard";
import { onScreenKeyboardEnabled } from "../inputPreferences";
import {
  CalendarData,
  CalendarEvent,
  HouseholdMember,
  PlannerChore,
  PlannerMeal,
  PlannerNote,
  PlannerWeek,
  Recipe,
  Weather
} from "../types";
import { roundTemperature, weatherKind } from "../weatherPresentation";
import { PLANNER_PASTELS } from "../plannerPalette";

interface Props {
  refreshToken: number;
  onToast: (message: string) => void;
  onOpenRecipe: (recipeId: string) => void;
}

type DragPayload =
  | { kind: "meal"; meal: PlannerMeal }
  | { kind: "chore"; chore: PlannerChore }
  | {
      kind: "member";
      member: HouseholdMember;
      sourceChoreId: number | null;
    };

const DAY_MS = 86_400_000;

function localDate(value = new Date()): string {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0")
  ].join("-");
}

function dateAtNoon(value: string): Date {
  return new Date(`${value}T12:00:00`);
}

function sunday(value = new Date()): string {
  const result = new Date(value);
  result.setHours(12, 0, 0, 0);
  result.setDate(result.getDate() - result.getDay());
  return localDate(result);
}

function addDays(value: string, days: number): string {
  const result = dateAtNoon(value);
  result.setDate(result.getDate() + days);
  return localDate(result);
}

function weatherSymbol(code: number): string {
  switch (weatherKind(code)) {
    case "storm":
      return "⛈";
    case "rain":
      return "🌧";
    case "snow":
      return "❄";
    case "fog":
      return "🌫";
    case "cloud":
      return "☁";
    default:
      return "☀";
  }
}

function eventFallsOn(event: CalendarEvent, day: string): boolean {
  const start = dateAtNoon(day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + DAY_MS);
  return new Date(event.starts_at) < end && new Date(event.ends_at) > start;
}

export function WeekPlannerScreen({
  refreshToken,
  onToast,
  onOpenRecipe
}: Props) {
  const [weekStart, setWeekStart] = useState(() => sunday());
  const [planner, setPlanner] = useState<PlannerWeek | null>(null);
  const [calendar, setCalendar] = useState<CalendarData>({
    events: [],
    holidays: [],
    expirations: []
  });
  const [weather, setWeather] = useState<Weather | null>(null);
  const [members, setMembers] = useState<HouseholdMember[]>([]);
  const [mealDate, setMealDate] = useState<string | null>(null);
  const [choreDate, setChoreDate] = useState<string | null>(null);
  const [noteDate, setNoteDate] = useState<string | null>(null);
  const [deleteChore, setDeleteChore] = useState<PlannerChore | null>(null);
  const [drag, setDrag] = useState<{
    payload: DragPayload;
    x: number;
    y: number;
  } | null>(null);
  const weekScroller = useRef<HTMLDivElement>(null);
  const positionedWeek = useRef("");
  const suppressMealClick = useRef(false);

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)),
    [weekStart]
  );

  const load = async () => {
    const end = addDays(weekStart, 7);
    try {
      const [plan, calendarData, forecast, household] = await Promise.all([
        api<PlannerWeek>(`/planner/week?start=${weekStart}`),
        api<CalendarData>(`/calendar?start=${weekStart}&end=${end}`),
        api<Weather | null>("/weather"),
        api<HouseholdMember[]>("/household/members")
      ]);
      setPlanner(plan);
      setCalendar(calendarData);
      setWeather(forecast);
      setMembers(household);
    } catch (error: any) {
      onToast(error.message);
    }
  };

  useEffect(() => {
    load();
  }, [weekStart, refreshToken]);

  useEffect(() => {
    if (!planner || positionedWeek.current === weekStart) return;
    positionedWeek.current = weekStart;
    window.requestAnimationFrame(() => {
      const scroller = weekScroller.current;
      if (!scroller) return;
      const today = localDate();
      if (!days.includes(today)) {
        scroller.scrollLeft = 0;
        return;
      }
      const weekday = dateAtNoon(today).getDay();
      if (weekday === 0) scroller.scrollLeft = 0;
      else if (weekday === 6) scroller.scrollLeft = scroller.scrollWidth;
      else {
        const target = scroller.querySelector<HTMLElement>(
          `[data-planner-date="${today}"]`
        );
        if (target) {
          scroller.scrollLeft =
            target.offsetLeft -
            scroller.offsetLeft -
            (scroller.clientWidth - target.clientWidth) / 2;
        }
      }
    });
  }, [planner?.start, weekStart]);

  const updateMembers = async (chore: PlannerChore, memberIds: number[]) => {
    await api(`/planner/chores/${chore.id}/members`, {
      method: "PUT",
      ...jsonBody({ member_ids: [...new Set(memberIds)] })
    });
    await load();
  };

  const finishDrag = async (
    payload: DragPayload,
    x: number,
    y: number
  ) => {
    const target = document.elementFromPoint(x, y) as HTMLElement | null;
    try {
      if (payload.kind === "meal") {
        const day = target?.closest<HTMLElement>("[data-planner-date]")?.dataset
          .plannerDate;
        if (!day) return;
        const targetMeal = target?.closest<HTMLElement>("[data-meal-id]");
        const dayMeals =
          planner?.meals
            .filter((item) => item.planned_date === day)
            .sort((left, right) => left.position - right.position) || [];
        let position = targetMeal
          ? dayMeals.findIndex(
              (item) => item.id === Number(targetMeal.dataset.mealId)
            )
          : dayMeals.length;
        if (position < 0) position = dayMeals.length;
        if (day === payload.meal.planned_date) {
          const oldPosition = dayMeals.findIndex((item) => item.id === payload.meal.id);
          if (oldPosition >= 0 && oldPosition < position) position -= 1;
          if (oldPosition === position) return;
        }
        await api(`/planner/meals/${payload.meal.id}/move`, {
          method: "PUT",
          ...jsonBody({ planned_date: day, position })
        });
        onToast(`Moved ${payload.meal.title}`);
        await load();
        return;
      }
      if (payload.kind === "chore") {
        const day = target?.closest<HTMLElement>("[data-planner-date]")?.dataset
          .plannerDate;
        if (!day || day === payload.chore.planned_date) return;
        await api(`/planner/chores/${payload.chore.id}/move`, {
          method: "PUT",
          ...jsonBody({ planned_date: day })
        });
        onToast(`Moved ${payload.chore.title} to ${dateAtNoon(day).toLocaleDateString([], { weekday: "long" })}`);
        await load();
        return;
      }
      const choreTarget = target?.closest<HTMLElement>("[data-chore-id]");
      if (choreTarget) {
        const chore = planner?.chores.find(
          (item) => item.id === Number(choreTarget.dataset.choreId)
        );
        if (chore && !chore.members.some((item) => item.id === payload.member.id)) {
          await updateMembers(chore, [
            ...chore.members.map((item) => item.id),
            payload.member.id
          ]);
          if (
            payload.sourceChoreId != null &&
            payload.sourceChoreId !== chore.id
          ) {
            const source = planner?.chores.find(
              (item) => item.id === payload.sourceChoreId
            );
            if (source) {
              await updateMembers(
                source,
                source.members
                  .filter((item) => item.id !== payload.member.id)
                  .map((item) => item.id)
              );
            }
          }
          onToast(`${payload.member.name} assigned to ${chore.title}`);
        }
      } else if (payload.sourceChoreId != null) {
        const source = planner?.chores.find(
          (item) => item.id === payload.sourceChoreId
        );
        if (source) {
          await updateMembers(
            source,
            source.members
              .filter((item) => item.id !== payload.member.id)
              .map((item) => item.id)
          );
          onToast(`${payload.member.name} removed from ${source.title}`);
        }
      }
    } catch (error: any) {
      onToast(error.message);
    }
  };

  const beginHold = (event: PointerEvent, payload: DragPayload) => {
    event.stopPropagation();
    const pointerId = event.pointerId;
    let active = false;
    let lastX = event.clientX;
    let lastY = event.clientY;
    const timer = window.setTimeout(() => {
      active = true;
      navigator.vibrate?.(30);
      setDrag({ payload, x: lastX, y: lastY });
    }, 1000);
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      lastX = moveEvent.clientX;
      lastY = moveEvent.clientY;
      if (active) {
        moveEvent.preventDefault();
        setDrag({ payload, x: lastX, y: lastY });
      } else if (
        Math.hypot(moveEvent.clientX - event.clientX, moveEvent.clientY - event.clientY) >
        12
      ) {
        window.clearTimeout(timer);
      }
    };
    const end = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      window.clearTimeout(timer);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", end, true);
      document.removeEventListener("pointercancel", end, true);
      if (active) {
        if (payload.kind === "meal") {
          suppressMealClick.current = true;
          window.setTimeout(() => (suppressMealClick.current = false), 220);
        }
        finishDrag(payload, endEvent.clientX, endEvent.clientY);
      }
      setDrag(null);
    };
    document.addEventListener("pointermove", move, { capture: true, passive: false });
    document.addEventListener("pointerup", end, true);
    document.addEventListener("pointercancel", end, true);
  };

  const weekLabel = `${dateAtNoon(weekStart).toLocaleDateString([], {
    month: "short",
    day: "numeric"
  })} – ${dateAtNoon(addDays(weekStart, 6)).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric"
  })}`;

  return (
    <main class="page-screen glass week-planner-screen">
      <header class="page-header week-planner-header">
        <div>
          <h1>Week Planner</h1>
          <p>{weekLabel}</p>
        </div>
        <div class="week-navigation">
          <button class="button secondary" onClick={() => setWeekStart(addDays(weekStart, -7))}>
            ←
          </button>
          <button class="button secondary" onClick={() => setWeekStart(sunday())}>
            This week
          </button>
          <button class="button secondary" onClick={() => setWeekStart(addDays(weekStart, 7))}>
            →
          </button>
        </div>
      </header>
      <div class="planner-member-tray" data-member-tray>
        <strong>Household</strong>
        {members.length === 0 && (
          <span class="hint">Add members in Settings → Household members</span>
        )}
        {members.map((member) => (
          <button
            class="planner-member-chip planner-hold-handle"
            style={{ "--member-color": member.color }}
            onPointerDown={(event) =>
              beginHold(event as unknown as PointerEvent, {
                kind: "member",
                member,
                sourceChoreId: null
              })
            }
            title="Hold for one second, then drag onto a chore"
          >
            {member.name}
          </button>
        ))}
        <small>Hold and drag people onto chores</small>
      </div>
      <div class="week-days" ref={weekScroller}>
        {days.map((day) => {
          const date = dateAtNoon(day);
          const meals = planner?.meals.filter((item) => item.planned_date === day) || [];
          const chores = planner?.chores.filter((item) => item.planned_date === day) || [];
          const notes = planner?.notes.filter((item) => item.planned_date === day) || [];
          const events = calendar.events.filter((item) => eventFallsOn(item, day));
          const holidays = calendar.holidays.filter((item) => item.date === day);
          const weatherIndex = (weather?.daily.time || []).map(String).indexOf(day);
          const weatherCode = Number(weather?.daily.weather_code?.[weatherIndex] ?? 0);
          return (
            <section
              class={`planner-day ${
                date.getDay() === 0 || date.getDay() === 6 ? "weekend" : ""
              } ${day === localDate() ? "today" : ""}`}
              data-planner-date={day}
            >
              <header>
                <div>
                  <strong>{date.toLocaleDateString([], { weekday: "long" })}</strong>
                  <span>{date.toLocaleDateString([], { month: "short", day: "numeric" })}</span>
                </div>
                {weatherIndex >= 0 && (
                  <div class="planner-weather">
                    <b>{weatherSymbol(weatherCode)}</b>
                    <span>
                      {roundTemperature(weather?.daily.temperature_2m_max?.[weatherIndex])}° /
                      {roundTemperature(weather?.daily.temperature_2m_min?.[weatherIndex])}°
                    </span>
                  </div>
                )}
              </header>
              <div class="planner-day-actions">
                <button onClick={() => setMealDate(day)}>+ Meal</button>
                <button onClick={() => setChoreDate(day)}>+ Chore</button>
                <button onClick={() => setNoteDate(day)}>+ Note</button>
              </div>
              {(holidays.length > 0 || events.length > 0) && (
                <div class="planner-section planner-events">
                  <h3>Calendar</h3>
                  {holidays.map((holiday) => (
                    <article class="planner-holiday">★ {holiday.title}</article>
                  ))}
                  {events.map((event) => (
                    <article style={{ "--event-color": event.color }}>
                      <i />
                      <span>
                        <strong>{event.title}</strong>
                        <small>
                          {event.all_day
                            ? "All day"
                            : new Date(event.starts_at).toLocaleTimeString([], {
                                hour: "numeric",
                                minute: "2-digit"
                              })}
                        </small>
                      </span>
                    </article>
                  ))}
                </div>
              )}
              <div class="planner-section planner-meals">
                <h3>Meals</h3>
                {meals.length === 0 && <p class="planner-empty">Nothing planned</p>}
                {meals.map((meal) => (
                  <article
                    class={`${meal.recipe_id ? "recipe-meal" : ""} planner-draggable-card`}
                    data-meal-id={meal.id}
                    data-planner-draggable
                    onPointerDown={(event) => {
                      if ((event.target as HTMLElement).closest("button")) return;
                      beginHold(event as unknown as PointerEvent, {
                        kind: "meal",
                        meal
                      });
                    }}
                    onClick={() => {
                      if (!suppressMealClick.current && meal.recipe_id) {
                        onOpenRecipe(meal.recipe_id);
                      }
                    }}
                    title="Hold for one second, then drag to reorder or move"
                  >
                    {meal.display_image || meal.image_url ? (
                      <img src={meal.display_image || meal.image_url} alt="" loading="lazy" />
                    ) : (
                      <span class="meal-placeholder">🍽</span>
                    )}
                    <strong>{meal.title}</strong>
                    <button
                      aria-label={`Remove ${meal.title}`}
                      onClick={async (event) => {
                        event.stopPropagation();
                        await api(`/planner/meals/${meal.id}`, { method: "DELETE" });
                        load();
                      }}
                    >
                      ×
                    </button>
                  </article>
                ))}
              </div>
              <div class="planner-section planner-chores">
                <h3>Chores</h3>
                {chores.length === 0 && <p class="planner-empty">No chores</p>}
                {chores.map((chore) => (
                  <article
                    class={`${chore.completed ? "completed" : ""} planner-draggable-card`}
                    data-chore-id={chore.id}
                    data-planner-draggable
                    style={{ "--chore-color": chore.color || "#A7D8F0" }}
                    onPointerDown={(event) => {
                      if (
                        (event.target as HTMLElement).closest(
                          "input, button, .planner-member-chip"
                        )
                      )
                        return;
                      beginHold(event as unknown as PointerEvent, {
                        kind: "chore",
                        chore
                      });
                    }}
                    title="Hold anywhere on the chore for one second, then drag"
                  >
                    <label>
                      <input
                        type="checkbox"
                        checked={chore.completed}
                        onChange={async () => {
                          await api(
                            `/planner/chores/${chore.id}/complete?week_start=${weekStart}&completed=${!chore.completed}`,
                            { method: "PUT" }
                          );
                          load();
                        }}
                      />
                      <span>
                        <strong>{chore.title}</strong>
                        <small>{chore.recurring ? "Repeats weekly" : "One time"}</small>
                      </span>
                    </label>
                    <button
                      class="planner-delete"
                      onClick={() => setDeleteChore(chore)}
                      aria-label={`Delete ${chore.title}`}
                    >
                      ×
                    </button>
                    <div class="planner-chore-members">
                      {chore.members.map((member) => (
                        <button
                          class="planner-member-chip planner-hold-handle"
                          style={{ "--member-color": member.color }}
                          onPointerDown={(event) =>
                            beginHold(event as unknown as PointerEvent, {
                              kind: "member",
                              member,
                              sourceChoreId: chore.id
                            })
                          }
                          title="Hold and drag away to unassign"
                        >
                          {member.name}
                        </button>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
              <div class="planner-section planner-notes">
                <h3>Notes</h3>
                {notes.map((note) => (
                  <article>
                    <span>{note.text}</span>
                    <button
                      aria-label="Delete note"
                      onClick={async () => {
                        await api(`/planner/notes/${note.id}`, { method: "DELETE" });
                        load();
                      }}
                    >
                      ×
                    </button>
                  </article>
                ))}
                {notes.length === 0 && <p class="planner-empty">No notes</p>}
              </div>
            </section>
          );
        })}
      </div>

      {mealDate && (
        <MealPlannerModal
          date={mealDate}
          onClose={() => setMealDate(null)}
          onToast={onToast}
          onSaved={() => {
            setMealDate(null);
            load();
          }}
        />
      )}
      {choreDate && (
        <ChorePlannerModal
          date={choreDate}
          members={members}
          onClose={() => setChoreDate(null)}
          onToast={onToast}
          onSaved={() => {
            setChoreDate(null);
            load();
          }}
        />
      )}
      {noteDate && (
        <NotePlannerModal
          date={noteDate}
          onClose={() => setNoteDate(null)}
          onToast={onToast}
          onSaved={() => {
            setNoteDate(null);
            load();
          }}
        />
      )}
      {deleteChore && (
        <ConfirmDialog
          title="Delete chore?"
          message={`Delete “${deleteChore.title}”${
            deleteChore.recurring ? " from every week" : ""
          }?`}
          confirmLabel="Delete chore"
          cancelLabel="Keep chore"
          onCancel={() => setDeleteChore(null)}
          onConfirm={async () => {
            await api(`/planner/chores/${deleteChore.id}`, { method: "DELETE" });
            setDeleteChore(null);
            load();
          }}
        />
      )}
      {drag && (
        <div class="planner-drag-ghost" style={{ left: drag.x, top: drag.y }}>
          {drag.payload.kind === "chore"
            ? drag.payload.chore.title
            : drag.payload.kind === "meal"
              ? drag.payload.meal.title
            : drag.payload.member.name}
        </div>
      )}
    </main>
  );
}

function MealPlannerModal({
  date,
  onClose,
  onSaved,
  onToast
}: {
  date: string;
  onClose: () => void;
  onSaved: () => void;
  onToast: (message: string) => void;
}) {
  const [mode, setMode] = useState<"favorites" | "search" | "label">("favorites");
  const [query, setQuery] = useState("");
  const [label, setLabel] = useState("");
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(false);
  const queryRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const quickMeals = [
    "Fast Food",
    "Dine Out",
    "Date Night",
    "Lunch Date",
    "Order Delivery",
    "Order Pizza",
    "Meal Delivery Service",
    "Every Man for Himself"
  ];

  useEffect(() => {
    if (mode === "favorites") {
      setLoading(true);
      api<Recipe[]>("/recipes/favorites")
        .then(setRecipes)
        .catch((error) => onToast(error.message))
        .finally(() => setLoading(false));
      return;
    }
    if (mode !== "search") return;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const result = await api<{ recipes: Recipe[] }>(
          `/recipes/search?query=${encodeURIComponent(query)}&mode=name`
        );
        setRecipes(result.recipes);
      } catch (error: any) {
        onToast(error.message);
      } finally {
        setLoading(false);
      }
    }, query ? 350 : 0);
    return () => window.clearTimeout(timer);
  }, [query, mode]);

  const saveRecipe = async (recipe: Recipe) => {
    await api("/planner/meals", {
      method: "POST",
      ...jsonBody({
        planned_date: date,
        recipe_id: recipe.recipe_id,
        title: recipe.title,
        image_url: recipe.image_url
      })
    });
    onSaved();
  };

  const saveLabel = async (title = label) => {
    if (!title.trim()) return;
    await api("/planner/meals", {
      method: "POST",
      ...jsonBody({ planned_date: date, title, recipe_id: null })
    });
    onSaved();
  };

  const recipeResults = (
    <div class="planner-recipe-results">
      {loading && <p class="empty">Loading recipes…</p>}
      {!loading && recipes.length === 0 && (
        <p class="empty">
          {mode === "favorites"
            ? "Favorite a recipe to keep it ready here."
            : "No matching recipes found."}
        </p>
      )}
      {recipes.map((recipe) => (
        <button onClick={() => saveRecipe(recipe).catch((error) => onToast(error.message))}>
          {recipe.image_data || recipe.image_url ? (
            <img src={recipe.image_data || recipe.image_url} alt="" />
          ) : (
            <span>🍽</span>
          )}
          <strong>{recipe.title}</strong>
          <small>{recipe.custom ? "Household recipe" : "TheMealDB"}</small>
        </button>
      ))}
    </div>
  );

  return (
    <Modal
      title={`Add meal · ${dateAtNoon(date).toLocaleDateString([], {
        weekday: "long"
      })}`}
      onClose={onClose}
      extraWide
    >
      <div class="planner-modal-tabs">
        <button class={mode === "favorites" ? "active" : ""} onClick={() => setMode("favorites")}>
          ★ Favorites
        </button>
        <button class={mode === "search" ? "active" : ""} onClick={() => setMode("search")}>
          Search recipes
        </button>
        <button class={mode === "label" ? "active" : ""} onClick={() => setMode("label")}>
          Simple meal label
        </button>
      </div>
      {mode === "favorites" && (
        <div class="planner-favorites-view">
          <section class="planner-quick-meals">
            <h3>Quick meal labels</h3>
            <div>
              {quickMeals.map((meal) => (
                <button onClick={() => saveLabel(meal).catch((error) => onToast(error.message))}>
                  {meal}
                </button>
              ))}
            </div>
          </section>
          <section>
            <h3>Favorite recipes</h3>
            {recipeResults}
          </section>
        </div>
      )}
      {mode === "search" && (
        <div class={`planner-entry-layout ${onScreenKeyboardEnabled.value ? "" : "without-keyboard"}`}>
          <section class="planner-entry-content">
            <label class="planner-entry-field">
              <span>Search local and online recipes</span>
              <input
                ref={queryRef}
                type="search"
                autofocus
                value={query}
                placeholder="Chicken, tacos, soup…"
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
            {recipeResults}
          </section>
          {onScreenKeyboardEnabled.value && (
            <TouchKeyboard
              value={query}
              onChange={setQuery}
              targetRef={queryRef}
              onConfirm={() => queryRef.current?.blur()}
            />
          )}
        </div>
      )}
      {mode === "label" && (
        <div class={`planner-entry-layout ${onScreenKeyboardEnabled.value ? "" : "without-keyboard"}`}>
          <section class="planner-entry-content planner-label-form">
            <label class="planner-entry-field">
              <span>Meal label</span>
              <input
                ref={labelRef}
                autofocus
                value={label}
                placeholder="Dine out, order pizza…"
                onInput={(event) => setLabel(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    saveLabel().catch((error) => onToast(error.message));
                  }
                }}
              />
            </label>
            <button
              class="button primary full-width planner-submit"
              disabled={!label.trim()}
              onClick={() => saveLabel().catch((error) => onToast(error.message))}
            >
              Add meal
            </button>
          </section>
          {onScreenKeyboardEnabled.value && (
            <TouchKeyboard
              value={label}
              onChange={setLabel}
              targetRef={labelRef}
              onConfirm={() => saveLabel().catch((error) => onToast(error.message))}
            />
          )}
        </div>
      )}
    </Modal>
  );
}

function ChorePlannerModal({
  date,
  members,
  onClose,
  onSaved,
  onToast
}: {
  date: string;
  members: HouseholdMember[];
  onClose: () => void;
  onSaved: () => void;
  onToast: (message: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [recurring, setRecurring] = useState(true);
  const [memberIds, setMemberIds] = useState<number[]>([]);
  const [color, setColor] = useState<string>(PLANNER_PASTELS[6]);
  const titleRef = useRef<HTMLInputElement>(null);
  const save = async () => {
    if (!title.trim()) return;
    try {
      await api("/planner/chores", {
        method: "POST",
        ...jsonBody({
          title,
          color,
          recurring,
          planned_date: date,
          member_ids: memberIds
        })
      });
      onSaved();
    } catch (error: any) {
      onToast(error.message);
    }
  };
  return (
    <Modal title="Add chore" onClose={onClose} extraWide>
      <div class={`planner-entry-layout ${onScreenKeyboardEnabled.value ? "" : "without-keyboard"}`}>
        <section class="planner-entry-content planner-chore-form">
        <label class="planner-entry-field">
          <span>Chore</span>
          <input
            ref={titleRef}
            autofocus
            value={title}
            onInput={(event) => setTitle(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") save();
            }}
          />
        </label>
        <label class="setting-toggle">
          <span>Repeat every week</span>
          <input
            type="checkbox"
            checked={recurring}
            onChange={(event) => setRecurring(event.currentTarget.checked)}
          />
        </label>
        <fieldset class="pastel-picker">
          <legend>Chore color</legend>
          {PLANNER_PASTELS.map((option) => (
            <button
              type="button"
              class={color === option ? "active" : ""}
              style={{ "--swatch": option }}
              aria-label={`Choose ${option}`}
              aria-pressed={color === option}
              onClick={() => setColor(option)}
            />
          ))}
        </fieldset>
        <fieldset>
          <legend>Assign household members</legend>
          {members.length === 0 && (
            <p class="hint">Members can be added in Settings → Household members.</p>
          )}
          <div class="planner-member-picker">
            {members.map((member) => (
              <label style={{ "--member-color": member.color }}>
                <input
                  type="checkbox"
                  checked={memberIds.includes(member.id)}
                  onChange={() =>
                    setMemberIds((items) =>
                      items.includes(member.id)
                        ? items.filter((id) => id !== member.id)
                        : [...items, member.id]
                    )
                  }
                />
                {member.name}
              </label>
            ))}
          </div>
        </fieldset>
        <button
          class="button primary full-width planner-submit"
          disabled={!title.trim()}
          onClick={save}
        >
          Add chore
        </button>
        </section>
        {onScreenKeyboardEnabled.value && (
          <TouchKeyboard
            value={title}
            onChange={setTitle}
            targetRef={titleRef}
            onConfirm={save}
          />
        )}
      </div>
    </Modal>
  );
}

function NotePlannerModal({
  date,
  onClose,
  onSaved,
  onToast
}: {
  date: string;
  onClose: () => void;
  onSaved: () => void;
  onToast: (message: string) => void;
}) {
  const [text, setText] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);
  const save = async () => {
    if (!text.trim()) return;
    try {
      await api("/planner/notes", {
        method: "POST",
        ...jsonBody({ planned_date: date, text })
      });
      onSaved();
    } catch (error: any) {
      onToast(error.message);
    }
  };
  return (
    <Modal title="Add planner note" onClose={onClose} extraWide>
      <div class={`planner-entry-layout ${onScreenKeyboardEnabled.value ? "" : "without-keyboard"}`}>
        <section class="planner-entry-content planner-note-form">
          <label class="planner-entry-field">
            <span>Note</span>
            <textarea
              ref={textRef}
              autofocus
              value={text}
              placeholder="Add anything useful for this day…"
              onInput={(event) => setText(event.currentTarget.value)}
            />
          </label>
          <button
            class="button primary full-width planner-submit"
            disabled={!text.trim()}
            onClick={save}
          >
            Add note
          </button>
        </section>
        {onScreenKeyboardEnabled.value && (
          <TouchKeyboard
            value={text}
            onChange={setText}
            targetRef={textRef}
            onConfirm={save}
          />
        )}
      </div>
    </Modal>
  );
}
