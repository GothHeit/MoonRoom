"use client";

import { animate, LazyMotion, m, useDragControls, useMotionValue, type PanInfo } from "motion/react";
import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";

/** Where a flick would come to rest, the way scrolling decelerates (Apple's projection). */
function project(velocity: number, rate = 0.998) {
  return ((velocity / 1000) * rate) / (1 - rate);
}

// Critically damped by default; a touch of bounce only when a flick carried momentum into it.
const SETTLE = { type: "spring", bounce: 0, duration: 0.4 } as const;
const FLICK = { type: "spring", bounce: 0.2, duration: 0.4 } as const;
const FLICK_SPEED = 300;

const loadFeatures = () => import("motion/react").then((mod) => mod.domMax);

function matches(query: string) {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

type Slots = {
  /** Closes along the path the sheet came in on. */
  dismiss: () => void;
  /** Spread on the header: on phones it is the handle that drags the sheet. */
  handleProps: { onPointerDown: (e: PointerEvent) => void; className: string };
};

type Props = {
  label: string;
  onClose: () => void;
  /** Layout for both forms: a sheet pinned to the bottom on phones, a popover from sm up. */
  className: string;
  children: (slots: Slots) => ReactNode;
};

/** A panel that phones get as a bottom sheet: it slides up, follows the finger from its header,
 * and a pull or a flick down dismisses it. Larger screens get a plain popover. */
export function BottomSheet({ label, onClose, className, children }: Props) {
  const [phone] = useState(() => matches("(max-width: 639px)"));
  const [still] = useState(() => matches("(prefers-reduced-motion: reduce)"));
  const ref = useRef<HTMLDivElement>(null);
  const y = useMotionValue(0);
  const drag = useDragControls();
  const sliding = phone && !still;

  // Before paint, so the sheet never shows a frame fully open before it slides up.
  useLayoutEffect(() => {
    if (!sliding) return;
    y.set(ref.current?.offsetHeight ?? 0);
    const enter = animate(y, 0, SETTLE);
    return () => enter.stop();
  }, [sliding, y]);

  function dismiss(velocity = 0) {
    if (!sliding) return onClose();
    void animate(y, ref.current?.offsetHeight ?? 0, { ...SETTLE, velocity }).then(onClose);
  }

  function onDragEnd(_: unknown, info: PanInfo) {
    const height = ref.current?.offsetHeight ?? 0;
    // Judge by where the gesture is going, not where the finger let go.
    if (y.get() + project(info.velocity.y) > height / 2) return dismiss(info.velocity.y);
    animate(y, 0, { ...(Math.abs(info.velocity.y) > FLICK_SPEED ? FLICK : SETTLE), velocity: info.velocity.y });
  }

  const slots: Slots = {
    dismiss: () => dismiss(),
    handleProps: phone
      ? { onPointerDown: (e) => drag.start(e), className: "touch-none cursor-grab" }
      : { onPointerDown: () => {}, className: "" },
  };

  if (!phone) {
    return (
      <div role="dialog" aria-label={label} className={`pop-in ${className}`}>
        {children(slots)}
      </div>
    );
  }
  return (
    <LazyMotion features={loadFeatures} strict>
      <m.div
        ref={ref}
        role="dialog"
        aria-label={label}
        className={className}
        style={{ y }}
        drag={still ? false : "y"}
        dragControls={drag}
        dragListener={false}
        dragMomentum={false}
        // Pulling up past the top resists like a rubber band; pulling down follows the finger 1:1.
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0.06, bottom: 1 }}
        onDragEnd={onDragEnd}
      >
        {children(slots)}
      </m.div>
    </LazyMotion>
  );
}
