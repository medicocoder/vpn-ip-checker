/**
 * Cloudflare Worker — VPN IP Checker Backend
 *
 * Routes:
 *   GET /ping?targets=google.com,cloudflare.com   -> HTTP latency to each target
 *   GET /healthz                                  -> liveness probe
 *
 * CORS is open so the static GitHub Pages front-end can call this from any origin.
 * All pings originate from Cloudflare edge PoP, NOT from the user's browser or device.
 * ICMP is not possible in Workers; we measure HTTP round-trip time as a proxy for
 * reachability. Status codes 0/timeout mean the host is unreachable from CF edge.
 */

const DEFAULT_TARGETS = [
  'google.com',
  'cloudflare.com',
  '1.1.1.1',
  '8.8.8.8',
  'one.one.one.one',
];

const TIMEOUT_MS = 5000;
const MAX_TARGETS = 10;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
      'Cache-Control': 'no-store',
    },
  });
}

async function pingTarget(host) {
  // Normalise: strip any scheme the user might have pasted
  const cleanHost = host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
  if (!cleanHost) return { host, error: 'invalid host', ms: null, status: null, reachable: false };

  const url = 'https://' + cleanHost + '/';
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const resp = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
      // Cloudflare Workers do not support cache: 'no-store' in fetch options the same way,
      // but we add a cache-busting query string to be safe.
      cf: { cacheTtl: 0 },
    });
    clearTimeout(timer);
    const ms = Date.now() - t0;
    return {
      host: cleanHost,
      ms,
      status: resp.status,
      reachable: resp.status < 600,
      error: null,
    };
  } catch (err) {
    const ms = Date.now() - t0;
    const isTimeout = err.name === 'AbortError' || ms >= TIMEOUT_MS;
    return {
      host: cleanHost,
      ms: isTimeout ? TIMEOUT_MS : ms,
      status: null,
      reachable: false,
      error: isTimeout ? 'timeout' : String(err.message || err),
    };
  }
}

export default {
  async fetch(request, env, ctx) {
    const { method, url } = request;
    const { pathname, searchParams } = new URL(url);

    // Preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (method !== 'GET') {
      return json({ error: 'Method Not Allowed' }, 405);
    }

    if (pathname === '/healthz') {
      return json({ ok: true, ts: new Date().toISOString() });
    }

    if (pathname === '/ping') {
      const rawTargets = searchParams.get('targets');
      let targets = rawTargets
        ? rawTargets.split(',').map(t => t.trim()).filter(Boolean).slice(0, MAX_TARGETS)
        : DEFAULT_TARGETS;

      const started = Date.now();
      const results = await Promise.all(targets.map(pingTarget));

      return json({
        ok: true,
        ts: new Date().toISOString(),
        took_ms: Date.now() - started,
        source: 'cloudflare-worker',
        note: 'Latency is from Cloudflare edge to target. This is HTTP HEAD, not ICMP.',
        results,
      });
    }

    return json({ error: 'Not Found', routes: ['/ping', '/healthz'] }, 404);
  },
};
