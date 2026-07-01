import { useEffect, useMemo, useState } from "preact/hooks";
import { api, jsonBody } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { TouchInput } from "../components/TouchInput";
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

function monday(value = new Date()): string {
  const result = new Date(value);
  result.setHours(12, 0, 0, 0);
  result.setDate(result.getDate() - ((result.getDay() + 6) % 7));
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
  const [weekStart, setWeekStart] = useState(() => monday());
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
      if (active) finishDrag(payload, endEvent.clientX, endEvent.clientY);
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
          <button class="button secondary" onClick={() => setWeekStart(monday())}>
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
      <div class="week-days">
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
                    class={meal.recipe_id ? "recipe-meal" : ""}
                    onClick={() => meal.recipe_id && onOpenRecipe(meal.recipe_id)}
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
                    class={chore.completed ? "completed" : ""}
                    data-chore-id={chore.id}
                    style={{ "--chore-color": chore.color || "#A7D8F0" }}
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
                      class="planner-chore-grip planner-hold-handle"
                      onPointerDown={(event) =>
                        beginHold(event as unknown as PointerEvent, {
                          kind: "chore",
                          chore
                        })
                      }
                      title="Hold for one second, then drag to another day"
                    >
                      ⠿
                    </button>
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
  const [mode, setMode] = useState<"recipe" | "label">("recipe");
  const [query, setQuery] = useState("");
  const [label, setLabel] = useState("");
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (mode !== "recipe") return;
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

  return (
    <Modal
      title={`Add meal · ${dateAtNoon(date).toLocaleDateString([], {
        weekday: "long"
      })}`}
      onClose={onClose}
      wide
    >
      <div class="planner-modal-tabs">
        <button class={mode === "recipe" ? "active" : ""} onClick={() => setMode("recipe")}>
          Find a recipe
        </button>
        <button class={mode === "label" ? "active" : ""} onClick={() => setMode("label")}>
          Simple meal label
        </button>
      </div>
      {mode === "recipe" ? (
        <>
          <TouchInput
            label="Search local and online recipes"
            value={query}
            onChange={setQuery}
            placeholder="Chicken, tacos, soup…"
          />
          <div class="planner-recipe-results">
            {loading && <p class="empty">Searching recipes…</p>}
            {!loading && recipes.length === 0 && (
              <p class="empty">Search for a recipe or choose the label option.</p>
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
        </>
      ) : (
        <div class="planner-label-form">
          <TouchInput
            label="Meal"
            value={label}
            onChange={setLabel}
            placeholder="Dine out, order pizza…"
          />
          <button
            class="button primary full-width"
            disabled={!label.trim()}
            onClick={async () => {
              await api("/planner/meals", {
                method: "POST",
                ...jsonBody({ planned_date: date, title: label, recipe_id: null })
              });
              onSaved();
            }}
          >
            Add meal
          </button>
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
  return (
    <Modal title="Add chore" onClose={onClose} wide>
      <div class="planner-chore-form">
        <TouchInput label="Chore" value={title} onChange={setTitle} />
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
          class="button primary full-width"
          disabled={!title.trim()}
          onClick={async () => {
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
          }}
        >
          Add chore
        </button>
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
  return (
    <Modal title="Add planner note" onClose={onClose} wide>
      <TouchInput label="Note" value={text} onChange={setText} multiline />
      <button
        class="button primary full-width"
        disabled={!text.trim()}
        onClick={async () => {
          try {
            await api("/planner/notes", {
              method: "POST",
              ...jsonBody({ planned_date: date, text })
            });
            onSaved();
          } catch (error: any) {
            onToast(error.message);
          }
        }}
      >
        Add note
      </button>
    </Modal>
  );
}
