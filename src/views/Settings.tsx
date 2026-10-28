import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, isTauri, openExternal } from "../lib/bridge";
import { useApp } from "../lib/store";
import { Badge, Button, Icon, Loading, Toggle, type IconName } from "../components/ui";
import { NuvioSync } from "./settings/NuvioSync";
import { StremioSync } from "./settings/StremioSync";
import { AddonsPanel } from "./Addons";
import TraktView from "./Trakt";
import DebridView from "./Debrid";
import TorrentView from "./Torrent";
import { MediaServers } from "./settings/MediaServers";
import { Updates } from "./settings/Updates";

type Section = {
  id: string;
  label: string;
  icon: IconName;
  group: string;
  blurb: string;
  keywords: string;
};

const SECTIONS: Section[] = [
  {
    id: "general",
    label: "General",
    icon: "sliders",
    group: "App",
    blurb: "Accent, motion and the language your media plays in.",
    keywords: "accent colour color theme appearance motion animation density rows language audio subtitle",
  },
  {
    id: "playback",
    label: "Playback",
    icon: "play",
    group: "Playback",
    blurb: "How mpv plays, remembers your place and moves between episodes.",
    keywords:
      "mpv player quality 4k 1080p hardware decoding resume next episode skip seek p2p torrent cache disk buffer memory ram forward backward",
  },
  {
    id: "addons",
    label: "Addons",
    icon: "puzzle",
    group: "Connections",
    blurb: "Catalogs, metadata and streams come from the addons you install.",
    keywords: "addon install url stremio protocol catalog stream manifest",
  },
  {
    id: "servers",
    label: "Media servers",
    icon: "tv",
    group: "Connections",
    blurb: "Jellyfin and Emby libraries on your own network.",
    keywords: "jellyfin emby server library login address",
  },
  {
    id: "integrations",
    label: "Integrations",
    icon: "key",
    group: "Connections",
    blurb: "TMDB artwork, Trakt history and debrid accounts.",
    keywords: "tmdb key trakt debrid real-debrid alldebrid premiumize api account",
  },
  {
    id: "sync",
    label: "Sync",
    icon: "cloud",
    group: "Connections",
    blurb: "Keep progress and library in step across your devices.",
    keywords: "nuvio cloud stremio account sync profile backup",
  },
  {
    id: "update",
    label: "Update",
    icon: "download",
    group: "System",
    blurb: "Check for a new release and install it without leaving the app.",
    keywords: "update release version download install changelog",
  },
  // Build-only, so a release never ships a panel that does nothing.
  ...(import.meta.env.DEV
    ? [
        {
          id: "developer",
          label: "Developer",
          icon: "monitor" as IconName,
          group: "System",
          blurb: "Build-only tools. Nothing here exists in a release.",
          keywords: "developer dev debug onboarding preview first run test",
        },
      ]
    : []),
];

const NAV_GROUPS = ["App", "Playback", "Connections", "System"];

const ACCENTS = [
  { id: "ember", label: "Ember" },
  { id: "violet", label: "Violet" },
  { id: "mint", label: "Mint" },
  { id: "rose", label: "Rose" },
];

const QUALITY: ["auto" | "4k" | "1080p" | "720p", string][] = [
  ["auto", "Auto"],
  ["4k", "4K"],
  ["1080p", "1080p"],
  ["720p", "720p"],
];

function Card({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <section className="settings-group">
      <h2>{title}</h2>
      {description ? <p className="settings-hint">{description}</p> : null}
      {children}
    </section>
  );
}

function Row({
  title,
  description,
  control,
}: {
  title: string;
  description?: string;
  control?: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <h3>{title}</h3>
        {description ? <p>{description}</p> : null}
      </div>
      {control ? <div className="settings-control">{control}</div> : null}
    </div>
  );
}

