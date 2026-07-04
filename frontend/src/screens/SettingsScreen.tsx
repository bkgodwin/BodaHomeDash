import { useEffect, useState } from "preact/hooks";
import { api, jsonBody } from "../api";
import { TouchInput } from "../components/TouchInput";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import {
  BarcodeScanEvent,
  scannerTestMode
} from "../scannerCapture";
import { HouseholdMember } from "../types";
import { PLANNER_PASTELS } from "../plannerPalette";

interface Props {
  onToast: (message: string) => void;
  onSetupStart?: () => void;
  onSetupAbort?: () => void;
  onSetupComplete?: () => void | Promise<void>;
  setupMode?: boolean;
}

type Settings = Record<string, any>;

export function SettingsScreen({
  onToast,
  onSetupStart,
  onSetupAbort,
  onSetupComplete,
  setupMode = false
}: Props) {
  const [settings, setSettings] = useState<Settings>({});
  const [tab, setTab] = useState(setupMode ? "welcome" : "general");
  const [calendarEmail, setCalendarEmail] = useState("");
  const [calendarPassword, setCalendarPassword] = useState("");
  const [calendarName, setCalendarName] = useState("iCloud");
  const [calendars, setCalendars] = useState<any[]>([]);
  const [locationSearch, setLocationSearch] = useState("");
  const [locationResults, setLocationResults] = useState<any[]>([]);
  const [pin, setPin] = useState("");
  const [backupPassword, setBackupPassword] = useState("");
  const [restorePath, setRestorePath] = useState("");
  const [restorePassword, setRestorePassword] = useState("");
  const [foundBackups, setFoundBackups] = useState<any[]>([]);
  const [devices, setDevices] = useState<any>({ input_devices: [] });
  const [networks, setNetworks] = useState<any[]>([]);
  const [interfaces, setInterfaces] = useState<any[]>([]);
  const [networkInfo, setNetworkInfo] = useState<any>(null);
  const [motionStatus, setMotionStatus] = useState<any>(null);
  const [motionTest, setMotionTest] = useState<{
    running: boolean;
    samples: number[];
    transitions: number;
  } | null>(null);
  const [systemVolume, setSystemVolume] = useState(50);
  const [wifiPassword, setWifiPassword] = useState("");
  const [selectedSsid, setSelectedSsid] = useState("");
  const [busy, setBusy] = useState(false);
  const [scannerTest, setScannerTest] = useState("");
  const [syncDiagnostics, setSyncDiagnostics] = useState<any>({
    providers: [],
    log: []
  });
  const [metrics, setMetrics] = useState<any>(null);
  const [updateStatus, setUpdateStatus] = useState<any>(null);
  const [exitDesktopConfirm, setExitDesktopConfirm] = useState(false);
  const [householdMembers, setHouseholdMembers] = useState<HouseholdMember[]>([]);
  const [memberName, setMemberName] = useState("");
  const [memberColor, setMemberColor] = useState<string>(PLANNER_PASTELS[6]);
  const [deleteMember, setDeleteMember] = useState<HouseholdMember | null>(null);
  const [editMember, setEditMember] = useState<HouseholdMember | null>(null);
  const [editMemberName, setEditMemberName] = useState("");
  const [editMemberColor, setEditMemberColor] = useState<string>(
    PLANNER_PASTELS[6]
  );

  const load = async () => {
    const [
      values,
      calendarValues,
      deviceValues,
      syncValues,
      interfaceValues,
      memberValues
    ] = await Promise.all([
      api<Settings>("/settings"),
      api<any[]>("/calendar/calendars"),
      api<any>("/hardware/devices"),
      api<any>("/sync/status"),
      api<any>("/network/interfaces"),
      api<HouseholdMember[]>("/household/members")
    ]);
    setSettings(values);
    setCalendars(calendarValues);
    setDevices(deviceValues);
    setSyncDiagnostics(syncValues);
    setInterfaces(interfaceValues.interfaces || []);
    setNetworkInfo(interfaceValues);
    setMotionStatus(deviceValues.motion_status || null);
    if (
      deviceValues.system_volume?.volume != null &&
      Number.isFinite(Number(deviceValues.system_volume.volume))
    ) {
      setSystemVolume(Number(deviceValues.system_volume.volume));
    }
    setHouseholdMembers(memberValues);
    api<any>("/system/metrics").then(setMetrics).catch(() => undefined);
    api<any>("/system/update/status").then(setUpdateStatus).catch(() => undefined);
  };
  useEffect(() => {
    load().catch((error) => onToast(error.message));
    const scanned = (event: Event) => {
      const detail = (event as CustomEvent<BarcodeScanEvent>).detail;
      if (!scannerTestMode.value) return;
      setScannerTest(`Scanner working — received ${detail.barcode}`);
      scannerTestMode.value = false;
    };
    window.addEventListener("dashboard:barcode", scanned);
    return () => {
      window.removeEventListener("dashboard:barcode", scanned);
      scannerTestMode.value = false;
    };
  }, []);

  useEffect(() => {
    if (tab !== "hardware") return;
    let stopped = false;
    const refresh = () =>
      api<any>("/hardware/motion")
        .then((value) => {
          if (!stopped) setMotionStatus(value);
        })
        .catch(() => undefined);
    refresh();
    const timer = window.setInterval(refresh, 600);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [tab]);

  useEffect(() => {
    if (tab !== "system") return;
    const refresh = () =>
      api<any>("/system/update/status")
        .then((value) => {
          setUpdateStatus(value);
          if (
            value.state === "complete" &&
            window.sessionStorage.getItem("bodadash-update-pending") === "1"
          ) {
            window.sessionStorage.removeItem("bodadash-update-pending");
            window.setTimeout(() => window.location.reload(), 700);
          }
        })
        .catch(() => undefined);
    refresh();
    const timer = window.setInterval(refresh, 1500);
    return () => window.clearInterval(timer);
  }, [tab]);

  const save = async (values: Settings, message = "Settings saved") => {
    setBusy(true);
    try {
      const next = await api<Settings>("/settings", {
        method: "PATCH",
        ...jsonBody({ values })
      });
      setSettings(next);
      onToast(message);
      return true;
    } catch (error: any) {
      onToast(error.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const testAudio = async (kind: "timer_audio" | "alert_audio") => {
    try {
      const result = await api<any>("/hardware/test", {
        method: "POST",
        ...jsonBody({ kind })
      });
      setDevices((current: any) => ({ ...current, audio_status: result }));
      onToast(
        result.success
          ? `Sound played through ${result.backend}`
          : `Audio failed: ${result.last_error || "unknown playback error"}`
      );
    } catch (error: any) {
      onToast(error.message);
    }
  };

  const updateSystemVolume = async (value: number) => {
    const next = Math.max(0, Math.min(100, Math.round(value)));
    setSystemVolume(next);
    try {
      const result = await api<any>(
        `/hardware/system-volume?volume=${next}`,
        { method: "PUT" }
      );
      setDevices((current: any) => ({
        ...current,
        system_volume: result
      }));
    } catch (error: any) {
      onToast(error.message);
    }
  };

  const chooseLocation = async (location: any) => {
    await save(
      {
        location_name: location.name,
        latitude: location.latitude,
        longitude: location.longitude,
        timezone: location.timezone || "America/Chicago",
        location_mode: "manual"
      },
      `Location set to ${location.name}`
    );
    setLocationResults([]);
  };

  const connectCalendar = async () => {
    setBusy(true);
    try {
      const result = await api<any>("/calendar/connect", {
        method: "POST",
        ...jsonBody({
          username: calendarEmail,
          app_password: calendarPassword,
          display_name: calendarName
        })
      });
      setCalendars(result.calendars);
      setCalendarPassword("");
      onToast("iCloud connected");
    } catch (error: any) {
      onToast(error.message);
    } finally {
      setBusy(false);
    }
  };

  const tabs = setupMode
    ? ["welcome", "location", "calendar", "hardware", "security", "finish"]
    : [
        "general",
        "calendar",
        "weather",
        "hardware",
        "household",
        "network",
        "security",
        "backup",
        "system"
      ];

  if (!Object.keys(settings).length) {
    return <main class="page-screen glass loading">Loading settings…</main>;
  }

  return (
    <main class={`page-screen settings-screen glass ${setupMode ? "setup-mode" : ""}`}>
      <header class="page-header">
        <div>
          <h1>{setupMode ? "Welcome Home" : "Settings"}</h1>
          <p>
            {setupMode
              ? "A few steps will prepare your dashboard."
              : "Calendar, weather, hardware and security"}
          </p>
        </div>
      </header>
      <nav class="settings-tabs">
        {tabs.map((name) => (
          <button
            class={tab === name ? "active" : ""}
            onClick={() => setTab(name)}
          >
            {name[0].toUpperCase() + name.slice(1)}
          </button>
        ))}
      </nav>
      <div class="settings-content">
        {tab === "welcome" && (
          <>
            <SettingsCard title="Your household dashboard">
              <p>
                This wizard configures local weather, iCloud calendars, hardware
                and optional phone access. Every option can be changed later.
              </p>
              <TouchInput
                label="Household name"
                value={settings.household_name || ""}
                onChange={(value) =>
                  setSettings({ ...settings, household_name: value })
                }
              />
              <button
                class="button primary"
                onClick={() => {
                  save({ household_name: settings.household_name });
                  setTab("location");
                }}
              >
                Begin new setup
              </button>
            </SettingsCard>
            <SettingsCard title="Restore an existing dashboard">
              <p>
                Connect the backup USB drive, then enter the .hdbak file and its
                recovery password.
              </p>
              <button
                class="button secondary"
                onClick={async () => {
                  try {
                    setFoundBackups(await api("/backups/discover"));
                  } catch (error: any) {
                    onToast(error.message);
                  }
                }}
              >
                Find backups on connected USB drives
              </button>
              <div class="location-results">
                {foundBackups.map((backup) => (
                  <button onClick={() => setRestorePath(backup.path)}>
                    {backup.path}
                  </button>
                ))}
              </div>
              <TouchInput
                label="Backup file"
                value={restorePath}
                onChange={setRestorePath}
                placeholder="/media/dashboard/USB/home-dashboard-date.hdbak"
              />
              <TouchInput
                label="Recovery password"
                value={restorePassword}
                onChange={setRestorePassword}
                secret
              />
              <button
                class="button secondary"
                disabled={!restorePath || restorePassword.length < 10}
                onClick={async () => {
                  try {
                    await api("/backups/restore", {
                      method: "POST",
                      ...jsonBody({
                        path: restorePath,
                        password: restorePassword
                      })
                    });
                    onToast("Backup restored. Restarting…");
                    await api("/system/restart", { method: "POST" });
                  } catch (error: any) {
                    onToast(error.message);
                  }
                }}
              >
                Restore and restart
              </button>
            </SettingsCard>
          </>
        )}

        {tab === "general" && (
          <>
            <SettingsCard title="Appearance and time">
              <TouchInput
                label="Household name"
                value={settings.household_name || ""}
                onChange={(value) =>
                  setSettings({ ...settings, household_name: value })
                }
              />
              <SettingToggle
                label="24-hour clock"
                checked={settings.clock_24_hour}
                onChange={(value) =>
                  setSettings({ ...settings, clock_24_hour: value })
                }
              />
              <SettingToggle
                label="Reduced motion"
                checked={settings.reduced_motion}
                onChange={(value) =>
                  setSettings({ ...settings, reduced_motion: value })
                }
              />
              <label class="setting-select">
                <span>Animated weather background</span>
                <select
                  value={settings.weather_effects || "full"}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      weather_effects: event.currentTarget.value
                    })
                  }
                >
                  <option value="off">Off</option>
                  <option value="subtle">Subtle</option>
                  <option value="full">Full</option>
                </select>
              </label>
              <SettingToggle
                label="Enable on-screen keyboard"
                checked={settings.onscreen_keyboard_enabled}
                onChange={(value) =>
                  setSettings({
                    ...settings,
                    onscreen_keyboard_enabled: value
                  })
                }
              />
              <div class="background-preview-setting">
                <div>
                  <strong>Background preview</strong>
                  <p>Choose a base sky, then layer one or more effects for testing. Auto uses the live time and weather.</p>
                </div>
                <small>Base sky</small>
                <div class="background-preview-grid" role="group" aria-label="Background mode">
                  {[
                    ["auto", "Auto"],
                    ["morning", "Morning"],
                    ["day", "Day"],
                    ["sunset", "Sunset"],
                    ["night", "Night + moon"]
                  ].map(([value, label]) => (
                    <button
                      type="button"
                      class={settings.background_preview === value ? "active" : ""}
                      disabled={busy}
                      onClick={() =>
                        save(
                          { background_preview: value },
                          value === "auto"
                            ? "Automatic background restored"
                            : `${label} background selected`
                        )
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <small>Effect layers</small>
                <div class="background-effect-checklist">
                  {[
                    ["cloudy", "Clouds"],
                    ["rain", "Rain"],
                    ["storm", "Thunder & lightning"],
                    ["wind", "Wind gusts"],
                    ["snow", "Snow"],
                    ["fog", "Fog"]
                  ].map(([value, label]) => {
                    const selected = (
                      settings.background_preview_effects || []
                    ).includes(value);
                    return (
                      <label class={selected ? "active" : ""}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => {
                            const current: string[] =
                              settings.background_preview_effects || [];
                            const next = selected
                              ? current.filter((item) => item !== value)
                              : [...current, value];
                            save(
                              { background_preview_effects: next },
                              "Background effect preview updated"
                            );
                          }}
                        />
                        {label}
                      </label>
                    );
                  })}
                </div>
              </div>
              <SettingToggle
                label="Move completed reminders to the bottom"
                checked={settings.completed_reminders_last}
                onChange={(value) =>
                  setSettings({
                    ...settings,
                    completed_reminders_last: value
                  })
                }
              />
              <SettingToggle
                label="Show garbage pickup reminder"
                checked={settings.garbage_pickup_enabled}
                onChange={(value) =>
                  setSettings({
                    ...settings,
                    garbage_pickup_enabled: value
                  })
                }
              />
              {settings.garbage_pickup_enabled && (
                <label class="setting-select">
                  <span>Garbage pickup day</span>
                  <select
                    value={settings.garbage_pickup_weekday}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        garbage_pickup_weekday: Number(
                          event.currentTarget.value
                        )
                      })
                    }
                  >
                    {[
                      "Sunday",
                      "Monday",
                      "Tuesday",
                      "Wednesday",
                      "Thursday",
                      "Friday",
                      "Saturday"
                    ].map((day, index) => (
                      <option value={index}>{day}</option>
                    ))}
                  </select>
                </label>
              )}
              <button
                class="button primary"
                onClick={() =>
                  save({
                    household_name: settings.household_name,
                    clock_24_hour: settings.clock_24_hour,
                    reduced_motion: settings.reduced_motion,
                    weather_effects: settings.weather_effects,
                    background_preview: settings.background_preview || "auto",
                    onscreen_keyboard_enabled:
                      settings.onscreen_keyboard_enabled,
                    completed_reminders_last:
                      settings.completed_reminders_last,
                    garbage_pickup_enabled:
                      settings.garbage_pickup_enabled,
                    garbage_pickup_weekday:
                      settings.garbage_pickup_weekday
                  })
                }
              >
                Save
              </button>
            </SettingsCard>
          </>
        )}

        {(tab === "location" || tab === "weather") ? (
          <SettingsCard title="Location and weather">
            <p>
              Current location: <strong>{settings.location_name || "Not set"}</strong>
            </p>
            <button
              class="button secondary"
              onClick={async () => {
                try {
                  const location = await api<any>("/location/automatic", {
                    method: "POST"
                  });
                  await chooseLocation(location);
                } catch (error: any) {
                  onToast(error.message);
                }
              }}
            >
              Detect approximate location
            </button>
            <TouchInput
              label="City or ZIP code"
              value={locationSearch}
              onChange={setLocationSearch}
              placeholder="Example: Baton Rouge, LA"
            />
            <button
              class="button secondary"
              onClick={async () =>
                setLocationResults(
                  await api(`/location/search?query=${encodeURIComponent(locationSearch)}`)
                )
              }
            >
              Search
            </button>
            <div class="location-results">
              {locationResults.map((result) => (
                <button onClick={() => chooseLocation(result)}>{result.name}</button>
              ))}
            </div>
            {!setupMode && (
              <>
                <label class="setting-select">
                  <span>Temperature</span>
                  <select
                    value={settings.temperature_unit}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        temperature_unit: event.currentTarget.value
                      })
                    }
                  >
                    <option value="fahrenheit">Fahrenheit</option>
                    <option value="celsius">Celsius</option>
                  </select>
                </label>
                <div class="alert-preference-grid">
                  <strong>Weather alert controls</strong>
                  <span>Show</span>
                  <span>Audio</span>
                  {([
                    ["advisory", "Advisories"],
                    ["warning", "Warnings"],
                    ["emergency", "Emergencies"]
                  ] as [string, string][]).map(([key, label]) => (
                    <>
                      <b>{label}</b>
                      <SettingToggle
                        label={`Show ${label.toLowerCase()}`}
                        compact
                        checked={settings[`alert_${key}_enabled`]}
                        onChange={(value) =>
                          setSettings({
                            ...settings,
                            [`alert_${key}_enabled`]: value
                          })
                        }
                      />
                      <SettingToggle
                        label={`${label} audio`}
                        compact
                        checked={settings[`alert_${key}_audio`]}
                        onChange={(value) =>
                          setSettings({
                            ...settings,
                            [`alert_${key}_audio`]: value
                          })
                        }
                      />
                    </>
                  ))}
                </div>
                <p class="hint">
                  Emergency alerts wake the display. Disabled alert types are
                  retained in the sync cache but do not appear or sound.
                </p>
                <button
                  class="button primary"
                  onClick={() =>
                    save({
                      temperature_unit: settings.temperature_unit,
                      alert_advisory_enabled: settings.alert_advisory_enabled,
                      alert_warning_enabled: settings.alert_warning_enabled,
                      alert_emergency_enabled: settings.alert_emergency_enabled,
                      alert_advisory_audio: settings.alert_advisory_audio,
                      alert_warning_audio: settings.alert_warning_audio,
                      alert_emergency_audio: settings.alert_emergency_audio
                    })
                  }
                >
                  Save weather settings
                </button>
              </>
            )}
            {setupMode && (
              <button class="button primary" onClick={() => setTab("calendar")}>
                Continue
              </button>
            )}
          </SettingsCard>
        ) : null}

        {tab === "calendar" && (
          <>
            <SettingsCard title="Connect iCloud">
              <p>
                Use your Apple Account email and an app-specific password—not
                your normal Apple password.
              </p>
              <TouchInput
                label="Account name"
                value={calendarName}
                onChange={setCalendarName}
              />
              <TouchInput
                label="Apple Account email"
                value={calendarEmail}
                onChange={setCalendarEmail}
              />
              <TouchInput
                label="App-specific password"
                value={calendarPassword}
                onChange={setCalendarPassword}
                secret
              />
              <button
                class="button primary"
                disabled={!calendarEmail || !calendarPassword || busy}
                onClick={connectCalendar}
              >
                Test and connect
              </button>
            </SettingsCard>
            {calendars.length > 0 && (
              <SettingsCard title="Visible calendars">
                <button
                  class="button secondary"
                  onClick={async () => {
                    try {
                      const values = await api<any[]>(
                        "/calendar/rediscover",
                        { method: "POST" }
                      );
                      setCalendars(values);
                      onToast(
                        `Calendar list refreshed — ${values.length} found`
                      );
                    } catch (error: any) {
                      onToast(error.message);
                    }
                  }}
                >
                  Refresh calendar list
                </button>
                {calendars.map((calendar) => (
                  <label
                    class={`calendar-setting-row ${
                      calendar.available ? "" : "unavailable"
                    }`}
                  >
                    <input
                      type="checkbox"
                      disabled={!calendar.available}
                      checked={Boolean(calendar.enabled)}
                      onChange={(event) =>
                        setCalendars((items) =>
                          items.map((item) =>
                            item.id === calendar.id
                              ? { ...item, enabled: event.currentTarget.checked }
                              : item
                          )
                        )
                      }
                    />
                    <input
                      type="color"
                      value={calendar.color}
                      onChange={(event) =>
                        setCalendars((items) =>
                          items.map((item) =>
                            item.id === calendar.id
                              ? { ...item, color: event.currentTarget.value }
                              : item
                          )
                        )
                      }
                    />
                    <span>
                      {calendar.name}
                      {calendar.shared ? " · Shared with me" : ""}
                      {!calendar.available ? " · No longer available" : ""}
                    </span>
                  </label>
                ))}
                <button
                  class="button primary"
                  onClick={async () => {
                    await api("/calendar/calendars", {
                      method: "PUT",
                      ...jsonBody({
                        enabled_ids: calendars
                          .filter((item) => item.enabled)
                          .map((item) => item.id),
                        colors: Object.fromEntries(
                          calendars.map((item) => [item.id, item.color])
                        )
                      })
                    });
                    onToast("Calendar selection saved");
                  }}
                >
                  Save calendars
                </button>
              </SettingsCard>
            )}
            {setupMode && (
              <div class="button-row">
                <button class="button primary" onClick={() => setTab("hardware")}>
                  Continue
                </button>
                <button class="button secondary" onClick={() => setTab("hardware")}>
                  Connect calendar later
                </button>
              </div>
            )}
          </>
        )}

        {tab === "hardware" && (
          <>
            <SettingsCard title="Motion and display">
              <SettingToggle
                label="Enable PIR motion sensor"
                checked={settings.motion_enabled}
                onChange={(value) =>
                  setSettings({ ...settings, motion_enabled: value })
                }
              />
              <div
                class={`motion-indicator ${
                  motionStatus?.error
                    ? "error"
                    : motionStatus?.active
                      ? "active"
                      : ""
                }`}
              >
                <i />
                <div>
                  <strong>
                    {motionStatus?.error
                      ? "PIR needs attention"
                      : motionStatus?.active
                        ? "Motion detected"
                        : motionStatus?.running
                          ? "Watching for motion"
                          : "PIR not running"}
                  </strong>
                  <small>
                    {motionStatus?.error ||
                      `BCM ${motionStatus?.pin ?? settings.motion_gpio_bcm}${
                        motionStatus?.pin_factory
                          ? ` · ${motionStatus.pin_factory}`
                          : ""
                      } · raw GPIO ${
                        motionStatus?.raw_value == null
                          ? "unavailable"
                          : `${motionStatus.raw_value} (${
                              motionStatus.raw_value ? "HIGH" : "LOW"
                            })`
                      } · ${motionStatus?.read_count ?? 0} reads`}
                  </small>
                </div>
              </div>
              <div class="button-row">
                <button
                  class="button secondary"
                  disabled={motionTest?.running}
                  onClick={async () => {
                    const samples: number[] = [];
                    let transitions = 0;
                    let previous: number | null = null;
                    setMotionTest({ running: true, samples: [], transitions: 0 });
                    try {
                      for (let index = 0; index < 25; index += 1) {
                        const value = await api<any>("/hardware/motion");
                        if (value.raw_value != null) {
                          const raw = Number(value.raw_value);
                          samples.push(raw);
                          if (previous != null && raw !== previous) transitions += 1;
                          previous = raw;
                        }
                        await new Promise((resolve) => window.setTimeout(resolve, 200));
                      }
                      setMotionTest({ running: false, samples, transitions });
                    } catch (error: any) {
                      setMotionTest({ running: false, samples, transitions });
                      onToast(error.message);
                    }
                  }}
                >
                  {motionTest?.running ? "Watching sensor…" : "Test PIR for 5 seconds"}
                </button>
              </div>
              {motionTest && !motionTest.running && (
                <p
                  class={`hardware-test-result ${
                    motionTest.transitions ? "success" : ""
                  }`}
                >
                  {motionTest.samples.length
                    ? `Read ${motionTest.samples.length} samples: ${
                        motionTest.samples.includes(0) ? "LOW" : ""
                      }${
                        motionTest.samples.includes(0) &&
                        motionTest.samples.includes(1)
                          ? " and "
                          : ""
                      }${
                        motionTest.samples.includes(1) ? "HIGH" : ""
                      }. ${motionTest.transitions} signal transition${
                        motionTest.transitions === 1 ? "" : "s"
                      } observed.`
                    : "No GPIO values were returned. Check the sensor power, ground, BCM pin, and service log."}
                </p>
              )}
              <SettingToggle
                label="Sensor output is active-high (HC-SR501 default)"
                checked={settings.motion_active_high !== false}
                onChange={(value) =>
                  setSettings({ ...settings, motion_active_high: value })
                }
              />
              <SettingStepper
                label="BCM GPIO pin"
                value={Number(settings.motion_gpio_bcm)}
                min={2}
                max={27}
                onChange={(value) =>
                  setSettings({ ...settings, motion_gpio_bcm: value })
                }
              />
              <label class="setting-select">
                <span>Sleep method</span>
                <select
                  value={settings.display_sleep_mode}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      display_sleep_mode: event.currentTarget.value
                    })
                  }
                >
                  <option value="hdmi">Turn HDMI off</option>
                  <option value="blank">Blank screen</option>
                </select>
              </label>
              <SettingStepper
                label="Sleep after"
                value={Math.round(settings.motion_timeout_seconds / 60)}
                min={1}
                max={120}
                suffix="minutes"
                onChange={(value) =>
                  setSettings({
                    ...settings,
                    motion_timeout_seconds: value * 60
                  })
                }
              />
              <div class="button-row">
                <button
                  class="button secondary"
                  onClick={async () => {
                    const result = await api<any>("/hardware/test", {
                      method: "POST",
                      ...jsonBody({ kind: "display_off" })
                    });
                    setDevices((current: any) => ({
                      ...current,
                      display_status: result
                    }));
                    onToast(
                      result.success
                        ? "Display test started — PIR is ignored for 5 seconds"
                        : `Display test failed: ${result.last_error || "display output unavailable"}`
                    );
                  }}
                >
                  Test display off
                </button>
                <button
                  class="button secondary"
                  onClick={() =>
                    api("/hardware/test", {
                      method: "POST",
                      ...jsonBody({ kind: "display_on" })
                    })
                  }
                >
                  Display on
                </button>
              </div>
              <p class="hint display-test-safety">
                During this test, touch the screen, press a key, scan a barcode,
                or trigger the PIR sensor to wake the display. It will also turn
                itself back on automatically after 15 seconds. PIR input is
                intentionally ignored for the first 5 seconds so you can confirm
                that the display actually turned off.
              </p>
              {devices.display_status?.last_error && (
                <p class="hardware-test-result error">
                  Last display error: {devices.display_status.last_error}
                </p>
              )}
            </SettingsCard>
            <SettingsCard title="Barcode scanner and audio">
              <div class="button-row">
                <button
                  class="button secondary"
                  onClick={async () => {
                    const refreshed = await api<any>("/hardware/devices");
                    setDevices(refreshed);
                    const candidates = (refreshed.input_devices || []).filter(
                      (device: any) => device.candidate === "true"
                    );
                    onToast(
                      candidates.length
                        ? `Detected ${candidates.length} likely barcode scanner${candidates.length === 1 ? "" : "s"}`
                        : `Found ${refreshed.input_devices?.length || 0} HID input device(s); use Test barcode scanner to confirm`
                    );
                  }}
                >
                  Scan for hardware
                </button>
                <button
                  class="button secondary"
                  onClick={() => {
                    setScannerTest("Waiting for a barcode…");
                    scannerTestMode.value = true;
                  }}
                >
                  Test barcode scanner
                </button>
              </div>
              {scannerTest && <p class="hardware-test-result">{scannerTest}</p>}
              {(devices.input_devices || [])
                .filter((device: any) => device.candidate === "true")
                .map((device: any) => (
                  <p class="hardware-test-result">
                    Scanner detected: {device.name}
                  </p>
                ))}
              {devices.platform === "Windows" && (
                <p class="hint">
                  Windows scanners use keyboard-wedge capture. The scan test is
                  the definitive check even if the device has a generic HID name.
                </p>
              )}
              {devices.platform !== "Windows" && <label class="setting-select">
                <span>Scanner input device</span>
                <select
                  value={settings.scanner_device}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      scanner_device: event.currentTarget.value
                    })
                  }
                >
                  <option value="">Select during hardware setup</option>
                  {devices.input_devices?.map((device: any) => (
                    <option
                      value={device.selectable === "false" ? "" : device.path}
                    >
                      {device.name} — {device.path}
                    </option>
                  ))}
                </select>
              </label>}
              <label class="setting-select">
                <span>Audio output</span>
                <select
                  value={settings.audio_output || "default"}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      audio_output: event.currentTarget.value
                    })
                  }
                >
                  {(devices.audio_outputs || [{ id: "default", name: "System default" }]).map(
                    (output: any) => (
                      <option value={output.id}>{output.name}</option>
                    )
                  )}
                </select>
              </label>
              <p class="hint">
                “Desktop default” uses Raspberry Pi OS PipeWire first and falls
                back to ALSA. Connect and power the HDMI monitor before scanning,
                then save before testing sound.
              </p>
              <div class="system-volume-control">
                <div>
                  <strong>Raspberry Pi system volume</strong>
                  <span>{systemVolume}%</span>
                </div>
                <div>
                  <button
                    type="button"
                    disabled={!devices.system_volume?.available}
                    onClick={() => updateSystemVolume(systemVolume - 5)}
                    aria-label="Lower system volume"
                  >
                    −
                  </button>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={systemVolume}
                    disabled={!devices.system_volume?.available}
                    onInput={(event) =>
                      setSystemVolume(Number(event.currentTarget.value))
                    }
                    onChange={(event) =>
                      updateSystemVolume(Number(event.currentTarget.value))
                    }
                    aria-label="Raspberry Pi system volume"
                  />
                  <button
                    type="button"
                    disabled={!devices.system_volume?.available}
                    onClick={() => updateSystemVolume(systemVolume + 5)}
                    aria-label="Raise system volume"
                  >
                    +
                  </button>
                </div>
                {!devices.system_volume?.available && (
                  <small>
                    System mixer control is available on the Raspberry Pi.
                  </small>
                )}
              </div>
              {devices.audio_status?.last_error && (
                <p class="hardware-test-result error">
                  Last audio error: {devices.audio_status.last_error}
                </p>
              )}
              <div class="button-row">
                <button
                  class="button secondary"
                  onClick={() => testAudio("timer_audio")}
                >
                  Test timer sound
                </button>
                <button
                  class="button secondary"
                  onClick={() => testAudio("alert_audio")}
                >
                  Test emergency sound
                </button>
              </div>
              <h3>Weather alert previews</h3>
              <p class="hint">
                These previews are not saved. Each includes the same visual and
                audio pattern used by a real advisory, warning, or emergency.
              </p>
              <div class="button-row">
                {[
                  ["weather_advisory", "Preview advisory"],
                  ["weather_warning", "Preview warning"],
                  ["weather_emergency", "Preview emergency"]
                ].map(([kind, label]) => (
                  <button
                    class="button secondary"
                    onClick={() =>
                      api("/hardware/test", {
                        method: "POST",
                        ...jsonBody({ kind })
                      })
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                class="button primary"
                onClick={() =>
                  save({
                    motion_enabled: settings.motion_enabled,
                    motion_gpio_bcm: settings.motion_gpio_bcm,
                    motion_active_high: settings.motion_active_high !== false,
                    motion_timeout_seconds: settings.motion_timeout_seconds,
                    display_sleep_mode: settings.display_sleep_mode,
                    scanner_device: settings.scanner_device,
                    audio_output: settings.audio_output || "default"
                  })
                }
              >
                Save hardware settings
              </button>
            </SettingsCard>
            {!setupMode && metrics && (
              <SettingsCard title="Hardware utilization">
                <div class="metric-grid">
                  {[
                    ["CPU", metrics.cpu_percent, `${metrics.cpu_count} cores`],
                    ["Memory", metrics.memory_percent, `${metrics.memory_used_gb} / ${metrics.memory_total_gb} GB`],
                    ["Storage", metrics.storage_percent, `${metrics.storage_used_gb} / ${metrics.storage_total_gb} GB`]
                  ].map(([label, percent, detail]) => (
                    <article>
                      <span><strong>{label}</strong><b>{percent}%</b></span>
                      <progress max="100" value={Number(percent)} />
                      <small>{detail}</small>
                    </article>
                  ))}
                </div>
                <p class="hint">
                  {metrics.platform} · Uptime since {new Date(metrics.boot_time).toLocaleString()}
                  {metrics.cpu_temperature_c != null ? ` · CPU ${metrics.cpu_temperature_c}°C` : ""}
                </p>
                <button class="button secondary" onClick={() => api<any>("/system/metrics").then(setMetrics)}>
                  Refresh utilization
                </button>
              </SettingsCard>
            )}
            {setupMode && (
              <button class="button primary" onClick={() => setTab("security")}>
                Continue
              </button>
            )}
          </>
        )}

        {tab === "household" && (
          <SettingsCard title="Household members">
            <p>
              These names are used for Week Planner chore assignments. Hold and
              drag a member chip onto a chore to assign it.
            </p>
            <div class="household-member-form">
              <TouchInput
                label="Member name"
                value={memberName}
                onChange={setMemberName}
                placeholder="Name"
              />
              <button
                class="button primary"
                disabled={!memberName.trim()}
                onClick={async () => {
                  try {
                    const created = await api<HouseholdMember>(
                      "/household/members",
                      {
                        method: "POST",
                        ...jsonBody({ name: memberName, color: memberColor })
                      }
                    );
                    setHouseholdMembers([...householdMembers, created]);
                    setMemberName("");
                    onToast(`${created.name} added`);
                  } catch (error: any) {
                    onToast(error.message);
                  }
                }}
              >
                Add member
              </button>
              <fieldset class="pastel-picker member-pastel-picker">
                <legend>Color</legend>
                {PLANNER_PASTELS.map((color) => (
                  <button
                    type="button"
                    class={memberColor === color ? "active" : ""}
                    style={{ "--swatch": color }}
                    aria-label={`Choose ${color}`}
                    aria-pressed={memberColor === color}
                    onClick={() => setMemberColor(color)}
                  />
                ))}
              </fieldset>
            </div>
            <div class="household-member-list">
              {householdMembers.length === 0 && (
                <p class="empty">No household members yet.</p>
              )}
              {householdMembers.map((member) => (
                <article>
                  <i style={{ background: member.color }} />
                  <strong>{member.name}</strong>
                  <div>
                    <button
                      class="button secondary"
                      onClick={() => {
                        setEditMember(member);
                        setEditMemberName(member.name);
                        setEditMemberColor(member.color);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      class="button danger"
                      onClick={() => setDeleteMember(member)}
                    >
                      Remove
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </SettingsCard>
        )}

        {tab === "network" && (
          <>
          <SettingsCard title="Mobile Dash address">
            <p>
              Choose the local or VPN address shown in the home-screen reminder.
              BodaDash listens on every active interface, so changing this choice
              takes effect immediately and does not require a reboot.
            </p>
            <label class="settings-field">
              <span>Displayed IPv4 address</span>
              <select
                value={settings.mobile_dash_ipv4 || ""}
                onChange={(event) => {
                  const value = (event.currentTarget as HTMLSelectElement).value;
                  setSettings({ ...settings, mobile_dash_ipv4: value });
                  save({ mobile_dash_ipv4: value }, "Mobile Dash address updated");
                }}
              >
                <option value="">Automatic (recommended)</option>
                {interfaces.map((item) => (
                  <option value={item.address}>{item.interface} — {item.address}</option>
                ))}
              </select>
            </label>
            {!interfaces.length && <p class="hint">No active non-loopback IPv4 addresses were found.</p>}
            {networkInfo?.listening_host === "0.0.0.0" && (
              <p class="hardware-test-result">
                Mobile server active on all listed IPv4 addresses · port {networkInfo.port}
              </p>
            )}
          </SettingsCard>
          <SettingsCard title="Wi-Fi">
            <button
              class="button secondary"
              onClick={async () => {
                try {
                  setNetworks(await api("/network/wifi"));
                } catch (error: any) {
                  onToast(error.message);
                }
              }}
            >
              Scan networks
            </button>
            <div class="network-list">
              {networks.map((network) => (
                <button
                  class={selectedSsid === network.ssid ? "active" : ""}
                  onClick={() => setSelectedSsid(network.ssid)}
                >
                  <strong>{network.ssid}</strong>
                  <span>{network.signal}% · {network.security || "Open"}</span>
                </button>
              ))}
            </div>
            {selectedSsid && (
              <>
                <TouchInput
                  label={`${selectedSsid} password`}
                  value={wifiPassword}
                  onChange={setWifiPassword}
                  secret
                />
                <button
                  class="button primary"
                  onClick={async () => {
                    await api("/network/wifi", {
                      method: "POST",
                      ...jsonBody({ ssid: selectedSsid, password: wifiPassword })
                    });
                    onToast("Wi-Fi connection requested");
                  }}
                >
                  Connect
                </button>
              </>
            )}
          </SettingsCard>
          </>
        )}

        {tab === "security" && (
          <SettingsCard title="Phone access">
            <p>
              Phone access is optional. Set a numeric PIN before enabling it.
            </p>
            <TouchInput
              label="Access PIN"
              value={pin}
              onChange={(value) => setPin(value.replace(/\D/g, "").slice(0, 12))}
              secret
            />
            <button
              class="button primary"
              disabled={pin.length < 4}
              onClick={async () => {
                await api("/settings/pin", {
                  method: "PUT",
                  ...jsonBody({ pin })
                });
                setPin("");
                setSettings({ ...settings, remote_access_enabled: true });
                onToast("Phone access enabled");
              }}
            >
              Set PIN and enable
            </button>
            {settings.remote_access_enabled && (
              <button
                class="button secondary"
                onClick={() => save({ remote_access_enabled: false })}
              >
                Disable phone access
              </button>
            )}
            {setupMode && (
              <button class="button secondary" onClick={() => setTab("finish")}>
                Continue without phone access
              </button>
            )}
            {setupMode && settings.remote_access_enabled && (
              <button class="button primary" onClick={() => setTab("finish")}>
                Continue
              </button>
            )}
          </SettingsCard>
        )}

        {tab === "backup" && (
          <SettingsCard title="Encrypted USB backups">
            <p>
              Backups are optional. The recovery password is required to restore
              private settings and Apple credentials on a fresh installation.
            </p>
            <TouchInput
              label="USB backup folder"
              value={settings.backup_path || ""}
              onChange={(value) => setSettings({ ...settings, backup_path: value })}
              placeholder="/media/dashboard/BACKUPS"
            />
            <TouchInput
              label="Recovery password"
              value={backupPassword}
              onChange={setBackupPassword}
              secret
            />
            <div class="button-row">
              <button
                class="button primary"
                disabled={!settings.backup_path || backupPassword.length < 10}
                onClick={async () => {
                  await api("/backups/configure", {
                    method: "POST",
                    ...jsonBody({
                      enabled: true,
                      path: settings.backup_path,
                      password: backupPassword,
                      retention: settings.backup_retention || 7
                    })
                  });
                  setBackupPassword("");
                  setSettings({ ...settings, backup_enabled: true });
                  onToast("Automatic backups enabled");
                }}
              >
                Enable backups
              </button>
              <button
                class="button secondary"
                disabled={!settings.backup_enabled}
                onClick={async () => {
                  const result = await api<any>("/backups/run", { method: "POST" });
                  onToast(`Backup created: ${result.path}`);
                }}
              >
                Back up now
              </button>
              <button
                class="button danger"
                disabled={!settings.backup_enabled}
                onClick={async () => {
                  await api("/backups/configure", {
                    method: "POST",
                    ...jsonBody({
                      enabled: false,
                      path: settings.backup_path || "",
                      retention: settings.backup_retention || 7
                    })
                  });
                  setSettings({ ...settings, backup_enabled: false });
                  onToast("Automatic backups disabled");
                }}
              >
                Disable automatic backups
              </button>
            </div>
          </SettingsCard>
        )}

        {tab === "system" && (
          <>
            <SettingsCard title="Synchronization">
              <button
                class="button primary"
                onClick={async () => {
                  const result = await api<any>("/refresh", { method: "POST" });
                  setSyncDiagnostics(await api("/sync/status"));
                  onToast(
                    result.errors.length
                      ? result.errors
                          .map(
                            (error: any) =>
                              `${error.provider}: ${error.error}`
                          )
                          .join(" · ")
                      : "Everything is up to date"
                  );
                }}
              >
                Refresh all now
              </button>
              <p class="hint">
                Calendar: 5 minutes · conditions: 2 minutes · forecast: 10
                minutes · weather alerts: 1 minute
              </p>
              <div class="sync-provider-grid">
                {syncDiagnostics.providers.map((provider: any) => (
                  <article
                    class={provider.last_error ? "sync-error" : "sync-ok"}
                  >
                    <strong>{provider.provider.replace("_", " ")}</strong>
                    <span>
                      {provider.last_error ? "Needs attention" : "Up to date"}
                    </span>
                    <small>
                      Last success:{" "}
                      {provider.last_success_at
                        ? new Date(provider.last_success_at).toLocaleString()
                        : "Never"}
                    </small>
                    {provider.last_error && <code>{provider.last_error}</code>}
                  </article>
                ))}
              </div>
              <details class="sync-log">
                <summary>Recent synchronization log</summary>
                {syncDiagnostics.log.map((entry: any) => (
                  <div class={entry.status === "error" ? "error" : ""}>
                    <time>
                      {new Date(entry.attempted_at).toLocaleString()}
                    </time>
                    <strong>{entry.provider}</strong>
                    <span>{entry.status}</span>
                    {entry.message && <code>{entry.message}</code>}
                  </div>
                ))}
              </details>
            </SettingsCard>
            <SettingsCard title="Software">
              <p>Update BodaDash from the latest GitHub main branch with one tap. Raspberry Pi OS updates remain manual.</p>
              {updateStatus?.state && (
                <p class={`update-status update-${updateStatus.state}`}>
                  <strong>{updateStatus.state}</strong>
                  {updateStatus.message ? ` · ${updateStatus.message}` : ""}
                </p>
              )}
              <div class="button-row">
                <button
                  class="button primary"
                  disabled={updateStatus?.state === "running" || metrics?.platform !== "Linux"}
                  onClick={async () => {
                    try {
                      const result = await api<any>("/system/update", { method: "POST" });
                      window.sessionStorage.setItem("bodadash-update-pending", "1");
                      setUpdateStatus({ state: "running", message: result.message });
                      onToast("Update started. BodaDash will restart automatically.");
                    } catch (error: any) {
                      onToast(error.message);
                    }
                  }}
                >
                  {metrics?.platform === "Linux" ? "Update BodaDash" : "Update BodaDash (Raspberry Pi)"}
                </button>
              <button
                class="button secondary"
                onClick={() => api("/system/restart", { method: "POST" })}
              >
                Restart dashboard service
              </button>
              </div>
              <hr class="settings-divider" />
              <h3>Raspberry Pi desktop</h3>
              <p>
                Close the kiosk for this session to use Raspberry Pi OS. The
                dashboard kiosk launches automatically again on the next boot.
              </p>
              <button
                class="button danger"
                disabled={metrics?.platform !== "Linux"}
                onClick={() => setExitDesktopConfirm(true)}
              >
                Exit kiosk to desktop
              </button>
            </SettingsCard>
          </>
        )}

        {tab === "finish" && (
          <SettingsCard title="Setup complete">
            <p>
              The dashboard is ready. You can add a backup destination or refine
              any hardware option later from Settings.
            </p>
            <button
              class="button primary"
              onClick={async () => {
                onSetupStart?.();
                const saved = await save(
                  { setup_complete: true },
                  "Setup complete"
                );
                if (saved) await onSetupComplete?.();
                else onSetupAbort?.();
              }}
            >
              Open my dashboard
            </button>
          </SettingsCard>
        )}
      </div>
      {deleteMember && (
        <ConfirmDialog
          title="Remove household member?"
          message={`Remove ${deleteMember.name}? Their chore assignments will also be removed.`}
          confirmLabel="Remove member"
          cancelLabel="Keep member"
          onCancel={() => setDeleteMember(null)}
          onConfirm={async () => {
            await api(`/household/members/${deleteMember.id}`, {
              method: "DELETE"
            });
            setHouseholdMembers(
              householdMembers.filter((member) => member.id !== deleteMember.id)
            );
            setDeleteMember(null);
          }}
        />
      )}
      {editMember && (
        <Modal title="Edit household member" onClose={() => setEditMember(null)} wide>
          <div class="household-member-editor">
            <TouchInput
              label="Member name"
              value={editMemberName}
              onChange={setEditMemberName}
            />
            <fieldset class="pastel-picker">
              <legend>Color</legend>
              {PLANNER_PASTELS.map((color) => (
                <button
                  type="button"
                  class={editMemberColor === color ? "active" : ""}
                  style={{ "--swatch": color }}
                  aria-label={`Choose ${color}`}
                  aria-pressed={editMemberColor === color}
                  onClick={() => setEditMemberColor(color)}
                />
              ))}
            </fieldset>
            <button
              class="button primary full-width"
              disabled={!editMemberName.trim()}
              onClick={async () => {
                const updated = await api<HouseholdMember>(
                  `/household/members/${editMember.id}`,
                  {
                    method: "PUT",
                    ...jsonBody({
                      name: editMemberName,
                      color: editMemberColor
                    })
                  }
                );
                setHouseholdMembers(
                  householdMembers.map((member) =>
                    member.id === updated.id ? updated : member
                  )
                );
                setEditMember(null);
              }}
            >
              Save member
            </button>
          </div>
        </Modal>
      )}
      {exitDesktopConfirm && (
        <ConfirmDialog
          title="Exit to Raspberry Pi desktop?"
          message="This closes the dashboard kiosk for the current session. It will open automatically after the next reboot."
          confirmLabel="Exit to desktop"
          cancelLabel="Stay in dashboard"
          onCancel={() => setExitDesktopConfirm(false)}
          onConfirm={async () => {
            setExitDesktopConfirm(false);
            try {
              const result = await api<any>("/system/exit-kiosk", {
                method: "POST"
              });
              onToast(result.message);
            } catch (error: any) {
              onToast(error.message);
            }
          }}
        />
      )}
    </main>
  );
}

function SettingsCard({
  title,
  children
}: {
  title: string;
  children: any;
}) {
  return (
    <section class="settings-card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function SettingToggle({
  label,
  checked,
  onChange,
  compact = false
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  compact?: boolean;
}) {
  return (
    <label class={`setting-toggle ${compact ? "compact" : ""}`}>
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  );
}

function SettingStepper({
  label,
  value,
  min,
  max,
  suffix = "",
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  const bounded = (next: number) => Math.max(min, Math.min(max, next));
  return (
    <div class="setting-stepper">
      <span>{label}</span>
      <div>
        <button
          type="button"
          onClick={() => onChange(bounded(value - 1))}
          disabled={value <= min}
          aria-label={`Decrease ${label}`}
        >
          −
        </button>
        <strong>{value}</strong>
        {suffix && <small>{suffix}</small>}
        <button
          type="button"
          onClick={() => onChange(bounded(value + 1))}
          disabled={value >= max}
          aria-label={`Increase ${label}`}
        >
          +
        </button>
      </div>
    </div>
  );
}
