import { useEffect, useRef, useState } from "react";
import { api } from "../lib/bridge";
import { cachedRecos, saveRecos } from "../lib/feed";
import { useApp } from "../lib/store";
import type { HomeRow, MetaPreview } from "../lib/types";
import { PosterCard, Row } from "../components/media";
import { Button, EmptyState, Icon, Spinner } from "../components/ui";

export function SearchView({ query }: { query?: string }) {
  const { navigate, playItem, addons } = useApp();
  const [results, setResults] = useState<MetaPreview[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState(query ?? "");
  const [recos, setRecos] = useState<HomeRow[]>(cachedRecos);
  const [recoState, setRecoState] = useState<"loading" | "ready" | "error">("loading");
  const input = useRef<HTMLInputElement>(null);

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

  return (
    <div className="page search-page">
      <h1 className="search-title">Search</h1>

      <form
        className="search-page-form"
        onSubmit={(event) => {
          event.preventDefault();
          const next = value.trim();
          if (next) navigate({ name: "search", query: next });
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

      {query ? (
        <>
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
            <div className="grid">
              {results.map((item) => (
                <PosterCard
                  key={`${item.id}-${item.type}`}
                  item={item}
                  caption
                  onOpen={() => navigate({ name: "details", id: item.id, type: item.type })}
                  onPlay={() => void playItem(item)}
                />
              ))}
            </div>
          )}
        </>
      ) : recos.length > 0 ? (
        <div className="search-discover">
          {recos.map((row) => (
            <Row key={row.id} title={row.title}>
              {row.items.map((item) => (
                <PosterCard
                  key={`${row.id}-${item.id}`}
                  item={item}
                  caption
                  onOpen={() => navigate({ name: "details", id: item.id, type: item.type })}
                  onPlay={() => void playItem(item)}
                />
              ))}
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
