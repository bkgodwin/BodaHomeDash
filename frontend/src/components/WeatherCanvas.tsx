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

function createMoon(radius: number, phase: number): HTMLCanvasElement {
  const size = Math.max(24, Math.round(radius * 2));
  const moon = document.createElement("canvas");
  moon.width = size;
  moon.height = size;
  const context = moon.getContext("2d");
  if (!context) return moon;
  const image = context.createImageData(size, size);
  const angle = phase * Math.PI * 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = (x + 0.5 - size / 2) / (size / 2);
      const ny = (y + 0.5 - size / 2) / (size / 2);
      const distance = nx * nx + ny * ny;
      if (distance > 1) continue;
      const z = Math.sqrt(Math.max(0, 1 - distance));
      const light = nx * Math.sin(angle) - z * Math.cos(angle);
      const edge = Math.min(1, (1 - Math.sqrt(distance)) * size * 0.72);
      const illumination = Math.max(0, Math.min(1, light * size * 0.22 + 0.5));
      const texture =
        0.92 +
        0.045 * Math.sin(nx * 19 + ny * 7) +
        0.035 * Math.sin(nx * 8 - ny * 23);
      const brightness = Math.max(0, Math.min(1, illumination * texture));
      const index = (y * size + x) * 4;
      image.data[index] = 214 + Math.round(34 * brightness);
      image.data[index + 1] = 211 + Math.round(32 * brightness);
      image.data[index + 2] = 194 + Math.round(43 * brightness);
      image.data[index + 3] = Math.round(255 * edge * (0.08 + brightness * 0.92));
    }
  }
  context.putImageData(image, 0, 0);
  context.save();
  context.globalCompositeOperation = "source-atop";
  context.fillStyle = "rgba(97,103,105,.11)";
  [
    [0.35, 0.34, 0.08],
    [0.63, 0.58, 0.11],
    [0.53, 0.24, 0.05],
    [0.28, 0.68, 0.06]
  ].forEach(([x, y, crater]) => {
    context.beginPath();
    context.arc(size * x, size * y, size * crater, 0, Math.PI * 2);
    context.fill();
  });
  context.restore();
  return moon;
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
    let moon: HTMLCanvasElement | null = null;
    const snowy = [71, 73, 75, 77, 85, 86].includes(code);
    const rainy = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code);
    const stormy = [95, 96, 99].includes(code);
    const foggy = [45, 48].includes(code);
    const clear = [0, 1].includes(code);
    const scale = effect === "subtle" ? 0.45 : 1;
    const count = Math.round(
      (snowy ? 68 : rainy || stormy ? 90 : foggy ? 20 : 0) * scale
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
    const moonAge =
      ((Date.now() - knownNewMoon) / 86400000 % lunarCycle + lunarCycle) %
      lunarCycle;
    const moonPhase = moonAge / lunarCycle;
    const skyVisibility = Math.max(0.06, 1 - cloudCover / 108);

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      const radius = Math.min(canvas.width, canvas.height) * 0.046;
      moon = createMoon(radius, moonPhase);
    };

    const drawBird = (x: number, y: number, size: number) => {
      context.beginPath();
      context.moveTo(x - size, y);
      context.quadraticCurveTo(x - size * 0.48, y - size * 0.52, x, y);
      context.quadraticCurveTo(x + size * 0.48, y - size * 0.52, x + size, y);
      context.stroke();
    };

    const draw = (timestamp: number) => {
      animation = requestAnimationFrame(draw);
      if (document.hidden || timestamp - last < 33) return;
      last = timestamp;
      context.clearRect(0, 0, canvas.width, canvas.height);

      if (isDay && clear) {
        const sunX = canvas.width * 0.84;
        const sunY = canvas.height * 0.12;
        const bloom = context.createRadialGradient(
          sunX, sunY, 0, sunX, sunY, Math.min(canvas.width, canvas.height) * 0.24
        );
        bloom.addColorStop(0, `rgba(255,242,184,${0.22 * scale})`);
        bloom.addColorStop(0.28, `rgba(255,222,130,${0.1 * scale})`);
        bloom.addColorStop(1, "rgba(255,215,120,0)");
        context.fillStyle = bloom;
        context.fillRect(0, 0, canvas.width, canvas.height);

        const birdCycle = timestamp % 23000;
        if (birdCycle < 4200) {
          const progress = birdCycle / 4200;
          context.save();
          context.strokeStyle = `rgba(29,50,64,${0.42 * scale})`;
          context.lineWidth = 2;
          context.lineCap = "round";
          for (let index = 0; index < 3; index += 1) {
            const x = canvas.width * (-0.08 + progress * 1.16 - index * 0.035);
            const y =
              canvas.height *
              (0.16 + index * 0.035 + Math.sin(progress * 8 + index) * 0.012);
            drawBird(x, y, 10 + index * 2);
          }
          context.restore();
        }
      }

      if (!isDay) {
        for (const star of stars) {
          const twinkle = 0.55 + Math.sin(timestamp / 900 + star.pulse) * 0.35;
          context.fillStyle = `rgba(235,244,255,${skyVisibility * twinkle})`;
          context.beginPath();
          context.arc(star.x * canvas.width, star.y * canvas.height, star.size, 0, Math.PI * 2);
          context.fill();
        }
        const shootingCycle = timestamp % 19000;
        if (clear && shootingCycle < 850) {
          const progress = shootingCycle / 850;
          const x = canvas.width * (0.15 + progress * 0.34);
          const y = canvas.height * (0.08 + progress * 0.2);
          const trail = context.createLinearGradient(x - 100, y - 58, x, y);
          trail.addColorStop(0, "rgba(255,255,255,0)");
          trail.addColorStop(1, `rgba(255,255,255,${0.85 * skyVisibility})`);
          context.strokeStyle = trail;
          context.lineWidth = 2;
          context.beginPath();
          context.moveTo(x - 100, y - 58);
          context.lineTo(x, y);
          context.stroke();
        }
        if (moon) {
          const moonX = canvas.width * 0.82;
          const moonY = canvas.height * 0.17;
          context.save();
          context.globalAlpha = skyVisibility;
          context.shadowColor = "rgba(221,235,255,.68)";
          context.shadowBlur = 22;
          context.drawImage(
            moon,
            moonX - moon.width / 2,
            moonY - moon.height / 2
          );
          context.restore();
        }
      }

      if (windSpeed >= 12) {
        context.save();
        context.strokeStyle = `rgba(220,241,255,${0.11 * scale})`;
        context.lineWidth = 1.5;
        context.lineCap = "round";
        for (let index = 0; index < 7; index += 1) {
          const progress =
            ((timestamp * (0.00006 + windSpeed * 0.000002) + index * 0.19) %
              1.35) -
            0.18;
          const x = progress * canvas.width;
          const y = canvas.height * (0.17 + index * 0.105);
          context.beginPath();
          context.moveTo(x - 95, y);
          context.bezierCurveTo(x - 55, y - 12, x - 25, y + 12, x + 35, y);
          context.stroke();
        }
        context.restore();
      }

      if (stormy) {
        const lightningCycle = timestamp % 11700;
        if (lightningCycle < 520) {
          const progress = Math.min(1, lightningCycle / 240);
          const alpha =
            (Math.sin(Math.min(lightningCycle, 420) / 55) * 0.28 + 0.62) *
            scale;
          context.fillStyle = `rgba(215,229,255,${alpha * 0.12})`;
          context.fillRect(0, 0, canvas.width, canvas.height);
          const points = [
            [0.62, -0.03],
            [0.595, 0.12],
            [0.625, 0.19],
            [0.58, 0.3],
            [0.605, 0.39],
            [0.555, 0.55],
            [0.565, 0.68]
          ];
          const visible = Math.max(2, Math.ceil(points.length * progress));
          context.save();
          context.strokeStyle = `rgba(235,243,255,${alpha})`;
          context.shadowColor = "#aacbff";
          context.shadowBlur = 15;
          context.lineWidth = 2.3;
          context.beginPath();
          points.slice(0, visible).forEach(([x, y], index) => {
            const px = x * canvas.width;
            const py = y * canvas.height;
            if (index === 0) context.moveTo(px, py);
            else context.lineTo(px, py);
          });
          context.stroke();
          if (visible >= 5) {
            context.lineWidth = 1.2;
            context.beginPath();
            context.moveTo(points[3][0] * canvas.width, points[3][1] * canvas.height);
            context.lineTo(0.67 * canvas.width, 0.39 * canvas.height);
            context.lineTo(0.65 * canvas.width, 0.48 * canvas.height);
            context.stroke();
          }
          context.restore();
        }
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
            x, y, 0, x, y, 100 + particle.size * 30
          );
          gradient.addColorStop(0, "rgba(230,240,245,.07)");
          gradient.addColorStop(1, "transparent");
          context.fillStyle = gradient;
          context.fillRect(x - 150, y - 100, 300, 200);
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
