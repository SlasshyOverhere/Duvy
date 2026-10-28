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
  seasonLabel,
  timeAgo,
} from "../lib/format";

// Title pages are the most revisited screen, so the last payload paints first.
const DETAILS_CACHE = new Map<string, Details>();

function firstSeason(details: Details): number | null {
  const seasons = [...new Set(details.videos.map((video) => video.season ?? 1))].sort(
    (a, b) => a - b,
  );
  // Prefer a real season over Specials (season 0).
  return seasons.find((value) => value > 0) ?? seasons[0] ?? null;
}

export function DetailsView({ id, type }: { id: string; type: string }) {
  const cacheKey = `${type}:${id}`;
  const cached = DETAILS_CACHE.get(cacheKey);
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

  const [details, setDetails] = useState<Details | null>(() => cached ?? null);
  const [loading, setLoading] = useState(() => !cached);
  const [error, setError] = useState<string | null>(null);
  const [season, setSeason] = useState<number | null>(() => (cached ? firstSeason(cached) : null));
  const [drawer, setDrawer] = useState<{ video: Video | null } | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const [brokenPhotos, setBrokenPhotos] = useState<Record<string, boolean>>({});
  const [similar, setSimilar] = useState<MetaPreview[]>([]);

  useEffect(() => {
    let alive = true;
    const hit = DETAILS_CACHE.get(cacheKey);
    if (!hit) setLoading(true);
    setError(null);
    setImageFailed(false);
    api
      .details(id, type)
      .then((result) => {
        if (!alive) return;
        DETAILS_CACHE.set(cacheKey, result);
        setDetails(result);
        setSeason((current) => current ?? firstSeason(result));
      })
      .catch((e: unknown) => {
        if (alive && !hit) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
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
        label: entry ? `Resume · ${timeAgo(entry.updatedAt)}` : "Play",
      };
    }
    const video =
      details.videos.find(
        (candidate) =>
          candidate.season === seriesProgress?.season &&
          (candidate.episode ?? candidate.number) === seriesProgress?.episode,
      ) ?? details.videos[0] ?? null;
    const entry = video ? progressFor(buildSession(details, video).key) : undefined;
    return {
      video,
      position: entry?.position ?? 0,
      label: entry ? "Resume" : "Play",
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
    let target = video;
    if (details.type === "series" && !target) {
      target = resumeTarget.video ?? details.videos[0] ?? null;
    }
    if (details.type === "series" && !target) {
      notify("This show has no episodes listed yet.", "error");
      return;
    }
    setDrawer({ video: target });
  };

  const startStream = async (stream: StreamOption) => {
    if (!details || !drawer) return;
    const session = buildSession(details, drawer.video);
    const resume = settings?.autoResume ? progressFor(session.key)?.position ?? 0 : 0;
    const title = drawer.video
      ? `${details.name} · ${seasonLabel(drawer.video.season, drawer.video.episode ?? drawer.video.number)}`
      : details.name;
    try {
      const url = await resolveStream(stream);
      const opened = await playRequest({ url, title, startAt: resume, session }, stream);
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

  if (loading) {
    return (
      <div className="page">
        <Loading variant="detail" label="Loading title" />
      </div>
    );
  }

  if (error || !details) {
    return (
      <div className="page">
        <EmptyState
          icon="info"
          title="Could not load this title"
          body={error ?? "Unknown error"}
          action={<Button onClick={() => navigate({ name: "home" })}>Back home</Button>}
        />
      </div>
    );
  }

  const inWatchlist = inLibrary(details.id);
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
                {details.rating ? (
                  <span className="detail-rating">
                    <span>{details.rating}</span>
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
                <Button
                  variant="primary"
                  icon="play"
                  onClick={playOrResume}
                  disabled={details.type === "series" && details.videos.length === 0}
                  title={resumeTarget.label}
                />
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
                      imdbRating: details.rating,
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
            <div className="season-tabs">
              {seasons.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`chip${season === value ? " is-active" : ""}`}
                  onClick={() => setSeason(value)}
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
                  key={video.id}
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
                      {entry ? <span className="episode-seen">Watched {timeAgo(entry.updatedAt)}</span> : null}
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
            {(details.cast ?? []).map((member) => {
              const photo = brokenPhotos[member.name]
                ? undefined
                : member.photo ?? photos[member.name];
              return (
                <div className="cast-card" key={`${member.name}-${member.character}`}>
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
