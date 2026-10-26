import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, isTauri, openExternal } from "../lib/bridge";
import { useApp } from "../lib/store";
import { Badge, Button, Icon, Toggle, type IconName } from "../components/ui";

const SECTIONS: { id: string; label: string; icon: IconName }[] = [
  { id: "general", label: "General", icon: "sliders" },
  { id: "playback", label: "Playback", icon: "play" },
  { id: "integrations", label: "Integrations", icon: "key" },
  { id: "about", label: "About", icon: "info" },
];

const ACCENTS = [
  { id: "ember", label: "Ember", color: "#f4b350" },
  { id: "violet", label: "Violet", color: "#a78bfa" },
  { id: "mint", label: "Mint", color: "#4ade80" },
  { id: "rose", label: "Rose", color: "#fb7185" },
];

export function SettingsView({ section }: { section?: string }) {
  const { settings, appInfo, saveSettings, notify, playRequest } = useApp();
  const [tab, setTab] = useState(section ?? "general");
  const [tmdbKey, setTmdbKey] = useState(settings?.tmdbApiKey ?? "");
  const [mpvPath, setMpvPath] = useState(settings?.mpvPath ?? "");
  const [log, setLog] = useState<string[]>([]);

  const loadLog = async () => {
    if (!isTauri()) return;
    try {
      setLog(await api.playbackLog(80));
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), "error");
    }
  };

  useEffect(() => {
    if (tab === "playback") void loadLog();
    // Reloads when the tab is opened; the button below refreshes on demand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    if (section) setTab(section);
  }, [section]);

  useEffect(() => {
    setTmdbKey(settings?.tmdbApiKey ?? "");
    setMpvPath(settings?.mpvPath ?? "");
  }, [settings?.tmdbApiKey, settings?.mpvPath]);

  if (!settings) return null;

  const update = (patch: Parameters<typeof saveSettings>[0]) => {
    void saveSettings(patch).catch((e: unknown) =>
      notify(e instanceof Error ? e.message : String(e), "error"),
    );
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

  return (
    <div className="page settings-page">
      <header className="page-head">
        <div>
          <p className="kicker">Settings</p>
          <h1>Make it yours</h1>
          <p className="page-sub">Everything is stored locally in a single SQLite file.</p>
        </div>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={tab === item.id ? "is-active" : ""}
              onClick={() => setTab(item.id)}
            >
              <Icon name={item.icon} size={17} />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="settings-body">
          {tab === "general" ? (
            <>
              <section className="settings-group">
                <h2>Appearance</h2>
                <p className="settings-hint">Accent colour is applied across the app instantly.</p>
                <div className="accent-row">
                  {ACCENTS.map((accent) => (
                    <button
                      key={accent.id}
                      type="button"
                      className={`accent-swatch${settings.accent === accent.id ? " is-active" : ""}`}
                      onClick={() => update({ accent: accent.id })}
                      aria-label={accent.label}
                      aria-pressed={settings.accent === accent.id}
                    >
                      <span style={{ background: accent.color }} />
                      {accent.label}
                    </button>
                  ))}
                </div>
              </section>

              <section className="settings-group">
                <div className="settings-row">
                  <div>
                    <h3>Reduce motion</h3>
                    <p>Skip hover scaling and row animation.</p>
                  </div>
                  <Toggle
                    checked={settings.reduceMotion}
                    onChange={(value) => update({ reduceMotion: value })}
                    label="Reduce motion"
                  />
                </div>
                <div className="settings-row">
                  <div>
                    <h3>Home rows</h3>
                    <p>How many catalog rows appear on Home.</p>
                  </div>
                  <div className="range-wrap">
                    <input
                      type="range"
                      min={2}
                      max={16}
                      step={1}
                      value={settings.homeRowsLimit}
                      onChange={(event) => update({ homeRowsLimit: Number(event.target.value) })}
                      aria-label="Home rows"
                    />
                    <span>{settings.homeRowsLimit}</span>
                  </div>
                </div>
              </section>

              <section className="settings-group">
                <h2>Regional</h2>
                <div className="field-grid">
                  <label className="field">
                    <span>Audio language</span>
                    <input
                      value={settings.audioLanguage}
                      onChange={(event) => update({ audioLanguage: event.target.value })}
                      placeholder="eng"
                    />
                  </label>
                  <label className="field">
                    <span>Subtitle language</span>
                    <input
                      value={settings.subtitleLanguage}
                      onChange={(event) => update({ subtitleLanguage: event.target.value })}
                      placeholder="eng"
                    />
                  </label>
                </div>
              </section>
            </>
          ) : null}

          {tab === "playback" ? (
            <>
              <section className="settings-group">
                <h2>Player</h2>
                <p className="settings-hint">
                  Video is decoded by mpv in its own process and drawn straight into this window, hardware
                  accelerated and separate from the UI thread. The player chrome renders on top of it.
                </p>
                <div className={`mpv-card${appInfo?.mpv ? " is-ready" : " is-missing"}`}>
                  <div className="mpv-status">
                    <span className="mpv-dot" />
                    <div>
                      <h3>{appInfo?.mpv ? "mpv is ready" : "mpv not found"}</h3>
                      <p>{appInfo?.mpv?.version ?? "Install mpv to enable playback."}</p>
                      {appInfo?.mpv ? <code>{appInfo.mpv.path}</code> : null}
                    </div>
                  </div>
                  <div className="mpv-actions">
                    <Button icon="monitor" onClick={() => void locateMpv()}>
                      Locate mpv
                    </Button>
                    {!appInfo?.mpv ? (
                      <Button icon="external" onClick={() => void openExternal("https://mpv.io/installation/")}>
                        Get mpv
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="field-row">
                  <input
                    value={mpvPath}
                    onChange={(event) => setMpvPath(event.target.value)}
                    placeholder="Custom mpv path (optional)"
                    aria-label="Custom mpv path"
                  />
                  <Button
                    onClick={() => {
                      if (mpvPath.trim() === settings.mpvPath.trim()) return;
                      update({ mpvPath: mpvPath.trim() });
                      notify("Player path saved");
                    }}
                  >
                    Save
                  </Button>
                </div>
              </section>

              <section className="settings-group">
                <div className="settings-row">
                  <div>
                    <h3>Hardware decoding</h3>
                    <p>Let mpv pick the fastest safe decoder (recommended).</p>
                  </div>
                  <Toggle
                    checked={settings.hardwareDecoding}
                    onChange={(value) => update({ hardwareDecoding: value })}
                    label="Hardware decoding"
                  />
                </div>
                <div className="settings-row">
                  <div>
                    <h3>Resume playback</h3>
                    <p>Continue from where you stopped, per episode.</p>
                  </div>
                  <Toggle
                    checked={settings.autoResume}
                    onChange={(value) => update({ autoResume: value })}
                    label="Resume playback"
                  />
                </div>
                <div className="settings-row">
                  <div>
                    <h3>Play next episode</h3>
                    <p>Automatically continue a series when an episode ends.</p>
                  </div>
                  <Toggle
                    checked={settings.autoPlayNext}
                    onChange={(value) => update({ autoPlayNext: value })}
                    label="Play next episode"
                  />
                </div>
                <div className="settings-row">
                  <div>
                    <h3>Track progress</h3>
                    <p>Keep a Continue Watching row and mark finished titles.</p>
                  </div>
                  <Toggle
                    checked={settings.trackProgress}
                    onChange={(value) => update({ trackProgress: value })}
                    label="Track progress"
                  />
                </div>
                <div className="settings-row">
                  <div>
                    <h3>Skip step</h3>
                    <p>Seconds moved by the skip buttons and arrow keys.</p>
                  </div>
                  <div className="range-wrap">
                    <input
                      type="range"
                      min={5}
                      max={60}
                      step={5}
                      value={settings.seekStep}
                      onChange={(event) => update({ seekStep: Number(event.target.value) })}
                      aria-label="Skip step"
                    />
                    <span>{settings.seekStep}s</span>
                  </div>
                </div>
              </section>

              <section className="settings-group">
                <h2>Try the player</h2>
                <p className="settings-hint">
                  Play a local video to confirm mpv, hardware decoding and progress tracking work.
                </p>
                <Button icon="film" onClick={() => void playLocalFile()}>
                  Open a video file
                </Button>
              </section>

              <section className="settings-group">
                <h2>Playback log</h2>
                <p className="settings-hint">
                  Every step between pressing play and the first frame, with the time since the
                  request and the gap since the step above. Written to{" "}
                  <code>playback.log</code> next to the database as well.
                </p>
                {log.length ? (
                  <pre className="log-view">{log.join("\n")}</pre>
                ) : (
                  <p className="settings-hint">
                    Nothing logged yet. Play something, then refresh.
                  </p>
                )}
                <div className="about-actions">
                  <Button icon="refresh" onClick={() => void loadLog()}>
                    Refresh
                  </Button>
                </div>
              </section>
            </>
          ) : null}

          {tab === "integrations" ? (
            <>
              <section className="settings-group">
                <h2>TMDB</h2>
                <p className="settings-hint">
                  Adds curated discovery rows, richer artwork, cast and trailers. Your key is stored locally.
                </p>
                <div className="field-row">
                  <input
                    value={tmdbKey}
                    onChange={(event) => setTmdbKey(event.target.value)}
                    placeholder="TMDB v3 API key"
                    aria-label="TMDB API key"
                    spellCheck={false}
                  />
                  <Button
                    variant="primary"
                    onClick={() => {
                      update({ tmdbApiKey: tmdbKey.trim() });
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
                      onClick={() => void openExternal("https://www.themoviedb.org/settings/api")}
                    >
                      themoviedb.org
                    </button>
                    . This product uses the TMDB API but is not endorsed or certified by TMDB.
                  </span>
                </p>
              </section>

              <section className="settings-group">
                <h2>Coming next</h2>
                <div className="roadmap">
                  {[
                    ["Trakt + Simkl sync", "Scrobble playback and mirror your library."],
                    ["Debrid", "Resolve cached torrents to direct links."],
                    ["Jellyfin / Emby", "Play from your own media server."],
                    ["P2P streaming", "Built-in torrent engine with buffer control."],
                  ].map(([title, body]) => (
                    <div key={title} className="roadmap-item">
                      <Badge>planned</Badge>
                      <div>
                        <h3>{title}</h3>
                        <p>{body}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </>
          ) : null}

          {tab === "about" ? (
            <section className="settings-group">
              <h2>BetterNuvio</h2>
              <p className="settings-hint">
                An unofficial, performance-first reimplementation inspired by Nuvio Desktop. Not affiliated
                with or endorsed by Nuvio Media.
              </p>
              <dl className="about-list">
                <div>
                  <dt>Version</dt>
                  <dd>{appInfo?.version ?? "0.1.0"}</dd>
                </div>
                <div>
                  <dt>Platform</dt>
                  <dd>{appInfo?.platform ?? "unknown"}</dd>
                </div>
                <div>
                  <dt>Data directory</dt>
                  <dd>
                    <code>{appInfo?.dataDir ?? "—"}</code>
                  </dd>
                </div>
                <div>
                  <dt>License</dt>
                  <dd>MIT (original code)</dd>
                </div>
              </dl>
              <div className="about-actions">
                <Button
                  icon="external"
                  onClick={() => void openExternal("https://github.com/NuvioMedia/NuvioDesktop")}
                >
                  Upstream project
                </Button>
                <Button
                  icon="external"
                  onClick={() => void openExternal("https://www.stremio.com/")}
                >
                  Addon protocol
                </Button>
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
