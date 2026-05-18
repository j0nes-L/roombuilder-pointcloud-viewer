# API Integration Guide (Astro + Vercel)

This document describes — using `snapspace-viewer` as a worked example — how to
wire a third‑party HTTP API into an Astro site, keep secrets server‑side, and
ship it to Vercel. Use it as a blueprint for future projects.

---

## 1. Architecture in one picture

```
Browser (TS in /src/scripts)
   │  fetch('/api/...')          ← same origin, no secrets
   ▼
Astro Server Routes (/src/pages/api/*.ts)   ← run as Vercel Serverless Functions
   │  fetch(EXTERNAL_API, { 'X-API-Key': process.env.SNAPSPACE_API_KEY })
   ▼
External API (https://api.example.com/...)
```

**Key rule:** the browser never talks to the upstream API directly and never
sees the API key. Every external call is proxied through an Astro endpoint
that injects credentials from environment variables.

Reasons:

- Secrets stay on the server (Vercel env vars, not bundled into the client).
- We can cache, validate, rate‑limit, redact, or transform responses.
- The client uses simple same‑origin `/api/*` URLs — no CORS pain.

---

## 2. Project layout

```
snapspace-viewer/
├─ astro.config.mjs              # SSR mode + Vercel adapter
├─ endpoints.yaml                # Non-secret config (upstream base URL)
├─ package.json
├─ tsconfig.json
├─ .env                          # LOCAL ONLY — never commit
├─ public/                       # Static assets served as-is
│  ├─ favicon.svg
│  └─ fonts/
└─ src/
   ├─ lib/
   │  ├─ endpoint-config.ts      # Loads endpoints.yaml (server-side)
   │  └─ snapspace-client.ts     # Browser-side typed client → /api/*
   ├─ pages/
   │  ├─ index.astro             # UI
   │  └─ api/                    # Server endpoints (one file = one route)
   │     ├─ auth/login.ts        # POST /api/auth/login
   │     ├─ delete-capture.ts    # DELETE /api/delete-capture
   │     ├─ get-captures-overview.ts
   │     ├─ get-colmap.ts
   │     ├─ get-mesh.ts
   │     ├─ get-mesh-info.ts
   │     ├─ get-pointcloud.ts
   │     └─ get-pointclouds-info.ts
   ├─ scripts/                   # Client-side TS bundled by Astro/Vite
   │  ├─ app.ts
   │  └─ viewer.ts
   └─ styles/global.css
```

### What goes where

| Folder              | Runs on      | May read `.env`? | Purpose                                          |
| ------------------- | ------------ | ---------------- | ------------------------------------------------ |
| `src/pages/*.astro` | Server (SSR) | yes              | HTML pages                                       |
| `src/pages/api/*`   | Server       | **yes**          | JSON / proxy endpoints (Vercel functions)        |
| `src/lib/*`         | Either       | only server-side | Shared utilities; secret access only server-side |
| `src/scripts/*`     | Browser      | **no**           | UI logic, calls `/api/*`                         |
| `public/*`          | Browser      | no               | Static files served verbatim                     |

---

## 3. Astro + Vercel configuration

### `astro.config.mjs`

```js
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

export default defineConfig({
  site: 'https://snapspace.jonasludorf.dev',
  base: '/',
  output: 'server',          // SSR — required for /api routes with secrets
  adapter: vercel({
    imageService: false,
  }),
  server: { host: 'localhost', port: 4321 },
});
```

Important flags:

- `output: 'server'` — without this, `.ts` files under `src/pages/api/` are
  pre‑rendered at build time and your environment variables would be baked in
  (or missing entirely). SSR makes them real Serverless Functions on Vercel.
- `adapter: vercel()` — emits the `.vercel/output` directory Vercel expects.

### `package.json` (essentials)

```json
{
  "type": "module",
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview"
  },
  "dependencies": {
    "@astrojs/vercel": "^10",
    "astro": "^6",
    "js-yaml": "^4"
  }
}
```

Vercel auto‑detects Astro: build command `astro build`, output `.vercel/output`.
No `vercel.json` needed for the basic case.

---

## 4. Configuration: secrets vs. non‑secrets

### Non‑secret config → `endpoints.yaml`

```yaml
api:
  base_url: https://api.00224466.xyz
  prefix: /snapspace
```

Committed to git. Loaded once per process by `src/lib/endpoint-config.ts`:

```ts
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';

let config: EndpointsConfig | null = null;

function loadConfig(): EndpointsConfig {
  if (config) return config;
  const p = path.resolve(process.cwd(), 'endpoints.yaml');
  config = yaml.load(fs.readFileSync(p, 'utf8')) as EndpointsConfig;
  return config;
}

export function getApiUrl(): string {
  const { api } = loadConfig();
  return `${api.base_url}${api.prefix}`;
}
```

> ⚠️ This module uses `fs`/`path` — it must only be imported from server code
> (`src/pages/api/*` or `.astro` frontmatter). Importing it from
> `src/scripts/*` would break the client bundle.

### Secrets → `.env` (local) and Vercel env vars (prod)

