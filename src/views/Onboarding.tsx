import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  AnimatePresence,
  motion,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
  useSpring,
} from "motion/react";
import { api, isTauri } from "../lib/bridge";
import { useApp } from "../lib/store";
import { TitleBar } from "../components/TitleBar";
import { Button, Icon } from "../components/ui";
import type { PlayerSetup } from "../lib/types";

type Step = "welcome" | "account";
type Provider = "nuvio" | "stremio";

const EASE: [number, number, number, number] = [0.22, 0.68, 0.32, 1];

const MARK =
  "M23.65 14H44.35A36 36 0 0 1 44.35 86H23.65Z M39.5 28L67 50L39.5 72Z";

const PROVIDERS: Array<{ id: Provider; name: string; note: string }> = [
  { id: "nuvio", name: "Nuvio Cloud", note: "Library, progress and watched state" },
  { id: "stremio", name: "Stremio", note: "Addons, library and resume points" },
];

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The boot screen's mark, lit on arrival: the outline traces itself first, then
 * the fill comes up behind it, the way a projector warms into a picture.
 */
function Mark({ size = 72, still }: { size?: number; still: boolean }) {
  return (
    <svg
      className="ob-mark"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <motion.path
        d={MARK}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={2.4}
        strokeLinejoin="round"
        initial={still ? false : { pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: still ? 0 : 0.9, ease: EASE }}
      />
      <motion.path
        d={MARK}
        fill="var(--accent)"
        fillRule="evenodd"
        initial={still ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: still ? 0 : 0.55, delay: still ? 0 : 0.5, ease: "easeOut" }}
      />
    </svg>
  );
}

