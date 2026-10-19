import { compressionPalette, stableColor } from "@/lib/palette";
import {
  formatRate,
  logicalRamp,
  relativeRamp,
  valueRamp,
  type LogicalColorMode,
  type LogicalMetrics,
  type ValueColumn,
} from "@/lib/logical-colors";

export function LogicalColorLegend({
  mode,
  metrics,
  column,
}: {
  mode: LogicalColorMode;
  metrics: LogicalMetrics;
  column?: ValueColumn;
}) {
  const ramp =
    mode === "relative-footprint"
      ? relativeRamp
      : mode === "value-range"
        ? valueRamp
        : logicalRamp;
  const title =
    mode === "bytes-per-row"
      ? "Bytes per row"
      : mode === "relative-footprint"
        ? "Vs. column median"
        : mode === "null-fraction"
          ? "Null fraction"
          : "Value range";
  return (
    <div
      className="legend logical-color-legend"
      aria-label="Logical color legend"
    >
      {mode === "compression" ? (
        <>
          <span className="legend-title">Compression</span>
          {metrics.compressions
            .filter((name) => name && name.toLowerCase() !== "unknown")
            .map((name) => (
              <span className="legend-item" key={name}>
                <i
                  style={{ background: stableColor(name, compressionPalette) }}
                />
                {name}
              </span>
            ))}
        </>
      ) : (
        <>
          <span className="legend-title">{title}</span>
          {mode === "value-range" && !column ? (
            <span>No numeric or date zonemaps available</span>
          ) : (
            <>
              <span>
                {mode === "relative-footprint"
                  ? "≤0.25×"
                  : mode === "value-range"
                    ? column?.minLabel
                    : "0"}
              </span>
              <span
                className="gradient-legend"
                style={{
                  background: `linear-gradient(90deg, ${ramp.join(",")})`,
                }}
              />
              <span>
                {mode === "relative-footprint"
                  ? "≥4×"
                  : mode === "null-fraction"
                    ? "100%"
                    : mode === "value-range"
                      ? column?.maxLabel
                      : `${formatRate(metrics.maxBytesPerRow)} B/row`}
              </span>
            </>
          )}
          {mode === "bytes-per-row" && (
            <span className="logical-legend-note">Log scale</span>
          )}
          {mode === "null-fraction" && (
            <span className="logical-legend-note">
              Exact counts or confirmed all/none only
            </span>
          )}
          {mode === "relative-footprint" && (
            <span className="logical-legend-note">
              Center = 1× · median of segments in the same column
            </span>
          )}
          {mode === "value-range" && column && (
            <span className="logical-legend-note">
              Each square spans its min → max · other columns dimmed
            </span>
          )}
        </>
      )}
      <span className="legend-unknown">
        <i />
        Unknown
      </span>
      <span className="legend-item">
        <i className="logical-constant-swatch" />
        No data block
      </span>
    </div>
  );
}