`.env` for local development:

```dotenv
# login credentials
SNAPSPACE_ADMIN_PASSWORD=leckeier
SNAPSPACE_PASSWORD=1234

# upstream api key
SNAPSPACE_API_KEY="aPeXlMZmNpy3svsHUSTFS8VFo_8XilxL76-EAlyVhoeficdmVYA3WMiU9R9xf7u3"
```

Rules:

- Add `.env` to `.gitignore`. **Never** commit.
- Read with `import.meta.env.SNAPSPACE_API_KEY` inside any `src/pages/api/*.ts`.
- Names **must not** start with `PUBLIC_` if you want them to stay server‑only.
  `PUBLIC_*` variables are inlined into the client bundle.

#### Setting them on Vercel

1. Vercel Dashboard → Project → **Settings → Environment Variables**.
2. Add each key (`SNAPSPACE_API_KEY`, `SNAPSPACE_ADMIN_PASSWORD`,
   `SNAPSPACE_PASSWORD`) for the environments you need: *Production*,
   *Preview*, *Development*.
3. Trigger a redeploy — env changes are not applied to existing deployments.

CLI alternative:

```bash
vercel env add SNAPSPACE_API_KEY production
vercel env pull .env.local        # mirror Vercel env to local file
```

---

## 5. Server endpoints — the proxy pattern

Every file in `src/pages/api/` becomes a route. Export `GET`, `POST`, `DELETE`,
etc. as `APIRoute`. The four recurring jobs are:

1. Read the env var → return 500 if missing.
2. Validate query / body → return 400 on bad input.
3. Forward the request to the upstream API with `X-API-Key`.
4. Map the upstream response back to the client.

### 5.1 Simple JSON proxy

`src/pages/api/get-pointclouds-info.ts`:

```ts
import type { APIRoute } from 'astro';
import { getApiUrl } from '../../lib/endpoint-config';

export const GET: APIRoute = async ({ request }) => {
  const apiKey = import.meta.env.SNAPSPACE_API_KEY;
  if (!apiKey) return j({ error: 'API key not configured.' }, 500);

  const captureId = new URL(request.url).searchParams.get('capture_id');
  if (!captureId) return j({ error: 'Missing capture_id.' }, 400);

  const r = await fetch(`${getApiUrl()}/captures/${captureId}/pointclouds`, {
    headers: { 'X-API-Key': apiKey },
  });
  if (!r.ok) return j({ error: 'Upstream failed', status: r.status }, r.status);
  return new Response(await r.text(), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

const j = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
```

### 5.2 Auth endpoint (password → role)

`src/pages/api/auth/login.ts` compares the posted password against
`SNAPSPACE_ADMIN_PASSWORD` / `SNAPSPACE_PASSWORD` and returns
`{ authenticated, role }`. The client never sees either password.

```ts
export const POST: APIRoute = async ({ request }) => {
  const admin  = import.meta.env.SNAPSPACE_ADMIN_PASSWORD;
  const viewer = import.meta.env.SNAPSPACE_PASSWORD;
  const { password } = await request.json();

  if (password === admin)  return ok({ authenticated: true, role: 'admin'  });
  if (password === viewer) return ok({ authenticated: true, role: 'viewer' });
  return ok({ authenticated: false, role: null }, 401);
};
```

### 5.3 Binary download via signed‑URL redirect

For large files (point clouds, meshes, COLMAP zips) we don't want to stream
hundreds of MB through the Vercel function (Vercel has a 4.5 MB response
limit on Hobby and execution‑time caps). Pattern: ask upstream for a
short‑lived download URL, then `302` the browser to it.

```ts
// src/pages/api/get-mesh.ts (excerpt)
const path = `Capture_${captureId}/pointclouds/mesh.glb`;
const linkRes = await fetch(
  `${baseUrl}/share/get-download-link?path=${encodeURIComponent(path)}`,
  { headers: { 'X-API-Key': apiKey } },
);
const { url } = await linkRes.json();
return Response.redirect(url, 302);
```

The browser follows the redirect and downloads directly from the storage
backend. The API key is never exposed because the signed URL is one‑shot.

### 5.4 HEAD probe + size detection

`get-mesh-info.ts` shows how to discover whether a remote file exists and how
large it is, working around APIs that don't support `HEAD`:

1. Try `HEAD`.
2. If the server returns `405`/`501`, fall back to `GET` with `Range: bytes=0-0`.
3. Parse `Content-Range: bytes 0-0/<total>` to get the size, cancel the body.

### 5.5 Fan‑out + in‑memory cache

`get-captures-overview.ts` calls `/captures`, then for each capture fetches
its pointclouds + mesh info in parallel (concurrency 16) and merges everything
into one payload. Add a tiny TTL cache to absorb client bursts:

```ts
const CACHE_TTL_MS = 5_000;
let cache: { ts: number; payload: any } | null = null;

if (!noCache && cache && Date.now() - cache.ts < CACHE_TTL_MS) {
  return new Response(JSON.stringify(cache.payload), {
    headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
  });
}
// ...build payload...
cache = { ts: Date.now(), payload };
```