/** A lamp that follows the pointer, so the room is lit by where you look. */
function Lamp() {
  const still = useReducedMotion() ?? false;
  const x = useMotionValue(50);
  const y = useMotionValue(4);
  const sx = useSpring(x, { stiffness: 70, damping: 24, mass: 0.6 });
  const sy = useSpring(y, { stiffness: 70, damping: 24, mass: 0.6 });
  const background = useMotionTemplate`radial-gradient(40rem 32rem at ${sx}% ${sy}%, rgba(240, 165, 58, 0.13), rgba(240, 165, 58, 0) 70%)`;

  useEffect(() => {
    if (still) return;
    const move = (event: PointerEvent) => {
      x.set((event.clientX / window.innerWidth) * 100);
      y.set((event.clientY / window.innerHeight) * 100);
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, [still, x, y]);

  return (
    <motion.div
      className="ob-lamp"
      aria-hidden="true"
      style={{ backgroundImage: background }}
    />
  );
}

/**
 * First run.
 *
 * Two decisions and nothing else: who to sync with, and whether the player is
 * ready. The player download starts on the welcome screen so it is usually done
 * by the time the account form is filled in.
 */
export function Onboarding({
  preview = false,
  onExit,
}: {
  /** Settings preview: nothing is saved and no download starts. */
  preview?: boolean;
  onExit?: () => void;
} = {}) {
  const { saveSettings, refreshProgress, refreshLibrary, refreshAddons, notify } = useApp();
  const [step, setStep] = useState<Step>("welcome");
  const [provider, setProvider] = useState<Provider | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [player, setPlayer] = useState<PlayerSetup | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const still = useReducedMotion() ?? false;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const run = async () => {
      const status = await api.playerSetup.status().catch(() => null);
      if (disposed || !status) return;
      setPlayer(status);
      if (status.state === "ready") return;

      if (isTauri()) {
        unlisten = await listen<{ state: PlayerSetup["state"]; progress: number; error: string }>(
          "player-setup",
          (event) => {
            setPlayer((current) =>
              current
                ? { ...current, state: event.payload.state, error: event.payload.error }
                : current,
            );
          },
        );
      }
      if (disposed) return;
      if (!preview) await api.playerSetup.start().catch(() => undefined);
    };

    void run();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [preview]);

  // The old step leaves first, so focus waits for the swap to finish.
  useEffect(() => {
    const id = window.setTimeout(
      () => stage.current?.focus({ preventScroll: true }),
      still ? 0 : 380,
    );
    return () => window.clearTimeout(id);
  }, [step, still]);

  const finish = useCallback(async () => {
    if (preview) {
      onExit?.();
      return;
    }
    try {
      await saveSettings({ onboarded: true });
    } catch (e) {
      notify(message(e), "error");
    }
  }, [preview, onExit, saveSettings, notify]);

  const signIn = async () => {
    if (!provider) return;
    // The preview must never reach a real backend.
    if (preview) {
      notify("Preview only. Nothing was sent.", "info");
      onExit?.();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (provider === "nuvio") {
        await api.nuvio.signIn(email.trim(), password, false);
      } else {
        await api.stremio.signIn(email.trim(), password);
      }
      await Promise.all([refreshProgress(), refreshLibrary(), refreshAddons()]);
      notify(`Signed in. Your library and progress are syncing.`, "success");
      await finish();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const downloading = player?.state === "downloading";
  const ready = player?.state === "ready";
  const canFinish = !downloading;

  const rise = (delay: number) =>
    still
      ? {}
      : {
          initial: { opacity: 0, y: 14 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.6, delay, ease: EASE },
        };

  return (
    <div className="app">
      <TitleBar />
      <main className="onboarding">
        <Lamp />
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step}
            ref={stage}
            tabIndex={-1}
            className="ob-stage"
            initial={{ opacity: 0, y: still ? 0 : 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: still ? 0 : -16 }}
            transition={{ duration: still ? 0 : 0.34, ease: EASE }}
          >
            {step === "welcome" ? (
              <>
                <header className="ob-head">
                  <Mark still={still} />
                  <h1 className="ob-word" aria-label="betterNuvio">
                    {[..."betterNuvio"].map((letter, index) => (
                      <motion.span
                        key={`${letter}-${index}`}
                        aria-hidden="true"
                        initial={still ? false : { opacity: 0, y: 26 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{
                          duration: still ? 0 : 0.72,
                          delay: still ? 0 : 0.4 + index * 0.028,
                          ease: EASE,
                        }}
                      >
                        {letter}
                      </motion.span>
                    ))}
                  </h1>
                  <motion.p className="ob-lede" {...rise(0.72)}>
                    Your addons, library and resume points, in one window. Sign in to bring them
                    across, or start clean.
                  </motion.p>
                </header>

                <motion.div className="ob-actions" {...rise(0.82)}>
                  <Button variant="primary" onClick={() => setStep("account")}>
                    Get started
                  </Button>
                </motion.div>
              </>
            ) : (
              <>
                <header className="ob-head">
                  <motion.div className="ob-masthead" {...rise(0)}>
                    <Mark size={24} still />
                    <span>betterNuvio</span>
                  </motion.div>
                  <motion.h1 className="ob-title" {...rise(0.04)}>
                    Bring your history with you
                  </motion.h1>
                  <motion.p className="ob-lede" {...rise(0.08)}>
                    Pick where your library already lives. Nothing is uploaded until you sign in.
                  </motion.p>
                </header>

                <div className="ob-providers" role="group" aria-label="Account provider">
                  {PROVIDERS.map((item, index) => (
                    <motion.button
                      key={item.id}
                      type="button"
                      className="ob-provider"
                      aria-pressed={provider === item.id}
                      disabled={busy}
                      onClick={() => setProvider(provider === item.id ? null : item.id)}
                      initial={still ? false : { opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{
                        duration: still ? 0 : 0.5,
                        delay: still ? 0 : 0.12 + index * 0.07,
                        ease: EASE,
                      }}
                    >
                      <span>
                        <span className="ob-provider-name">{item.name}</span>
                        <span className="ob-provider-note">{item.note}</span>
                      </span>
                      <AnimatePresence initial={false}>
                        {provider === item.id ? (
                          <motion.span
                            key="check"
                            className="ob-check"
                            initial={{ scale: 0.4, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.4, opacity: 0 }}
                            transition={{ type: "spring", stiffness: 520, damping: 30 }}
                          >
                            <Icon name="check" size={16} />
                          </motion.span>
                        ) : null}
                      </AnimatePresence>
                    </motion.button>
                  ))}
                </div>

                <AnimatePresence initial={false}>
                  {provider ? (
                    <motion.div
                      key="form"
                      className="ob-form-wrap"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: still ? 0 : 0.36, ease: EASE }}
                    >
                      <form
                        className="ob-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void signIn();
                        }}
                      >
                        <label className="field">
                          <span>Email</span>
                          <input
                            type="email"
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            autoComplete="username"
                            placeholder="you@example.com"
                            required
                          />
                        </label>
                        <label className="field">
                          <span>Password</span>
                          <input
                            type="password"
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            autoComplete="current-password"
                            placeholder="Your password"
                            required
                          />
                        </label>
                        {error ? (
                          <motion.p
                            className="ob-error"
                            role="alert"
                            initial={still ? false : { opacity: 0, x: -6 }}
                            animate={{ opacity: 1, x: 0 }}
                          >
                            {error}
                          </motion.p>
                        ) : null}
                        <div className="ob-actions">
                          <Button
                            type="submit"
                            variant="primary"
                            disabled={busy || !canFinish}
                          >
                            {busy
                              ? "Signing in..."
                              : downloading
                                ? "Preparing the player..."
                                : "Sign in"}
                          </Button>
                          <button
                            type="button"
                            className="ob-skip"
                            onClick={() => void finish()}
                            disabled={busy || !canFinish}
                          >
                            Skip for now
                          </button>
                        </div>
                      </form>
                    </motion.div>
                  ) : (
                    <motion.div key="actions" className="ob-actions" {...rise(0.24)}>
                      <Button variant="primary" onClick={() => void finish()} disabled={!canFinish}>
                        {downloading ? "Preparing the player..." : "Continue without an account"}
                      </Button>
                    </motion.div>
                  )}
                </AnimatePresence>

                {ready ? null : (
                  <motion.p className="ob-foot" {...rise(0.3)}>
                    You can change this later in Settings. Playback also works with an mpv you
                    install yourself.
                  </motion.p>
                )}
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </main>

    </div>
  );
}
