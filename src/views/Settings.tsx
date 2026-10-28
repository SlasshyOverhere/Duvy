import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, isTauri, openExternal } from "../lib/bridge";
import { useApp } from "../lib/store";
import { Button, Icon, Spinner, Toggle, type IconName } from "../components/ui";
import { NuvioSync } from "./settings/NuvioSync";
import { AddonsPanel } from "./Addons";
import TraktView from "./Trakt";
import DebridView from "./Debrid";
import TorrentView from "./Torrent";
import { MediaServers } from "./settings/MediaServers";
import { Updates } from "./settings/Updates";

const SECTIONS: { id: string; label: string; icon: IconName }[] = [
  { id: "general", label: "General", icon: "sliders" },
  { id: "playback", label: "Playback", icon: "play" },
  { id: "addons", label: "Addons", icon: "puzzle" },
  { id: "servers", label: "Servers", icon: "tv" },
  { id: "integrations", label: "Integrations", icon: "key" },
  { id: "sync", label: "Sync", icon: "refresh" },
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
  const [p2pReview, setP2pReview] = useState(false);
  const [p2pAck, setP2pAck] = useState(false);

  const loadLog = async () => {
    if (!isTauri()) return;
    try {
      setLog(await api.playbackLog(80));
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), "error");
    }
  };

  useEffect(() => {
    if (tab === "about") void loadLog();
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

  const openLink = (url: string) => {
    void openExternal(url).catch(() => notify("Could not open that link", "error"));
  };

  if (!settings) {
    return (
      <div className="page page-loading">
        <Spinner label="Loading settings" />
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
                      <Button icon="external" onClick={() => openLink("https://mpv.io/installation/")}>
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
                    onClick={async () => {
                      if (mpvPath.trim() === settings.mpvPath.trim()) return;
                      if (!(await update({ mpvPath: mpvPath.trim() }))) return;
                      notify("Player path saved", "success");
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
                    <h3>Preferred quality</h3>
                    <p>Try this quality first. Auto takes the best-ranked source available.</p>
                  </div>
                  <div className="field-row" style={{ margin: 0 }} role="group" aria-label="Preferred quality">
                    {[
                      ["auto", "Auto"],
                      ["4k", "4K"],
                      ["1080p", "1080p"],
                      ["720p", "720p"],
                    ].map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={`chip${settings.preferredQuality === value ? " is-active" : ""}`}
                        aria-pressed={settings.preferredQuality === value}
                        onClick={() => update({ preferredQuality: value })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
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
                <h2>Peer-to-peer streaming</h2>
                <p className="settings-hint">
                  Torrent sources are off until you opt in. Nothing joins a swarm before that, and
                  Debrid and direct links keep working either way.
                </p>
                {settings.p2pConsent ? (
                  <>
                    <div className="settings-row">
                      <div>
                        <h3>P2P playback is on</h3>
                        <p>Turn this off to hide torrent sources. A running session keeps going until you stop it below.</p>
                      </div>
                      <Toggle
                        label="Allow P2P playback"
                        checked
                        onChange={(next) => update({ p2pConsent: next })}
                      />
                    </div>
                    <p className="settings-note">
                      <Icon name="info" size={14} />
                      <span>
                        Swarm peers can see your IP while a torrent streams. Streamed pieces are
                        cached on this machine and deleted when the torrent session stops; leftovers
                        above {settings.p2pCacheMb} MB are wiped before the next torrent starts.
                      </span>
                    </p>
                  </>
                ) : (
                  <>
                    <div className="settings-row">
                      <div>
                        <h3>P2P playback is off</h3>
                        <p>Torrent sources stay out of search and detail pages.</p>
                      </div>
                      <Button onClick={() => setP2pReview((open) => !open)}>
                        {p2pReview ? "Close" : "Review and enable"}
                      </Button>
                    </div>
                    {p2pReview ? (
                      <>
                        <p className="settings-hint">
                          <strong>Your IP address becomes visible.</strong> A torrent stream
                          connects you to other peers, so everyone in that swarm can see the address
                          you connect from, exactly like any torrent client. Your internet provider
                          can see the traffic as well.
                        </p>
                        <p className="settings-hint">
                          <strong>Pieces are cached on disk.</strong> The parts being streamed are
                          written to a local torrent cache, capped at {settings.p2pCacheMb} MB. That
                          cache is deleted when the torrent session stops. If a file is still locked
                          and the wipe cannot finish, the next start tries again before streaming.
                        </p>
                        <p className="settings-hint">
                          <strong>It is easy to undo.</strong> Switch P2P playback off on this tab
                          and torrent sources disappear. A stream already running keeps going until
                          you stop its session below.
                        </p>
                        <label
                          className="settings-hint"
                          style={{
                            display: "flex",
                            alignItems: "flex-start",
                            gap: 9,
                            color: "var(--muted)",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={p2pAck}
                            onChange={(event) => setP2pAck(event.target.checked)}
                            style={{ marginTop: 3 }}
                          />
                          <span>
                            I understand my IP address will be visible to the torrent swarm.
                          </span>
                        </label>
                        <div className="about-actions">
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
                        </div>
                      </>
                    ) : null}
                  </>
                )}
                <div className="settings-row">
                  <div>
                    <h3>Disk cache</h3>
                    <p className="settings-hint">
                      The torrent cache is wiped when a session stops and before the next start.
                      This cap bounds anything the system still has open if a wipe cannot finish.
                    </p>
                  </div>
                  <span className="settings-value">{settings.p2pCacheMb} MB</span>
                </div>
                <div className="settings-embed">
                  <TorrentView />
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
              </section>

              <section className="settings-group">
                <h2>Trakt</h2>
                <div className="settings-embed">
                  <TraktView />
                </div>
              </section>

              <section className="settings-group">
                <h2>Debrid</h2>
                <div className="settings-embed">
                  <DebridView />
                </div>
              </section>
            </>
          ) : null}

          {tab === "sync" ? <NuvioSync /> : null}
          {tab === "servers" ? <MediaServers /> : null}

          {tab === "addons" ? (
            <>
              <section className="settings-group">
                <h2>Addons</h2>
                <p className="settings-hint">
                  BetterNuvio speaks the open Stremio addon protocol. Nothing is bundled and nothing
                  is scraped; every catalog, metadata record and stream comes from a URL you add.
                </p>
              </section>
              <AddonsPanel />
            </>
          ) : null}

          {tab === "about" ? (
            <>
              <section className="settings-group">
                <h2>BetterNuvio</h2>
                <p className="settings-hint">
                  An unofficial, performance-first reimplementation inspired by Nuvio Desktop. Not affiliated
                  with or endorsed by Nuvio Media.
                </p>
                <dl className="about-list">
                  <div>
                    <dt>Version</dt>
                    <dd>{appInfo?.version ?? "unknown"}</dd>
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
                    <dt>mpv</dt>
                    <dd>
                      {appInfo?.mpv ? (
                        <code>{appInfo.mpv.path}</code>
                      ) : (
                        "Not found. Set a path in Playback."
                      )}
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
                    onClick={() => openLink("https://github.com/NuvioMedia/NuvioDesktop")}
                  >
                    Upstream project
                  </Button>
                  <Button
                    icon="external"
                    onClick={() => openLink("https://www.stremio.com/")}
                  >
                    Addon protocol
                  </Button>
                </div>
              </section>

              <Updates />

              <section className="settings-group">
                <h2>Diagnostics</h2>
                <p className="settings-hint">
                  Every step between pressing play and the first frame, with the time since the
                  request and the gap since the step above. The same lines are written to{" "}
                  <code>playback.log</code> next to the database.
                </p>
                <details>
                  <summary
                    style={{ cursor: "pointer", fontSize: 13, color: "var(--muted)", padding: "4px 0" }}
                  >
                    Recent playback log
                  </summary>
                  {log.length ? (
                    <pre className="log-view">{log.join("\n")}</pre>
                  ) : (
                    <p className="settings-hint" style={{ marginTop: 12 }}>
                      {isTauri()
                        ? "Nothing logged yet. Play something, then refresh."
                        : "The playback log is only available in the desktop app."}
                    </p>
                  )}
                </details>
                <div className="about-actions">
                  <Button
                    icon="refresh"
                    disabled={!isTauri()}
                    onClick={() => void loadLog()}
                  >
                    Refresh log
                  </Button>
                </div>
              </section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
