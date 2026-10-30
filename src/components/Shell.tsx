import { useEffect } from "react";
import { motion } from "motion/react";
import { useApp, usePlayer, type Route } from "../lib/store";
import { WindowControls } from "./TitleBar";
import { Icon, IconButton, type IconName } from "./ui";

const DOCK: { route: Route; label: string; icon: IconName }[] = [
  { route: { name: "home" }, label: "Home", icon: "home" },
  { route: { name: "search" }, label: "Search", icon: "search" },
  { route: { name: "library" }, label: "Library", icon: "library" },
  { route: { name: "settings" }, label: "Settings", icon: "settings" },
];

// A title page keeps Home lit, and watched history lives inside Library.
function isActive(route: Route, target: Route) {
  if (target.name === "home") return route.name === "home" || route.name === "details";
  if (target.name === "library") return route.name === "library" || route.name === "watched";
  return route.name === target.name;
}

// Isolated so player ticks do not re-render the whole header.
function NowPlaying() {
  const { navigate } = useApp();
  const player = usePlayer();
  if (!player) return null;
  return (
    <button type="button" className="now-playing" onClick={() => navigate({ name: "player" })}>
      <span className="now-playing-dot" />
      <span className="now-playing-title">{player.session?.name ?? player.title ?? "Playing"}</span>
    </button>
  );
}

export function TopBar() {
  const { navigate, back, route, addons } = useApp();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;
      if (
        (event.key === "/" && !typing) ||
        (event.key.toLowerCase() === "k" && (event.ctrlKey || event.metaKey))
      ) {
        // Navigating again from search would stack an entry and drop the query.
        if (route.name === "search") return;
        event.preventDefault();
        navigate({ name: "search" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, route.name]);

  return (
    <header
      className={`topbar${route.name === "details" ? " topbar-detail" : ""}`}
      data-tauri-drag-region
    >
      <div className="topbar-left" data-tauri-drag-region>
        {route.name !== "home" ? <IconButton icon="back" label="Back" onClick={back} /> : null}
        <button
          type="button"
          className="wordmark"
          onClick={() => navigate({ name: "home" })}
          aria-label="Duvy home"
        >
          Duvy
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
                  transition={{ type: "tween", duration: 0.2, ease: [0.22, 0.68, 0.32, 1] }}
                />
              ) : null}
              <Icon name={item.icon} size={19} />
              <span className="dock-label">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="topbar-right" data-tauri-drag-region>
        {addons.length === 0 ? (
          <button
            type="button"
            className="pill pill-warn"
            onClick={() => navigate({ name: "settings", section: "addons" })}
          >
            <Icon name="puzzle" size={14} /> No addons
          </button>
        ) : null}
        <NowPlaying />

        <WindowControls />
      </div>
    </header>
  );
}
