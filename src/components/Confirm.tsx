import { useEffect } from "react";
import { useApp } from "../lib/store";
import { useFocusTrap } from "./ui";

/**
 * The app's own yes/no card.
 *
 * A native confirmation goes through the dialog plugin, which rejects at the
 * ACL layer when the grant is missing and leaves an unhandled rejection behind.
 * Destructive actions ask here instead, where a missing plugin cannot break
 * them.
 */
export function ConfirmHost() {
  const { confirmRequest, settleConfirm } = useApp();
  const open = Boolean(confirmRequest);
  const trap = useFocusTrap<HTMLDivElement>(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      settleConfirm(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, settleConfirm]);

  if (!confirmRequest) return null;
  const {
    title,
    body,
    confirmLabel = "Continue",
    cancelLabel = "Cancel",
    danger = false,
  } = confirmRequest;

  return (
    <div className="consent">
      <div
        ref={trap}
        className="consent-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={body ? "confirm-body" : undefined}
      >
        <h2 id="confirm-title">{title}</h2>
        {body ? <p id="confirm-body">{body}</p> : null}
        <div className="consent-actions">
          <button
            type="button"
            className={danger ? "btn btn-danger" : "btn btn-primary"}
            autoFocus
            onClick={() => settleConfirm(true)}
          >
            {confirmLabel}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => settleConfirm(false)}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
