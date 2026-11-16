// Usage-count rules. Run with: bun scripts/analytics.check.ts
// The module reads Vite's env at import time, so the shape of a build is faked
// before it loads. Dynamic import below: a static one would hoist.
const env = (import.meta as unknown as { env: Record<string, unknown> }).env;
env.PROD = true;
env.VITE_POSTHOG_KEY = "pk_test";

const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  },
  __TAURI_INTERNALS__: {},
};
(globalThis as unknown as { fetch: unknown }).fetch = (url: string, init: { body: string }) => {
  sent.push({ url, body: JSON.parse(init.body) });
  return Promise.resolve({ ok: true });
};

const { analyticsAvailableFor, applyAnalytics, track, trackRequests } = await import(
  "../src/lib/analytics.ts"
);

const checks: Array<{ name: string; fn: () => string[] }> = [];
const check = (name: string, fn: () => string[]) => checks.push({ name, fn });

/** Every check starts from an empty outbox and the same enabled release build. */
const fresh = () => {
  sent.length = 0;
  applyAnalytics(true, "0.1.14");
};

check("a key and the Tauri shell both decide availability", () => {
  const bad: string[] = [];
  const cases: Array<[string, boolean, boolean]> = [
    ["pk_live", true, true],
    ["", true, false],
    ["   ", true, false],
    ["pk_live", false, false],
  ];
  for (const [key, shell, want] of cases) {
    const got = analyticsAvailableFor(key, shell);
    if (got !== want) {
      bad.push(`analyticsAvailableFor(${JSON.stringify(key)}, ${shell}) = ${got}, want ${want}`);
    }
  }
  return bad;
});

check("an event carries what PostHog needs, and nothing that identifies the user", () => {
  fresh();
  track("playback_end", { media: "movie", seconds: 600, completed: true });
  const bad: string[] = [];
  const body = sent[0]?.body as Record<string, any> | undefined;
  if (!body) return ["nothing was sent"];
  if (sent[0].url !== "https://us.i.posthog.com/i/v0/e/") bad.push(`wrong url: ${sent[0].url}`);
  for (const field of ["api_key", "event", "distinct_id"]) {
    if (!body[field]) bad.push(`${field} is missing`);
  }
  const props = body.properties ?? {};
  if (props.$process_person_profile !== false) bad.push("the event is not anonymous");
  if (props.app_version !== "0.1.14") bad.push("the version is missing");
  if (props.media !== "movie" || props.seconds !== 600) bad.push("the playback props were lost");
  if (props.environment !== "production") bad.push("the build is not tagged");
  return bad;
});

check("an event cannot un-anonymise itself or rewrite the build", () => {
  fresh();
  track("app_open", { $process_person_profile: true, app_version: "9.9.9" });
  const props = (sent[0]?.body.properties ?? {}) as Record<string, unknown>;
  const bad: string[] = [];
  if (!sent.length) return ["nothing was sent"];
  if (props.$process_person_profile !== false) bad.push("a prop turned the person profile on");
  if (props.app_version !== "0.1.14") bad.push(`a prop overrode the build version: ${props.app_version}`);
  return bad;
});

check("the install id is stable across events", () => {
  fresh();
  store.clear();
  track("app_open");
  track("playback_start");
  const bad: string[] = [];
  const ids = sent.map((item) => item.body.distinct_id);
  if (ids.length !== 2) return [`${ids.length} events sent, want 2`];
  if (!ids[0]) bad.push("the install id is empty");
  if (ids[0] !== ids[1]) bad.push("the id changed between events");
  if (store.get("duvy:install") !== ids[0]) bad.push("the id was not persisted");
  return bad;
});

check("outbound traffic is one event per host, with its own count", () => {
  fresh();
  trackRequests({ "v3-cinemeta.strem.io": 12, "duvy-tmdb.slasshy02.workers.dev": 3 });
  const bad: string[] = [];
  if (sent.length !== 2) return [`${sent.length} events, want one per host`];
  const got = sent
    .map((item) => {
      const props = item.body.properties as Record<string, unknown>;
      return `${String(props.host)}=${String(props.count)}`;
    })
    .sort();
  const want = ["v3-cinemeta.strem.io=12", "duvy-tmdb.slasshy02.workers.dev=3"].sort();
  if (got.join() !== want.join()) bad.push(`host counts [${got}], want [${want}]`);
  if (sent.some((item) => item.body.event !== "net_requests")) {
    bad.push("a host event is not tagged net_requests");
  }
  return bad;
});

check("a host with no requests sends nothing", () => {
  fresh();
  trackRequests({ "example.com": 0 });
  return sent.length ? ["an empty host was sent"] : [];
});

check("the switch stops everything", () => {
  sent.length = 0;
  applyAnalytics(false);
  track("app_open");
  trackRequests({ "v3-cinemeta.strem.io": 4 });
  return sent.length ? [`${sent.length} events escaped the off switch`] : [];
});

check("the switch is reversible", () => {
  applyAnalytics(false);
  sent.length = 0;
  track("app_open");
  const off = sent.length;
  fresh();
  track("app_open");
  return off === 0 && sent.length === 1
    ? []
    : [`off sent ${off} events, back on sent ${sent.length}`];
});

let failed = 0;
for (const { name, fn } of checks) {
  let detail: string[];
  try {
    detail = fn();
  } catch (error) {
    detail = [`threw: ${(error as Error).message}`];
  }
  if (detail.length === 0) {
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}`);
    for (const line of detail) console.log(`      - ${line}`);
  }
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
