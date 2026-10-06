// Serves side projects under paths of jbernier.com.
//
// Each project is its own Cloudflare Pages site, built to live under a path prefix (for this
// project: vite.config.js). This Worker is routed on jbernier.com for those prefixes only (see
// wrangler.toml) and forwards each request, path unchanged, to the project's Pages host. The
// visitor only ever sees jbernier.com/<project>/.
//
// To add a project: build it with the same prefix, add a line here, and add a route for it in
// wrangler.toml.
const PROJECTS = {
  '/systems-design-viz': 'systems-design-viz.pages.dev',
  '/night-in-japan': 'night-in-japan.pages.dev',
  '/raccoon-city': 'raccoon-city.pages.dev',
  '/music-viz': 'music-viz.pages.dev',
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const prefix = Object.keys(PROJECTS).find((p) => url.pathname === p || url.pathname.startsWith(p + '/'));
    if (!prefix) return fetch(request); // not one of ours: let the main site answer
    if (url.pathname === prefix) return Response.redirect(url.origin + prefix + '/' + url.search, 301);

    const host = PROJECTS[prefix];
    const upstream = new URL(url);
    upstream.hostname = host;
    const res = await fetch(new Request(upstream, request), { redirect: 'manual' });

    // a redirect issued by the Pages site must keep the visitor on this domain
    const location = res.headers.get('location');
    if (!location) return res;
    const to = new URL(location, upstream);
    if (to.hostname === host) to.hostname = url.hostname;
    const headers = new Headers(res.headers);
    headers.set('location', to.toString());
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};
