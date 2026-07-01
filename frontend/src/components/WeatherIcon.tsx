import { weatherKind } from "../weatherPresentation";

export function WeatherIcon({
  code = 0,
  className = ""
}: {
  code?: number;
  className?: string;
}) {
  const kind = weatherKind(Number(code));
  const cloud = (
    <path d="M7 17.5h10.2a3.8 3.8 0 0 0 .5-7.57A5.8 5.8 0 0 0 6.6 8.7 4.45 4.45 0 0 0 7 17.5Z" />
  );
  return (
    <svg
      class={`weather-icon ${className}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {kind === "clear" && (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
        </>
      )}
      {kind === "cloud" && (
        <>
          <circle cx="7.2" cy="7.3" r="3" />
          <path d="M7.2 2.8V1.5M2.7 7.3H1.5M4 4.1 3 3.1" />
          {cloud}
        </>
      )}
      {kind === "rain" && (
        <>
          {cloud}
          <path d="m8 20-1 2M13 20l-1 2M18 20l-1 2" />
        </>
      )}
      {kind === "storm" && (
        <>
          {cloud}
          <path d="m13 18-2 3h2l-1 2.2 4-4.2h-2l1-1Z" />
        </>
      )}
      {kind === "snow" && (
        <>
          {cloud}
          <path d="M8 19v4M6.3 20l3.4 2M9.7 20l-3.4 2M16 19v4M14.3 20l3.4 2M17.7 20l-3.4 2" />
        </>
      )}
      {kind === "fog" && (
        <>
          {cloud}
          <path d="M5 20h14M7 23h10" />
        </>
      )}
    </svg>
  );
}
