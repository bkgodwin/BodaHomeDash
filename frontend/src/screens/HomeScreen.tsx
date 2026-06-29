import { useEffect, useMemo, useState } from "preact/hooks";
import { api, jsonBody } from "../api";
import { Modal } from "../components/Modal";
import { NumberPad, TouchKeyboard } from "../components/TouchKeyboard";
import {
  CalendarData,
  CalendarEvent,
  Expiration,
  Reminder,
  ShoppingItem,
  Timer,
  Weather
} from "../types";

interface Props {
  refreshToken: number;
  onNavigate: (screen: string) => void;
  onToast: (message: string) => void;
  onRefresh: () => void;
  clock24Hour: boolean;
  garbagePickupEnabled: boolean;
  garbagePickupWeekday: number;
  reducedMotion: boolean;
}

function keyForDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateForEvent(value: string): string {
  return keyForDate(new Date(value));
}

function weatherSymbol(code = 0): string {
  if ([0, 1].includes(code)) return "☀";
  if ([2, 3].includes(code)) return "⛅";
  if ([45, 48].includes(code)) return "≋";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄";
  if ([95, 96, 99].includes(code)) return "⛈";
  return "🌧";
}

function monthBounds(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - first.getDay());
  const gridEnd = new Date(gridStart);
  gridEnd.setDate(gridStart.getDate() + 42);
  return { gridStart, gridEnd };
}

