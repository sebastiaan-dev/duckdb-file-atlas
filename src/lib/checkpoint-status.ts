import type { CheckpointHeader } from "./types";

export type CheckpointTone = "active" | "previous" | "invalid";

export function checkpointStatus(
  checkpoint: CheckpointHeader,
  activeSlot: 1 | 2,
): { label: string; tone: CheckpointTone; description: string } {
  if (!checkpoint.valid)
    return {
      label: "Invalid",
      tone: "invalid",
      description: "This header failed validation",
    };
  return checkpoint.slot === activeSlot
    ? {
        label: "Active",
        tone: "active",
        description: "The database reads this checkpoint",
      }
    : {
        label: "Previous",
        tone: "previous",
        description: "Older checkpoint kept for crash recovery",
      };
}

/** Shared schema prefixes (e.g. every table in `main`) are noise in lists. */
export function commonSchemaPrefix(names: string[]) {
  if (!names.length) return "";
  const schemas = new Set(
    names.map((name) => (name.includes(".") ? name.split(".")[0] : "")),
  );
  const [schema] = [...schemas];
  return schemas.size === 1 && schema ? `${schema}.` : "";
}
