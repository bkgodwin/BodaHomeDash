import { ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";

interface Props {
  children: ComponentChildren;
  actionLabel: string;
  onAction: () => void | Promise<void>;
}

export function SwipeActionRow({
  children,
  actionLabel,
  onAction
}: Props) {
  const [open, setOpen] = useState(false);
  const start = useRef({ x: 0, y: 0 });
  const delta = useRef(0);

  return (
    <div class={`swipe-action-row ${open ? "open" : ""}`}>
      <button
        type="button"
        class="swipe-delete-action"
        aria-label={actionLabel}
        onClick={onAction}
      >
        ×
      </button>
      <div
        class="swipe-action-content"
        onPointerDown={(event) => {
          start.current = { x: event.clientX, y: event.clientY };
          delta.current = 0;
        }}
        onPointerMove={(event) => {
          const x = event.clientX - start.current.x;
          const y = event.clientY - start.current.y;
          if (Math.abs(x) > Math.abs(y)) delta.current = x;
        }}
        onPointerUp={() => {
          if (delta.current < -35) setOpen(true);
          if (delta.current > 25) setOpen(false);
        }}
      >
        {children}
      </div>
    </div>
  );
}
