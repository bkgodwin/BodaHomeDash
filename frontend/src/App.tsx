import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, jsonBody, openEventSocket } from "./api";
import { Modal } from "./components/Modal";
import { NumberPad } from "./components/TouchKeyboard";
import { ProductEntry, ProductSeed } from "./components/ProductEntry";
import { WeatherCanvas } from "./components/WeatherCanvas";
import { HomeScreen } from "./screens/HomeScreen";
import { PantryScreen } from "./screens/PantryScreen";
import { RemindersScreen } from "./screens/RemindersScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { ShoppingScreen } from "./screens/ShoppingScreen";
import { WeatherScreen } from "./screens/WeatherScreen";
import { timeOfDayTheme } from "./theme";
import { onScreenKeyboardEnabled } from "./inputPreferences";
import {
  installScannerCapture,
  scannerQuickMode,
  scannerTestMode
} from "./scannerCapture";
import {
  Status,
  Timer,
  Weather,
  WeatherAlert
} from "./types";

type Screen =
  | "home"
  | "pantry"
  | "shopping"
  | "reminders"
  | "weather"
  | "settings";

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [screen, setScreen] = useState<Screen>(() => {
    const requested = new URLSearchParams(window.location.search).get("screen");
    return ["home", "pantry", "shopping", "reminders", "weather", "settings"].includes(
      requested || ""
    )
      ? (requested as Screen)
      : "home";
  });
  const [refreshToken, setRefreshToken] = useState(0);
  const [weatherRefreshToken, setWeatherRefreshToken] = useState(0);
  const [homeKey, setHomeKey] = useState(0);
  const [weather, setWeather] = useState<Weather | null>(null);
  const [alerts, setAlerts] = useState<WeatherAlert[]>([]);
  const [previewAlert, setPreviewAlert] = useState<WeatherAlert | null>(null);
  const [timerAlert, setTimerAlert] = useState<Timer | null>(null);
  const [showAlertDialog, setShowAlertDialog] = useState(false);
  const [toast, setToast] = useState("");
  const [blanked, setBlanked] = useState(false);
  const [themeClock, setThemeClock] = useState(() => new Date());
  const [scanned, setScanned] = useState<{
    barcode: string;
    loading: boolean;
    seed?: ProductSeed;
  } | null>(null);
  const [scanDestination, setScanDestination] = useState<
    "pantry" | "shopping" | null
  >(null);
  const toastTimer = useRef<number | null>(null);
  const [scanPromptOpen, setScanPromptOpen] = useState(false);

  const showToast = (message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => {
      setToast("");
      toastTimer.current = null;
    }, 3200);
  };

  const loadStatus = () =>
    api<Status>("/status")
      .then((value) => {
        onScreenKeyboardEnabled.value = value.onscreen_keyboard_enabled;
        setStatus(value);
      })
      .catch((error) => showToast(error.message));

  const loadAtmosphere = async (showOnApproach = false) => {
    try {
      const [forecast, activeAlerts] = await Promise.all([
        api<Weather | null>("/weather"),
        api<WeatherAlert[]>("/weather/alerts")
      ]);
      setWeather(forecast);
      setAlerts(activeAlerts);
      if (
        showOnApproach &&
        activeAlerts.some((alert) => !alert.dismissed)
      ) {
        setShowAlertDialog(true);
      }
    } catch {
      // Cached atmosphere remains visible.
    }
  };

  useEffect(() => {
    loadStatus();
    const timer = window.setInterval(() => setThemeClock(new Date()), 60_000);
    return () => {
      window.clearInterval(timer);
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!status?.authenticated) return;
    loadAtmosphere();
    const closeSocket = openEventSocket((event, payload: any) => {
      if (
        [
          "calendar.updated",
          "calendar.discovery.updated",
          "pantry.updated",
          "shopping.updated",
          "reminders.updated",
          "timers.updated",
          "settings.updated"
        ].includes(event) ||
        event === "timer.finished"
      ) {
        setRefreshToken((value) => value + 1);
      }
      if (event === "settings.updated") {
        loadStatus();
        loadAtmosphere();
      }
      if (event === "weather.updated" || event === "alerts.updated") {
        loadAtmosphere();
        if (event === "weather.updated") {
          setWeatherRefreshToken((value) => value + 1);
        }
        if (payload?.emergency) setShowAlertDialog(true);
      }
      if (event === "timer.finished") setTimerAlert(payload as Timer);
      if (event === "weather.alert.test") {
        setPreviewAlert(payload as WeatherAlert);
        setShowAlertDialog(true);
      }
      if (event === "display.lock") {
        setStatus((current) =>
          current ? { ...current, display_awake_lock: Boolean(payload.enabled) } : current
        );
      }
      if (event === "display.sleep") setBlanked(payload?.mode === "blank");
      if (event === "display.wake") {
        setBlanked(false);
        setScreen("home");
        setHomeKey((value) => value + 1);
        loadAtmosphere(true);
      }
      if (event === "barcode.scanned") {
        beginScan(payload.barcode);
      }
      if (event === "backup.completed") showToast("USB backup completed");
      if (event === "backup.failed") showToast(`Backup failed: ${payload.error}`);
    });
    const closeScanner = installScannerCapture((barcode) => {
      if (scannerTestMode.value) return;
      scannerQuickMode.value = false;
      setScanPromptOpen(false);
      beginScan(barcode);
    });
    return () => {
      closeSocket();
      closeScanner();
    };
  }, [status?.authenticated]);

  const beginScan = async (barcode: string) => {
    scannerTestMode.value = false;
    scannerQuickMode.value = false;
    setScanned({ barcode, loading: true });
    try {
      const result = await api<any>(
        `/barcodes/lookup?barcode=${encodeURIComponent(barcode)}`,
        { method: "POST" }
      );
      setScanned({
        barcode,
        loading: false,
        seed: result.found
          ? {
              product_id: result.product.id,
              barcode,
              name: result.product.name,
              brand: result.product.brand,
              category: result.product.category,
              package_size: result.product.package_size
            }
          : { barcode }
      });
    } catch (error: any) {
      setScanned({ barcode, loading: false, seed: { barcode } });
      showToast(error.message);
    }
  };

  const refreshAll = async () => {
    showToast("Refreshing…");
    try {
      const result = await api<any>("/refresh", { method: "POST" });
      setRefreshToken((value) => value + 1);
      setWeatherRefreshToken((value) => value + 1);
      await loadAtmosphere();
      showToast(
        result.errors.length
          ? result.errors
              .map((error: any) => `${error.provider}: ${error.error}`)
              .join(" · ")
          : "Everything is up to date"
      );
    } catch (error: any) {
      showToast(error.message);
    }
  };

  const background = useMemo(
    () => timeOfDayTheme(themeClock, weather),
    [themeClock, weather]
  );

  if (!status) return <div class="startup-screen">Starting Home Dashboard…</div>;
  if (!status.authenticated)
    return <PinLogin onSuccess={loadStatus} onToast={showToast} />;
  if (!status.setup_complete && status.local)
    return (
      <div
        class="app-shell setup-shell"
        style={{
          "--sky-top": background[0],
          "--sky-bottom": background[1]
        }}
      >
        <SettingsScreen
          setupMode
          onToast={showToast}
          onSetupComplete={loadStatus}
        />
        {toast && <div class="toast">{toast}</div>}
      </div>
    );

  const visibleAlerts = alerts.filter((alert) => !alert.dismissed);
  const emergency = visibleAlerts.find((alert) => alert.severity === "Extreme");
  const regularAlert = visibleAlerts[0];
  const dialogAlert = previewAlert || emergency || regularAlert;

  return (
    <div
      class="app-shell"
      style={{
        "--sky-top": background[0],
        "--sky-bottom": background[1]
      }}
    >
      <WeatherCanvas
        code={Number(weather?.current?.weather_code || 0)}
        reduced={status.reduced_motion}
        effect={status.weather_effects}
        windSpeed={Number(weather?.current?.wind_speed_10m || 0)}
        isDay={Boolean(Number(weather?.current?.is_day ?? 1))}
        cloudCover={Number(weather?.current?.cloud_cover || 0)}
      />
      <nav class="main-nav glass">
        <button
          class={screen === "home" ? "active" : ""}
          onClick={() => setScreen("home")}
        >
          <span>⌂</span> Calendar
        </button>
        <button
          class={screen === "pantry" ? "active" : ""}
          onClick={() => setScreen("pantry")}
        >
          <span>▦</span> Pantry
        </button>
        <button
          class={screen === "shopping" ? "active" : ""}
          onClick={() => setScreen("shopping")}
        >
          <span>✓</span> Shopping
        </button>
        <button
          class={screen === "reminders" ? "active" : ""}
          onClick={() => setScreen("reminders")}
        >
          <span>☑</span> Reminders
        </button>
        <button
          class={screen === "weather" ? "active" : ""}
          onClick={() => setScreen("weather")}
        >
          <span>☀</span> Weather
        </button>
        {status.local && (
          <button
            class={screen === "settings" ? "active" : ""}
            onClick={() => setScreen("settings")}
          >
            <span>⚙</span> Settings
          </button>
        )}
      </nav>
      <div class="screen-host">
        {screen === "home" && (
          <HomeScreen
            key={homeKey}
            refreshToken={refreshToken}
            weatherRefreshToken={weatherRefreshToken}
            onNavigate={(value) => setScreen(value as Screen)}
            onToast={showToast}
            onRefresh={refreshAll}
            clock24Hour={status.clock_24_hour}
            garbagePickupEnabled={status.garbage_pickup_enabled}
            garbagePickupWeekday={status.garbage_pickup_weekday}
            reducedMotion={status.reduced_motion}
            awakeLock={status.display_awake_lock}
            onToggleAwakeLock={async () => {
              const result = await api<{ enabled: boolean }>(
                `/display/awake-lock?enabled=${!status.display_awake_lock}`,
                { method: "PUT" }
              );
              setStatus({ ...status, display_awake_lock: result.enabled });
              showToast(result.enabled ? "Display locked awake" : "Automatic sleep restored");
            }}
            onScanNow={() => {
              scannerQuickMode.value = true;
              setScanPromptOpen(true);
            }}
          />
        )}
        {screen === "pantry" && (
          <PantryScreen refreshToken={refreshToken} onToast={showToast} />
        )}
        {screen === "shopping" && (
          <ShoppingScreen refreshToken={refreshToken} onToast={showToast} />
        )}
        {screen === "reminders" && (
          <RemindersScreen refreshToken={refreshToken} onToast={showToast} />
        )}
        {screen === "weather" && (
          <WeatherScreen
            refreshToken={refreshToken + weatherRefreshToken}
            onToast={showToast}
          />
        )}
        {screen === "settings" && (
          <SettingsScreen onToast={showToast} />
        )}
      </div>
      {screen === "home" && (
        <footer class="app-credits" aria-label="Dashboard information">
          <span>Mobile Dash @ {status.mobile_dash_address}</span>
          <span>BodaDash | Made by Ben Godwin for Koda Godwin | Open Source | V1.0 (July 2026)</span>
        </footer>
      )}

      {showAlertDialog && (previewAlert || emergency || regularAlert) && (
        <Modal
          title={
            previewAlert
              ? "Weather Alert Preview"
              : emergency
                ? "Emergency Weather Alert"
                : "Weather Alert"
          }
          severity={
            dialogAlert?.severity === "Extreme"
              ? "emergency"
              : dialogAlert?.severity === "Severe"
                ? "warning"
                : "advisory"
          }
        >
          <article class="active-alert">
            <h2>{(previewAlert || emergency || regularAlert).event}</h2>
            <h3>{(previewAlert || emergency || regularAlert).headline}</h3>
            <p>{(previewAlert || emergency || regularAlert).description}</p>
            {(previewAlert || emergency || regularAlert).instruction && (
              <p class="alert-instruction">
                {(previewAlert || emergency || regularAlert).instruction}
              </p>
            )}
            <small>
              Expires{" "}
              {new Date((previewAlert || emergency || regularAlert).expires_at).toLocaleString()}
            </small>
            <button
              class="button primary full-width"
              onClick={async () => {
                if (previewAlert) {
                  setPreviewAlert(null);
                  setShowAlertDialog(false);
                  return;
                }
                await api(
                  `/weather/alerts/${encodeURIComponent((emergency || regularAlert).alert_id)}/dismiss`,
                  { method: "POST" }
                );
                await loadAtmosphere();
                setShowAlertDialog(false);
              }}
            >
              Dismiss alert
            </button>
          </article>
        </Modal>
      )}

      {timerAlert && (
        <Modal title="Timer Finished">
          <div class="timer-finished-dialog">
            <div class="timer-bell">♪</div>
            <h2>{timerAlert.label}</h2>
            <button
              class="button primary"
              onClick={async () => {
                await api(`/timers/${timerAlert.id}`, { method: "DELETE" });
                setTimerAlert(null);
                setRefreshToken((value) => value + 1);
              }}
            >
              Dismiss timer
            </button>
          </div>
        </Modal>
      )}

      {scanned && !scanDestination && (
        <Modal title="Barcode Scanned" onClose={() => setScanned(null)}>
          {scanned.loading ? (
            <p class="loading">Looking up {scanned.barcode}…</p>
          ) : (
            <div class="scan-choice">
              <p>
                {scanned.seed?.name || `Unknown product ${scanned.barcode}`}
              </p>
              <button
                class="button primary"
                onClick={() => setScanDestination("pantry")}
              >
                Add to Pantry
              </button>
              <button
                class="button secondary"
                onClick={() => setScanDestination("shopping")}
              >
                Add to Shopping List
              </button>
            </div>
          )}
        </Modal>
      )}
      {scanPromptOpen && !scanned && (
        <Modal
          title="Scan a barcode"
          onClose={() => {
            scannerTestMode.value = false;
            scannerQuickMode.value = false;
            setScanPromptOpen(false);
          }}
        >
          <div class="scan-now-dialog">
            <div class="scan-now-icon">▥</div>
            <h2>Scan now</h2>
            <p>Hold a product barcode in front of the USB scanner.</p>
            <p class="hint">The item options will open automatically.</p>
            <button
              type="button"
              class="button cancel-action"
              onClick={() => {
                scannerTestMode.value = false;
                scannerQuickMode.value = false;
                setScanPromptOpen(false);
              }}
            >
              Cancel scanning
            </button>
          </div>
        </Modal>
      )}

      {scanned && scanDestination && (
        <ProductEntry
          seed={scanned.seed}
          destination={scanDestination}
          onClose={() => {
            setScanDestination(null);
            setScanned(null);
          }}
          onSaved={() => {
            showToast(
              scanDestination === "pantry"
                ? "Added to pantry"
                : "Added to shopping list"
            );
            setScanDestination(null);
            setScanned(null);
            setRefreshToken((value) => value + 1);
          }}
        />
      )}
      {toast && <div class="toast">{toast}</div>}
      {blanked && (
        <div class="blank-screen" aria-label="Display sleeping">
          <span />
        </div>
      )}
    </div>
  );
}

function PinLogin({
  onSuccess,
  onToast
}: {
  onSuccess: () => void;
  onToast: (message: string) => void;
}) {
  const [pin, setPin] = useState("");
  return (
    <div class="login-screen">
      <section class="login-card glass">
        <h1>Home Dashboard</h1>
        <p>Enter the household PIN.</p>
        <NumberPad
          value={pin}
          secret
          onChange={(value) => setPin(value.slice(0, 12))}
          onConfirm={async () => {
            try {
              await api("/auth/login", {
                method: "POST",
                ...jsonBody({ pin })
              });
              onSuccess();
            } catch (error: any) {
              setPin("");
              onToast(error.message);
            }
          }}
        />
      </section>
    </div>
  );
}
