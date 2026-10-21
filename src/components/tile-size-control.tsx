import { useState, type CSSProperties, type KeyboardEvent } from "react";
import {
  clampTileSize,
  TILE_MAX,
  TILE_MIN,
  TILE_SLIDER_MAX,
  TILE_SLIDER_MIN,
} from "@/lib/heatmap-layout";

/**
 * A fill scrubber for the common tile sizes, with an editable readout that
 * accepts any whole size in TILE_MIN–TILE_MAX. Typed values commit on Enter or
 * blur (not per keystroke, so "16" never lays out a transient 1px map); Escape
 * or an unparseable entry restores the current size.
 */
export function TileSizeControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (size: number) => void;
}) {
  // Non-null only while the user is editing the readout.
  const [draft, setDraft] = useState<string | null>(null);
  const fill = Math.max(
    0,
    Math.min(
      1,
      (value - TILE_SLIDER_MIN) / (TILE_SLIDER_MAX - TILE_SLIDER_MIN),
    ),
  );
  const commit = () => {
    if (draft == null) return;
    const parsed = Number.parseFloat(draft);
    setDraft(null);
    if (Number.isFinite(parsed)) onChange(clampTileSize(parsed));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      commit();
      event.currentTarget.select();
    } else if (event.key === "Escape") {
      setDraft(null);
      event.currentTarget.select();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const base = Number.parseFloat(draft ?? "");
      const next = clampTileSize(
        (Number.isFinite(base) ? base : value) +
          (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 4 : 1),
      );
      setDraft(null);
      onChange(next);
    }
  };
  return (
    <div
      className="tile-size-control"
      style={{ "--tile-fill": fill } as CSSProperties}
    >
      <span>Tile size</span>
      <input
        type="range"
        aria-label="Block tile size"
        aria-valuetext={`${value} pixel tiles`}
        min={TILE_SLIDER_MIN}
        max={TILE_SLIDER_MAX}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="tile-size-entry">
        <input
          type="text"
          inputMode="numeric"
          aria-label="Block tile size in pixels"
          title={`Type a size from ${TILE_MIN} to ${TILE_MAX} px`}
          size={2}
          maxLength={3}
          value={draft ?? String(value)}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
        px
      </span>
    </div>
  );
}
