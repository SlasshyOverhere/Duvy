import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, openExternal } from "../lib/bridge";
import { rememberedLogo } from "../lib/art";
import { rememberSource, useApp } from "../lib/store";
import type { Details, MetaPreview, StreamOption, Video } from "../lib/types";
import { StreamDrawer } from "../components/StreamDrawer";
import { PosterCard, Row, menuFromKey, useDragScroll } from "../components/media";
import { Button, ContextMenu, EmptyState, Icon, IconButton, ImdbMark, Loading, type ContextAction } from "../components/ui";
import {
  airOrder,
  episodeCode,
  episodesUpTo,
  placeholderGradient,
  progressPercent,
  runtimeLabel,
  scoreLabel,
  timeAgo,
} from "../lib/format";

// Title pages are the most revisited screen, so the last payload paints first.
const DETAILS_CACHE = new Map<string, Details>();
const DETAILS_CACHE_LIMIT = 40;

const AIR_DATE = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** "Airs 12 Nov 2026" for an episode the catalogue has not caught up with. */
function airsDateLabel(released?: string | null): string | null {
  if (!released) return null;
  const date = new Date(released);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) return null;
  return `Airs ${AIR_DATE.format(date)}`;
}

function firstSeason(details: Details): number | null {
  const seasons = [...new Set(details.videos.map((video) => video.season ?? 1))].sort(
    (a, b) => a - b,
  );
  // Prefer a real season over Specials (season 0).
  return seasons.find((value) => value > 0) ?? seasons[0] ?? null;
}

/** TMDB sends a language code; the table reads better as its name. */
function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Episode still or trailer frame. Addons ship dead image URLs often enough
 *  that a broken one falls back to the posterless gradient, not a torn icon. */
