import { useEffect, useRef } from "preact/hooks";

interface Props {
  code?: number;
  reduced?: boolean;
}

interface Particle {
  x: number;
  y: number;
  speed: number;
  size: number;
  drift: number;
}

export function WeatherCanvas({ code = 0, reduced = false }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || reduced) return;
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
    const count = snowy ? 70 : rainy || stormy ? 100 : foggy ? 24 : 12;
    const particles: Particle[] = Array.from({ length: count }, () => ({
      x: Math.random(),
      y: Math.random(),
      speed: 0.002 + Math.random() * 0.006,
      size: 1 + Math.random() * 3,
      drift: -0.001 + Math.random() * 0.002
    }));

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    const draw = (timestamp: number) => {
      animation = requestAnimationFrame(draw);
      if (document.hidden || timestamp - last < 33) return;
      last = timestamp;
      context.clearRect(0, 0, canvas.width, canvas.height);
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
  }, [code, reduced]);

  return <canvas ref={ref} class="weather-canvas" aria-hidden="true" />;
}
