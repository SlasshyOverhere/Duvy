import { useEffect, useMemo, useState } from "react";
import { api, isBrowserPreview } from "../lib/bridge";
import { useApp } from "../lib/store";
import type { AddonInfo, CatalogDef, MetaPreview } from "../lib/types";
import { PosterCard } from "../components/media";
import { Button, EmptyState, Spinner } from "../components/ui";

interface CatalogChoice {
  addon: AddonInfo;
  catalog: CatalogDef;
  key: string;
}

const PAGE_SIZE = 24;

export function DiscoverView({ mediaType }: { mediaType?: string }) {
  const { addons, navigate, playItem } = useApp();
  const [active, setActive] = useState<string | null>(null);
  const [items, setItems] = useState<MetaPreview[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const catalogs = useMemo<CatalogChoice[]>(() => {
    const list: CatalogChoice[] = [];
    addons
      .filter((addon) => addon.enabled)
      .forEach((addon) => {
        addon.catalogs.forEach((catalog) => {
          if (mediaType && catalog.type !== mediaType) return;
          if (catalog.extra?.some((extra) => extra.isRequired)) return;
          list.push({
            addon,
            catalog,
            key: `${addon.url}|${catalog.type}|${catalog.id}`,
          });
        });
      });
    return list;
  }, [addons, mediaType]);

  useEffect(() => {
    if (catalogs.length === 0) {
      setActive(null);
      return;
    }
    if (!active || !catalogs.some((choice) => choice.key === active)) {
      setActive(catalogs[0].key);
    }
  }, [catalogs, active]);

  const selected = catalogs.find((choice) => choice.key === active) ?? null;

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setDone(false);
    setItems([]);
    api
      .catalog({
        addonUrl: selected.addon.url,
        mediaType: selected.catalog.type,
        catalogId: selected.catalog.id,
      })
      .then((page) => {
        if (!alive) return;
        setItems(page.metas);
        setDone(page.metas.length < PAGE_SIZE);
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
  }, [selected?.key]);

  const loadMore = async () => {
    if (!selected || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.catalog({
        addonUrl: selected.addon.url,
        mediaType: selected.catalog.type,
        catalogId: selected.catalog.id,
        skip: items.length,
      });
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...page.metas.filter((item) => !seen.has(item.id))];
      });
      if (page.metas.length < PAGE_SIZE) setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  };

  if (catalogs.length === 0) {
    return (
      <div className="page">
        <EmptyState
          icon="compass"
          title="No catalogs to discover"
          body="Install a catalog addon to browse curated rows and genres here."
          action={
            <Button variant="primary" icon="puzzle" onClick={() => navigate({ name: "addons" })}>
              Add an addon
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="kicker">Discover</p>
          <h1>Everything, from your own sources</h1>
          <p className="page-sub">
            {catalogs.length} catalogs from {new Set(catalogs.map((choice) => choice.addon.url)).size} addons
            {isBrowserPreview() ? " · browser preview data" : ""}
          </p>
        </div>
      </header>

      <div className="catalog-tabs" role="tablist" aria-label="Catalogs">
        {catalogs.map((choice) => (
          <button
            key={choice.key}
            type="button"
            role="tab"
            aria-selected={choice.key === active}
            className={`chip${choice.key === active ? " is-active" : ""}`}
            onClick={() => setActive(choice.key)}
          >
            {choice.catalog.name || choice.catalog.id}
            <span>{choice.catalog.type === "series" ? "Series" : "Movies"}</span>
          </button>
        ))}
      </div>

      {loading ? <Spinner label="Loading catalog…" /> : null}
      {error ? <EmptyState icon="info" title="Catalog failed to load" body={error} /> : null}

      <div className="grid">
        {items.map((item) => (
          <PosterCard
            key={`${item.id}-${item.type}`}
            item={item}
            onOpen={() => navigate({ name: "details", id: item.id, type: item.type })}
            onPlay={() => void playItem(item)}
          />
        ))}
      </div>

      {!loading && !error && items.length > 0 && !done ? (
        <div className="load-more">
          <Button variant="soft" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
