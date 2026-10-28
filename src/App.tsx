import { Component, Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { TopBar } from "./components/Shell";
import { TitleBar } from "./components/TitleBar";
import { StoreProvider, useApp } from "./lib/store";
import { Icon } from "./components/ui";
import { HomeView } from "./views/Home";
import { Onboarding } from "./views/Onboarding";

// Home ships in the entry chunk because it is the first screen. Everything
// else is fetched on open; the player is prewarmed below.
const PlayerView = lazy(() => import("./views/Player").then((m) => ({ default: m.PlayerView })));
const SearchView = lazy(() => import("./views/Search").then((m) => ({ default: m.SearchView })));
const DetailsView = lazy(() => import("./views/Details").then((m) => ({ default: m.DetailsView })));
const LibraryView = lazy(() => import("./views/Library").then((m) => ({ default: m.LibraryView })));
const WatchedView = lazy(() => import("./views/Watched").then((m) => ({ default: m.WatchedView })));
const SettingsView = lazy(() =>
  import("./views/Settings").then((m) => ({ default: m.SettingsView })),
);

// Idle-prewarm the player chunk so clicking play never waits on the network.
const prewarmPlayer = () => void import("./views/Player");
if (typeof requestIdleCallback === "function") {
  requestIdleCallback(prewarmPlayer, { timeout: 4000 });
} else {
  setTimeout(prewarmPlayer, 1500);
}

// A render error or a failed lazy chunk would otherwise unmount the whole tree
// and leave an empty window, so each screen is wrapped on its own: the shell,
// the library and playback history keep working while one view recovers.
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="empty-state empty-state-fill">
        <h3>This screen hit a snag</h3>
        <p>
          Something in this view stopped rendering. Your library, addons and playback history are
          untouched.
        </p>
        <div className="empty-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => this.setState({ failed: false })}
          >
            Try again
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => window.location.reload()}>
            Reload app
          </button>
        </div>
      </div>
    );
  }
}

function Toasts() {
  const { toasts, dismissToast } = useApp();
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            layout
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.2, ease: [0.22, 0.68, 0.32, 1] }}
            className={`toast toast-${toast.tone}`}
          >
            <Icon
              name={toast.tone === "success" ? "check" : toast.tone === "error" ? "alert" : "info"}
              size={16}
            />
            <span>{toast.text}</span>
            <button type="button" onClick={() => dismissToast(toast.id)} aria-label="Dismiss">
              <Icon name="x" size={14} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function Screen() {
  const { route, booting, bootError, settings } = useApp();
  const [preview, setPreview] = useState(false);

  // Dev builds can replay first run from Settings without touching saved state.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const show = () => setPreview(true);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreview(false);
    };
    window.addEventListener("betternuvio:preview-onboarding", show);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("betternuvio:preview-onboarding", show);
      window.removeEventListener("keydown", key);
    };
  }, []);

  // While something is playing the window shows the native video surface, so
  // the document itself has to stop painting its background.
  useEffect(() => {
    document.documentElement.dataset.video = route.name === "player" ? "true" : "false";
  }, [route.name]);

  if (booting) {
    return (
      <div className="boot">
        <div className="boot-mark">
          <svg viewBox="0 0 100 100" width="72" height="72" aria-hidden="true">
            <path
              fill="var(--accent)"
              fillRule="evenodd"
              d="M23.65 14H44.35A36 36 0 0 1 44.35 86H23.65Z M39.5 28L67 50L39.5 72Z"
            />
          </svg>
        </div>
        <p className="boot-title">betterNuvio</p>
        <p className="boot-sub">Warming up the projector…</p>
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="boot">
        <p className="boot-title">BetterNuvio could not start</p>
        <p className="boot-sub">{bootError}</p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }

  // First run owns the window until it is answered or skipped.
  if (settings && !settings.onboarded) {
    return <Onboarding />;
  }

  if (route.name === "player") {
    return (
      <>
        <ErrorBoundary>
          <Suspense fallback={null}>
            <PlayerView />
          </Suspense>
        </ErrorBoundary>
        <Toasts />
      </>
    );
  }

  const viewKey = `${route.name}-${"id" in route ? route.id : ""}${
    "mediaType" in route ? route.mediaType ?? "" : ""
  }`;

  return (
    <div className="app">
      <TitleBar />
      <div className="shell">
        <div className="main">
          <TopBar />
          <main className="view" key={viewKey}>
            <ErrorBoundary key={viewKey}>
              <Suspense fallback={<div className="view-loading" aria-hidden="true" />}>
                {route.name === "home" ? <HomeView /> : null}
                {route.name === "search" ? <SearchView query={route.query} /> : null}
                {route.name === "library" ? <LibraryView /> : null}
                {route.name === "watched" ? <WatchedView /> : null}
                {route.name === "settings" ? <SettingsView section={route.section} /> : null}
                {route.name === "details" ? <DetailsView id={route.id} type={route.type} /> : null}
              </Suspense>
            </ErrorBoundary>
          </main>
        </div>
        <Toasts />
      </div>
      {preview ? (
        <div className="ob-preview">
          <Onboarding preview onExit={() => setPreview(false)} />
        </div>
      ) : null}
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Screen />
    </StoreProvider>
  );
}