> Note: module‑level state lives only for the life of a single Lambda
> instance on Vercel. Treat it as best‑effort, not durable cache.

### 5.6 Mutations

`delete-capture.ts` shows a `DELETE` route with input validation
(`/^[A-Za-z0-9_-]+$/`) before forwarding to upstream:

```ts
export const DELETE: APIRoute = async ({ request }) => {
  const id = new URL(request.url).searchParams.get('capture_id');
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return j({ error: 'bad id' }, 400);
  const r = await fetch(`${baseUrl}/captures/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'X-API-Key': apiKey },
  });
  return new Response(await r.text(), { status: r.status });
};
```

---

## 6. Client‑side typed wrapper

`src/lib/snapspace-client.ts` is imported by browser scripts. It only talks to
`/api/*` and is the single place that defines DTO types.

```ts
function getApiBase() { return '/api'; }

let apiKey = '';                 // optional extra header for the proxy
export function setApiKey(k: string) { apiKey = k; }
function authHeaders(): Record<string, string> {
  return apiKey ? { 'X-API-Key': apiKey } : {};
}

export async function login(password: string) {
  const res = await fetch(`${getApiBase()}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ password }),
  });
  if (res.status === 401) return { ok: false, role: null };
  const data = await res.json();
  return { ok: true, role: data.role };
}

export async function fetchCapturesOverview(forceRefresh = false) {
  const qs = forceRefresh ? '?refresh=1' : '';
  const res = await fetch(`${getApiBase()}/get-captures-overview${qs}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`overview failed: ${res.status}`);
  return (await res.json()).captures;
}
```

Bonus utilities that pay off in real apps:

- **Progress reporting** on big downloads — read the response with
  `res.body.getReader()` and compute `received / Content-Length`.
  See `fetchMeshGlb` / `fetchPointCloudData` / `fetchColmapZip`.
- **In‑memory caches** on the client (e.g. `meshInfoCache`,
  `pointCloudsRespCache`) to avoid re‑hitting `/api/*` for already‑known data.
- **In‑flight de‑duplication** with a `Map<string, Promise<...>>` so two
  components asking for the same resource share one network call.

---

## 7. Local development workflow

```powershell
npm install
# create .env with the secrets (see section 4)
npm run dev          # http://localhost:4321
```

`astro dev` serves the SSR routes with the same semantics Vercel will use, so
`/api/*` calls work locally with your `.env`.

To validate the production build locally:

```powershell
npm run build
npm run preview
```

---

## 8. Deploying to Vercel

1. Push the repository to GitHub.
2. On Vercel: **Add New → Project → Import** the repo.
3. Framework preset: *Astro* (auto‑detected). Leave build settings default.
4. Under **Environment Variables**, add all keys from `.env` for
   *Production* (and *Preview* if you want PR previews to work).
5. Deploy. Each route in `src/pages/api/*` becomes a Serverless Function.
6. Verify in the Vercel **Functions** tab; logs show `console.log` output.

Redeploy after any env‑var change.

### Optional: `vercel.json`

Usually not needed. Add only for advanced features, e.g.:

```json
{
  "functions": {
    "src/pages/api/get-captures-overview.ts": { "maxDuration": 30 }
  }
}
```

---

## 9. Security & operational checklist

- [ ] `.env` is in `.gitignore`.
- [ ] No env var starts with `PUBLIC_` unless the client legitimately needs it.
- [ ] Every `/api/*` handler returns **500** when its env var is missing,
      **400** on bad input, and forwards upstream status otherwise.
- [ ] All path params used in upstream URLs are `encodeURIComponent`’d.
- [ ] User‑supplied IDs are regex‑validated before being interpolated.
- [ ] Large binaries are delivered via **redirect to a signed URL**, not
      streamed through the function.
- [ ] No upstream error body is forwarded verbatim if it might leak secrets;
      log server‑side, return a sanitized message.
- [ ] CORS: not needed because everything is same‑origin. If you ever expose
      `/api/*` to other origins, add explicit `Access-Control-*` headers.

---

## 10. Reusable recipe for a new project

1. `npm create astro@latest` → choose *empty / minimal*, TypeScript strict.
2. `npm i @astrojs/vercel js-yaml` and `npm i -D @types/js-yaml`.
3. Set `output: 'server'` and `adapter: vercel()` in `astro.config.mjs`.
4. Create `endpoints.yaml` for non‑secret upstream config; load it via a
   `src/lib/endpoint-config.ts` helper (server‑only).
5. Put all upstream calls behind `src/pages/api/<name>.ts` handlers that read
   secrets via `import.meta.env.*`.
6. Add a `src/lib/<service>-client.ts` typed wrapper for the browser that
   only calls `/api/*`.
7. Configure env vars locally in `.env`, on Vercel in *Settings → Environment
   Variables*. Add `.env` to `.gitignore`.
8. Push → Vercel imports → deploy.

That's the whole pattern. Every new external API integration in future
projects is just: *add a YAML entry, add one `src/pages/api/*.ts` proxy, add
one function to the client wrapper.*

