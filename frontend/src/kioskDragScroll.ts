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
  axis: "x" | "y",
  root: Document
): HTMLElement | null {
  let element: Element | null = origin;
  while (element) {
    if ("scrollHeight" in element) {
      const htmlElement = element as HTMLElement;
      const style = (root.defaultView || window).getComputedStyle(element);
      const overflow = axis === "y" ? style.overflowY : style.overflowX;
      const hasRoom =
        axis === "y"
          ? htmlElement.scrollHeight > htmlElement.clientHeight + 2
          : htmlElement.scrollWidth > htmlElement.clientWidth + 2;
      if (
        hasRoom &&
        (overflow === "auto" ||
          overflow === "scroll" ||
          element === root.documentElement ||
          element === root.body)
      ) {
        return htmlElement;
      }
    }
    if (element === root.documentElement) break;
    element = element.parentElement;
  }
  return null;
}

export function installKioskDragScroll(root: Document = document): () => void {
  let drag: DragState | null = null;
  let suppressClick = false;
  root.documentElement.classList.add("kiosk-drag-scroll");

  const pointerDown = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return;
    const origin = event.target;
    if (!origin || !(origin as Element).closest) return;
    if (
      (origin as Element).closest(
        "input, textarea, select, [contenteditable=true], .leaflet-container, .reminder-drag-handle, .planner-hold-handle, .week-days"
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
      origin: origin as Element,
      scroller: null,
      dragged: false
    };
  };

  const pointerMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (root.documentElement.classList.contains("planner-drag-active")) {
      drag = null;
      return;
    }
    const totalX = event.clientX - drag.startX;
    const totalY = event.clientY - drag.startY;
    if (!drag.dragged && Math.hypot(totalX, totalY) < 9) return;
    if (!drag.scroller) {
      const preferred = Math.abs(totalX) > Math.abs(totalY) ? "x" : "y";
      drag.scroller =
        scrollableAncestor(drag.origin, preferred, root) ||
        scrollableAncestor(drag.origin, preferred === "x" ? "y" : "x", root);
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

  root.addEventListener("pointerdown", pointerDown, true);
  root.addEventListener("pointermove", pointerMove, { capture: true, passive: false });
  root.addEventListener("pointerup", pointerEnd, true);
  root.addEventListener("pointercancel", pointerEnd, true);
  root.addEventListener("click", click, true);

  return () => {
    root.documentElement.classList.remove("kiosk-drag-scroll");
    root.removeEventListener("pointerdown", pointerDown, true);
    root.removeEventListener("pointermove", pointerMove, true);
    root.removeEventListener("pointerup", pointerEnd, true);
    root.removeEventListener("pointercancel", pointerEnd, true);
    root.removeEventListener("click", click, true);
  };
}
