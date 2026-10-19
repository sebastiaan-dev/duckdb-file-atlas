import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { SqlBuilder } from "./sql-builder";
import type { SqlRecipe } from "@/lib/sql-recipes";

/** Build a database from SQL without leaving the workspace. */
export function SqlDialog({
  open,
  onClose,
  recipe,
  onRecipeChange,
  onBuilt,
}: {
  open: boolean;
  onClose: () => void;
  recipe: SqlRecipe;
  onRecipeChange: (recipe: SqlRecipe) => void;
  /** Resolves true when the new database opened. */
  onBuilt: (file: File, recipe: SqlRecipe) => Promise<boolean>;
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
      className="sql-dialog"
      aria-labelledby="sql-dialog-title"
      onClose={onClose}
      onClick={(event) => {
        // Clicking the backdrop (the dialog element itself) closes it.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="sql-dialog-header">
        <div>
          <h2 id="sql-dialog-title">Build a database from SQL</h2>
          <p>The result replaces the open database.</p>
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
        <SqlBuilder
          variant="workspace"
          autoFocus
          recipe={recipe}
          onRecipeChange={onRecipeChange}
          onBuilt={async (file, built) => {
            if (await onBuilt(file, built)) onClose();
          }}
        />
      )}
    </dialog>
  );
}
