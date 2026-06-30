import { useEffect, useRef, useState } from "preact/hooks";
import "leaflet/dist/leaflet.css";

interface Props {
  latitude?: number;
  longitude?: number;
  isDay?: boolean;
}

type WeatherLayer = "precipitation" | "temperature" | "wind";

const layerLabels: Record<WeatherLayer, string> = {
  precipitation: "Precipitation",
  temperature: "Temperature",
  wind: "Wind"
};

export function RadarMap({ latitude, longitude, isDay = true }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const leafletRef = useRef<any>(null);
  const overlayRef = useRef<any>(null);
  const baseLayerRef = useRef<any>(null);
  const [layer, setLayer] = useState<WeatherLayer>("precipitation");
  const [mapReady, setMapReady] = useState(false);
  const [error, setError] = useState("");
  const [layerStatus, setLayerStatus] = useState("Loading live precipitation…");

  useEffect(() => {
    if (!host.current || latitude == null || longitude == null) return;
    let active = true;
    import("leaflet")
      .then((module) => {
        if (!active || !host.current) return;
        const L = module.default;
        leafletRef.current = L;
        const map = L.map(host.current, {
          center: [latitude, longitude],
          zoom: 7,
          minZoom: 4,
          maxZoom: 12,
          zoomControl: true,
          attributionControl: true,
          preferCanvas: true
        });
        baseLayerRef.current = L.tileLayer(
          isDay
            ? "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            : "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
          {
            attribution: isDay
              ? "© OpenStreetMap contributors"
              : "© OpenStreetMap contributors © CARTO",
            maxZoom: 19
          }
        ).addTo(map);
        L.circleMarker([latitude, longitude], {
          radius: 6,
          color: "#ffffff",
          weight: 2,
          fillColor: "#48a8e8",
          fillOpacity: 1
        }).addTo(map);
        const Recenter = L.Control.extend({
          onAdd() {
            const button = L.DomUtil.create("button", "radar-recenter") as HTMLButtonElement;
            button.type = "button";
            button.title = "Recenter map";
            button.textContent = "⌖";
            L.DomEvent.disableClickPropagation(button);
            L.DomEvent.on(button, "click", () => map.setView([latitude, longitude], 7));
            return button;
          }
        });
        new Recenter({ position: "topleft" }).addTo(map);
        mapRef.current = map;
        setMapReady(true);
        window.setTimeout(() => map.invalidateSize(), 100);
      })
      .catch(() => setError("Weather map is temporarily unavailable."));
    return () => {
      active = false;
      mapRef.current?.remove();
      mapRef.current = null;
      setMapReady(false);
      leafletRef.current = null;
      overlayRef.current = null;
    };
  }, [latitude, longitude]);

  useEffect(() => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!map || !L) return;
    baseLayerRef.current?.remove();
    baseLayerRef.current = L.tileLayer(
      isDay
        ? "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        : "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      {
        attribution: isDay
          ? "© OpenStreetMap contributors"
          : "© OpenStreetMap contributors © CARTO",
        maxZoom: 19
      }
    ).addTo(map);
    baseLayerRef.current.bringToBack();
  }, [isDay, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!map || !L) return;
    let cancelled = false;
    setError("");
    overlayRef.current?.remove();
    overlayRef.current = null;

    const addWms = (url: string, options: Record<string, unknown>, status: string) => {
      if (cancelled) return;
      overlayRef.current = L.tileLayer.wms(url, options).addTo(map);
      setLayerStatus(status);
    };

    if (layer === "precipitation") {
      setLayerStatus("Loading live precipitation…");
      fetch("https://api.rainviewer.com/public/weather-maps.json")
        .then((response) => {
          if (!response.ok) throw new Error("Radar service unavailable");
          return response.json();
        })
        .then((metadata) => {
          if (cancelled) return;
          const frames = metadata?.radar?.past || [];
          const latest = frames[frames.length - 1];
          if (!latest?.path || !metadata?.host) throw new Error("No radar frame available");
          overlayRef.current = L.tileLayer(
            `${metadata.host}${latest.path}/256/{z}/{x}/{y}/2/1_1.png`,
            {
              opacity: 0.78,
              maxNativeZoom: 7,
              maxZoom: 12,
              attribution: "Precipitation radar © RainViewer"
            }
          ).addTo(map);
          setLayerStatus(
            `Live precipitation · ${new Date(Number(latest.time) * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
          );
        })
        .catch(() => {
          addWms(
            "https://mapservices.weather.noaa.gov/eventdriven/services/radar/radar_base_reflectivity/MapServer/WMSServer",
            {
              layers: "3",
              format: "image/png",
              transparent: true,
              opacity: 0.78,
              attribution: "Radar © NOAA/NWS"
            },
            "NOAA precipitation radar"
          );
        });
    } else if (layer === "temperature") {
      addWms(
        "/api/v1/weather/map/temperature",
        {
          layers: "temperature",
          format: "image/png",
          transparent: true,
          opacity: 0.68,
          attribution: "Temperature forecast © NOAA/NWS"
        },
        "Current temperature forecast"
      );
    } else {
      addWms(
        "/api/v1/weather/map/wind",
        {
          layers: "wind",
          format: "image/png",
          transparent: true,
          opacity: 0.9,
          attribution: "Surface wind observations © NOAA/NWS"
        },
        "Surface wind observations · knots"
      );
    }
    return () => {
      cancelled = true;
    };
  }, [layer, mapReady]);

  if (latitude == null || longitude == null) {
    return <div class="radar-empty">Set a weather location to view radar.</div>;
  }
  return (
    <div class="radar-shell">
      <div class="radar-layer-controls" role="group" aria-label="Weather map layer">
        {(Object.keys(layerLabels) as WeatherLayer[]).map((value) => (
          <button
            type="button"
            class={layer === value ? "active" : ""}
            onClick={() => setLayer(value)}
          >
            {layerLabels[value]}
          </button>
        ))}
      </div>
      {error ? <div class="radar-empty">{error}</div> : <div ref={host} class="radar-map" />}
      <div class={`radar-legend radar-legend-${layer}`}>
        <span>{layerStatus}</span>
        <i aria-hidden="true" />
      </div>
    </div>
  );
}
