export interface MetaPreview {
  id: string;
  type: string;
  name: string;
  poster?: string | null;
  background?: string | null;
  logo?: string | null;
  description?: string | null;
  releaseInfo?: string | null;
  imdbRating?: string | null;
  genres?: string[] | null;
  runtime?: string | null;
  posterShape?: string | null;
}

export interface Video {
  id: string;
  title?: string | null;
  season?: number | null;
  episode?: number | null;
  number?: number | null;
  overview?: string | null;
  thumbnail?: string | null;
  released?: string | null;
  rating?: string | null;
}

export interface CastMember {
  name: string;
  character: string;
  photo?: string | null;
  /** TMDB person id; a face with one opens its own page. */
  personId?: number | null;
}

/** One season, with the art the season picker shows. */
export interface SeasonSummary {
  number: number;
  name: string;
  poster?: string | null;
  episodes: number;
}

export interface TrailerLink {
  name: string;
  url: string;
  thumbnail?: string | null;
  year?: string | null;
}

export interface Network {
  name: string;
  logo?: string | null;
}

export interface Details {
  id: string;
  type: string;
  name: string;
  poster?: string | null;
  background?: string | null;
  logo?: string | null;
  description?: string | null;
  releaseInfo?: string | null;
  year?: string | null;
  rating?: string | null;
  genres: string[];
  runtime?: string | null;
  status?: string | null;
  videos: Video[];
  cast: CastMember[];
  director: string[];
  writer: string[];
  composer: string[];
  country: string[];
  trailer?: string | null;
  trailers: TrailerLink[];
  seasons: SeasonSummary[];
  networks: Network[];
  companies: Network[];
  collectionName?: string | null;
  collectionItems: MetaPreview[];
  certification?: string | null;
  originCountry: string[];
  originalLanguage?: string | null;
  imdbId?: string | null;
  tmdbId?: number | null;
  source: string;
}

export interface PersonDetails {
  id: number;
  name: string;
  photo?: string | null;
  department?: string | null;
  birthday?: string | null;
  deathday?: string | null;
  placeOfBirth?: string | null;
  biography?: string | null;
  credits: number;
  since?: string | null;
  popular: MetaPreview[];
  latest: MetaPreview[];
  upcoming: MetaPreview[];
}

/** One IMDb parents-guide category, worst first when listed. */
export interface ParentalEntry {
  category: "nudity" | "violence" | "profanity" | "alcohol" | "frightening";
  severity: "none" | "mild" | "moderate" | "severe";
}

export interface StreamOption {
  addon: string;
  name?: string | null;
  title?: string | null;
  description?: string | null;
  url?: string | null;
  infoHash?: string | null;
  fileIdx?: number | null;
  externalUrl?: string | null;
  quality: string;
  size?: string | null;
  sizeBytes?: number | null;
  seeders?: number | null;
  languages: string[];
  badges: string[];
  cached: boolean;
  playable: boolean;
  score: number;
}

export interface SubtitleTrack {
  id: string;
  url: string;
  lang: string;
  addon: string;
}

export interface HomeRow {
  id: string;
  title: string;
  addon?: string | null;
  type: string;
  catalogId: string;
  items: MetaPreview[];
}

export interface HomeFeed {
  continueWatching: ProgressItem[];
  rows: HomeRow[];
  addonErrors: string[];
}

export interface ProgressItem {
  key: string;
  metaId: string;
  type: string;
  name: string;
  poster?: string | null;
  background?: string | null;
  season?: number | null;
  episode?: number | null;
  episodeTitle?: string | null;
  position: number;
  duration: number;
  updatedAt: number;
}

export interface WatchedItem {
  key: string;
  metaId: string;
  type: string;
  name: string;
  poster?: string | null;
  background?: string | null;
  season?: number | null;
  episode?: number | null;
  watchedAt: number;
}

export interface CatalogDef {
  type: string;
  id: string;
  name: string;
  extra: { name: string; isRequired: boolean; options: string[] | null }[];
  genres: string[] | null;
}

export interface AddonInfo {
  url: string;
  addonId: string;
  name: string;
  version: string;
  description?: string | null;
  logo?: string | null;
  enabled: boolean;
  types: string[];
  resources: string[];
  catalogs: CatalogDef[];
  configureUrl?: string | null;
  configurationRequired?: boolean | null;
}

export interface LibraryItem {
  id: string;
  type: string;
  name: string;
  poster?: string | null;
  background?: string | null;
  addedAt: number;
  meta: MetaPreview | null;
}

