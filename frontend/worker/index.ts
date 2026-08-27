interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

// The SPA fallback is what makes deep links like /acme/employees/<id> work:
// any unmatched path returns index.html for the client router to handle.
// That is wrong for hashed build assets. After a redeploy, a browser still
// running the previous index.html asks for a chunk whose hash no longer
// exists; the fallback hands it index.html, and the browser reports
// "Expected a JavaScript-or-Wasm module script but the server responded with
// a MIME type of text/html" instead of a plain 404 the app can react to.
//
// So: /assets/* is served strictly. Everything else keeps the SPA fallback.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/assets/")) {
      const res = await env.ASSETS.fetch(request);
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("text/html")) {
        return new Response("Asset not found", {
          status: 404,
          headers: { "content-type": "text/plain", "cache-control": "no-store" },
        });
      }
      return res;
    }

    return env.ASSETS.fetch(request);
  },
};
