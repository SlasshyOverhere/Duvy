import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api } from "../lib/bridge";
import { cachedRecos, saveRecos } from "../lib/feed";
import { useApp } from "../lib/store";
import type { HomeRow, MetaPreview } from "../lib/types";
import { PosterCard, Row } from "../components/media";
import { Button, EmptyState, Icon, Spinner } from "../components/ui";

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

export function SearchView({ query }: { query?: string }) {
  const { navigate, playItem, addons } = useApp();
  const [results, setResults] = useState<MetaPreview[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState(query ?? "");
  const [recos, setRecos] = useState<HomeRow[]>(cachedRecos);
  const [recoState, setRecoState] = useState<"loading" | "ready" | "error">("loading");
  const input = useRef<HTMLInputElement>(null);
  const [recent, setRecent] = useState<string[]>(readRecent);

  const remember = (raw: string) => {
    const next = raw.trim();
    if (!next) return;
    const list = withRecent(recent, next);
    setRecent(list);
    storeRecent(list);
    setValue(next);
    navigate({ name: "search", query: next });
  };

  const forget = (entry: string) => {
    const list = recent.filter((item) => item !== entry);
    setRecent(list);
    storeRecent(list);
  };

  useEffect(() => {
    setValue(query ?? "");
  }, [query]);

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    if (!query) {
      setResults([]);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .search(query)
      .then((items) => {
        if (alive) setResults(items);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [query, addons.length]);

  // Recommendations follow the watch history, so they are refetched every visit.
  useEffect(() => {
    let alive = true;
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
    return () => {
      alive = false;
    };
  }, []);

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
        onSubmit={(event) => {
          event.preventDefault();
          remember(value);
        }}
      >
        <Icon name="search" size={20} />
        <input
          ref={input}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Search movies, shows…"
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
        ) : null}
      </form>

      {!query && !value && recent.length > 0 ? (
        <div className="season-tabs" role="group" aria-label="Recent searches">
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

      {query ? (
        <div className="search-results">
          {loading ? (
            <Spinner label="Searching" />
          ) : error ? (
            <EmptyState icon="info" title="Search failed" body={error} />
          ) : results.length === 0 ? (
            <EmptyState
              icon="search"
              title="Nothing matched"
              body="Try a shorter title, or check that a catalog addon with search support is enabled."
            />
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
        <Spinner label="Cooking up your recommendations" />
      ) : recoState === "error" ? (
        <EmptyState
          icon={null}
          title="Recommendations could not load"
          body="They are built on this machine from your history. If the app has only just started, give it a moment and reopen this page."
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