export function HomeScreen({
  refreshToken,
  onNavigate,
  onToast,
  onRefresh,
  clock24Hour,
  garbagePickupEnabled,
  garbagePickupWeekday,
  reducedMotion
}: Props) {
  const [month, setMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  );
  const [now, setNow] = useState(() => new Date());
  const [calendar, setCalendar] = useState<CalendarData>({
    events: [],
    holidays: [],
    expirations: []
  });
  const [weather, setWeather] = useState<Weather | null>(null);
  const [shopping, setShopping] = useState<ShoppingItem[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [timers, setTimers] = useState<Timer[]>([]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [timerOpen, setTimerOpen] = useState(false);
  const [customTimer, setCustomTimer] = useState("");
  const [reminderEntry, setReminderEntry] = useState(false);
  const [reminderText, setReminderText] = useState("");

  const load = async () => {
    const { gridStart, gridEnd } = monthBounds(month);
    const [calendarData, weatherData, shoppingData, reminderData, timerData] =
      await Promise.all([
        api<CalendarData>(
          `/calendar?start=${keyForDate(gridStart)}&end=${keyForDate(gridEnd)}`
        ),
        api<Weather | null>("/weather"),
        api<ShoppingItem[]>("/shopping"),
        api<Reminder[]>("/reminders"),
        api<Timer[]>("/timers")
      ]);
    setCalendar(calendarData);
    setWeather(weatherData);
    setShopping(shoppingData);
    setReminders(reminderData);
    setTimers(timerData);
  };

  useEffect(() => {
    load().catch((error) => onToast(error.message));
  }, [month.getTime(), refreshToken]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const days = useMemo(() => {
    const { gridStart } = monthBounds(month);
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + index);
      return date;
    });
  }, [month]);

  const selectedEvents =
    calendar.events.filter(
      (event) =>
        selectedDay &&
        (event.all_day
          ? event.starts_at.slice(0, 10)
          : dateForEvent(event.starts_at)) === selectedDay
    ) || [];
  const selectedHolidays =
    calendar.holidays.filter((holiday) => holiday.date === selectedDay) || [];
  const selectedExpirations =
    calendar.expirations.filter(
      (expiration) => expiration.expires_on === selectedDay
    ) || [];

  const moveMonth = (amount: number) =>
    setMonth(new Date(month.getFullYear(), month.getMonth() + amount, 1));

  let touchStart = 0;
  const onTouchStart = (event: TouchEvent) => {
    touchStart = event.touches[0].clientX;
  };
  const onTouchEnd = (event: TouchEvent) => {
    const distance = event.changedTouches[0].clientX - touchStart;
    if (Math.abs(distance) > 90) moveMonth(distance > 0 ? -1 : 1);
  };

  const toggleReminder = async (item: Reminder) => {
    await api(`/reminders/${item.id}`, {
      method: "PATCH",
      ...jsonBody({ completed: !item.completed })
    });
    setReminders((items) =>
      items.map((candidate) =>
        candidate.id === item.id
          ? { ...candidate, completed: item.completed ? 0 : 1 }
          : candidate
      )
    );
  };

  const addReminder = async () => {
    if (!reminderText.trim()) return;
    await api("/reminders", {
      method: "POST",
      ...jsonBody({ text: reminderText })
    });
    setReminderEntry(false);
    setReminderText("");
    load();
  };

  const addTimer = async (minutes: number, label = "Kitchen timer") => {
    await api("/timers", {
      method: "POST",
      ...jsonBody({ seconds: minutes * 60, label })
    });
    setTimerOpen(false);
    setCustomTimer("");
    load();
  };

  const current = weather?.current || {};
  const hourlyTimes = (weather?.hourly?.time || []).slice(0, 24);
  const dailyTimes = (weather?.daily?.time || []).slice(0, 7);

  return (
    <main class="home-screen">
      <section
        class="calendar-shell glass"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <header class="calendar-header">
          <button class="month-arrow" onClick={() => moveMonth(-1)} aria-label="Previous month">
            ‹
          </button>
          <button
            class="month-title"
            onClick={() =>
              setMonth(new Date(now.getFullYear(), now.getMonth(), 1))
            }
          >
            {month.toLocaleDateString(undefined, {
              month: "long",
              year: "numeric"
            })}
          </button>
          <button class="month-arrow" onClick={() => moveMonth(1)} aria-label="Next month">
            ›
          </button>
        </header>
        <div class="weekday-row">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
            <span>{day}</span>
          ))}
        </div>
        <div class="month-grid">
          {days.map((day) => {
            const key = keyForDate(day);
            const events = calendar.events.filter(
              (event) =>
                (event.all_day
                  ? event.starts_at.slice(0, 10)
                  : dateForEvent(event.starts_at)) === key
            );
            const dayHolidays = calendar.holidays.filter(
              (holiday) => holiday.date === key
            );
            const expires = calendar.expirations.some(
              (expiration) => expiration.expires_on === key
            );
            const today = key === keyForDate(now);
            const muted = day.getMonth() !== month.getMonth();
            const entries = [
              ...dayHolidays.map((holiday) => ({
                title: holiday.title,
                color: "#ca8f50",
                holiday: true
              })),
              ...events.map((event) => ({
                title: event.title,
                color: event.color,
                holiday: false
              }))
            ];
            return (
              <button
                class={`day-cell ${today ? "today" : ""} ${muted ? "muted" : ""}`}
                onClick={() => setSelectedDay(key)}
                aria-label={day.toDateString()}
              >
                <span class="day-number">{day.getDate()}</span>
                {expires && <span class="expiration-dot" title="Food expires" />}
                <div class="event-stack">
                  {entries.slice(0, 3).map((entry) => (
                    <span
                      class={`event-block ${entry.holiday ? "holiday" : ""}`}
                      style={{ "--event-color": entry.color }}
                    >
                      {entry.title}
                    </span>
                  ))}
                  {entries.length > 3 && (
                    <span class="more-events">+{entries.length - 3} more</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section class="widget-row">
        <article class="widget weather-widget glass">
          <button class="widget-heading" onClick={() => onNavigate("weather")}>
            <span class="weather-main-symbol">
              {weatherSymbol(Number(current.weather_code || 0))}
            </span>
            <span>
              <strong>
                {current.temperature_2m ?? "—"}
                {weather?.units.temperature}
              </strong>
              <small>
                Feels like {current.apparent_temperature ?? "—"}
                {weather?.units.temperature}
              </small>
            </span>
          </button>
          <div class="horizontal-forecast">
            {hourlyTimes.map((item, index) => (
              <div class="forecast-hour">
                <span>
                  {new Date(item).toLocaleTimeString([], { hour: "numeric" })}
                </span>
                <b>
                  {weatherSymbol(
                    Number(weather?.hourly.weather_code?.[index] || 0)
                  )}
                </b>
                <span>
                  {weather?.hourly.temperature_2m?.[index]}
                  {weather?.units.temperature}
                </span>
              </div>
            ))}
            {dailyTimes.map((item, index) => (
              <div class="forecast-hour daily">
                <span>
                  {new Date(`${item}T12:00`).toLocaleDateString([], {
                    weekday: "short"
                  })}
                </span>
                <b>
                  {weatherSymbol(
                    Number(weather?.daily.weather_code?.[index] || 0)
                  )}
                </b>
                <span>
                  {weather?.daily.temperature_2m_max?.[index]}°/
                  {weather?.daily.temperature_2m_min?.[index]}°
                </span>
              </div>
            ))}
          </div>
        </article>

        <article class="widget glass">
          <header class="widget-title">
            <button onClick={() => onNavigate("reminders")}>Reminders</button>
            <button class="mini-add" onClick={() => setReminderEntry(true)}>
              +
            </button>
          </header>
          <div class="widget-scroll checklist">
            {reminders.length === 0 && <p class="empty">Nothing pending</p>}
            {reminders.map((item) => (
              <label class={item.completed ? "completed" : ""}>
                <input
                  type="checkbox"
                  checked={Boolean(item.completed)}
                  onChange={() => toggleReminder(item)}
                />
                <span>{item.text}</span>
              </label>
            ))}
          </div>
        </article>

        <article class="widget glass">
          <header class="widget-title">
            <button onClick={() => onNavigate("shopping")}>Shopping</button>
            <span>{shopping.filter((item) => !item.purchased).length}</span>
          </header>
          <div class="widget-scroll shopping-summary">
            {shopping.filter((item) => !item.purchased).length === 0 && (
              <p class="empty">List is clear</p>
            )}
            {shopping
              .filter((item) => !item.purchased)
              .slice(0, 8)
              .map((item) => (
                <button onClick={() => onNavigate("shopping")}>
                  <span>{item.name}</span>
                  <b>×{item.quantity}</b>
                </button>
              ))}
          </div>
        </article>
      </section>

      <footer class="home-footer">
        <button class="clock-button" onClick={() => setTimerOpen(true)}>
          {now.toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
            hour12: !clock24Hour
          })}
        </button>
        {garbagePickupEnabled && now.getDay() === garbagePickupWeekday && (
          <div
            class={`garbage-reminder ${reducedMotion ? "no-animation" : ""}`}
            role="status"
            aria-label="Garbage pickup today"
            title="Garbage pickup today"
          >
            <span aria-hidden="true">🗑️</span>
            <strong>Pickup today</strong>
          </div>
        )}
        <button class="refresh-button" onClick={onRefresh} aria-label="Refresh dashboard">
          ↻
        </button>
        <div class="running-timers">
          {timers.map((timer) => (
            <button
              class={timer.status === "finished" ? "timer-finished" : ""}
              onClick={async () => {
                if (confirm(`Cancel ${timer.label}?`)) {
                  await api(`/timers/${timer.id}`, { method: "DELETE" });
                  load();
                }
              }}
            >
              {timer.label}{" "}
              {timer.status === "finished"
                ? "Done"
                : Math.max(
                    0,
                    Math.ceil(
                      (new Date(timer.ends_at).getTime() - Date.now()) / 60000
                    )
                  ) + "m"}
            </button>
          ))}
        </div>
      </footer>

      {selectedDay && (
        <Modal
          title={new Date(`${selectedDay}T12:00`).toLocaleDateString(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric"
          })}
          onClose={() => setSelectedDay(null)}
        >
          <DayDetails
            events={selectedEvents}
            holidays={selectedHolidays}
            expirations={selectedExpirations}
          />
        </Modal>
      )}

      {timerOpen && (
        <Modal title="Kitchen Timer" onClose={() => setTimerOpen(false)}>
          <div class="timer-presets">
            {[1, 5, 10, 15, 30, 45, 60].map((minutes) => (
              <button onClick={() => addTimer(minutes)}>{minutes} min</button>
            ))}
          </div>
          <h3>Custom minutes</h3>
          <NumberPad
            value={customTimer}
            onChange={(value) => setCustomTimer(value.slice(0, 3))}
            onConfirm={() => addTimer(Math.max(1, Number(customTimer)))}
          />
        </Modal>
      )}

      {reminderEntry && (
        <Modal title="Add Reminder" onClose={() => setReminderEntry(false)}>
          <div class="entry-preview">{reminderText || "Type a reminder…"}</div>
          <TouchKeyboard
            value={reminderText}
            onChange={setReminderText}
            onConfirm={addReminder}
          />
        </Modal>
      )}
    </main>
  );
}

function DayDetails({
  events,
  holidays,
  expirations
}: {
  events: CalendarEvent[];
  holidays: { title: string }[];
  expirations: Expiration[];
}) {
  const empty = !events.length && !holidays.length && !expirations.length;
  return (
    <div class="day-details">
      {empty && <p class="empty">Nothing scheduled for this day.</p>}
      {holidays.map((holiday) => (
        <article class="detail-row holiday-detail">
          <span>Holiday</span>
          <strong>{holiday.title}</strong>
        </article>
      ))}
      {events.map((event) => (
        <article class="detail-row" style={{ "--event-color": event.color }}>
          <span>
            {event.all_day
              ? "All day"
              : new Date(event.starts_at).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit"
                })}
          </span>
          <strong>{event.title}</strong>
          {event.location && <small>{event.location}</small>}
          {event.description && <p>{event.description}</p>}
        </article>
      ))}
      {expirations.map((item) => (
        <article class="detail-row expiration-detail">
          <span>Pantry</span>
          <strong>
            {item.name} ×{item.quantity}
          </strong>
          <small>Expires today</small>
        </article>
      ))}
    </div>
  );
}