function Callout({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warn" | "danger";
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={`settings-callout is-${tone}`}>
      <Icon name={tone === "info" ? "info" : "alert"} size={15} />
      <div className="settings-callout-copy">
        {title ? <strong>{title}</strong> : null}
        {children}
      </div>
    </div>
  );
}

const LANGUAGES: Array<[code: string, name: string]> = [
  ["eng", "English"],
  ["spa", "Spanish"],
  ["fra", "French"],
  ["deu", "German"],
  ["ita", "Italian"],
  ["por", "Portuguese"],
  ["nld", "Dutch"],
  ["swe", "Swedish"],
  ["nor", "Norwegian"],
  ["dan", "Danish"],
  ["fin", "Finnish"],
  ["pol", "Polish"],
  ["ces", "Czech"],
  ["hun", "Hungarian"],
  ["ron", "Romanian"],
  ["ell", "Greek"],
  ["tur", "Turkish"],
  ["rus", "Russian"],
  ["ukr", "Ukrainian"],
  ["heb", "Hebrew"],
  ["ara", "Arabic"],
  ["hin", "Hindi"],
  ["zho", "Chinese"],
  ["jpn", "Japanese"],
  ["kor", "Korean"],
  ["tha", "Thai"],
  ["vie", "Vietnamese"],
  ["ind", "Indonesian"],
  ["msa", "Malay"],
  ["tgl", "Tagalog"],
];

function LanguageSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const known = LANGUAGES.some(([code]) => code === value);
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} aria-label={label}>
        {known ? null : <option value={value}>{value ? `${value} (custom)` : "Not set"}</option>}
        {LANGUAGES.map(([code, name]) => (
          <option key={code} value={code}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

function Range({
  label,
  min,
  max,
  step,
  value,
  suffix = "",
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  const fill = max === min ? 0 : ((value - min) / (max - min)) * 100;
  return (
    <div className="range-wrap">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ "--fill": `${fill}%` } as CSSProperties}
      />
      <output>
        {value}
        {suffix}
      </output>
    </div>
  );
}

const BUFFER_UNITS: [string, string][] = [
  ["sec", "s"],
  ["min", "min"],
  ["mb", "MB"],
  ["gb", "GB"],
];

function BufferField({
  label,
  value,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  unit: string;
  onChange: (value: number, unit: string) => void;
}) {
  // The draft is free text so a value can be cleared and retyped; it only
  // becomes a number on blur or Enter, never mid-keystroke.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const read = () => Math.min(65536, Math.max(1, Math.round(Number(draft)) || 1));
  const commit = () => {
    const next = read();
    setDraft(String(next));
    if (next !== value) onChange(next, unit);
  };

  return (
    <div className="buffer-field">
      <input
        type="number"
        inputMode="numeric"
        min={1}
        max={65536}
        value={draft}
        aria-label={label}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setDraft(String(value));
        }}
      />
      <span className="buffer-sep" aria-hidden="true">
        /
      </span>
      <select
        value={unit}
        aria-label={`${label} unit`}
        onChange={(event) => onChange(read(), event.target.value)}
      >
        {BUFFER_UNITS.map(([id, text]) => (
          <option key={id} value={id}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([id, text]) => (
        <button
          key={id}
          type="button"
          className={value === id ? "is-active" : ""}
          aria-pressed={value === id}
          onClick={() => onChange(id)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export function SettingsView({ section }: { section?: string }) {
  const { settings, appInfo, saveSettings, notify, playRequest } = useApp();
  const [tab, setTab] = useState(section ?? "general");
  const [query, setQuery] = useState("");
  const [tmdbKey, setTmdbKey] = useState(settings?.tmdbApiKey ?? "");
  const [mpvPath, setMpvPath] = useState(settings?.mpvPath ?? "");
  const [p2pReview, setP2pReview] = useState(false);
  const [p2pAck, setP2pAck] = useState(false);

  useEffect(() => {
    if (section) setTab(section);
  }, [section]);

  useEffect(() => {
    setTmdbKey(settings?.tmdbApiKey ?? "");
    setMpvPath(settings?.mpvPath ?? "");
  }, [settings?.tmdbApiKey, settings?.mpvPath]);

  const openLink = (url: string) => {
    void openExternal(url).catch(() => notify("Could not open that link", "error"));
  };

  if (!settings) {
    return (
      <div className="page">
        <Loading variant="list" label="Loading settings" count={6} />
      </div>
    );
  }

  const update = async (patch: Parameters<typeof saveSettings>[0]) => {
    try {
      await saveSettings(patch);
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), "error");
      return false;
    }
  };

  const locateMpv = async () => {
    if (!isTauri()) {
      notify("The file picker is only available in the desktop app");
      return;
    }
    const selected = await open({
      multiple: false,
      filters: [{ name: "mpv executable", extensions: ["exe", ""] }],
    });
    if (typeof selected !== "string") return;
    await saveSettings({ mpvPath: selected });
    const info = await api.mpvDetect(selected);
    notify(
      info ? `mpv detected: ${info.version}` : "That file did not answer --version",
      info ? "success" : "error",
    );
  };

  const playLocalFile = async () => {
    if (!isTauri()) {
      notify("Local file playback needs the desktop app");
      return;
    }
    const selected = await open({
      multiple: false,
      filters: [{ name: "Video", extensions: ["mkv", "mp4", "webm", "avi", "mov", "m4v", "ts"] }],
    });
    if (typeof selected !== "string") return;
    const name = selected.split(/[\\/]/).pop() ?? "Local file";
    await playRequest({ url: selected, title: name });
  };

  const needle = query.trim().toLowerCase();
  const visible = SECTIONS.filter(
    (item) => !needle || `${item.label} ${item.keywords}`.toLowerCase().includes(needle),
  );
  const active = SECTIONS.find((item) => item.id === tab) ?? SECTIONS[0];

  return (
    <div className="page settings-page">
      <header className="settings-head">
        <div>
          <h1>Settings</h1>
          <p>Changes apply as you make them. Everything is stored locally on this machine.</p>
        </div>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <label className="settings-search">
            <Icon name="search" size={15} />
            <input
              value={query}
              onChange={(event) => {
                const value = event.target.value;
                setQuery(value);
                const q = value.trim().toLowerCase();
                if (!q) return;
                // Jump to the first section that matches, so the panel follows the query.
                const hit = SECTIONS.find((item) =>
                  `${item.label} ${item.keywords}`.toLowerCase().includes(q),
                );
                if (hit) setTab(hit.id);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && visible.length > 0) {
                  setTab(visible[0].id);
                  event.currentTarget.blur();
                }
                if (event.key === "Escape") setQuery("");
              }}
              placeholder="Search settings"
              aria-label="Search settings"
              spellCheck={false}
            />
          </label>

          {NAV_GROUPS.map((group) => {
            const items = visible.filter((item) => item.group === group);
            if (items.length === 0) return null;
            return (
              <div className="settings-nav-group" key={group}>
                {needle ? null : <p className="settings-nav-label">{group}</p>}
                {items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={tab === item.id ? "is-active" : ""}
                    aria-current={tab === item.id ? "page" : undefined}
                    onClick={() => setTab(item.id)}
                  >
                    <Icon name={item.icon} size={16} className="settings-nav-icon" />
                    {item.label}
                  </button>
                ))}
              </div>
            );
          })}

          {visible.length === 0 ? (
            <p className="settings-nav-empty">Nothing matches “{query.trim()}”.</p>
          ) : null}
        </nav>

        <div className="settings-body">
          <header className="settings-body-head">
            <h2>{active.label}</h2>
            <p>{active.blurb}</p>
          </header>

          {tab === "general" ? (
            <>
              <Card title="Appearance">
                <div className="settings-block">
                  <div className="settings-block-copy">
                    <h3>Accent colour</h3>
                    <p>Carries through buttons, focus rings and progress bars.</p>
                  </div>
                  <div className="accent-row">
                    {ACCENTS.map((accent) => (
                      <button
                        key={accent.id}
                        type="button"
                        className={`accent-option accent-${accent.id}${
                          settings.accent === accent.id ? " is-active" : ""
                        }`}
                        onClick={() => update({ accent: accent.id })}
                        aria-pressed={settings.accent === accent.id}
                      >
                        <span className="accent-dot">
                          {settings.accent === accent.id ? <Icon name="check" size={14} /> : null}
                        </span>
                        {accent.label}
                      </button>
                    ))}
                  </div>
                </div>

                <Row
                  title="Reduce motion"
                  description="Skip hover scaling and row animation."
                  control={
                    <Toggle
                      checked={settings.reduceMotion}
                      onChange={(value) => update({ reduceMotion: value })}
                      label="Reduce motion"
                    />
                  }
                />
                <Row
                  title="Home rows"
                  description="How many catalog rows appear on Home."
                  control={
                    <Range
                      label="Home rows"
                      min={2}
                      max={16}
                      step={1}
                      value={settings.homeRowsLimit}
                      onChange={(value) => update({ homeRowsLimit: value })}
                    />
                  }
                />
              </Card>

              <Card
                title="Language"
                description="The preferred track when a title offers more than one."
              >
                <div className="field-grid settings-fields">
                  <LanguageSelect
                    label="Audio language"
                    value={settings.audioLanguage}
                    onChange={(value) => update({ audioLanguage: value })}
                  />
                  <LanguageSelect
                    label="Subtitle language"
                    value={settings.subtitleLanguage}
                    onChange={(value) => update({ subtitleLanguage: value })}
                  />
                </div>
              </Card>
            </>
          ) : null}

          {tab === "playback" ? (
            <>
              <Card
                title="Player"
                description="mpv decodes video in its own process and draws straight into this window, so playback stays off the UI thread."
              >
                <div className={`mpv-card${appInfo?.mpv ? " is-ready" : " is-missing"}`}>
                  <div className="mpv-status">
                    <span className="mpv-dot" />
                    <div className="mpv-status-copy">
                      <div className="mpv-status-title">
                        <h3>{appInfo?.mpv ? "mpv is ready" : "mpv not found"}</h3>
                        <Badge tone={appInfo?.mpv ? "good" : "warn"}>
                          {appInfo?.mpv ? "Ready" : "Missing"}
                        </Badge>
                      </div>
                      <p>{appInfo?.mpv?.version ?? "Install mpv to enable playback."}</p>
                      {appInfo?.mpv ? <code>{appInfo.mpv.path}</code> : null}
                    </div>
                  </div>
                  <div className="mpv-actions">
                    <Button icon="monitor" onClick={() => void locateMpv()}>
                      Locate mpv
                    </Button>
                    {!appInfo?.mpv ? (
                      <Button icon="external" onClick={() => openLink("https://mpv.io/installation/")}>
                        Get mpv
                      </Button>
                    ) : null}
                  </div>
                </div>

                <div className="field-row settings-path">
                  <label className="field">
                    <span>Custom path</span>
                    <input
                      value={mpvPath}
                      onChange={(event) => setMpvPath(event.target.value)}
                      placeholder="Auto-detected when empty"
                      aria-label="Custom mpv path"
                      spellCheck={false}
                    />
                  </label>
                  <Button
                    onClick={async () => {
                      if (mpvPath.trim() === settings.mpvPath.trim()) return;
                      if (!(await update({ mpvPath: mpvPath.trim() }))) return;
                      notify("Player path saved", "success");
                    }}
                  >
                    Save
                  </Button>
                </div>
              </Card>

              <Card title="Behaviour">
                <Row
                  title="Hardware decoding"
                  description="Let mpv pick the fastest safe decoder."
                  control={
                    <Toggle
                      checked={settings.hardwareDecoding}
                      onChange={(value) => update({ hardwareDecoding: value })}
                      label="Hardware decoding"
                    />
                  }
                />
                <Row
                  title="Resume playback"
                  description="Continue from where you stopped, per episode."
                  control={
                    <Toggle
                      checked={settings.autoResume}
                      onChange={(value) => update({ autoResume: value })}
                      label="Resume playback"
                    />
                  }
                />
                <Row
                  title="Play next episode"
                  description="Automatically continue a series when an episode ends."
                  control={
                    <Toggle
                      checked={settings.autoPlayNext}
                      onChange={(value) => update({ autoPlayNext: value })}
                      label="Play next episode"
                    />
                  }
                />
                <Row
                  title="Track progress"
                  description="Keep a Continue Watching row and mark finished titles."
                  control={
                    <Toggle
                      checked={settings.trackProgress}
                      onChange={(value) => update({ trackProgress: value })}
                      label="Track progress"
                    />
                  }
                />
                <Row
                  title="Preferred quality"
                  description="Try this quality first. Auto takes the best-ranked source."
                  control={
                    <Segmented
                      label="Preferred quality"
                      value={settings.preferredQuality}
                      options={QUALITY}
                      onChange={(value) => update({ preferredQuality: value })}
                    />
                  }
                />
                <Row
                  title="Skip step"
                  description="Seconds moved by the skip buttons and arrow keys."
                  control={
                    <Range
                      label="Skip step"
                      min={5}
                      max={60}
                      step={5}
                      value={settings.seekStep}
                      suffix="s"
                      onChange={(value) => update({ seekStep: value })}
                    />
                  }
                />
              </Card>

              <Card
                title="Memory buffer"
                description="How much of the stream stays in RAM ahead of and behind the playhead. Nothing is written to disk."
              >
                <Row
                  title="Forward buffer"
                  description="Read ahead so a slow source does not stall playback."
                  control={
                    <BufferField
                      label="Forward buffer"
                      value={settings.bufferForwardValue}
                      unit={settings.bufferForwardUnit}
                      onChange={(value, unit) =>
                        update({ bufferForwardValue: value, bufferForwardUnit: unit })
                      }
                    />
                  }
                />
                <Row
                  title="Backward buffer"
                  description="Keep recent data in memory so stepping back is instant."
                  control={
                    <BufferField
                      label="Backward buffer"
                      value={settings.bufferBackwardValue}
                      unit={settings.bufferBackwardUnit}
                      onChange={(value, unit) =>
                        update({ bufferBackwardValue: value, bufferBackwardUnit: unit })
                      }
                    />
                  }
                />
                <p className="settings-note">
                  <Icon name="info" size={14} />
                  <span>
                    mpv only caps the back buffer in bytes, so a time value there is read as 1 MB
                    per second.
                  </span>
                </p>
              </Card>

              <Card
                title="Peer-to-peer streaming"
                description="Torrent sources stay off until you opt in. Debrid and direct links work either way."
              >
                {settings.p2pConsent ? (
                  <>
                    <Row
                      title="P2P playback is on"
                      description="Torrent sources appear in search and detail pages. A running session keeps going until you stop it below."
                      control={
                        <Toggle
                          label="Allow P2P playback"
                          checked
                          onChange={(next) => update({ p2pConsent: next })}
                        />
                      }
                    />
                    <Callout tone="warn" title="Your IP is visible to the swarm">
                      Streamed pieces are cached on disk and deleted when the session stops. Leftovers
                      above {settings.p2pCacheMb} MB are wiped before the next torrent starts.
                    </Callout>
                  </>
                ) : (
                  <>
                    <Row
                      title="P2P playback is off"
                      description="Torrent sources stay out of search and detail pages."
                      control={
                        <Button onClick={() => setP2pReview((open) => !open)}>
                          {p2pReview ? "Close" : "Review and enable"}
                        </Button>
                      }
                    />
                    {p2pReview ? (
                      <Callout tone="warn" title="Enabling P2P exposes your IP address">
                        <ul>
                          <li>
                            Every peer in the swarm sees the address you connect from, exactly like any
                            torrent client. Your internet provider sees the traffic too.
                          </li>
                          <li>
                            Streamed pieces are cached on disk, capped at {settings.p2pCacheMb} MB, and
                            deleted when the session stops.
                          </li>
                          <li>
                            Switch P2P off at any time to hide torrent sources. A stream already
                            running keeps going until you stop it below.
                          </li>
                        </ul>
                        <label className="settings-check">
                          <input
                            type="checkbox"
                            checked={p2pAck}
                            onChange={(event) => setP2pAck(event.target.checked)}
                          />
                          <span>I understand my IP address will be visible to the torrent swarm.</span>
                        </label>
                        <Button
                          variant="primary"
                          disabled={!p2pAck}
                          onClick={async () => {
                            if (!(await update({ p2pConsent: true }))) return;
                            setP2pAck(false);
                            setP2pReview(false);
                            notify("P2P playback enabled", "success");
                          }}
                        >
                          Enable P2P playback
                        </Button>
                      </Callout>
                    ) : null}
                  </>
                )}

                <Row
                  title="Disk cache"
                  description="Bounds anything the system still holds open if a wipe cannot finish."
                  control={<span className="settings-value">{settings.p2pCacheMb} MB</span>}
                />

                <div className="settings-embed">
                  <TorrentView />
                </div>
              </Card>

              <Card
                title="Try the player"
                description="Play a local video to confirm mpv, hardware decoding and progress tracking work."
              >
                <Button icon="film" onClick={() => void playLocalFile()}>
                  Open a video file
                </Button>
              </Card>
            </>
          ) : null}

          {tab === "integrations" ? (
            <>
              <Card
                title="TMDB"
                description="Adds curated discovery rows, richer artwork, cast and trailers. Your key is stored locally."
              >
                <div className="field-row settings-path">
                  <label className="field">
                    <span>API key</span>
                    <input
                      value={tmdbKey}
                      onChange={(event) => setTmdbKey(event.target.value)}
                      placeholder="TMDB v3 API key"
                      aria-label="TMDB API key"
                      spellCheck={false}
                    />
                  </label>
                  <Button
                    variant="primary"
                    onClick={async () => {
                      if (!(await update({ tmdbApiKey: tmdbKey.trim() }))) return;
                      notify(tmdbKey.trim() ? "TMDB key saved" : "TMDB key removed", "success");
                    }}
                  >
                    Save
                  </Button>
                </div>
                <p className="settings-note">
                  <Icon name="info" size={14} />
                  <span>
                    Get a free key at{" "}
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => openLink("https://www.themoviedb.org/settings/api")}
                    >
                      themoviedb.org
                    </button>
                    . This product uses the TMDB API but is not endorsed or certified by TMDB.
                  </span>
                </p>
              </Card>

              <Card
                title="Trakt"
                description="Watched flags, episode history and resume points move both ways through your own Trakt API app."
              >
                <div className="settings-embed">
                  <TraktView />
                </div>
              </Card>

              <Card
                title="Debrid"
                description="A debrid account turns a cached torrent into a direct HTTPS link, so playback starts without waiting on peers."
              >
                <div className="settings-embed">
                  <DebridView />
                </div>
              </Card>
            </>
          ) : null}

          {tab === "sync" ? (
            <>
              <NuvioSync />
              <StremioSync />
            </>
          ) : null}

          {tab === "servers" ? <MediaServers /> : null}

          {tab === "addons" ? <AddonsPanel /> : null}

          {tab === "update" ? <Updates /> : null}

          {tab === "developer" ? (
            <Card
              title="First run"
              description="Replays the onboarding screens over the app. Nothing is saved, no account is contacted and no player download starts."
            >
              <Button
                variant="primary"
                onClick={() =>
                  window.dispatchEvent(new Event("duvy:preview-onboarding"))
                }
              >
                Preview onboarding
              </Button>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
