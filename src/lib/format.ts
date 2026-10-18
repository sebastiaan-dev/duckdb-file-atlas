/** Binary byte sizes for the UI; null and non-finite values read "Unknown". */
export function formatBytes(value: number | null | undefined, precise = false) {
  if (value == null || !Number.isFinite(value)) return "Unknown";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024)
    return `${(value / 1024).toFixed(precise ? 1 : value >= 10 * 1024 ? 0 : 1)} KiB`;
  if (value < 1024 ** 3)
    return `${(value / 1024 ** 2).toFixed(precise ? 1 : value >= 10 * 1024 ** 2 ? 0 : 1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

const numberFormatter = new Intl.NumberFormat();

export function formatNumber(value: number | null | undefined) {
  return value == null || !Number.isFinite(value)
    ? "Unknown"
    : numberFormatter.format(value);
}