function Thumb({
  src,
  seed,
  className,
  fallback,
  children,
}: {
  src?: string | null;
  seed: string;
  className: string;
  fallback?: ReactNode;
  children?: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  const show = Boolean(src) && !failed;
  return (
    <span
      className={className}
      style={show ? undefined : ({ background: placeholderGradient(seed) } as CSSProperties)}
    >
      {show ? (
        <img src={src as string} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        fallback
      )}
      {children}
    </span>
  );
}

/** The first episode of the default season, so Specials never lead. */
function firstEpisode(details: Details): Video | null {
  const season = firstSeason(details);
  return (
    details.videos
      .filter((video) => (video.season ?? 1) === season)
      .sort((a, b) => (a.episode ?? a.number ?? 0) - (b.episode ?? b.number ?? 0))[0] ?? null
  );
}

/** The row that opened this page holds the hero: name, art, year, rating, blurb. */
function seededDetails(preview: MetaPreview): Details {
  return {
    id: preview.id,
    type: preview.type,
    name: preview.name,
    poster: preview.poster,
    background: preview.background,
    logo: preview.logo,
    description: preview.description,
    releaseInfo: preview.releaseInfo,
    year: preview.releaseInfo,
    rating: preview.imdbRating,
    genres: preview.genres ?? [],
    runtime: preview.runtime,
    videos: [],
    cast: [],
    director: [],
    writer: [],
    composer: [],
    country: [],
    trailers: [],
    seasons: [],
    networks: [],
    companies: [],
    collectionItems: [],
    originCountry: [],
    source: "seed",
  };
}

export function DetailsView({
  id,
  type,
  preview,
}: {
  id: string;
  type: string;
  preview?: MetaPreview;
}) {
  const cacheKey = `${type}:${id}`;
  const {
    navigate,
    playRequest,
    toggleLibrary,
    inLibrary,
    progress,
    progressFor,
    resumeEntry,
    markWatched,
    markWatchedMany,
    watched,
    notify,
    buildSession,
    resolveStream,
    settings,
  } = useApp();

  // Keyed by cacheKey so a title swap can never paint the previous payload.
  const [loaded, setLoaded] = useState<{ key: string; details: Details } | null>(() => {
    const hit = DETAILS_CACHE.get(cacheKey);
    return hit ? { key: cacheKey, details: hit } : null;
  });
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ key: string; season: number } | null>(null);
  const [drawer, setDrawer] = useState<{ video: Video | null } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; video: Video } | null>(null);
  const [actionsMenu, setActionsMenu] = useState<{ x: number; y: number } | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const [brokenPhotos, setBrokenPhotos] = useState<Record<string, boolean>>({});
  const [similar, setSimilar] = useState<MetaPreview[]>([]);
  // The card that was clicked already knows the hero, so paint it at once and
  // let the rest of the page fill in behind it.
  const details =
    loaded?.key === cacheKey
      ? loaded.details
      : preview && !error
        ? seededDetails(preview)
        : null;
  // A TMDB id and its IMDb twin are the same title, so one id owns its rows.
  const metaId = details?.imdbId ?? id;
  const episodeRail = useRef<HTMLDivElement>(null);
  const castRail = useRef<HTMLDivElement>(null);
  useDragScroll(episodeRail, details);
  useDragScroll(castRail, details);

  useEffect(() => {
    let alive = true;
    const hit = DETAILS_CACHE.get(cacheKey);
    setError(null);
    setImageFailed(false);
    setPhotos({});
    setBrokenPhotos({});
    setSimilar([]);
    api
      .details(id, type)
      .then((result) => {
        if (!alive) return;
        if (DETAILS_CACHE.size >= DETAILS_CACHE_LIMIT) {
          const oldest = DETAILS_CACHE.keys().next();
          if (!oldest.done) DETAILS_CACHE.delete(oldest.value);
        }
        DETAILS_CACHE.set(cacheKey, result);
        setLoaded({ key: cacheKey, details: result });
      })
      .catch((e: unknown) => {
        if (alive && !hit) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [id, type, cacheKey]);

  // Photos and neighbours land after the page paints: the title is readable
  // immediately, and both requests are decoration, never a blocker.
  useEffect(() => {
    if (!details || details.source === "seed") return;
    let alive = true;
    const cast = details.cast ?? [];
    // TMDB already sent a face per cast member; only the gaps need a lookup.
    const faceless = cast.filter((member) => !member.photo).map((member) => member.name);
    if (faceless.length > 0) {
      api
        .castPhotos(faceless, details.name)
        .then((map) => {
          if (alive) setPhotos(map);
        })
        .catch(() => {});
    }
    const genre = (details.genres ?? [])[0];
    if (genre) {
      api
        .similar(details.type, genre, details.id)
        .then((items) => {
          if (alive) setSimilar(items);
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [details]);

  const seriesProgress = useMemo(
    () =>
      progress
        .filter((entry) => entry.metaId === metaId)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null,
    [progress, metaId],
  );

  const seasons = useMemo(
    () => [...new Set((details?.videos ?? []).map((video) => video.season ?? 1))].sort((a, b) => a - b),
    [details],
  );

  // TMDB art for the seasons we can actually play; a missing poster falls back
  // to the chip picker instead of an empty tile.
  const seasonArt = useMemo(() => {
    const art = new Map<number, string>();
    for (const season of details?.seasons ?? []) {
      if (season.poster) art.set(season.number, season.poster);
    }
    return art;
  }, [details]);

  // Explicit marks for this title, so an episode can be ticked off without
  // playing it first. The store's watched list keeps one row per title, so the
  // per-episode marks come from their own read, refetched after every change.
  const [marked, setMarked] = useState<Array<[string, number]>>([]);

  useEffect(() => {
    let alive = true;
    api.watched
      .marks(metaId)
      .then((rows) => {
        if (alive) setMarked(rows);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [metaId, watched]);

  const marks = useMemo(() => new Map(marked), [marked]);

  const toggleWatched = useCallback(
    (key: string, next: boolean) => {
      markWatched(key, metaId, next)
        .then(() => notify(next ? "Marked as watched" : "Marked as unwatched"))
        .catch(() => notify("Could not update that", "error"));
    },
    [markWatched, metaId, notify],
  );

  /** Every episode from the first one through `target` still needing a mark. */
  const unmarkedUpTo = useCallback(
    (target: Video) => {
      if (!details) return [];
      return episodesUpTo(details.videos, target)
        .map((video) => buildSession(details, video).key)
        .filter((key) => {
          if (marks.has(key)) return false;
          const entry = progressFor(key);
          return !entry || progressPercent(entry.position, entry.duration) < 90;
        });
    },
    [details, buildSession, marks, progressFor],
  );

  const markUpTo = useCallback(
    (target: Video) => {
      const keys = unmarkedUpTo(target);
      if (!keys.length) return;
      markWatchedMany(keys, metaId)
        .then(() => notify(`${keys.length} episodes marked as watched`))
        .catch(() => notify("Could not update those", "error"));
    },
    [unmarkedUpTo, markWatchedMany, metaId, notify],
  );

  const defaultSeason = useMemo(() => (details ? firstSeason(details) : null), [details]);

  // A pick only counts for the title it was made on, and only while that season
  // still exists, so switching titles never leaves an empty episode list.
  const season =
    picked && picked.key === cacheKey && seasons.includes(picked.season)
      ? picked.season
      : defaultSeason;

  const episodes = useMemo(
    () =>
      (details?.videos ?? [])
        .filter((video) => (video.season ?? 1) === season)
        .sort(
          (a, b) =>
            (a.episode ?? a.number ?? 0) - (b.episode ?? b.number ?? 0),
        ),
    [details, season],
  );

  const similarRow = useMemo(
    () =>
      similar.map((item) => (
        <PosterCard
          key={item.id}
          item={item}
          onOpen={() =>
            navigate({ name: "details", id: item.id, type: item.type, preview: item })
          }
        />
      )),
    [similar, navigate],
  );

  // A title or episode is behind the viewer once it is marked or played out.
  const finished = useCallback(
    (key: string) => {
      if (marks.has(key)) return true;
      const entry = progressFor(key);
      return Boolean(entry && progressPercent(entry.position, entry.duration) >= 90);
    },
    [marks, progressFor],
  );

  const resumeTarget = useMemo(() => {
    if (!details) return { video: null as Video | null, position: 0, label: "Play" };
    if (details.type !== "series") {
      const entry = finished(metaId) ? undefined : progressFor(metaId);
      return {
        video: null,
        position: entry?.position ?? 0,
        label: entry ? "Resume" : "Play",
      };
    }
    const queue = [...details.videos].sort((a, b) => {
      const [aSeason, aEpisode] = airOrder(a);
      const [bSeason, bEpisode] = airOrder(b);
      return aSeason - bSeason || aEpisode - bEpisode;
    });
    // A finished episode is behind the viewer, so resume walks forward to the
    // first one still open instead of replaying it.
    const done = (video: Video) => finished(buildSession(details, video).key);
    const at = queue.findIndex(
      (candidate) =>
        candidate.season === seriesProgress?.season &&
        (candidate.episode ?? candidate.number) === seriesProgress?.episode,
    );
    const start = at < 0 ? 0 : at;
    const video =
      queue.slice(start).find((candidate) => !done(candidate)) ?? firstEpisode(details);
    const entry = video ? progressFor(buildSession(details, video).key) : undefined;
    return {
      video,
      position: entry?.position ?? 0,
      label: video ? `${entry ? "Resume" : "Play"} ${episodeCode(video)}` : "Play",
    };
  }, [details, seriesProgress, progressFor, buildSession, finished]);

  // The check marks what the play button points at: the title for a movie, the
  // episode it would resume for a show.
  const watchTarget = useMemo(() => {
    if (!details) return null;
    const video = details.type === "series" ? resumeTarget.video : null;
    if (details.type === "series" && !video) return null;
    const key = video ? buildSession(details, video).key : metaId;
    return { key, watched: finished(key) };
  }, [details, resumeTarget.video, buildSession, metaId, finished]);

  /** Resume goes straight back to what was playing; the drawer is for picking anew. */
  const playOrResume = () => {
    if (!details) return;
    const target = resumeTarget.video;
    const key = target ? buildSession(details, target).key : metaId;
    const entry = finished(key) ? undefined : progressFor(key);
    if (entry) {
      void resumeEntry(entry);
      return;
    }
    openSources(null);
  };

  const openSources = useCallback(
    (video: Video | null) => {
      if (!details) return;
      const target = video ?? (details.type === "series" ? resumeTarget.video : null);
      if (details.type === "series" && !target) {
        notify("This show has no episodes listed yet.", "error");
        return;
      }
      setDrawer({ video: target });
    },
    [details, resumeTarget.video, notify],
  );

  // Rebuilt only when the season, the progress or the title changes, so a
  // progress tick elsewhere never re-keys a hundred episode cards.
  const episodeRows = useMemo(() => {
    if (!details) return null;
    return episodes.map((video) => {
      const key = buildSession(details, video).key;
      const entry = progressFor(key);
      const percent = entry ? progressPercent(entry.position, entry.duration) : 0;
      const markedAt = marks.get(key);
      const done = markedAt != null || percent >= 90;
      const code = episodeCode(video);
      const airs = airsDateLabel(video.released);
      return (
        <div
          key={`${video.id}:${video.season ?? 1}:${video.episode ?? video.number ?? 0}`}
          className="episode"
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, video });
          }}
        >
          <button
            type="button"
            className="episode-open"
            onClick={() => openSources(video)}
            onKeyDown={(event) => {
              const at = menuFromKey(event);
              if (at) setMenu({ ...at, video });
            }}
            aria-label={`Play ${code}${video.title ? ` · ${video.title}` : ""}`}
          >
            <Thumb
              className="episode-thumb"
              src={video.thumbnail}
              seed={key}
              fallback={
                // No still yet: the number on a plate reads as deliberate,
                // where an empty box read as a broken card.
                <span className="episode-plate" aria-hidden="true">
                  {String(video.episode ?? video.number ?? 0).padStart(2, "0")}
                </span>
              }
            >
              <span className="episode-play">
                <Icon name="play" size={16} />
              </span>
            </Thumb>
            <span className="episode-body">
              <span className="episode-top">
                <span className="episode-num">{code}</span>
                <span className="episode-title">{video.title ?? "Untitled episode"}</span>
                {done ? (
                  <span className="episode-seen">
                    Watched {timeAgo(markedAt ?? entry?.updatedAt ?? 0)}
                  </span>
                ) : entry ? (
                  <span className="episode-seen">In progress</span>
                ) : null}
              </span>
              <span className="episode-overview">{video.overview || airs || ""}</span>
              {percent > 0 && percent < 90 ? (
                <span className="episode-progress">
                  <span style={{ width: `${percent}%` }} />
                </span>
              ) : null}
            </span>
          </button>
          <button
            type="button"
            className="episode-watch"
            aria-pressed={done}
            aria-label={`Mark ${code} as ${done ? "unwatched" : "watched"}`}
            title={`Mark ${code} as ${done ? "unwatched" : "watched"}`}
            onClick={() => toggleWatched(key, !done)}
          >
            <Icon name="check" size={15} />
          </button>
        </div>
      );
    });
  }, [
    details,
    episodes,
    openSources,
    progressFor,
    buildSession,
    marks,
    toggleWatched,
  ]);

  const startStream = async (stream: StreamOption) => {
    if (!details || !drawer) return;
    const session = buildSession(details, drawer.video);
    const stored = settings?.autoResume ? progressFor(session.key) : undefined;
    // A finished session restarts instead of opening on its last seconds.
    const resume = stored && !finished(session.key) ? stored.position : 0;
    const title = drawer.video
      ? `${details.name} · ${episodeCode(drawer.video)}`
      : details.name;
    try {
      const url = await resolveStream(stream);
      const opened = await playRequest({ url, title, startAt: resume, session });
      if (!opened) return;
      rememberSource(session.key, stream);
      // Only close once playback is actually opening, so a failed source can be
      // retried without reopening the drawer.
      setDrawer(null);
    } catch (error) {
      notify(error instanceof Error ? error.message : "That source could not be opened.", "error");
    }
  };

  const drawerRequest =
    details && drawer
      ? {
          id: details.imdbId ?? details.id,
          mediaType: details.type,
          season: drawer.video?.season ?? null,
          episode: drawer.video?.episode ?? drawer.video?.number ?? null,
          imdbId: details.imdbId,
        }
      : null;

  if (!details) {
    return (
      <div className="page">
        {error ? (
          <EmptyState
            icon="info"
            title="Could not load this title"
            body={error}
            action={<Button onClick={() => navigate({ name: "home" })}>Back home</Button>}
          />
        ) : (
          <Loading variant="detail" label="Loading title" />
        )}
      </div>
    );
  }

  const inWatchlist = inLibrary(metaId);
  const rating = scoreLabel(details.rating);
  const trailer = details.trailer;
  const detailMenu: ContextAction[] = [
    { label: "Sources", icon: "sliders", onSelect: () => openSources(resumeTarget.video) },
  ];
  if (trailer) {
    detailMenu.push({
      label: "Trailer",
      icon: "external",
      onSelect: () =>
        void openExternal(trailer).catch(() => notify("Could not open the trailer", "error")),
    });
  }
  const logo = details.logo ?? rememberedLogo(metaId);
  const origin = (details.originCountry ?? []).length
    ? details.originCountry ?? []
    : details.country ?? [];
  const factRows = (
    [
      ["Status", details.status ?? ""],
      ["Release info", details.releaseInfo ?? ""],
      ["Runtime", runtimeLabel(details.runtime) ?? ""],
      ["Certification", details.certification ?? ""],
      ["Origin country", origin.join(", ")],
      ["Original language", details.originalLanguage ? languageName(details.originalLanguage) : ""],
    ] as Array<[string, string]>
  ).filter(([, value]) => value);

  // A show belongs to its network; a film to its studio. Either falls back.
  const isSeries = details.type === "series";
  const studios = isSeries
    ? (details.networks ?? []).length
      ? details.networks ?? []
      : details.companies ?? []
    : (details.companies ?? []).length
      ? details.companies ?? []
      : details.networks ?? [];
  const collection = details.collectionItems ?? [];
  const crewRows = (
    [
      [isSeries ? "Creator" : "Director", (details.director ?? []).join(", ")],
      ["Writer", (details.writer ?? []).join(", ")],
      ["Music", (details.composer ?? []).join(", ")],
    ] as Array<[string, string]>
  ).filter(([, value]) => value);

  return (
    <div className="page detail-page">
      <section
        className="detail-hero"
        style={{ background: placeholderGradient(details.name) } as CSSProperties}
      >
        {details.background && !imageFailed ? (
          <img
            className="detail-backdrop"
            src={details.background}
            alt=""
            onError={() => setImageFailed(true)}
          />
        ) : null}
        <div className="detail-scrim" aria-hidden="true" />
        <div className="detail-shell">
          <div className="detail-info">
            <h1 className="detail-title">
              {logo ? (
                <img className="detail-logo" src={logo} alt={details.name} draggable={false} />
              ) : (
                details.name
              )}
            </h1>
              <div className="detail-meta">
                <span className="detail-kind">{details.type === "series" ? "Show" : "Movie"}</span>
                {details.year ? <span>{details.year}</span> : null}
                {runtimeLabel(details.runtime) ? <span>{runtimeLabel(details.runtime)}</span> : null}
                {rating ? (
                  <span className="detail-rating">
                    <span>{rating}</span>
                    <ImdbMark />
                  </span>
                ) : null}
                {details.status ? <span>{details.status}</span> : null}
                {(details.genres ?? []).slice(0, 3).map((genre) => (
                  <span key={genre} className="detail-genre">
                    {genre}
                  </span>
                ))}
              </div>
              <p className="detail-overview">{details.description || "No overview yet."}</p>

              <div className={`detail-actions${actionsOpen ? " is-open" : ""}`}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={playOrResume}
                  disabled={details.type === "series" && details.videos.length === 0}
                >
                  <Icon name="play" size={17} />
                  <span>{resumeTarget.label}</span>
                </button>
                <div className="detail-actions-extra" inert={!actionsOpen}>
                  <IconButton
                    icon="check"
                    size={19}
                    label={watchTarget?.watched ? "Mark as unwatched" : "Mark as watched"}
                    active={watchTarget?.watched}
                    disabled={!watchTarget}
                    onClick={() => {
                      if (watchTarget) toggleWatched(watchTarget.key, !watchTarget.watched);
                    }}
                  />
                  <IconButton
                    icon="library"
                    size={19}
                    label={inWatchlist ? "Remove from library" : "Add to library"}
                    active={inWatchlist}
                    onClick={() =>
                      void toggleLibrary({
                        id: metaId,
                        type: details.type,
                        name: details.name,
                        poster: details.poster,
                        background: details.background,
                        releaseInfo: details.year,
                        imdbRating: rating,
                      })
                    }
                  />
                </div>
                <button
                  type="button"
                  className={`icon-btn detail-actions-toggle${actionsOpen ? " is-active" : ""}`}
                  aria-label={actionsOpen ? "Hide actions" : "Show actions"}
                  aria-expanded={actionsOpen}
                  title={actionsOpen ? "Hide actions" : "Show actions"}
                  onClick={() => setActionsOpen((open) => !open)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    const box = event.currentTarget.getBoundingClientRect();
                    setActionsMenu({ x: box.left, y: box.bottom + 8 });
                  }}
                >
                  <Icon name="more" size={19} />
                </button>
              </div>
            </div>
          </div>
      </section>

      {details.type === "series" && details.videos.length > 0 ? (
        <section className="detail-shell detail-section episodes">
          <div className="episodes-head">
            <h2>Episodes</h2>
            {seasonArt.size === 0 ? (
              <div className="season-tabs" role="group" aria-label="Seasons">
                {seasons.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`chip${season === value ? " is-active" : ""}`}
                    aria-pressed={season === value}
                    onClick={() => setPicked({ key: cacheKey, season: value })}
                  >
                    {value === 0 ? "Specials" : `Season ${value}`}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {seasonArt.size > 0 ? (
            <div className="season-rail" role="group" aria-label="Seasons">
              {seasons.map((value) => {
                const poster = seasonArt.get(value);
                const active = season === value;
                return (
                  <button
                    key={value}
                    type="button"
                    className={`season-card${active ? " is-active" : ""}`}
                    aria-pressed={active}
                    onClick={() => setPicked({ key: cacheKey, season: value })}
                  >
                    <span className="season-poster">
                      {poster ? (
                        <img src={poster} alt="" loading="lazy" />
                      ) : (
                        <span className="season-fallback">{value === 0 ? "S" : value}</span>
                      )}
                    </span>
                    <span className="season-name">
                      {value === 0 ? "Specials" : `Season ${value}`}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}

          <div className="episode-list" ref={episodeRail}>{episodeRows}</div>
        </section>
      ) : null}

      {studios.length ? (
        <section className="detail-shell detail-section production-section">
          <h2>{isSeries ? "Network" : "Production"}</h2>
          <div className="network-row">
            {studios.slice(0, 6).map((studio) => (
              <span className="network" key={studio.name}>
                {studio.logo && !brokenPhotos[studio.name] ? (
                  <img
                    src={studio.logo}
                    alt=""
                    loading="lazy"
                    onError={() =>
                      setBrokenPhotos((current) => ({ ...current, [studio.name]: true }))
                    }
                  />
                ) : null}
                <span className="network-name">{studio.name}</span>
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {(details.cast ?? []).length ? (
        <section className="detail-shell detail-section cast-section">
          <h2>Cast</h2>
          <div className="cast-grid" ref={castRail}>
            {(details.cast ?? []).map((member, index) => {
              const photo = brokenPhotos[member.name]
                ? undefined
                : member.photo ?? photos[member.name];
              const personId = member.personId;
              const face = (
                <>
                  <span className="cast-photo">
                    {photo ? (
                      <img
                        src={photo}
                        alt=""
                        loading="lazy"
                        onError={() =>
                          setBrokenPhotos((current) => ({ ...current, [member.name]: true }))
                        }
                      />
                    ) : (
                      <span>{member.name.slice(0, 1)}</span>
                    )}
                  </span>
                  <span className="cast-name">{member.name}</span>
                  {member.character ? <span className="cast-role">{member.character}</span> : null}
                </>
              );
              // A face with a TMDB id opens the person behind it.
              return personId ? (
                <button
                  key={`${member.name}:${index}`}
                  type="button"
                  className="cast-card is-link"
                  onClick={() => navigate({ name: "person", id: personId })}
                >
                  {face}
                </button>
              ) : (
                <div className="cast-card" key={`${member.name}:${index}`}>
                  {face}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {crewRows.length ? (
        <section className="detail-shell detail-section crew-section">
          <h2>Crew</h2>
          <dl className="detail-table">
            {crewRows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {(details.trailers ?? []).length ? (
        <section className="detail-shell detail-section">
          <Row title="Trailers">
            {(details.trailers ?? []).map((link) => (
              <button
                key={link.url}
                type="button"
                className="trailer-card"
                onClick={() =>
                  void openExternal(link.url).catch(() =>
                    notify("Could not open the trailer", "error"),
                  )
                }
              >
                <Thumb className="trailer-thumb" src={link.thumbnail} seed={link.name}>
                  <span className="trailer-play">
                    <Icon name="play" size={16} />
                  </span>
                </Thumb>
                <span className="trailer-name">{link.name}</span>
                {link.year ? <span className="trailer-year">{link.year}</span> : null}
              </button>
            ))}
          </Row>
        </section>
      ) : null}

      {factRows.length ? (
        <section className="detail-shell detail-section">
          <h2>Details</h2>
          <dl className="detail-table">
            {factRows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {collection.length ? (
        <section className="detail-shell detail-section collection-section">
          <Row title={details.collectionName ?? "Collection"}>
            {collection.map((item) => (
              <PosterCard
                key={item.id}
                item={item}
                onOpen={() =>
                  navigate({ name: "details", id: item.id, type: item.type, preview: item })
                }
              />
            ))}
          </Row>
        </section>
      ) : null}

      {similar.length > 0 ? (
        <section className="detail-shell detail-section similar-section">
          <Row
            title="More like this"
            detail={<span className="row-detail">{(details.genres ?? [])[0] ?? "Discover"}</span>}
          >
            {similarRow}
          </Row>
          {details.source === "tmdb" ? <p className="detail-source">Powered by TMDB</p> : null}
        </section>
      ) : null}

      {actionsMenu ? (
        <ContextMenu
          x={actionsMenu.x}
          y={actionsMenu.y}
          title={details.name}
          onClose={() => setActionsMenu(null)}
          actions={detailMenu}
        />
      ) : null}

      {menu
        ? (() => {
            const key = buildSession(details, menu.video).key;
            const entry = progressFor(key);
            const done =
              marks.has(key) ||
              (entry ? progressPercent(entry.position, entry.duration) >= 90 : false);
            const earlier = unmarkedUpTo(menu.video);
            return (
              <ContextMenu
                x={menu.x}
                y={menu.y}
                title={`${episodeCode(menu.video)}${
                  menu.video.title ? ` · ${menu.video.title}` : ""
                }`}
                onClose={() => setMenu(null)}
                actions={[
                  {
                    label: done ? "Mark as unwatched" : "Mark as watched",
                    icon: "check",
                    onSelect: () => toggleWatched(key, !done),
                  },
                  {
                    label:
                      earlier.length > 0
                        ? `Mark all ${earlier.length} up to here watched`
                        : "Nothing earlier to mark",
                    icon: "check",
                    disabled: earlier.length === 0,
                    onSelect: () => markUpTo(menu.video),
                  },
                ]}
              />
            );
          })()
        : null}

      <StreamDrawer
        open={drawer !== null}
        title={details.name}
        subtitle={
          drawer?.video
            ? `${episodeCode(drawer.video)}${drawer.video.title ? ` · ${drawer.video.title}` : ""}`
            : undefined
        }
        request={drawerRequest}
        onClose={() => setDrawer(null)}
        onPlay={(stream) => void startStream(stream)}
      />
    </div>
  );
}
