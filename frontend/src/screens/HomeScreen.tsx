import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, jsonBody } from "../api";
import { Modal } from "../components/Modal";
import { NumberPad, TouchKeyboard } from "../components/TouchKeyboard";
import { onScreenKeyboardEnabled } from "../inputPreferences";
import { ConfirmDialog } from "../components/ConfirmDialog";
import {
  centeredDailyIndices,
  centeredHourlyIndices,
  roundTemperature,
  weatherGradient
} from "../weatherPresentation";
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
  weatherRefreshToken: number;
  onNavigate: (screen: string) => void;
  onToast: (message: string) => void;
  onRefresh: () => void;
  clock24Hour: boolean;
  garbagePickupEnabled: boolean;
  garbagePickupWeekday: number;
  reducedMotion: boolean;
  awakeLock: boolean;
  localDevice: boolean;
  mobileDashAddress: string;
  onToggleAwakeLock: () => void;
  onScanNow: () => void;
}

function keyForDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function eventOccursOnDay(event: CalendarEvent, day: string): boolean {
  if (event.all_day) {
    return event.starts_at.slice(0, 10) <= day && event.ends_at.slice(0, 10) > day;
  }
  const start = new Date(`${day}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return (
    new Date(event.starts_at).getTime() < end.getTime() &&
    new Date(event.ends_at).getTime() > start.getTime()
  );
}

function weatherSymbol(code = 0): string {
  if ([0, 1].includes(code)) return "☀";
  if ([2, 3].includes(code)) return "⛅";
  if ([45, 48].includes(code)) return "≋";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄";
  if ([95, 96, 99].includes(code)) return "⛈";
  return "🌧";
}

export function formatTimerCountdown(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function timerProgress(timer: Timer, now: Date): number {
  const start = new Date(timer.created_at).getTime();
  const end = new Date(timer.ends_at).getTime();
  if (!Number.isFinite(start) || end <= start) return 0;
  return Math.max(0, Math.min(100, ((now.getTime() - start) / (end - start)) * 100));
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
  weatherRefreshToken,
  onNavigate,
  onToast,
  onRefresh,
  clock24Hour,
  garbagePickupEnabled,
  garbagePickupWeekday,
  reducedMotion,
  awakeLock,
  localDevice,
  mobileDashAddress,
  onToggleAwakeLock,
  onScanNow
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
  const reminderInputRef = useRef<HTMLInputElement>(null);
  const [timerToCancel, setTimerToCancel] = useState<Timer | null>(null);
  const [forecastMode, setForecastMode] = useState<"hourly" | "week">("hourly");
  const hourlyStripRef = useRef<HTMLDivElement>(null);
  const currentHourRef = useRef<HTMLDivElement>(null);
  const currentDayRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    const { gridStart, gridEnd } = monthBounds(month);
    const [calendarData, shoppingData, reminderData, timerData] =
      await Promise.all([
        api<CalendarData>(
          `/calendar?start=${keyForDate(gridStart)}&end=${keyForDate(gridEnd)}`
        ),
        api<ShoppingItem[]>("/shopping"),
        api<Reminder[]>("/reminders"),
        api<Timer[]>("/timers")
      ]);
    setCalendar(calendarData);
    setShopping(shoppingData);
    setReminders(reminderData);
    setTimers(timerData);
  };

  useEffect(() => {
    load().catch((error) => onToast(error.message));
  }, [month.getTime(), refreshToken]);

  useEffect(() => {
    api<Weather | null>("/weather")
      .then(setWeather)
      .catch((error) => onToast(error.message));
  }, [weatherRefreshToken]);

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
      (event) => selectedDay && eventOccursOnDay(event, selectedDay)
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
    setReminders(await api<Reminder[]>("/reminders"));
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
  const hourlyIndices = useMemo(
    () => centeredHourlyIndices(weather, now, 18),
    [weather, now.getHours()]
  );
  const todayKey = keyForDate(now);
  const dailyIndices = centeredDailyIndices(weather, now, 4);

  useEffect(() => {
    const strip = hourlyStripRef.current;
    const current =
      forecastMode === "hourly" ? currentHourRef.current : currentDayRef.current;
    if (!strip || !current) return;
    strip.scrollTo({
      left:
        current.offsetLeft -
        strip.clientWidth / 2 +
        current.clientWidth / 2,
      behavior: "auto"
    });
  }, [weather, forecastMode]);

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
              (event) => eventOccursOnDay(event, key)
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
        <article
          class="widget weather-widget glass"
          style={{
            background: weatherGradient(
              Number(current.weather_code || 0),
              {
                weather,
                timestamp: String(current.time || new Date().toISOString()),
                temperature: current.temperature_2m,
                temperatureUnit: weather?.units.temperature
              }
            )
          }}
        >
          <button class="widget-heading" onClick={() => onNavigate("weather")}>
            <span class="weather-main-symbol">
              {weatherSymbol(Number(current.weather_code || 0))}
            </span>
            <span>
              <strong>
                {roundTemperature(current.temperature_2m)}
                {weather?.units.temperature}
              </strong>
              <small>
                Feels like {roundTemperature(current.apparent_temperature)}
                {weather?.units.temperature}
              </small>
            </span>
          </button>
          <div class="weather-widget-toolbar">
            <button class="weather-details-link" onClick={() => onNavigate("weather")}>
              Detailed Conditions ›
            </button>
            <div class="forecast-mode-toggle">
              <button
                class={forecastMode === "hourly" ? "active" : ""}
                onClick={() => setForecastMode("hourly")}
              >
                Hourly
              </button>
              <button
                class={forecastMode === "week" ? "active" : ""}
                onClick={() => setForecastMode("week")}
              >
                9 Day
              </button>
            </div>
          </div>
          <div ref={hourlyStripRef} class="horizontal-forecast">
            {forecastMode === "hourly" &&
              hourlyIndices.map((index) => {
                const item = String(weather?.hourly.time?.[index] || "");
                const itemDate = new Date(item);
                const currentHour =
                  itemDate.getFullYear() === now.getFullYear() &&
                  itemDate.getMonth() === now.getMonth() &&
                  itemDate.getDate() === now.getDate() &&
                  itemDate.getHours() === now.getHours();
                const code = Number(
                  weather?.hourly.weather_code?.[index] || 0
                );
                return (
                  <div
                    ref={currentHour ? currentHourRef : undefined}
                    class={`forecast-hour ${
                      currentHour ? "current-hour" : ""
                    }`}
                    style={{
                      background: weatherGradient(code, {
                        weather,
                        timestamp: item,
                        temperature:
                          weather?.hourly.temperature_2m?.[index],
                        temperatureUnit: weather?.units.temperature
                      })
                    }}
                  >
                    <span>
                      {itemDate.toLocaleTimeString([], { hour: "numeric" })}
                    </span>
                    <b>{weatherSymbol(code)}</b>
                    <span>
                      {roundTemperature(
                        weather?.hourly.temperature_2m?.[index]
                      )}
                      {weather?.units.temperature}
                    </span>
                  </div>
                );
              })}
            {forecastMode === "week" &&
              dailyIndices.map((index) => {
                const item = String(weather?.daily.time?.[index] || "");
                const code = Number(
                  weather?.daily.weather_code?.[index] || 0
                );
                return (
                  <div
                    ref={item === todayKey ? currentDayRef : undefined}
                    class={`forecast-hour daily ${item === todayKey ? "current-day" : ""}`}
                    style={{
                      background: weatherGradient(code, {
                        weather,
                        timestamp: `${item}T12:00`,
                        temperature:
                          weather?.daily.temperature_2m_max?.[index],
                        temperatureUnit: weather?.units.temperature
                      })
                    }}
                  >
                    <span>
                      {new Date(`${item}T12:00`).toLocaleDateString([], {
                        weekday: "short"
                      })}
                    </span>
                    <b>{weatherSymbol(code)}</b>
                    <span>
                      {roundTemperature(
                        weather?.daily.temperature_2m_max?.[index]
                      )}
                      °/
                      {roundTemperature(
                        weather?.daily.temperature_2m_min?.[index]
                      )}
                      °
                    </span>
                  </div>
                );
              })}
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
              <label class={`${item.completed ? "completed" : ""} ${item.high_priority ? "high-priority" : ""}`}>
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
        <button
          class="scan-button"
          onClick={onScanNow}
          aria-label="Scan a barcode"
          title="Scan a barcode"
        >
          ▥
        </button>
        {localDevice && (
          <button
            class={`awake-lock-button ${awakeLock ? "active" : ""}`}
            onClick={onToggleAwakeLock}
            aria-label={awakeLock ? "Allow display to sleep" : "Keep display awake"}
            title={awakeLock ? "Display locked awake" : "Keep display awake"}
          >
            <span class={`lock-glyph ${awakeLock ? "locked" : ""}`} aria-hidden="true" />
          </button>
        )}
        <div class="running-timers">
          {timers.map((timer) => (
            <button
              class={timer.status === "finished" ? "timer-finished" : ""}
              onClick={() => setTimerToCancel(timer)}
            >
              <span>
                <b>{timer.label}</b>
                <strong>
                  {timer.status === "finished"
                    ? "Done"
                    : formatTimerCountdown(
                        new Date(timer.ends_at).getTime() - now.getTime()
                      )}
                </strong>
              </span>
              <i>
                <i
                  style={{
                    width: `${timerProgress(timer, now)}%`
                  }}
                />
              </i>
            </button>
          ))}
        </div>
      </footer>
      <div class="mobile-home-credits" aria-label="Dashboard information">
        <span>Mobile Dash @ {mobileDashAddress}</span>
        <span>BodaDash | Made by Ben Godwin for Koda Godwin | Open Source | V1.0 (July 2026)</span>
      </div>

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
          {localDevice ? (
            <NumberPad
              value={customTimer}
              onChange={(value) => setCustomTimer(value.slice(0, 3))}
              onConfirm={() => addTimer(Math.max(1, Number(customTimer)))}
            />
          ) : (
            <div class="native-timer-entry">
              <input
                type="number"
                inputMode="numeric"
                min="1"
                max="999"
                value={customTimer}
                placeholder="Minutes"
                onInput={(event) =>
                  setCustomTimer(event.currentTarget.value.slice(0, 3))
                }
              />
              <button
                class="button primary"
                disabled={!Number(customTimer)}
                onClick={() => addTimer(Math.max(1, Number(customTimer)))}
              >
                Start timer on dashboard
              </button>
            </div>
          )}
        </Modal>
      )}

      {reminderEntry && (
        <Modal title="Add Reminder" onClose={() => setReminderEntry(false)} wide>
          <input
            ref={reminderInputRef}
            class="entry-native-input"
            value={reminderText}
            placeholder="Type a reminder…"
            autofocus
            onInput={(event) => setReminderText(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addReminder();
            }}
          />
          {onScreenKeyboardEnabled.value && (
            <TouchKeyboard
              value={reminderText}
              onChange={setReminderText}
              targetRef={reminderInputRef}
              onConfirm={addReminder}
            />
          )}
        </Modal>
      )}
      {timerToCancel && (
        <ConfirmDialog
          title="Cancel timer?"
          message={`Cancel ${timerToCancel.label}?`}
          confirmLabel="Yes, cancel timer"
          cancelLabel="No, keep timer"
          onCancel={() => setTimerToCancel(null)}
          onConfirm={async () => {
            await api(`/timers/${timerToCancel.id}`, { method: "DELETE" });
            setTimerToCancel(null);
            load();
          }}
        />
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
