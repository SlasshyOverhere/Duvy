import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "../lib/bridge";

// Frameless windows lose the OS resize border, so each edge gets an invisible
// strip that hands the drag back to the window manager.
type Edge =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

const EDGES: Array<[string, Edge]> = [
  ["north", "North"],
  ["south", "South"],
  ["east", "East"],
  ["west", "West"],
  ["north-east", "NorthEast"],
  ["north-west", "NorthWest"],
  ["south-east", "SouthEast"],
  ["south-west", "SouthWest"],
];

export function ResizeEdges() {
  if (!isTauri()) return null;
  const win = getCurrentWindow();
  return (
    <>
      {EDGES.map(([side, direction]) => (
        <div
          key={side}
          className={`resize-edge resize-${side}`}
          aria-hidden="true"
          onPointerDown={(event) => {
            event.preventDefault();
            void win.startResizeDragging(direction);
          }}
        />
      ))}
    </>
  );
}

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    const win = getCurrentWindow();
    let alive = true;
    void win.isMaximized().then((value) => {
      if (alive) setMaximized(value);
    });
    const unlisten = win.onResized(() => {
      void win.isMaximized().then((value) => {
        if (alive) setMaximized(value);
      });
    });
    return () => {
      alive = false;
      void unlisten.then((off) => off());
    };
  }, []);

  // The browser preview has no window to move, so it gets no fake chrome.
  if (!isTauri()) return null;
  const win = getCurrentWindow();

  return (
    <>
      <div className="titlebar" data-tauri-drag-region>
        <div className="titlebar-controls">
          <button
            type="button"
            className="titlebar-button"
            aria-label="Minimise"
            onClick={() => void win.minimize()}
          >
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <path d="M1 5h8" />
            </svg>
          </button>
          <button
            type="button"
            className="titlebar-button"
            aria-label={maximized ? "Restore" : "Maximise"}
            onClick={() => void win.toggleMaximize()}
          >
            <svg viewBox="0 0 10 10" aria-hidden="true">
              {maximized ? (
                <path d="M3 1.5h5.5V7M1.5 3H7v5.5H1.5z" />
              ) : (
                <path d="M1.5 1.5h7v7h-7z" />
              )}
            </svg>
          </button>
          <button
            type="button"
            className="titlebar-button is-close"
            aria-label="Close"
            onClick={() => void win.close()}
          >
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
            </svg>
          </button>
        </div>
      </div>

      <ResizeEdges />
    </>
  );
}
