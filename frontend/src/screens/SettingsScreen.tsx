import { useEffect, useState } from "preact/hooks";
import { api, jsonBody } from "../api";
import { TouchInput } from "../components/TouchInput";

interface Props {
  onToast: (message: string) => void;
  onSetupComplete?: () => void;
  setupMode?: boolean;
}

type Settings = Record<string, any>;

export function SettingsScreen({
  onToast,
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
  const [wifiPassword, setWifiPassword] = useState("");
  const [selectedSsid, setSelectedSsid] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [values, calendarValues, deviceValues] = await Promise.all([
      api<Settings>("/settings"),
      api<any[]>("/calendar/calendars"),
      api<any>("/hardware/devices")
    ]);
    setSettings(values);
    setCalendars(calendarValues);
    setDevices(deviceValues);
  };
  useEffect(() => {
    load().catch((error) => onToast(error.message));
  }, []);

  const save = async (values: Settings, message = "Settings saved") => {
    setBusy(true);
    try {
      const next = await api<Settings>("/settings", {
        method: "PATCH",
        ...jsonBody({ values })
      });
      setSettings(next);
      onToast(message);
    } catch (error: any) {
      onToast(error.message);
    } finally {
      setBusy(false);
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
                <p class="hint">
                  Extreme NWS alerts wake the display and sound once. Other alerts
                  appear the next time someone approaches.
                </p>
                <button
                  class="button primary"
                  onClick={() =>
                    save({ temperature_unit: settings.temperature_unit })
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
                {calendars.map((calendar) => (
                  <label class="calendar-setting-row">
                    <input
                      type="checkbox"
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
                    <span>{calendar.name}</span>
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
              <label class="setting-number">
                <span>BCM GPIO pin</span>
                <input
                  type="number"
                  min="2"
                  max="27"
                  value={settings.motion_gpio_bcm}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      motion_gpio_bcm: Number(event.currentTarget.value)
                    })
                  }
                />
              </label>
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
              <label class="setting-number">
                <span>Sleep after minutes</span>
                <input
                  type="number"
                  min="1"
                  max="120"
                  value={Math.round(settings.motion_timeout_seconds / 60)}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      motion_timeout_seconds:
                        Number(event.currentTarget.value) * 60
                    })
                  }
                />
              </label>
              <div class="button-row">
                <button
                  class="button secondary"
                  onClick={() =>
                    api("/hardware/test", {
                      method: "POST",
                      ...jsonBody({ kind: "display_off" })
                    })
                  }
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
            </SettingsCard>
            <SettingsCard title="Barcode scanner and audio">
              <label class="setting-select">
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
                    <option value={device.path}>
                      {device.name} — {device.path}
                    </option>
                  ))}
                </select>
              </label>
              <div class="button-row">
                <button
                  class="button secondary"
                  onClick={() =>
                    api("/hardware/test", {
                      method: "POST",
                      ...jsonBody({ kind: "timer_audio" })
                    })
                  }
                >
                  Test timer sound
                </button>
                <button
                  class="button secondary"
                  onClick={() =>
                    api("/hardware/test", {
                      method: "POST",
                      ...jsonBody({ kind: "alert_audio" })
                    })
                  }
                >
                  Test emergency alert
                </button>
              </div>
              <button
                class="button primary"
                onClick={() =>
                  save({
                    motion_enabled: settings.motion_enabled,
                    motion_gpio_bcm: settings.motion_gpio_bcm,
                    motion_timeout_seconds: settings.motion_timeout_seconds,
                    display_sleep_mode: settings.display_sleep_mode,
                    scanner_device: settings.scanner_device
                  })
                }
              >
                Save hardware settings
              </button>
            </SettingsCard>
            {setupMode && (
              <button class="button primary" onClick={() => setTab("security")}>
                Continue
              </button>
            )}
          </>
        )}

        {tab === "network" && (
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
                  onToast(
                    result.errors.length
                      ? `Refresh finished with ${result.errors.length} error(s)`
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
            </SettingsCard>
            <SettingsCard title="Software">
              <p>Application updates and Raspberry Pi OS updates are manual.</p>
              <button
                class="button secondary"
                onClick={() => api("/system/restart", { method: "POST" })}
              >
                Restart dashboard service
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
                await save({ setup_complete: true }, "Setup complete");
                onSetupComplete?.();
              }}
            >
              Open my dashboard
            </button>
          </SettingsCard>
        )}
      </div>
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
  onChange
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label class="setting-toggle">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  );
}
