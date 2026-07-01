type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  origin: Element;
  scroller: HTMLElement | null;
  dragged: boolean;
};

function scrollableAncestor(
  origin: Element,
  axis: "x" | "y"
): HTMLElement | null {
  let element: Element | null = origin;
  while (element && element !== document.documentElement) {
    if (element instanceof HTMLElement) {
      const style = getComputedStyle(element);
      const overflow = axis === "y" ? style.overflowY : style.overflowX;
      const hasRoom =
        axis === "y"
          ? element.scrollHeight > element.clientHeight + 2
          : element.scrollWidth > element.clientWidth + 2;
      if (hasRoom && (overflow === "auto" || overflow === "scroll")) {
        return element;
      }
    }
    element = element.parentElement;
  }
  return null;
}

export function installKioskDragScroll(): () => void {
  let drag: DragState | null = null;
  let suppressClick = false;
  document.documentElement.classList.add("kiosk-drag-scroll");

  const pointerDown = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return;
    const origin = event.target;
    if (!(origin instanceof Element)) return;
    if (
      origin.closest(
        "input, textarea, select, [contenteditable=true], .leaflet-container, .reminder-drag-handle, .planner-hold-handle, [data-planner-draggable]"
      )
    ) {
      return;
    }
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      origin,
      scroller: null,
      dragged: false
    };
  };

  const pointerMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const totalX = event.clientX - drag.startX;
    const totalY = event.clientY - drag.startY;
    if (!drag.dragged && Math.hypot(totalX, totalY) < 9) return;
    if (!drag.scroller) {
      const preferred = Math.abs(totalX) > Math.abs(totalY) ? "x" : "y";
      drag.scroller =
        scrollableAncestor(drag.origin, preferred) ||
        scrollableAncestor(drag.origin, preferred === "x" ? "y" : "x");
      if (!drag.scroller) {
        drag = null;
        return;
      }
    }
    drag.dragged = true;
    suppressClick = true;
    event.preventDefault();
    drag.scroller.scrollLeft -= event.clientX - drag.lastX;
    drag.scroller.scrollTop -= event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    drag.scroller.classList.add("drag-scrolling");
  };

  const pointerEnd = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.scroller?.classList.remove("drag-scrolling");
    drag = null;
    window.setTimeout(() => {
      suppressClick = false;
    }, 80);
  };

  const click = (event: MouseEvent) => {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressClick = false;
  };

  document.addEventListener("pointerdown", pointerDown, true);
  document.addEventListener("pointermove", pointerMove, { capture: true, passive: false });
  document.addEventListener("pointerup", pointerEnd, true);
  document.addEventListener("pointercancel", pointerEnd, true);
  document.addEventListener("click", click, true);

  return () => {
    document.documentElement.classList.remove("kiosk-drag-scroll");
    document.removeEventListener("pointerdown", pointerDown, true);
    document.removeEventListener("pointermove", pointerMove, true);
    document.removeEventListener("pointerup", pointerEnd, true);
    document.removeEventListener("pointercancel", pointerEnd, true);
    document.removeEventListener("click", click, true);
  };
}
