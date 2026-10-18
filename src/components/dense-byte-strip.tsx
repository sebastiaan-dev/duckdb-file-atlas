import { memo, useId } from "react";
import type { ByteRange, FileBlock } from "@/lib/types";

/** Exact proportional coordinates, grouped into paths instead of per-range DOM. */
export const DenseByteStrip = memo(function DenseByteStrip({
  block,
  ranges,
  appearances,
}: {
  block: FileBlock;
  ranges: ByteRange[];
  appearances: Map<string, { background: string }>;
}) {
  const pattern = useId();
  const paths = new Map<string, string[]>();
  for (const range of ranges) {
    const left = Math.max(
      0,
      Math.min(100, ((range.offset - block.offset) / block.size) * 100),
    );
    const right = Math.max(
      left,
      Math.min(
        100,
        ((range.offset + range.size - block.offset) / block.size) * 100,
      ),
    );
    if (right <= left) continue;
    const background = appearances.get(range.id)!.background;
    const fill = background.startsWith("repeating-linear-gradient")
      ? `url(#${pattern})`
      : background;
    const parts = paths.get(fill) ?? [];
    parts.push(`M${left} 0h${right - left}v18h${left - right}Z`);
    paths.set(fill, parts);
  }
  return (
    <svg
      className="dense-byte-strip"
      viewBox="0 0 100 18"
      preserveAspectRatio="none"
      role="img"
      aria-label="Dense proportional byte layout; individual range details are listed below"
    >
      <defs>
        <pattern
          id={pattern}
          width="4"
          height="4"
          patternUnits="userSpaceOnUse"
        >
          <rect width="4" height="4" fill="var(--chart-unknown)" />
          <path d="M0 4L4 0" stroke="var(--line)" strokeWidth="1" />
        </pattern>
      </defs>
      {[...paths].map(([fill, parts]) => (
        <path key={fill} fill={fill} d={parts.join(" ")} />
      ))}
    </svg>
  );
});
