import { useEffect, useRef, useState } from "react";
import { api } from "../lib/bridge";
import { useApp } from "../lib/store";
import type { MetaPreview } from "../lib/types";
import { PosterCard } from "../components/media";
import { EmptyState, Icon, Spinner } from "../components/ui";

export function SearchView({ query }: { query?: string }) {
  const { navigate, playItem, addons } = useApp();
  const [results, setResults] = useState<MetaPreview[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState(query ?? "");
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

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="kicker">Search</p>
          <h1>{query ? `Results for “${query}”` : "Search everything"}</h1>
          <p className="page-sub">
            {query
              ? `${results.length} ${results.length === 1 ? "title" : "titles"} across your addons`
              : "Press / anywhere to come straight here."}
          </p>
        </div>
        <form
          className="search-page-form"
          onSubmit={(event) => {
            event.preventDefault();
            const next = value.trim();
            if (next) navigate({ name: "search", query: next });
          }}
        >
          <Icon name="search" size={17} />
          <input
            ref={input}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Search films and series"
            aria-label="Search films and series"
            spellCheck={false}
          />
        </form>
      </header>

      {loading ? <Spinner label="Searching your addons…" /> : null}

      {!loading && error ? (
        <EmptyState icon="info" title="Search failed" body={error} />
      ) : null}

      {!loading && !query ? (
        <EmptyState
          icon="search"
          title="Start with a title"
          body="Search reaches every addon that exposes a search catalog, plus TMDB when a key is configured."
        />
      ) : null}

      {!loading && query && results.length === 0 && !error ? (
        <EmptyState
          icon="search"
          title="Nothing matched"
          body="Try a shorter title, or check that a catalog addon with search support is enabled."
        />
      ) : null}

      <div className="grid">
        {results.map((item) => (
          <PosterCard
            key={`${item.id}-${item.type}`}
            item={item}
            onOpen={() => navigate({ name: "details", id: item.id, type: item.type })}
            onPlay={() => void playItem(item)}
          />
        ))}
      </div>
    </div>
  );
}
