// TMDB proxy: keeps the read token server-side and caches every response.
// Deploy: paste this into a Cloudflare Worker, set TMDB_TOKEN as a secret,
// then copy the worker URL into PROXY in src-tauri/src/tmdb.rs.

const ALLOWED = /^\/(movie|tv|search|find|trending)\//;
const MAX_AGE = 21600;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "GET" || !ALLOWED.test(url.pathname)) {
      return new Response("not found", { status: 404 });
    }
    url.searchParams.delete("api_key");

    const target = `https://api.themoviedb.org/3${url.pathname}${url.search}`;
    const cacheKey = new Request(target);
    const hit = await caches.default.match(cacheKey);
    if (hit) return hit;

    const upstream = await fetch(target, {
      headers: {
        Authorization: `Bearer ${env.TMDB_TOKEN}`,
        Accept: "application/json",
      },
    });
    const response = new Response(await upstream.text(), {
      status: upstream.status,
      headers: {
        "content-type": "application/json",
        "cache-control": upstream.ok ? `public, max-age=${MAX_AGE}` : "no-store",
      },
    });
    if (upstream.ok) ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    return response;
  },
};
