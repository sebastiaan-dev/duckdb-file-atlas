import { useState, type ReactElement, type ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Info } from "lucide-react";

export type DetailRow = [label: string, value: ReactNode];

/** Compact key/value body shared by every index tooltip. */
export function DetailBody({
  title,
  subtitle,
  swatch,
  rows,
  hint,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  swatch?: string;
  rows: DetailRow[];
  hint?: ReactNode;
}) {
  return (
    <>
      <div className="index-tip-title">
        {swatch && (
          <i className="index-swatch" style={{ background: swatch }} />
        )}
        <strong>{title}</strong>
        {subtitle && <span>{subtitle}</span>}
      </div>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {hint && <p className="index-tip-hint">{hint}</p>}
    </>
  );
}

export function TipContent({
  children,
  wide,
  ...props
}: {
  children: ReactNode;
  wide?: boolean;
} & Pick<
  Tooltip.TooltipContentProps,
  "id" | "onEscapeKeyDown" | "onPointerDownOutside"
>) {
  return (
    <Tooltip.Portal>
      <Tooltip.Content
        {...props}
        className={`index-tip${wide ? " index-tip-prose" : ""}`}
        side="top"
        sideOffset={8}
        collisionPadding={16}
        avoidCollisions
      >
        {children}
        <Tooltip.Arrow className="index-tip-arrow" />
      </Tooltip.Content>
    </Tooltip.Portal>
  );
}

/** Hover/focus tooltip around an existing interactive element. */
export function DetailTip({
  children,
  ...body
}: Parameters<typeof DetailBody>[0] & { children: ReactElement }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <TipContent>
        <DetailBody {...body} />
      </TipContent>
    </Tooltip.Root>
  );
}

/** Small ⓘ affordance for explanatory text; also toggles on tap for touch. */
export function InfoTip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // A click pins the tip open until Escape, an outside press or another click,
  // so taps work on touch and incidental scrolls don't dismiss it.
  const [pinned, setPinned] = useState(false);
  const close = () => {
    setPinned(false);
    setOpen(false);
  };
  return (
    <Tooltip.Root
      open={open || pinned}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        else if (!pinned) setOpen(false);
      }}
    >
      <Tooltip.Trigger asChild>
        <button
          type="button"
          className="index-info"
          aria-label={label}
          aria-expanded={pinned}
          onClick={(event) => {
            event.preventDefault();
            if (pinned) close();
            else setPinned(true);
          }}
        >
          <Info size={13} aria-hidden="true" />
        </button>
      </Tooltip.Trigger>
      <TipContent wide onEscapeKeyDown={close} onPointerDownOutside={close}>
        {children}
      </TipContent>
    </Tooltip.Root>
  );
}
