import { useEffect, useMemo, useState } from "preact/hooks";
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
  const [screen, setScreen] = useState<Screen>("home");
  const [refreshToken, setRefreshToken] = useState(0);
  const [homeKey, setHomeKey] = useState(0);
  const [weather, setWeather] = useState<Weather | null>(null);
  const [alerts, setAlerts] = useState<WeatherAlert[]>([]);
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

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
  };

  const loadStatus = () =>
    api<Status>("/status")
      .then(setStatus)
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
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!status?.authenticated) return;
    loadAtmosphere();
    return openEventSocket((event, payload: any) => {
      if (
        event.endsWith(".updated") ||
        event === "timer.finished" ||
        event === "backup.completed"
      ) {
        setRefreshToken((value) => value + 1);
      }
      if (event === "settings.updated") loadStatus();
      if (event === "weather.updated" || event === "alerts.updated") {
        loadAtmosphere();
        if (payload?.emergency) setShowAlertDialog(true);
      }
      if (event === "timer.finished") setTimerAlert(payload as Timer);
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
  }, [status?.authenticated]);

  const beginScan = async (barcode: string) => {
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
      await loadAtmosphere();
      showToast(
        result.errors.length
          ? "Refresh completed with an offline service"
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
        reduced={false}
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
            onNavigate={(value) => setScreen(value as Screen)}
            onToast={showToast}
            onRefresh={refreshAll}
            clock24Hour={status.clock_24_hour}
            garbagePickupEnabled={status.garbage_pickup_enabled}
            garbagePickupWeekday={status.garbage_pickup_weekday}
            reducedMotion={status.reduced_motion}
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
          <WeatherScreen refreshToken={refreshToken} onToast={showToast} />
        )}
        {screen === "settings" && (
          <SettingsScreen onToast={showToast} />
        )}
      </div>

      {showAlertDialog && (emergency || regularAlert) && (
        <Modal
          title={emergency ? "Emergency Weather Alert" : "Weather Alert"}
          danger
        >
          <article class="active-alert">
            <h2>{(emergency || regularAlert).event}</h2>
            <h3>{(emergency || regularAlert).headline}</h3>
            <p>{(emergency || regularAlert).description}</p>
            {(emergency || regularAlert).instruction && (
              <p class="alert-instruction">
                {(emergency || regularAlert).instruction}
              </p>
            )}
            <small>
              Expires{" "}
              {new Date((emergency || regularAlert).expires_at).toLocaleString()}
            </small>
            <button
              class="button primary full-width"
              onClick={async () => {
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
          display={"•".repeat(pin.length)}
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
