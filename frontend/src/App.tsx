import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, jsonBody, openEventSocket } from "./api";
import { Modal } from "./components/Modal";
import { MobileBarcodeScanner } from "./components/MobileBarcodeScanner";
import { NumberPad } from "./components/TouchKeyboard";
import { ProductEntry, ProductSeed } from "./components/ProductEntry";
import { SharedNotepad } from "./components/SharedNotepad";
import { WeatherCanvas } from "./components/WeatherCanvas";
import { WeatherIcon } from "./components/WeatherIcon";
import { HomeScreen } from "./screens/HomeScreen";
import { PantryScreen } from "./screens/PantryScreen";
import { RemindersScreen } from "./screens/RemindersScreen";
import { RecipesScreen } from "./screens/RecipesScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { ShoppingScreen } from "./screens/ShoppingScreen";
import { WeatherScreen } from "./screens/WeatherScreen";
import { WeekPlannerScreen } from "./screens/WeekPlannerScreen";
import { backgroundAtmosphere, timeOfDayTheme } from "./theme";
import { onScreenKeyboardEnabled } from "./inputPreferences";
import { installKioskDragScroll } from "./kioskDragScroll";
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
  | "week"
  | "pantry"
  | "shopping"
  | "reminders"
  | "recipes"
  | "weather"
  | "settings";

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [screen, setScreen] = useState<Screen>(() => {
    const requested = new URLSearchParams(window.location.search).get("screen");
    return ["home", "week", "pantry", "shopping", "reminders", "recipes", "weather", "settings"].includes(
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
  const [scanQuantityOpen, setScanQuantityOpen] = useState(false);
  const [scanQuantity, setScanQuantity] = useState(1);
  const toastTimer = useRef<number | null>(null);
  const [scanPromptOpen, setScanPromptOpen] = useState(false);
  const [cameraScanOpen, setCameraScanOpen] = useState(false);
  const [notepadOpen, setNotepadOpen] = useState(false);
  const [recipeToOpen, setRecipeToOpen] = useState<string | null>(null);
  const [recipeReturnToWeek, setRecipeReturnToWeek] = useState(false);
  const [preparingDashboard, setPreparingDashboard] = useState(false);
  const recipeWakeHeld = useRef(false);

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
        onScreenKeyboardEnabled.value =
          value.local && value.onscreen_keyboard_enabled;
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
    if (!status?.local || status.platform !== "Linux") return;
    return installKioskDragScroll();
  }, [status?.local, status?.platform]);

  useEffect(() => {
    if (!status?.local || !status.authenticated) return;
    let lastSent = 0;
    const activity = () => {
      const now = Date.now();
      if (now - lastSent < 1500) return;
      lastSent = now;
      api("/activity", { method: "POST" }).catch(() => undefined);
    };
    document.addEventListener("pointerdown", activity, true);
    document.addEventListener("keydown", activity, true);
    return () => {
      document.removeEventListener("pointerdown", activity, true);
      document.removeEventListener("keydown", activity, true);
    };
  }, [status?.local, status?.authenticated]);

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
          "recipes.updated",
          "planner.updated",
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
      if (event === "notepad.updated") {
        window.dispatchEvent(
          new CustomEvent("dashboard:notepad-updated", { detail: payload })
        );
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
        if (!recipeWakeHeld.current) {
          setScreen("home");
          setHomeKey((value) => value + 1);
          loadAtmosphere(true);
        }
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
    setScanQuantityOpen(false);
    setScanQuantity(1);
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
              package_size: result.product.package_size,
              serving_size: result.product.serving_size,
              pantry_quantity: Number(result.product.pantry_quantity || 0)
            }
          : { barcode }
      });
    } catch (error: any) {
      setScanned({ barcode, loading: false, seed: { barcode } });
      showToast(error.message);
    }
  };

  const adjustScannedPantry = async (direction: "add" | "remove", quantity = 1) => {
    const seed = scanned?.seed;
    if (!seed?.product_id || !seed.name) return;
    try {
      if (direction === "add") {
        await api("/pantry", {
          method: "POST",
          ...jsonBody({
            product_id: seed.product_id,
            barcode: seed.barcode,
            name: seed.name,
            brand: seed.brand || "",
            category: seed.category || "",
            package_size: seed.package_size || "",
            serving_size: seed.serving_size || "",
            quantity,
            expires_on: null
          })
        });
      } else {
        await api(
          `/pantry/${seed.product_id}/consume?quantity=${quantity}`,
          { method: "POST" }
        );
      }
      showToast(
        direction === "add"
          ? `${quantity} added to pantry`
          : `${quantity} removed from pantry`
      );
      setScanned(null);
      setScanQuantityOpen(false);
      setScanQuantity(1);
      setRefreshToken((value) => value + 1);
    } catch (error: any) {
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

  const warmRadarCache = async (forecast: Weather | null) => {
    if (forecast?.latitude == null || forecast?.longitude == null) return;
    const zoom = 7;
    const latitude = Math.max(-85.0511, Math.min(85.0511, Number(forecast.latitude)));
    const longitude = Number(forecast.longitude);
    const scale = 2 ** zoom;
    const x = Math.floor(((longitude + 180) / 360) * scale);
    const latitudeRadians = (latitude * Math.PI) / 180;
    const y = Math.floor(
      ((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2) * scale
    );
    const loadImage = (url: string) =>
      new Promise<void>((resolve) => {
        const image = new Image();
        const done = () => resolve();
        image.onload = done;
        image.onerror = done;
        image.src = url;
        window.setTimeout(done, 5000);
      });
    const urls = [
      `https://a.tile.openstreetmap.org/${zoom}/${x}/${y}.png`
    ];
    try {
      const response = await fetch("https://api.rainviewer.com/public/weather-maps.json");
      const metadata = await response.json();
      const latest = metadata?.radar?.past?.at(-1);
      if (latest?.path && metadata?.host) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
            urls.push(
              `${metadata.host}${latest.path}/256/${zoom}/${x + offsetX}/${y + offsetY}/2/1_1.png`
            );
          }
        }
      }
    } catch {
      // The normal radar fallback remains available if warmup is offline.
    }
    await Promise.allSettled(urls.map(loadImage));
  };

  const prepareFirstDashboard = async () => {
    const minimum = new Promise((resolve) => window.setTimeout(resolve, 10_000));
    try {
      await api("/refresh", { method: "POST" });
      const forecast = await api<Weather | null>("/weather");
      await Promise.allSettled([warmRadarCache(forecast), minimum]);
    } catch {
      await minimum;
    }
    await loadStatus();
    await loadAtmosphere();
    setPreparingDashboard(false);
  };

  const atmosphere = useMemo(
    () =>
      backgroundAtmosphere(
        status?.background_preview || "auto",
        themeClock,
        weather,
        status?.background_preview_effects || []
      ),
    [
      status?.background_preview,
      status?.background_preview_effects,
      themeClock,
      weather
    ]
  );
  const background = useMemo(
    () => timeOfDayTheme(atmosphere.now, atmosphere.weather),
    [atmosphere]
  );

  if (!status) return <div class="startup-screen">Starting Home Dashboard…</div>;
  if (preparingDashboard)
    return (
      <div class="startup-screen preparing-dashboard">
        <span class="preparing-spinner" />
        <strong>We are preparing your dashboard.</strong>
        <small>One moment please…</small>
      </div>
    );
  if (!status.authenticated)
    return (
      <PinLogin
        localDevice={status.local}
        onSuccess={loadStatus}
        onToast={showToast}
      />
    );
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
          onSetupStart={() => setPreparingDashboard(true)}
          onSetupAbort={() => setPreparingDashboard(false)}
          onSetupComplete={prepareFirstDashboard}
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
        code={atmosphere.code}
        reduced={status.reduced_motion}
        effect={status.weather_effects}
        windSpeed={atmosphere.windSpeed}
        isDay={atmosphere.isDay}
        cloudCover={atmosphere.cloudCover}
      />
      <nav class="main-nav glass">
        <button
          class={screen === "home" ? "active" : ""}
          onClick={() => setScreen("home")}
        >
          <span>⌂</span> Calendar
        </button>
        <button
          class={screen === "week" ? "active" : ""}
          onClick={() => setScreen("week")}
        >
          <span>▤</span> Week Planner
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
          class={screen === "recipes" ? "active" : ""}
          onClick={() => {
            setRecipeReturnToWeek(false);
            setScreen("recipes");
          }}
        >
          <span>♨</span> Recipes
        </button>
        <button
          class={screen === "weather" ? "active" : ""}
          onClick={() => setScreen("weather")}
        >
          <span><WeatherIcon code={0} /></span> Weather
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
            localDevice={status.local}
            mobileDashAddress={status.mobile_dash_address}
            onToggleAwakeLock={async () => {
              const result = await api<{ enabled: boolean }>(
                `/display/awake-lock?enabled=${!status.display_awake_lock}`,
                { method: "PUT" }
              );
              setStatus({ ...status, display_awake_lock: result.enabled });
              showToast(result.enabled ? "Display locked awake" : "Automatic sleep restored");
            }}
            onScanNow={() => {
              if (status.local) {
                scannerQuickMode.value = true;
                setScanPromptOpen(true);
              } else {
                setCameraScanOpen(true);
              }
            }}
            onOpenNotepad={() => setNotepadOpen(true)}
          />
        )}
        {screen === "week" && (
          <WeekPlannerScreen
            refreshToken={refreshToken}
            onToast={showToast}
            onOpenRecipe={(recipeId) => {
              setRecipeToOpen(recipeId);
              setRecipeReturnToWeek(true);
              setScreen("recipes");
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
        {screen === "recipes" && (
          <RecipesScreen
            refreshToken={refreshToken}
            localDevice={status.local}
            onToast={showToast}
            openRecipeId={recipeToOpen}
            onExternalRecipeOpened={() => setRecipeToOpen(null)}
            externalBackLabel={recipeReturnToWeek ? "Week Planner" : undefined}
            onExternalBack={
              recipeReturnToWeek
                ? () => {
                    setRecipeReturnToWeek(false);
                    setScreen("week");
                  }
                : undefined
            }
            onViewingChange={async (viewing) => {
              if (!status.local) return;
              try {
                if (viewing && !status.display_awake_lock) {
                  recipeWakeHeld.current = true;
                  const result = await api<{ enabled: boolean }>(
                    "/display/awake-lock?enabled=true",
                    { method: "PUT" }
                  );
                  setStatus((current) =>
                    current ? { ...current, display_awake_lock: result.enabled } : current
                  );
                } else if (!viewing && recipeWakeHeld.current) {
                  recipeWakeHeld.current = false;
                  const result = await api<{ enabled: boolean }>(
                    "/display/awake-lock?enabled=false",
                    { method: "PUT" }
                  );
                  setStatus((current) =>
                    current ? { ...current, display_awake_lock: result.enabled } : current
                  );
                }
              } catch (error: any) {
                recipeWakeHeld.current = false;
                showToast(`Could not change recipe keep-awake: ${error.message}`);
              }
            }}
          />
        )}
        {screen === "weather" && (
          <WeatherScreen
            refreshToken={refreshToken + weatherRefreshToken}
            onToast={showToast}
            localDevice={status.local}
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
      {notepadOpen && (
        <Modal title="Shared Notepad" onClose={() => setNotepadOpen(false)} wide>
          <SharedNotepad onToast={showToast} />
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
              {scanned.seed?.product_id ? (
                <>
                  <div class="scan-stock-summary">
                    <span>Currently in pantry</span>
                    <strong>{scanned.seed.pantry_quantity || 0}</strong>
                  </div>
                  <div class="scan-quick-actions">
                    <button
                      class="button primary"
                      onClick={() => adjustScannedPantry("add")}
                    >
                      + Add 1
                    </button>
                    <button
                      class="button secondary"
                      disabled={!scanned.seed.pantry_quantity}
                      onClick={() => adjustScannedPantry("remove")}
                    >
                      − Remove 1
                    </button>
                    <button
                      class="button secondary scan-adjust-toggle"
                      aria-expanded={scanQuantityOpen}
                      onClick={() => setScanQuantityOpen(!scanQuantityOpen)}
                    >
                      Adjust amount {scanQuantityOpen ? "▴" : "▾"}
                    </button>
                  </div>
                  {scanQuantityOpen && (
                    <div class="scan-quantity-adjuster">
                      <div class="quantity-control">
                        <span>Quantity</span>
                        <button
                          onClick={() => setScanQuantity(Math.max(1, scanQuantity - 1))}
                        >
                          −
                        </button>
                        <strong>{scanQuantity}</strong>
                        <button
                          onClick={() => setScanQuantity(Math.min(999, scanQuantity + 1))}
                        >
                          +
                        </button>
                      </div>
                      <div class="button-row">
                        <button
                          class="button primary"
                          onClick={() => adjustScannedPantry("add", scanQuantity)}
                        >
                          Add {scanQuantity}
                        </button>
                        <button
                          class="button secondary"
                          disabled={
                            scanQuantity > (scanned.seed.pantry_quantity || 0)
                          }
                          onClick={() => adjustScannedPantry("remove", scanQuantity)}
                        >
                          Remove {scanQuantity}
                        </button>
                      </div>
                    </div>
                  )}
                  <button
                    class="button secondary"
                    onClick={() => setScanDestination("pantry")}
                  >
                    Add with expiration or details
                  </button>
                </>
              ) : (
                <button
                  class="button primary"
                  onClick={() => setScanDestination("pantry")}
                >
                  Add to Pantry
                </button>
              )}
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
      {cameraScanOpen && !scanned && (
        <MobileBarcodeScanner
          onClose={() => setCameraScanOpen(false)}
          onScan={(barcode) => {
            setCameraScanOpen(false);
            beginScan(barcode);
          }}
        />
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
  localDevice,
  onSuccess,
  onToast
}: {
  localDevice: boolean;
  onSuccess: () => void;
  onToast: (message: string) => void;
}) {
  const [pin, setPin] = useState("");
  return (
    <div class="login-screen">
      <section class="login-card glass">
        <h1>Home Dashboard</h1>
        <p>Enter the household PIN.</p>
        {localDevice ? (
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
        ) : (
          <form
            class="native-pin-login"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!pin) return;
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
          >
            <input
              type="password"
              inputMode="numeric"
              autocomplete="current-password"
              value={pin}
              autofocus
              placeholder="Household PIN"
              onInput={(event) => setPin(event.currentTarget.value.slice(0, 12))}
            />
            <button class="button primary" type="submit" disabled={!pin}>
              Open dashboard
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
