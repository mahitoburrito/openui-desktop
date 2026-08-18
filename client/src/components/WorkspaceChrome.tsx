import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Codicon } from "./Codicon";
import { MicroButton, type MicroInteraction } from "./micro";

type WorkspaceIconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  icon: string;
  label: string;
  interaction?: MicroInteraction;
  active?: boolean;
  primary?: boolean;
  badge?: ReactNode;
  iconSize?: number;
};

export function WorkspaceIconButton({
  icon,
  label,
  interaction = "none",
  active = false,
  primary = false,
  badge,
  iconSize = 16,
  className = "",
  ...props
}: WorkspaceIconButtonProps) {
  const color = primary
    ? "bg-zinc-100 text-canvas-dark shadow-[inset_0_1px_0_oklch(1_0_0/.5),0_4px_12px_oklch(0.03_0.005_255/.3)] hover:bg-zinc-200"
    : active
      ? "bg-white/[0.085] text-zinc-100 shadow-[inset_0_0_0_1px_oklch(0.92_0.006_255/.07)]"
      : "text-zinc-500 hover:text-zinc-100";

  return (
    <MicroButton
      {...props}
      interaction={interaction}
      className={`workspace-icon-button relative flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[7px] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-zinc-500 ${color} ${className}`}
      title={props.title || label}
      aria-label={props["aria-label"] || label}
    >
      <Codicon name={icon} size={iconSize} />
      {badge}
      <span className="workspace-tooltip" role="tooltip" aria-hidden="true">
        {label}
      </span>
    </MicroButton>
  );
}
