import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { api, openExternal } from "../lib/bridge";
import { rememberedLogo } from "../lib/art";
import { rememberSource, useApp } from "../lib/store";
import type { Details, MetaPreview, StreamOption, Video } from "../lib/types";
import { StreamDrawer } from "../components/StreamDrawer";
import { PosterCard, Row } from "../components/media";
import { Button, EmptyState, Icon, ImdbMark, Loading } from "../components/ui";
import {
  episodeCode,
  placeholderGradient,
  progressPercent,
  scoreLabel,
  timeAgo,
} from "../lib/format";

// Title pages are the most revisited screen, so the last payload paints first.
const DETAILS_CACHE = new Map<string, Details>();
const DETAILS_CACHE_LIMIT = 40;

function firstSeason(details: Details): number | null {
  const seasons = [...new Set(details.videos.map((video) => video.season ?? 1))].sort(
    (a, b) => a - b,
  );
  // Prefer a real season over Specials (season 0).
  return seasons.find((value) => value > 0) ?? seasons[0] ?? null;
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

export function DetailsView({ id, type }: { id: string; type: string }) {
  const cacheKey = `${type}:${id}`;
  const {
    navigate,
    playRequest,
    toggleLibrary,
    inLibrary,
    progress,
    progressFor,
    resumeEntry,
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
  const [imageFailed, setImageFailed] = useState(false);
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const [brokenPhotos, setBrokenPhotos] = useState<Record<string, boolean>>({});
  const [similar, setSimilar] = useState<MetaPreview[]>([]);
  const details = loaded?.key === cacheKey ? loaded.details : null;

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
    if (!details) return;
    let alive = true;
    const cast = details.cast ?? [];
    if (cast.length > 0) {
      api
        .castPhotos(
          cast.map((member) => member.name),
          details.name,
        )
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
        .filter((entry) => entry.metaId === id)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null,
    [progress, id],
  );

  const seasons = useMemo(
    () => [...new Set((details?.videos ?? []).map((video) => video.season ?? 1))].sort((a, b) => a - b),
    [details],
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

  const resumeTarget = useMemo(() => {
    if (!details) return { video: null as Video | null, position: 0, label: "Play" };
    if (details.type !== "series") {
      const entry = progressFor(details.id);
      return {
        video: null,
        position: entry?.position ?? 0,
        label: entry ? `Resume ${timeAgo(entry.updatedAt)}` : "Play",
      };
    }
    const stored =
      seriesProgress &&
      details.videos.find(
        (candidate) =>
          candidate.season === seriesProgress.season &&
          (candidate.episode ?? candidate.number) === seriesProgress.episode,
      );
    const video = stored || firstEpisode(details);
    const entry = video ? progressFor(buildSession(details, video).key) : undefined;
    return {
      video,
      position: entry?.position ?? 0,
      label: video ? `${entry ? "Resume" : "Play"} ${episodeCode(video)}` : "Play",
    };
  }, [details, seriesProgress, progressFor, buildSession]);

  /** Resume goes straight back to what was playing; the drawer is for picking anew. */
  const playOrResume = () => {
    if (!details) return;
    const target = resumeTarget.video;
    const entry =
      details.type === "series"
        ? target
          ? progressFor(buildSession(details, target).key)
          : null
        : progressFor(details.id);
    if (entry) {
      void resumeEntry(entry);
      return;
    }
    openSources(null);
  };

  const openSources = (video: Video | null) => {
    if (!details) return;
    const target = video ?? (details.type === "series" ? resumeTarget.video : null);
    if (details.type === "series" && !target) {
      notify("This show has no episodes listed yet.", "error");
      return;
    }
    setDrawer({ video: target });
  };

  const startStream = async (stream: StreamOption) => {
    if (!details || !drawer) return;
    const session = buildSession(details, drawer.video);
    const stored = settings?.autoResume ? progressFor(session.key) : undefined;
    // A finished session restarts instead of opening on its last seconds.
    const resume =
      stored && progressPercent(stored.position, stored.duration) < 90 ? stored.position : 0;
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

  const inWatchlist = inLibrary(details.id);
  const rating = scoreLabel(details.rating);
  const trailer = details.trailer;
  const logo = details.logo ?? rememberedLogo(details.id);

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
          <div className="detail-body">
            <div className="detail-poster">
              {details.poster ? <img src={details.poster} alt="" /> : null}
            </div>
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
                {details.runtime ? <span>{details.runtime}</span> : null}
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

              <div className="detail-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={playOrResume}
                  disabled={details.type === "series" && details.videos.length === 0}
                  aria-label={resumeTarget.label}
                  title={resumeTarget.label}
                >
                  <Icon name="play" size={17} />
                </button>
                <Button icon="sliders" onClick={() => openSources(resumeTarget.video)}>
                  Sources
                </Button>
                <Button
                  icon={inWatchlist ? "check" : "plus"}
                  onClick={() =>
                    void toggleLibrary({
                      id: details.id,
                      type: details.type,
                      name: details.name,
                      poster: details.poster,
                      background: details.background,
                      releaseInfo: details.year,
                      imdbRating: rating,
                    })
                  }
                >
                  {inWatchlist ? "In library" : "Library"}
                </Button>
                {trailer ? (
                  <Button
                    icon="external"
                    onClick={() =>
                      void openExternal(trailer).catch(() =>
                        notify("Could not open the trailer", "error"),
                      )
                    }
                  >
                    Trailer
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="detail-credits">
              <dl className="detail-facts">
                {(details.director ?? []).length ? (
                  <div className="detail-fact">
                    <dt>Director</dt>
                    <dd>{(details.director ?? []).join(", ")}</dd>
                  </div>
                ) : null}
                {(details.writer ?? []).length ? (
                  <div className="detail-fact">
                    <dt>Writer</dt>
                    <dd>{(details.writer ?? []).join(", ")}</dd>
                  </div>
                ) : null}
                {(details.country ?? []).length ? (
                  <div className="detail-fact">
                    <dt>Country</dt>
                    <dd>{(details.country ?? []).join(", ")}</dd>
                  </div>
                ) : null}
              </dl>
              {details.source === "tmdb" ? (
                <p className="detail-source">Metadata from TMDB</p>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {details.type === "series" && details.videos.length > 0 ? (
        <section className="detail-shell detail-section episodes">
          <div className="episodes-head">
            <h2>Episodes</h2>
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
          </div>

          <div className="episode-list">
            {episodes.map((video) => {
              const key = buildSession(details, video).key;
              const entry = progressFor(key);
              const percent = entry ? progressPercent(entry.position, entry.duration) : 0;
              return (
                <button
                  key={`${video.id}:${video.season ?? 1}:${video.episode ?? video.number ?? 0}`}
                  type="button"
                  className="episode"
                  onClick={() => openSources(video)}
                >
                  <span className="episode-thumb">
                    {video.thumbnail ? <img src={video.thumbnail} alt="" loading="lazy" /> : null}
                    <span className="episode-play">
                      <Icon name="play" size={16} />
                    </span>
                  </span>
                  <span className="episode-body">
                    <span className="episode-top">
                      <span className="episode-num">{episodeCode(video)}</span>
                      <span className="episode-title">{video.title ?? "Untitled episode"}</span>
                      {entry ? (
                        <span className="episode-seen">
                          {percent >= 90 ? `Watched ${timeAgo(entry.updatedAt)}` : "In progress"}
                        </span>
                      ) : null}
                    </span>
                    <span className="episode-overview">{video.overview ?? ""}</span>
                    {percent > 0 ? (
                      <span className="episode-progress">
                        <span style={{ width: `${percent}%` }} />
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {(details.cast ?? []).length ? (
        <section className="detail-shell detail-section cast-section">
          <h2>Cast</h2>
          <div className="cast-grid">
            {(details.cast ?? []).map((member, index) => {
              const photo = brokenPhotos[member.name]
                ? undefined
                : member.photo ?? photos[member.name];
              return (
                <div className="cast-card" key={`${member.name}:${index}`}>
                  <div className="cast-photo">
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
                  </div>
                  <span className="cast-name">{member.name}</span>
                  {member.character ? <span className="cast-role">{member.character}</span> : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {similar.length > 0 ? (
        <section className="detail-shell detail-section similar-section">
          <Row
            title="More like this"
            detail={<span className="row-detail">{(details.genres ?? [])[0] ?? "Discover"}</span>}
          >
            {similar.map((item) => (
              <PosterCard
                key={item.id}
                item={item}
                onOpen={() => navigate({ name: "details", id: item.id, type: item.type })}
              />
            ))}
          </Row>
        </section>
      ) : null}

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
