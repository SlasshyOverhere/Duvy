/**
 * One window, one fullscreen change at a time.
 *
 * A close that lands while an exit is still in flight used to send a second
 * `window_fullscreen(false)`, which the window rejected because it was already
 * windowed. The request is dropped here instead, so each user action maps to
 * at most one IPC call and the last known state is the one the window has.
 */

export type ApplyFullscreen = (on: boolean) => Promise<unknown>;

export interface FullscreenController {
  /** Resolves true when the window is in the requested state. */
  request: (on: boolean) => Promise<boolean>;
  /** Adopt a state the browser changed on its own. */
  sync: (on: boolean) => void;
  readonly current: boolean;
}

export function createFullscreenController(
  apply: ApplyFullscreen,
  onChange: (on: boolean) => void,
  onError?: (error: unknown, on: boolean) => void,
): FullscreenController {
  let current = false;
  let queue: Promise<boolean> = Promise.resolve(true);

  return {
    request(on) {
      const run = queue.then(async () => {
        if (current === on) return true;
        try {
          await apply(on);
          current = on;
          onChange(on);
          return true;
        } catch (error) {
          onError?.(error, on);
          return false;
        }
      });
      // Failures already resolved false; the chain only keeps the order.
      queue = run.then(
        () => true,
        () => false,
      );
      return run;
    },
    sync(on) {
      current = on;
    },
    get current() {
      return current;
    },
  };
}
