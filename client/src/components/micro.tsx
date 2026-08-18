import {
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, type Transition } from "framer-motion";

// Micro-interactions for workspace chrome buttons.
// Interaction patterns adapted from Amicro (MIT, Syed Subhan)
// https://amicro.vercel.app — trimmed to the quiet, state-conveying subset
// that fits a product surface: no layout shifts, 150–400ms, spring ease-out.

export type MicroInteraction =
  | "none"
  | "rotate" // 180° spin while hovered (reload, settings)
  | "rotate-quarter" // 90° tilt while hovered (add / create)
  | "shake" // disapproval wiggle (delete, destructive close)
  | "pulse" // single heartbeat scale (launchers, toggles)
  | "nudge-left" // lean toward the action's direction (back, zoom out)
  | "nudge-right"; // (forward, external)

const QUICK: Transition = { duration: 0.16, ease: [0.16, 1, 0.3, 1] };

function animationFor(interaction: MicroInteraction, hovered: boolean) {
  switch (interaction) {
    case "none":
      return { animate: { x: 0, y: 0, scale: 1, rotate: 0 }, transition: QUICK };
    case "rotate":
      return { animate: { rotate: hovered ? 22 : 0 }, transition: QUICK };
    case "rotate-quarter":
      return { animate: { rotate: hovered ? 45 : 0 }, transition: QUICK };
    case "shake":
      return {
        animate: hovered
          ? { x: [0, -1, 1, 0] }
          : { y: 0, rotate: 0 },
        transition: QUICK,
      };
    case "pulse":
      return {
        animate: { scale: hovered ? 1.06 : 1 },
        transition: QUICK,
      };
    case "nudge-left":
      return { animate: { x: hovered ? -1.5 : 0 }, transition: QUICK };
    case "nudge-right":
      return { animate: { x: hovered ? 1.5 : 0 }, transition: QUICK };
  }
}

interface MicroButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  interaction: MicroInteraction;
  children: ReactNode;
}

// Drop-in replacement for a chrome <button>: same props and styling, but the
// icon inside answers hover (and keyboard focus) with its micro-interaction.
export function MicroButton({
  interaction,
  children,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
  ...props
}: MicroButtonProps) {
  const [hovered, setHovered] = useState(false);
  const { animate, transition } = animationFor(interaction, hovered);

  return (
    <button
      {...props}
      onMouseEnter={(event) => {
        if (window.matchMedia("(hover: hover)").matches) setHovered(true);
        onMouseEnter?.(event);
      }}
      onMouseLeave={(event) => {
        setHovered(false);
        onMouseLeave?.(event);
      }}
      onFocus={(event) => {
        setHovered(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setHovered(false);
        onBlur?.(event);
      }}
    >
      <motion.span
        animate={animate}
        transition={transition}
        className="flex items-center justify-center"
      >
        {children}
      </motion.span>
    </button>
  );
}

// One-shot ring that blooms outward when `active` becomes true — for
// selection feedback on swatches and dots. Parent needs `relative`.
export function ExpandRing({ active }: { active: boolean }) {
  return (
    <AnimatePresence>
      {active && (
        <motion.span
          key="expand-ring"
          initial={{ opacity: 0.7, scale: 1 }}
          animate={{ opacity: 0, scale: 1.7 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="pointer-events-none absolute inset-0 rounded-full border border-white/40"
        />
      )}
    </AnimatePresence>
  );
}
