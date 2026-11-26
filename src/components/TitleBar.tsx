import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "../lib/bridge";
import { useApp } from "../lib/store";
import { Icon } from "./ui";

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

// A refused window call must not surface as an unhandled rejection.
const run = (task: Promise<unknown>) => void task.catch(() => {});

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
            run(win.startResizeDragging(direction));
          }}
        />
      ))}
    </>
  );
}

/**
 * The window buttons live inline at the end of the app's own header row.
 * `player` drops fullscreen, which the player already owns.
 */
export function WindowControls({ variant = "app" }: { variant?: "app" | "player" }) {
  const { fullscreen, requestFullscreen } = useApp();
  const [maximized, setMaximized] = useState(false);
  const shellControls = variant === "app";

  useEffect(() => {
    if (!isTauri()) return;
    const win = getCurrentWindow();
    let alive = true;
    const sync = () =>
      run(
        win.isMaximized().then((value) => {
          if (alive) setMaximized(value);
        }),
      );
    sync();
    const unlisten = win.onResized(sync);
    return () => {
      alive = false;
      run(unlisten.then((off) => off()));
    };
  }, []);

  const toggleFullscreen = useCallback(async () => {
    // The shared controller drops a repeat and reports a refusal, so a failed
    // toggle leaves the button on the real state.
    await requestFullscreen(!fullscreen);
  }, [fullscreen, requestFullscreen]);

  useEffect(() => {
    if (!fullscreen || !shellControls) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void toggleFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, shellControls, toggleFullscreen]);

  // The browser preview has no window to move, so it gets no fake chrome.
  if (!isTauri()) return null;
  const win = getCurrentWindow();

  return (
    <div className="win-bar">
      {shellControls ? (
        <button
          type="button"
          className="win-btn"
          aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          onClick={() => void toggleFullscreen()}
        >
          <Icon name={fullscreen ? "compress" : "expand"} size={17} />
        </button>
      ) : null}
      <button
        type="button"
        className="win-btn win-btn-frame"
        aria-label="Minimise"
        title="Minimise"
        onClick={() => run(win.minimize())}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 5h8" />
        </svg>
      </button>
      <button
        type="button"
        className="win-btn win-btn-frame"
        aria-label={maximized ? "Restore" : "Maximise"}
        title={maximized ? "Restore" : "Maximise"}
        onClick={() => run(win.toggleMaximize())}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          {maximized ? <path d="M3 1.5h5.5V7M1.5 3H7v5.5H1.5z" /> : <path d="M1.5 1.5h7v7h-7z" />}
        </svg>
      </button>
      <button
        type="button"
        className="win-btn win-btn-frame is-close"
        aria-label="Close"
        title="Close"
        onClick={() => run(win.close())}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
        </svg>
      </button>
    </div>
  );
}
