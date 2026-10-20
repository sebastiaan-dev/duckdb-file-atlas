import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { ScenarioBuilder } from "./scenario-builder";
import type { ScenarioState } from "@/lib/scenarios";

/** Generate a database without leaving the workspace. */
export function ScenarioDialog({
  open,
  onClose,
  state,
  onChange,
  onBuilt,
}: {
  open: boolean;
  onClose: () => void;
  state: ScenarioState;
  onChange: (state: ScenarioState) => void;
  /** Resolves true when the new database opened. */
  onBuilt: (file: File, state: ScenarioState) => Promise<boolean>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="scenario-dialog"
      aria-labelledby="scenario-dialog-title"
      onClose={onClose}
      onClick={(event) => {
        // Clicking the backdrop (the dialog element itself) closes it.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="scenario-dialog-header">
        <div>
          <h2 id="scenario-dialog-title">Scenarios</h2>
          <p>The generated database replaces the open one.</p>
        </div>
        <button
          type="button"
          className="details-close"
          aria-label="Close"
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </div>
      {open && (
        <ScenarioBuilder
          variant="workspace"
          state={state}
          onChange={onChange}
          onBuilt={async (file, built) => {
            if (await onBuilt(file, built)) onClose();
          }}
        />
      )}
    </dialog>
  );
}
