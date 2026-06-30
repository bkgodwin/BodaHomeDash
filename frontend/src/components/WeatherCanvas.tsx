import { useEffect, useRef } from "preact/hooks";

interface Props {
  code?: number;
  reduced?: boolean;
  effect?: "off" | "subtle" | "full";
  windSpeed?: number;
  isDay?: boolean;
  cloudCover?: number;
}

interface Particle {
  x: number;
  y: number;
  speed: number;
  size: number;
  drift: number;
}

export function WeatherCanvas({
  code = 0,
  reduced = false,
  effect = "full",
  windSpeed = 0,
  isDay = true,
  cloudCover = 0
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || reduced || effect === "off") return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let last = 0;
    let animation = 0;
    const snowy = [71, 73, 75, 77, 85, 86].includes(code);
    const rainy = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(
      code
    );
    const stormy = [95, 96, 99].includes(code);
    const foggy = [45, 48].includes(code);
    const scale = effect === "subtle" ? 0.4 : 1;
    const count = Math.round(
      (snowy ? 70 : rainy || stormy ? 100 : foggy ? 24 : 12) * scale
    );
    const particles: Particle[] = Array.from({ length: count }, () => ({
      x: Math.random(),
      y: Math.random(),
      speed: 0.002 + Math.random() * 0.006,
      size: 1 + Math.random() * 3,
      drift: -0.001 + Math.random() * 0.002 + Math.min(windSpeed, 50) / 30000
    }));
    const stars = Array.from({ length: Math.round(90 * scale) }, (_, index) => ({
      x: ((index * 73) % 997) / 997,
      y: ((index * 41) % 389) / 778,
      size: 0.5 + ((index * 17) % 16) / 10,
      pulse: (index * 0.37) % (Math.PI * 2)
    }));
    const lunarCycle = 29.53058867;
    const knownNewMoon = Date.UTC(2000, 0, 6, 18, 14);
    const moonAge = ((Date.now() - knownNewMoon) / 86400000) % lunarCycle;
    const moonPhase = moonAge / lunarCycle;
    const skyVisibility = Math.max(0.08, 1 - cloudCover / 110);

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    const draw = (timestamp: number) => {
      animation = requestAnimationFrame(draw);
      if (document.hidden || timestamp - last < 33) return;
      last = timestamp;
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (!isDay) {
        for (const star of stars) {
          const twinkle = 0.55 + Math.sin(timestamp / 900 + star.pulse) * 0.35;
          context.fillStyle = `rgba(235,244,255,${skyVisibility * twinkle})`;
          context.beginPath();
          context.arc(star.x * canvas.width, star.y * canvas.height, star.size, 0, Math.PI * 2);
          context.fill();
        }
        const moonX = canvas.width * 0.82;
        const moonY = canvas.height * 0.17;
        const moonRadius = Math.min(canvas.width, canvas.height) * 0.038;
        context.save();
        context.globalAlpha = skyVisibility;
        context.shadowColor = "rgba(220,235,255,.8)";
        context.shadowBlur = 24;
        context.fillStyle = "rgba(12,25,48,.94)";
        context.beginPath();
        context.arc(moonX, moonY, moonRadius, 0, Math.PI * 2);
        context.fill();
        context.clip();
        context.shadowBlur = 0;
        context.fillStyle = "#f4edcf";
        const waxing = moonPhase <= 0.5;
        const phaseProgress = waxing ? moonPhase * 2 : (moonPhase - 0.5) * 2;
        const phaseOffset = waxing
          ? moonRadius * 2 * (1 - phaseProgress)
          : -moonRadius * 2 * phaseProgress;
        context.beginPath();
        context.arc(moonX + phaseOffset, moonY, moonRadius, 0, Math.PI * 2);
        context.fill();
        context.restore();
        context.save();
        context.globalAlpha = skyVisibility * 0.55;
        const planetX = canvas.width * 0.18;
        const planetY = canvas.height * 0.22;
        const planetGradient = context.createRadialGradient(planetX - 3, planetY - 3, 1, planetX, planetY, 13);
        planetGradient.addColorStop(0, "#fff4bd");
        planetGradient.addColorStop(0.45, "#d2a5ff");
        planetGradient.addColorStop(1, "#574c89");
        context.fillStyle = planetGradient;
        context.beginPath();
        context.arc(planetX, planetY, 10, 0, Math.PI * 2);
        context.fill();
        context.strokeStyle = "rgba(235,220,255,.7)";
        context.lineWidth = 2;
        context.beginPath();
        context.ellipse(planetX, planetY, 18, 5, -0.3, 0, Math.PI * 2);
        context.stroke();
        context.restore();
      }
      for (const particle of particles) {
        particle.y += particle.speed;
        particle.x += particle.drift;
        if (particle.y > 1.05) {
          particle.y = -0.05;
          particle.x = Math.random();
        }
        if (particle.x > 1.05) particle.x = -0.05;
        if (particle.x < -0.05) particle.x = 1.05;
        const x = particle.x * canvas.width;
        const y = particle.y * canvas.height;
        if (snowy) {
          context.fillStyle = "rgba(255,255,255,.72)";
          context.beginPath();
          context.arc(x, y, particle.size, 0, Math.PI * 2);
          context.fill();
        } else if (rainy || stormy) {
          context.strokeStyle = "rgba(185,220,255,.38)";
          context.lineWidth = particle.size / 2;
          context.beginPath();
          context.moveTo(x, y);
          context.lineTo(x - 5, y + 16 + particle.size * 3);
          context.stroke();
        } else if (foggy) {
          const gradient = context.createRadialGradient(
            x,
            y,
            0,
            x,
            y,
            100 + particle.size * 30
          );
          gradient.addColorStop(0, "rgba(230,240,245,.07)");
          gradient.addColorStop(1, "transparent");
          context.fillStyle = gradient;
          context.fillRect(x - 150, y - 100, 300, 200);
        } else {
          context.fillStyle = "rgba(255,235,170,.1)";
          context.beginPath();
          context.arc(x, y, particle.size * 2, 0, Math.PI * 2);
          context.fill();
        }
      }
    };
    resize();
    window.addEventListener("resize", resize);
    animation = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(animation);
      window.removeEventListener("resize", resize);
    };
  }, [code, reduced, effect, windSpeed, isDay, cloudCover]);

  return <canvas ref={ref} class="weather-canvas" aria-hidden="true" />;
}
