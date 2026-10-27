import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { api, isTauri } from "../lib/bridge";
import { useApp, usePlayer, type Route } from "../lib/store";
import { Icon, IconButton, type IconName } from "./ui";

const DOCK: { route: Route; label: string; icon: IconName }[] = [
  { route: { name: "home" }, label: "Home", icon: "home" },
  { route: { name: "discover" }, label: "Discover", icon: "compass" },
  { route: { name: "search" }, label: "Search", icon: "search" },
  { route: { name: "library" }, label: "Library", icon: "library" },
  { route: { name: "watched" }, label: "Watched", icon: "check" },
  { route: { name: "addons" }, label: "Addons", icon: "puzzle" },
];

// Home stays lit on a title page, the way a tab would.
function isActive(route: Route, target: Route) {
  if (target.name === "home") return route.name === "home" || route.name === "details";
  return route.name === target.name;
}

export function TopBar() {
  const { appInfo, navigate, back, route, addons } = useApp();
  const player = usePlayer();
  const [fullscreen, setFullscreen] = useState(
    () => document.documentElement.dataset.fullscreen === "on",
  );

  const toggleFullscreen = useCallback(() => {
    const next = !fullscreen;
    setFullscreen(next);
    // Fullscreen drops the floating window buttons along with the frame.
    if (next) document.documentElement.dataset.fullscreen = "on";
    else delete document.documentElement.dataset.fullscreen;
    void api.window.fullscreen(next);
  }, [fullscreen]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") toggleFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, toggleFullscreen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if (
        (event.key === "/" && !typing) ||
        (event.key.toLowerCase() === "k" && (event.ctrlKey || event.metaKey))
      ) {
        event.preventDefault();
        navigate({ name: "search" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="topbar-left">
        {route.name !== "home" ? <IconButton icon="back" label="Back" onClick={back} /> : null}
        <button
          type="button"
          className="wordmark"
          onClick={() => navigate({ name: "home" })}
          aria-label="BetterNuvio home"
        >
          betterNuvio
        </button>
      </div>

      <nav className="dock" aria-label="Primary">
        {DOCK.map((item) => {
          const active = isActive(route, item.route);
          return (
            <button
              key={item.label}
              type="button"
              className={`dock-item${active ? " is-active" : ""}`}
              onClick={() => navigate(item.route)}
              aria-current={active ? "page" : undefined}
              title={item.label}
            >
              {active ? (
                <motion.span
                  layout
                  layoutId="dock-pill"
                  className="dock-pill"
                  transition={{ type: "spring", stiffness: 420, damping: 34 }}
                />
              ) : null}
              <Icon name={item.icon} size={19} />
              <span className="dock-label">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="topbar-right">
        {addons.length === 0 ? (
          <button type="button" className="pill pill-warn" onClick={() => navigate({ name: "addons" })}>
            <Icon name="puzzle" size={14} /> No addons
          </button>
        ) : null}
        {!appInfo?.mpv ? (
          <button
            type="button"
            className="pill pill-warn"
            onClick={() => navigate({ name: "settings", section: "playback" })}
          >
            <Icon name="monitor" size={14} /> mpv missing
          </button>
        ) : null}

        {player ? (
          <button type="button" className="now-playing" onClick={() => navigate({ name: "player" })}>
            <span className="now-playing-dot" />
            <span className="now-playing-title">{player.session?.name ?? player.title ?? "Playing"}</span>
          </button>
        ) : null}

        <button
          type="button"
          className="profile-btn"
          onClick={() => navigate({ name: "settings" })}
          aria-label="Settings"
          title="Settings"
        >
          <Icon name="settings" size={19} />
        </button>

        {isTauri() ? (
          <button
            type="button"
            className="profile-btn"
            onClick={toggleFullscreen}
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            <Icon name={fullscreen ? "compress" : "expand"} size={19} />
          </button>
        ) : null}
      </div>
    </header>
  );
}
