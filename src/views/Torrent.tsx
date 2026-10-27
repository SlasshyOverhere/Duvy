import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/bridge";
import { Badge, Button, Icon, Spinner } from "../components/ui";
import type { TorrentStats } from "../lib/types";

const IDLE: TorrentStats = {
  active: false,
  name: "",
  progress: 0,
  downloadBps: 0,
  uploadBps: 0,
  peers: 0,
  seeds: 0,
};

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  const read = useCallback(async () => {
    try {
      setStats(await api.torrent.stats());
      setError(null);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let timer: number | undefined;

    const stopPolling = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };

    const startPolling = () => {
      if (timer !== undefined) return;
      void read();
      timer = window.setInterval(() => void read(), 1000);
    };

    const onVisibility = () => {
      if (document.hidden) stopPolling();
      else startPolling();
    };

    if (document.hidden) stopPolling();
    else startPolling();

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [read]);

  const stop = async () => {
    if (!window.confirm("Stop the torrent session? Downloaded files in the cache will be deleted.")) {
      return;
    }
    setStopping(true);
    try {
      await api.torrent.stop();
      setStats(IDLE);
      setError(null);
      await read();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setStopping(false);
    }
  };

  const percent = Math.max(0, Math.min(1, stats.progress)) * 100;

  return (
    <div className="page">
      {loading ? <Spinner label="Reading torrent session…" /> : null}

      {!loading && stats.active ? (
        <div>
          <div className="settings-row" style={{ alignItems: "flex-start" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <h3 style={{ overflowWrap: "anywhere" }}>{stats.name || "Torrent session"}</h3>
                <Badge tone="good">streaming</Badge>
              </div>
              <p>
                {stats.peers === 1 ? "1 peer connected" : `${stats.peers} peers connected`} while the
                player reads ahead of the playhead.
              </p>
            </div>
            <Button
              variant="danger"
              icon="stop"
              onClick={() => void stop()}
              disabled={stopping}
            >
              {stopping ? "Stopping…" : "Stop session"}
            </Button>
          </div>

          <div style={{ padding: "16px 0 4px" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 16,
                fontSize: 12,
                color: "var(--faint)",
                marginBottom: 8,
              }}
            >
              <span>Progress</span>
              <span style={{ color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>
                {percent.toFixed(1)}%
              </span>
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
              padding: "14px 0 6px",
            }}
          >
            <Metric label="Download" value={rate(stats.downloadBps)} />
            <Metric label="Upload" value={rate(stats.uploadBps)} />
            <Metric label="Peers" value={String(stats.peers)} />
          </div>

          <p className="settings-hint">
            The engine reports total peers only. It does not expose how many of them hold the
            complete torrent, so there is no seeder count here.
          </p>
        </div>
      ) : null}

      {!loading && !stats.active ? (
        <div className="settings-row">
          <div>
            <h3>Engine idle</h3>
            <p>
              No torrent session is running. The engine starts only while a torrent source is
              playing, and it is off the rest of the time.
            </p>
          </div>
          <Badge tone="neutral">off</Badge>
        </div>
      ) : null}

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <p className="settings-note">
        <Icon name="info" size={14} />
        <span>
          Stopping deletes the session cache from the app data folder. Peer-to-peer traffic only
          happens while a torrent source is playing.
        </span>
      </p>
    </div>
  );
}
