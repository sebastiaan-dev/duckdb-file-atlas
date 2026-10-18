import { AlertTriangle } from "lucide-react";
import { storageVersionName } from "@/lib/storage-version";
import "./storage-compatibility-warning.css";

/** Keep storage limitations visible even when the overview is collapsed. */
export function StorageCompatibilityWarning({ version }: { version: number }) {
  // Exact segment lengths were introduced in storage format 69 (v2.0.0).
  if (version >= 69) return null;
  return (
    <aside
      className="storage-compatibility-warning"
      role="status"
      aria-label="Storage compatibility warning"
    >
      <AlertTriangle size={17} aria-hidden="true" />
      <div>
        <strong>
          Limited features · {storageVersionName(version)} storage
        </strong>
        <p>
          Not all inspection features are available for storage formats before
          v2.0.0. Exact column-segment sizes and data internal free space cannot
          be measured. Some older index layouts may also be unmeasured.
        </p>
      </div>
    </aside>
  );
}
