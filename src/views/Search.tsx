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

  const submit = () => {
    const next = value.trim();
    if (next) navigate({ name: "search", query: next });
  };

  return (
    <div className={`page search-page${query ? " has-results" : ""}`}>
      <div className="search-stage">
        {!query ? (
          <>
            <h1>Search everything</h1>
            <p className="search-hint">Films and series, across every addon you have installed.</p>
          </>
        ) : null}

        <form
          className="search-page-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Icon name="search" size={18} />
          <input
            ref={input}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Search films and series"
            aria-label="Search films and series"
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
              <Icon name="x" size={14} />
            </button>
          ) : null}
        </form>

        {!query ? (
          <p className="search-keys">
            Press <kbd>/</kbd> anywhere to land here
          </p>
        ) : null}
      </div>

      {loading ? (
        <div className="page-loading page-loading-inline">
          <Spinner label="Searching" />
        </div>
      ) : null}

      {!loading && error ? <EmptyState icon="info" title="Search failed" body={error} /> : null}

      {!loading && query && results.length === 0 && !error ? (
        <EmptyState
          icon="search"
          title="Nothing matched"
          body="Try a shorter title, or check that a catalog addon with search support is enabled."
        />
      ) : null}

      {results.length > 0 ? (
        <>
          <p className="search-count">
            {results.length} {results.length === 1 ? "title" : "titles"}
          </p>
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
        </>
      ) : null}
    </div>
  );
}