export interface Settings {
  tmdbApiKey: string;
  accent: string;
  preferredQuality: string;
  /** "size": biggest file first. "addon": the order the addon returned. */
  sourceSort: string;
  autoResume: boolean;
  subtitleLanguage: string;
  audioLanguage: string;
  hardwareDecoding: boolean;
  seekStep: number;
  reduceMotion: boolean;
  homeRowsLimit: number;
  trackProgress: boolean;
  playerWindow: string;
  nuvioAutoSync: boolean;
  stremioAutoSync: boolean;
  nuvioBaseUrl: string;
  nuvioApiKey: string;
  bufferForwardValue: number;
  bufferForwardUnit: string;
  bufferBackwardValue: number;
  bufferBackwardUnit: string;
  traktScrobble: boolean;
  autoUpdateCheck: boolean;
  ignoredUpdateVersion: string;
  /** The bundled metadata addons were installed once already. */
  defaultsSeeded: boolean;
  onboarded: boolean;
  /** Crash reporting: null until the user is asked, off unless they agree. */
  telemetry: boolean | null;
  /** Anonymous usage counts. On unless the user turns it off in Privacy. */
  analytics: boolean;
}

/** A release newer than the running build. */
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes?: string | null;
  date?: string | null;
}

export interface NuvioStatus {
  signedIn: boolean;
  email: string;
  profile: number;
  lastSync: number;
  baseUrl: string;
}

export interface NuvioProfile {
  id: string;
  name: string;
  profileIndex: number;
}

export interface NuvioSyncReport {
  progress: number;
  watched: number;
  library: number;
  addons: number;
  pushed: number;
}

export interface StremioStatus {
  signedIn: boolean;
  email: string;
  lastSync: number;
}

export interface StremioSyncReport {
  addons: number;
  progress: number;
  watched: number;
  library: number;
  pushed: number;
}

export interface DebridProvider {
  id: string;
  name: string;
  connected: boolean;
}

export interface TraktStatus {
  connected: boolean;
  username: string;
  lastSync: number;
  userCode: string;
  verificationUrl: string;
}

export interface AppInfo {
  version: string;
  platform: string;
  dataDir: string;
}

export interface Track {
  id: number;
  label: string;
  lang?: string | null;
  selected: boolean;
  external: boolean;
  /** Signs and songs only, not the dialogue. */
  forced: boolean;
  /** Channels and codec, e.g. "5.1 · Dolby Digital". */
  details?: string | null;
}

export interface Chapter {
  start: number;
  title?: string | null;
}

/** What the stream itself is: shape, rate, codec. */
export interface MediaInfo {
  width: number;
  height: number;
  /** Display aspect ratio. */
  aspect?: number | null;
  fps?: number | null;
  /** Bits per second. */
  bitrate?: number | null;
  videoCodec?: string | null;
  /** HDR10 or HLG; absent for SDR. */
  hdr?: string | null;
}

/** What the player shows while a start is still resolving its source. */
export interface StartingArt {
  name: string;
  sub?: string | null;
  logo?: string | null;
  background?: string | null;
}

export interface PlaybackSession {
  key: string;
  metaId: string;
  type: string;
  name: string;
  poster?: string | null;
  background?: string | null;
  season?: number | null;
  episode?: number | null;
  episodeTitle?: string | null;
}

export interface PlayerSnapshot {
  playing: boolean;
  paused: boolean;
  /** True once the first frame has been decoded. */
  started: boolean;
  position: number;
  duration: number;
  /** Seconds fetched ahead of the playhead. */
  buffered: number;
  /** mpv drained the cache and is waiting on the network. */
  buffering: boolean;
  title: string;
  volume: number;
  muted: boolean;
  speed: number;
  ended: boolean;
  /** An eof well before the duration: the source dropped, not the credits. */
  cutShort: boolean;
  /** Set when mpv cannot open or continue the source. */
  error: string | null;
  audioTracks: Track[];
  subTracks: Track[];
  activeAudio: number | null;
  activeSub: number | null;
  chapters: Chapter[];
  /** Resolution, shape and codec, once the video is initialised. */
  media: MediaInfo | null;
  session: PlaybackSession | null;
  /** Identifies the mpv process; events from an older one are ignored. */
  generation: number;
}

export interface PlayRequest {
  url: string;
  title: string;
  startAt?: number;
  session?: PlaybackSession | null;
}
