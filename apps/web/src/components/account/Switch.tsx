"use client";

type Props = {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
};

export function Switch({ checked, onChange, label, disabled }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="-my-2.5 flex h-11 w-11 shrink-0 items-center rounded-full disabled:opacity-50"
    >
      {/* The track keeps its size; the button around it is the 44px touch target. */}
      <span className={`relative block h-6 w-11 rounded-full transition-colors ${checked ? "bg-accent" : "bg-line"}`}>
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-fg transition-all ${checked ? "left-[22px]" : "left-0.5"}`}
        />
      </span>
    </button>
  );
}
