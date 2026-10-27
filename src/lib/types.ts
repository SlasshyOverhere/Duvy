export type MediaType = "movie" | "series" | "channel" | "tv";

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
  country: string[];
  trailer?: string | null;
  imdbId?: string | null;
  tmdbId?: number | null;
  source: string;
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
  extra?: { name: string; isRequired?: boolean; options?: string[] }[];
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
}

export interface LibraryItem {
  id: string;
  type: string;
  name: string;
  poster?: string | null;
  background?: string | null;
  addedAt: number;
  meta?: MetaPreview | null;
}

export interface Settings {
  mpvPath: string;
  tmdbApiKey: string;
  accent: string;
  preferredQuality: string;
  autoPlayNext: boolean;
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
  nuvioBaseUrl: string;
  nuvioApiKey: string;
  p2pConsent: boolean;
  p2pCacheMb: number;
  traktScrobble: boolean;
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
  avatarColorHex: string;
  avatarUrl?: string | null;
  pinEnabled: boolean;
}

export interface NuvioSyncReport {
  progress: number;
  watched: number;
  library: number;
  addons: number;
  pushed: number;
}

export interface TorrentStats {
  active: boolean;
  name: string;
  progress: number;
  downloadBps: number;
  uploadBps: number;
  peers: number;
  seeds: number;
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
  mpv: { path: string; version: string } | null;
}

export interface Track {
  id: number;
  label: string;
  lang?: string | null;
  selected: boolean;
  external: boolean;
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
  position: number;
  duration: number;
  /** Seconds fetched ahead of the playhead. */
  buffered?: number;
  title: string;
  volume: number;
  muted: boolean;
  speed: number;
  ended: boolean;
  /** Set when mpv cannot open or continue the source. */
  error?: string | null;
  audioTracks: Track[];
  subTracks: Track[];
  activeAudio?: number | null;
  activeSub?: number | null;
  session?: PlaybackSession | null;
}

export interface PlayRequest {
  url: string;
  title: string;
  startAt?: number;
  session?: PlaybackSession | null;
}
