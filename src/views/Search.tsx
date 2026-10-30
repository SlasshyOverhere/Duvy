import { useEffect, useRef, useState, type CSSProperties } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, isTauri } from "../lib/bridge";
import { cachedRecos, saveRecos } from "../lib/feed";
import { useApp } from "../lib/store";
import type { HomeRow, MetaPreview } from "../lib/types";
import { PosterCard, Row } from "../components/media";
import { Button, EmptyState, Icon, Loading } from "../components/ui";

const RECENT_KEY = "search.recent";
const RECENT_MAX = 8;
const chipText: CSSProperties = { border: 0, background: "none", padding: 0, color: "inherit" };
const chipRemove: CSSProperties = {
  ...chipText,
  display: "grid",
  placeItems: "center",
  width: 18,
  height: 18,
  margin: "-3px -7px -3px 0",
  color: "var(--faint)",
};

function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string").slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

function storeRecent(items: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(items));
  } catch {
    // Storage can be blocked; recents then last for the session only.
  }
}

function withRecent(list: string[], raw: string): string[] {
  const entry = raw.trim();
  if (!entry) return list;
  const rest = list.filter((item) => item.toLowerCase() !== entry.toLowerCase());
  return [entry, ...rest].slice(0, RECENT_MAX);
}

/// Addon rows arrive after the first paint; keep the first copy of each title.
function mergeResults(base: MetaPreview[], extra: MetaPreview[]): MetaPreview[] {
  const seen = new Set(base.map((item) => `${item.id}-${item.type}`));
  const merged = [...base];
  for (const item of extra) {
    if (!item.name?.trim()) continue;
    const key = `${item.id}-${item.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

// Screen-reader only: announces results without adding a visual row.
const srOnly: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  border: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};

export function SearchView({ query }: { query?: string }) {
  const { navigate, playItem } = useApp();
  const [results, setResults] = useState<MetaPreview[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [value, setValue] = useState(query ?? "");
  // Typing searches on its own; the route only changes on submit.
  const [activeQuery, setActiveQuery] = useState(query ?? "");
  const [waiting, setWaiting] = useState(false);
  // An IME composition is mid-word; searching it would fire on partial input.
  const [ime, setIme] = useState(false);
  const activeRef = useRef(activeQuery);
  activeRef.current = activeQuery;
  const [recos, setRecos] = useState<HomeRow[]>(cachedRecos);
  const [recoState, setRecoState] = useState<"loading" | "ready" | "error">("loading");
  const [recoAttempt, setRecoAttempt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const [recent, setRecent] = useState<string[]>(readRecent);

  const remember = (raw: string) => {
    const next = raw.trim();
    if (!next) return;
    const list = withRecent(recent, next);
    setRecent(list);
    storeRecent(list);
    setValue(next);
    // Submitting the query already on screen reruns it instead of doing nothing.
    if (next === activeQuery) setAttempt((count) => count + 1);
    else setActiveQuery(next);
    navigate({ name: "search", query: next });
  };

  const forget = (entry: string) => {
    const list = recent.filter((item) => item !== entry);
    setRecent(list);
    storeRecent(list);
  };

  useEffect(() => {
    setValue(query ?? "");
    setActiveQuery(query ?? "");
  }, [query]);

  // Stremio searches as you type; the debounce keeps it to one request.
  useEffect(() => {
    if (ime) return;
    const next = value.trim();
    if (next === activeQuery) return;
    const timer = window.setTimeout(() => setActiveQuery(next), 250);
    return () => window.clearTimeout(timer);
  }, [value, activeQuery, ime]);

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    if (!activeQuery) {
      setResults([]);
      setError(null);
      setLoading(false);
      setWaiting(false);
      return;
    }
    let alive = true;
    // Results always belong to the query being asked; never merge across.
    setResults([]);
    setLoading(true);
    setError(null);
    setWaiting(true);
    api
      .search(activeQuery)
      .then((items) => {
        // Addon chunks can land first; append instead of replacing them.
        if (alive) setResults((prev) => mergeResults(items, prev));
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setWaiting(false);
      })
      .finally(() => {
        if (!alive) return;
        setLoading(false);
        // The addon fan-out only streams in the desktop shell; in the browser
        // nothing else is coming, so close the wait here.
        if (!isTauri()) setWaiting(false);
      });
    return () => {
      alive = false;
    };
  }, [activeQuery, attempt]);

  // Addon catalogs finish later and land here.
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ query: string; items: MetaPreview[]; done?: boolean }>(
      "search:addons",
      (event) => {
        if (event.payload.query !== activeRef.current) return;
        setResults((prev) => mergeResults(prev, event.payload.items));
        if (event.payload.done ?? true) setWaiting(false);
      },
    )
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // No event bridge: the metadata results still land.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Recommendations follow the watch history, so they are refetched every visit.
  // Held back while a search is running: the burst is a dozen metadata calls.
  useEffect(() => {
    if (activeQuery) return;
    let alive = true;
    setRecoState("loading");
    const timer = window.setTimeout(() => {
      api
        .recommendations()
        .then((rows) => {
          if (!alive) return;
          setRecos(rows);
          saveRecos(rows);
          setRecoState("ready");
        })
        .catch(() => {
          if (alive) setRecoState("error");
        });
    }, 700);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [recoAttempt, activeQuery]);

  // Search returns both kinds at once; split them the way Stremio does.
  const movies = results.filter((item) => item.type === "movie");
  const series = results.filter((item) => item.type === "series");
  const other = results.filter((item) => item.type !== "movie" && item.type !== "series");

  const card = (item: MetaPreview) => (
    <PosterCard
      key={`${item.id}-${item.type}`}
      item={item}
      caption
      onOpen={() => navigate({ name: "details", id: item.id, type: item.type })}
      onPlay={() => void playItem(item)}
    />
  );

  return (
    <div className="page search-page">
      <h1 className="search-title">Search</h1>

      <form
        className="search-page-form"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          if (ime) return;
          remember(value);
        }}
      >
        <Icon name="search" size={20} />
        <input
          ref={input}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onCompositionStart={() => setIme(true)}
          onCompositionEnd={() => setIme(false)}
          onBlur={() => setIme(false)}
          placeholder="Search titles"
          aria-label="Search movies and shows"
          spellCheck={false}
        />
        {value ? (
          <button
            type="button"
            className="search-clear"
            aria-label="Clear search"
            onClick={() => {
              setValue("");
              navigate({ name: "search" });
              input.current?.focus();
            }}
          >
            <Icon name="x" size={15} />
          </button>
        ) : (
          <kbd className="search-key" aria-hidden="true">
            /
          </kbd>
        )}
      </form>

      <p style={srOnly} role="status" aria-live="polite">
        {!activeQuery
          ? ""
          : error && results.length === 0
            ? `Search failed for ${activeQuery}`
            : loading || waiting
              ? `Searching for ${activeQuery}`
              : `${results.length} ${results.length === 1 ? "result" : "results"} for ${activeQuery}`}
      </p>

      {!query && !value && recent.length > 0 ? (
        <div
          className="season-tabs"
          style={{ marginTop: 16 }}
          role="group"
          aria-label="Recent searches"
        >
          {recent.map((entry) => (
            <span className="chip" key={entry}>
              <button style={chipText} onClick={() => remember(entry)}>
                {entry}
              </button>
              <button
                style={chipRemove}
                aria-label={`Remove ${entry} from recent searches`}
                onClick={() => forget(entry)}
              >
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
          <Button
            variant="ghost"
            onClick={() => {
              setRecent([]);
              storeRecent([]);
            }}
          >
            Clear
          </Button>
        </div>
      ) : null}

      {activeQuery ? (
        <div className="search-results">
          {error && results.length === 0 ? (
            <EmptyState
              icon="info"
              title="Search failed"
              body={error}
              action={
                <Button variant="primary" icon="refresh" onClick={() => setAttempt((count) => count + 1)}>
                  Try again
                </Button>
              }
            />
          ) : loading && results.length === 0 ? (
            <Loading variant="grid" label="Searching" />
          ) : results.length === 0 ? (
            waiting ? (
              <Loading variant="grid" label="Searching addons" count={4} />
            ) : (
              <EmptyState
                icon="search"
                title="Nothing matched"
                body="Try a shorter title, or check that a catalog addon with search support is enabled."
              />
            )
          ) : (
            <>
              {movies.length ? (
                <Row
                  title="Popular - Movie"
                  detail={<span className="row-detail">{movies.length}</span>}
                >
                  {movies.map(card)}
                </Row>
              ) : null}
              {series.length ? (
                <Row
                  title="Popular - Series"
                  detail={<span className="row-detail">{series.length}</span>}
                >
                  {series.map(card)}
                </Row>
              ) : null}
              {other.length ? (
                <Row
                  title="More results"
                  detail={<span className="row-detail">{other.length}</span>}
                >
                  {other.map(card)}
                </Row>
              ) : null}
            </>
          )}
        </div>
      ) : recos.length > 0 ? (
        <div className="search-discover">
          {recos.map((row) => (
            <Row key={row.id} title={row.title}>
              {row.items.map(card)}
            </Row>
          ))}
        </div>
      ) : recoState === "loading" ? (
        <Loading variant="rows" label="Cooking up your recommendations" />
      ) : recoState === "error" ? (
        <EmptyState
          icon={null}
          title="Recommendations could not load"
          body="They are built on this machine from your history. If the app has only just started, give it a moment and try again."
          action={
            <Button
              variant="primary"
              icon="refresh"
              onClick={() => setRecoAttempt((count) => count + 1)}
            >
              Try again
            </Button>
          }
        />
      ) : (
        <EmptyState
          icon={null}
          title="Nothing to recommend yet"
          body="Recommendations come from what you finish. Watch one movie or show and this page fills with titles picked from your taste."
          action={
            <Button variant="soft" onClick={() => navigate({ name: "home" })}>
              Find something to watch
            </Button>
          }
        />
      )}
    </div>
  );
}
