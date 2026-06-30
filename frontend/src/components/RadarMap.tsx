import { useEffect, useRef, useState } from "preact/hooks";
import "leaflet/dist/leaflet.css";

interface Props {
  latitude?: number;
  longitude?: number;
}

export function RadarMap({ latitude, longitude }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!host.current || latitude == null || longitude == null) return;
    let active = true;
    import("leaflet")
      .then((module) => {
        if (!active || !host.current) return;
        const L = module.default;
        const map = L.map(host.current, {
          center: [latitude, longitude],
          zoom: 7,
          minZoom: 5,
          maxZoom: 12,
          zoomControl: true,
          attributionControl: true,
          preferCanvas: true
        });
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: "© OpenStreetMap contributors",
          maxZoom: 19
        }).addTo(map);
        L.tileLayer
          .wms(
            "https://mapservices.weather.noaa.gov/eventdriven/services/radar/radar_base_reflectivity/MapServer/WMSServer",
            {
              layers: "3",
              format: "image/png",
              transparent: true,
              opacity: 0.72,
              attribution: "Radar: NOAA/NWS"
            }
          )
          .addTo(map);
        L.circleMarker([latitude, longitude], {
          radius: 6,
          color: "#ffffff",
          weight: 2,
          fillColor: "#48a8e8",
          fillOpacity: 1
        }).addTo(map);
        const Recenter = L.Control.extend({
          onAdd() {
            const button = L.DomUtil.create(
              "button",
              "radar-recenter"
            ) as HTMLButtonElement;
            button.type = "button";
            button.title = "Recenter radar";
            button.textContent = "⌖";
            L.DomEvent.disableClickPropagation(button);
            L.DomEvent.on(button, "click", () =>
              map.setView([latitude, longitude], 7)
            );
            return button;
          }
        });
        new Recenter({ position: "topleft" }).addTo(map);
        mapRef.current = map;
        window.setTimeout(() => map.invalidateSize(), 100);
      })
      .catch(() => setError("Radar is temporarily unavailable."));
    return () => {
      active = false;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [latitude, longitude]);

  if (latitude == null || longitude == null) {
    return <div class="radar-empty">Set a weather location to view radar.</div>;
  }
  return (
    <div class="radar-shell">
      {error ? <div class="radar-empty">{error}</div> : <div ref={host} class="radar-map" />}
    </div>
  );
}
