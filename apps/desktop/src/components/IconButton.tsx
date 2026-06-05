import type { LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes, ReactElement } from "react";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  tone?: "primary" | "neutral" | "danger";
}

export function IconButton({
  icon: Icon,
  label,
  tone = "neutral",
  className,
  ...buttonProps
}: IconButtonProps): ReactElement {
  const classes = ["icon-button", `icon-button--${tone}`, className].filter(Boolean).join(" ");

  return (
    <button className={classes} title={label} {...buttonProps}>
      <Icon size={18} aria-hidden="true" />
      <span className="visually-hidden">{label}</span>
    </button>
  );
}
