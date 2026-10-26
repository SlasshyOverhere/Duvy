import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Badge, Button, Icon } from "../components/ui";

type TorrentStats = {
  active: boolean;
  name: string;
  progress: number;
  downloadBps: number;
  uploadBps: number;
  peers: number;
  seeds: number;
};

const IDLE: TorrentStats = {
  active: false,
  name: "",
  progress: 0,
  downloadBps: 0,
  uploadBps: 0,
  peers: 0,
  seeds: 0,
};

function rate(bytesPerSecond: number) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "0 B/s";
  const units = ["B/s", "KiB/s", "MiB/s", "GiB/s"];
  let value = bytesPerSecond;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11.5, color: "var(--faint)", marginBottom: 4 }}>{label}</div>
      <div
        style={{
          fontSize: 17,
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "-0.01em",
        }}
      >
        {value}
      </div>
    </div>
  );
}

export default function TorrentView() {
  const [stats, setStats] = useState<TorrentStats>(IDLE);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    let alive = true;
    const read = () => {
      invoke<TorrentStats>("stats")
        .then((next) => {
          if (!alive) return;
          setStats(next);
          setError(null);
        })
        .catch((reason: unknown) => {
          if (alive) setError(String(reason));
        });
    };
    read();
    const timer = window.setInterval(read, 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const stop = async () => {
    setStopping(true);
    try {
      await invoke("stop");
      setStats(await invoke<TorrentStats>("stats"));
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setStopping(false);
    }
  };

  const percent = Math.max(0, Math.min(1, stats.progress)) * 100;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="kicker">Streaming</p>
          <h1>Torrent engine</h1>
          <p className="page-sub">
            The selected video is served to the player from a loopback HTTP proxy. Peers are only
            contacted while a torrent is active.
          </p>
        </div>
        <Badge tone={stats.active ? "good" : "neutral"}>
          {stats.active ? "streaming" : "idle"}
        </Badge>
      </header>

      <section className="settings-group">
        <div className="settings-row">
          <div style={{ minWidth: 0 }}>
            <h3 style={{ overflowWrap: "anywhere" }}>
              {stats.active && stats.name ? stats.name : "No active torrent"}
            </h3>
            <p>
              {stats.active
                ? "Downloading ahead of the playhead. Stop releases the port and clears the cache."
                : "Start a magnet or info-hash source from the stream picker to fill this panel."}
            </p>
          </div>
          <Button
            variant="danger"
            icon="stop"
            onClick={() => void stop()}
            disabled={!stats.active || stopping}
          >
            {stopping ? "Stopping…" : "Stop"}
          </Button>
        </div>

        <div style={{ padding: "18px 0", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
            <span style={{ color: "var(--faint)" }}>Progress</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{percent.toFixed(1)}%</span>
          </div>
          <div
            role="progressbar"
            aria-label="Torrent progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent)}
            style={{
              height: 4,
              borderRadius: 2,
              background: "var(--line)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${percent}%`,
                background: "var(--accent)",
                transition: "width 0.4s var(--ease)",
              }}
            />
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
            gap: "16px 28px",
            padding: "4px 0 18px",
          }}
        >
          <Metric label="Down" value={rate(stats.downloadBps)} />
          <Metric label="Up" value={rate(stats.uploadBps)} />
          <Metric label="Peers" value={String(stats.peers)} />
          <Metric label="Seeds" value={String(stats.seeds)} />
        </div>

        {error ? <p className="form-error">{error}</p> : null}

        <p className="settings-note">
          <Icon name="info" size={14} />
          <span>
            Peer-to-peer streaming needs consent in Settings. The cache lives under the app data
            folder and is wiped when the torrent stops.
          </span>
        </p>
      </section>
    </div>
  );
}
