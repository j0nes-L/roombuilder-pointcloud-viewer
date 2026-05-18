# Direct Supabase Integration

Permission-related operations on captures (listing, sharing, claiming, registering ownership) talk to Supabase directly from the client — no SnapSpace server endpoint involved. Only operations that touch files on disk go through the SnapSpace server (upload, delete, download-link, merging, point clouds).

---

## 1. Architecture overview

| Operation | Where it runs |
|---|---|
| List my captures | Supabase — `select` from `capture_permissions` |
| Register owner on new capture | Supabase — `insert` into `capture_permissions` |
| Create share link | Supabase — `insert` into `capture_share_tokens` |
| Claim share link | Supabase — `rpc('claim_capture_share')` |
| Upload frames | SnapSpace server `POST /upload` |
| Start merge / mesh | SnapSpace server `POST /merging/*` |
| Delete capture (owner) | SnapSpace server `DELETE /captures/{id}` + removes all `capture_permissions` rows |
| Remove shared capture (collaborator) | Supabase — `delete` own row from `capture_permissions` |
| Get a temporary file download URL | SnapSpace server `GET /share/get-download-link` |
| Cancel a running capture | SnapSpace server `POST /captures/{id}/cancel` (X-API-Key) |

> The Astro proxy endpoints verify the user's Supabase session (via cookie/JWT) and check `capture_permissions` before forwarding any file request to the SnapSpace server with the server-side API key. The browser never sees the API key.

---

## 2. Supabase schema

Run this once in the **Supabase SQL editor**. Re-run after any schema changes.

```sql
-- Tables

CREATE TABLE IF NOT EXISTS public.capture_permissions (
  capture_id  text        NOT NULL,
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        text        NOT NULL CHECK (role IN ('owner', 'collaborator')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (capture_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.capture_share_tokens (
  token       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_id  text        NOT NULL,
  created_by  uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz
);

ALTER TABLE public.capture_permissions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capture_share_tokens ENABLE ROW LEVEL SECURITY;

-- RLS policies

CREATE POLICY "read own permissions"
  ON public.capture_permissions FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "insert own owner row"
  ON public.capture_permissions FOR INSERT
  WITH CHECK (user_id = auth.uid() AND role = 'owner');

CREATE POLICY "delete own permission"
  ON public.capture_permissions FOR DELETE
  USING (user_id = auth.uid());

CREATE POLICY "create share token for own capture"
  ON public.capture_share_tokens FOR INSERT
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.capture_permissions p
      WHERE p.capture_id = capture_share_tokens.capture_id
        AND p.user_id    = auth.uid()
    )
  );

CREATE POLICY "read own share tokens"
  ON public.capture_share_tokens FOR SELECT
  USING (created_by = auth.uid());

-- Claim RPC
-- Returns the capture_id when newly claimed, NULL when already a member.
-- SECURITY DEFINER lets the caller read and act on any token row regardless of who created it.

CREATE OR REPLACE FUNCTION public.claim_capture_share(p_token uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_capture_id uuid;
  v_expires_at timestamptz;
BEGIN
  SELECT capture_id, expires_at
    INTO v_capture_id, v_expires_at
    FROM public.capture_share_tokens
   WHERE token = p_token;

  IF v_capture_id IS NULL THEN
    RAISE EXCEPTION 'Share token not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_expires_at IS NOT NULL AND v_expires_at < now() THEN
    RAISE EXCEPTION 'Share token has expired' USING ERRCODE = 'P0003';
  END IF;

  INSERT INTO public.capture_permissions (capture_id, user_id, role)
  VALUES (v_capture_id, auth.uid(), 'collaborator')
  ON CONFLICT (capture_id, user_id) DO NOTHING;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN v_capture_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_capture_share(uuid) TO authenticated;
```

> **`capture_id` is `text`**, not `uuid`. SnapSpace uses date-based folder names
> like `20260424_144651` as capture identifiers.

---

## 3. Website integration (JS/TS — `@supabase/ssr`)

In the Astro project, `@supabase/ssr` is used so SSR pages and client scripts share the same cookie-based session. The browser singleton lives in `src/lib/supabase-browser.ts`.

```ts
import { createBrowserClient } from '@supabase/ssr';

let client: ReturnType<typeof createBrowserClient> | null = null;

export function getSupabaseBrowserClient() {
  if (client) return client;
  client = createBrowserClient(
    import.meta.env.PUBLIC_SUPABASE_URL,
    import.meta.env.PUBLIC_SUPABASE_ANON_KEY,
  );
  return client;
}
```

### 3.1 List my captures

```ts
const { data, error } = await supabase
  .from('capture_permissions')
  .select('capture_id, role, created_at')
  .order('created_at', { ascending: false });
// data: [{ capture_id: '20260424_144651', role: 'owner' }, ...]
```

### 3.2 Register as owner of a new capture

Call this once after the Unity app confirms the capture session started and you know the `capture_id`:

```ts
const { error } = await supabase
  .from('capture_permissions')
  .insert({ capture_id: captureId, role: 'owner' });
if (error && error.code !== '23505') throw error; // ignore duplicate
```

### 3.3 Create a share link

Share links use the format `/?token=<uuid>` — there is no dedicated `/claim` route.

```ts
const { data: { session } } = await supabase.auth.getSession();
if (!session) throw new Error('not signed in');

const { data, error } = await supabase
  .from('capture_share_tokens')
  .insert({ capture_id: captureId, created_by: session.user.id })
  .select('token')
  .single();
if (error) throw error;

const shareUrl = `${location.origin}/?token=${data.token}`;
```

> `created_by` must be set explicitly in the insert — the RLS policy checks
> `created_by = auth.uid()` and Postgres does not auto-fill it from the JWT.

### 3.4 Claim a share link

When `/?token=<uuid>` is opened, `app.ts` handles it on page load:

- **Logged in** → calls the RPC. If the result is `null` the capture was already in the user's library and nothing happens. Otherwise shows a success toast and refreshes the list.
- **Not logged in** → shows an info toast and redirects to `/account?next=/?token=<uuid>`. After login the user lands on `/?token=<uuid>` and the claim runs automatically.

```ts
const { data: claimedId, error } = await supabase
  .rpc('claim_capture_share', { p_token: token });

if (error) { /* show error toast */ return; }
if (claimedId === null) return; // already owned — do nothing silently
// show success toast, refresh list
```

### 3.5 Delete a capture

Behaviour depends on the user's role for that capture. The Astro proxy at `DELETE /api/auth/delete-capture` checks `capture_permissions.role` server-side:

| Role | What happens |
|---|---|
| `owner` | Deletes the capture from the SnapSpace server, then removes **all** `capture_permissions` rows for that `capture_id` |
| `collaborator` | Removes only the caller's own `capture_permissions` row — files are untouched |

```ts
await fetch(
  `/api/auth/delete-capture?capture_id=${encodeURIComponent(captureId)}`,
  { method: 'DELETE', credentials: 'include' },
);
```

### 3.6 Get a temporary download URL

All download proxy endpoints (`/api/get-pointcloud`, `/api/get-colmap`, `/api/get-mesh`) require the user to be logged in and to have a row in `capture_permissions` for that capture. The Astro proxy injects the `SNAPSPACE_API_KEY` server-side and issues a signed redirect URL. The browser follows the redirect and downloads directly from storage — the API key is never exposed.

---

## 4. Unity integration (C#)

Two options:

- [supabase-csharp](https://github.com/supabase-community/supabase-csharp) — managed client, similar to supabase-js.
- Plain `UnityWebRequest` to the Supabase REST endpoints — zero dependencies, more boilerplate. Shown below.

```csharp
using System;
using System.Collections;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

public static class SnapSpaceConfig {
    public const string SupabaseUrl     = "https://fihmxvcuwozqzaxjmbmj.supabase.co";
    public const string SupabaseAnonKey = "<anon key>";
    public const string SnapSpaceApi    = "https://api.00224466.xyz/snapspace";
}
```

### 4.1 Sign in

```csharp
public static IEnumerator SignIn(string email, string password, Action<bool, string> done) {
    var body = JsonUtility.ToJson(new LoginBody { email = email, password = password });
    using var req = new UnityWebRequest(
        $"{SnapSpaceConfig.SupabaseUrl}/auth/v1/token?grant_type=password", "POST");
    req.uploadHandler   = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
    req.downloadHandler = new DownloadHandlerBuffer();
    req.SetRequestHeader("apikey", SnapSpaceConfig.SupabaseAnonKey);
    req.SetRequestHeader("Content-Type", "application/json");
    yield return req.SendWebRequest();
    if (req.result != UnityWebRequest.Result.Success) {
        done(false, ExtractError(req.downloadHandler.text) ?? req.error);
        yield break;
    }
    SupabaseAuth.SetSession(JsonUtility.FromJson<LoginResp>(req.downloadHandler.text));
    done(true, null);
}

[Serializable] class LoginBody { public string email; public string password; }
[Serializable] class LoginResp {
    public string access_token;
    public string refresh_token;
    public int    expires_in;
    public long   expires_at;
    public UserField user;
}
[Serializable] class UserField { public string id; public string email; }
[Serializable] class ErrField  { public string error_description; public string msg; public string message; }

static string ExtractError(string json) {
    if (string.IsNullOrEmpty(json)) return null;
    try { var e = JsonUtility.FromJson<ErrField>(json); return e?.error_description ?? e?.msg ?? e?.message; }
    catch { return null; }
}
static string Escape(string s) => s.Replace("\\", "\\\\").Replace("\"", "\\\"");
```

### 4.2 Sign up

After the user taps the confirmation link they land on the web app (`/api/auth/callback?flow=signup`) and are **not** automatically logged in. They must sign in inside Unity manually afterwards.

```csharp
public static IEnumerator SignUp(string email, string password, string displayName, Action<bool, string> done) {
    var body = "{"
        + $"\"email\":\"{Escape(email)}\","
        + $"\"password\":\"{Escape(password)}\","
        + $"\"data\":{{\"display_name\":\"{Escape(displayName)}\"}}"
        + "}";
    using var req = new UnityWebRequest($"{SnapSpaceConfig.SupabaseUrl}/auth/v1/signup", "POST");
    req.uploadHandler   = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
    req.downloadHandler = new DownloadHandlerBuffer();
    req.SetRequestHeader("apikey", SnapSpaceConfig.SupabaseAnonKey);
    req.SetRequestHeader("Content-Type", "application/json");
    yield return req.SendWebRequest();
    if (req.result != UnityWebRequest.Result.Success) {
        done(false, ExtractError(req.downloadHandler.text) ?? req.error);
        yield break;
    }
    done(true, null);
}
```

### 4.3 Password reset

Sends a reset link to the user's inbox. The link opens the web app's `/account?mode=update-password` flow.

```csharp
public static IEnumerator RequestPasswordReset(string email, Action<bool, string> done) {
    var body = $"{{\"email\":\"{Escape(email)}\"}}";
    using var req = new UnityWebRequest($"{SnapSpaceConfig.SupabaseUrl}/auth/v1/recover", "POST");
    req.uploadHandler   = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
    req.downloadHandler = new DownloadHandlerBuffer();
    req.SetRequestHeader("apikey", SnapSpaceConfig.SupabaseAnonKey);
    req.SetRequestHeader("Content-Type", "application/json");
    yield return req.SendWebRequest();
    bool ok = req.result == UnityWebRequest.Result.Success;
    done(ok, ok ? null : (ExtractError(req.downloadHandler.text) ?? req.error));
}
```

### 4.4 Refresh the access token

Access tokens expire after 1 hour by default. Call this before expiry or on a 401 response.

```csharp
public static IEnumerator Refresh(Action<bool> done) {
    if (string.IsNullOrEmpty(SupabaseAuth.RefreshToken)) { done(false); yield break; }
    var body = $"{{\"refresh_token\":\"{SupabaseAuth.RefreshToken}\"}}";
    using var req = new UnityWebRequest(
        $"{SnapSpaceConfig.SupabaseUrl}/auth/v1/token?grant_type=refresh_token", "POST");
    req.uploadHandler   = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
    req.downloadHandler = new DownloadHandlerBuffer();
    req.SetRequestHeader("apikey", SnapSpaceConfig.SupabaseAnonKey);
    req.SetRequestHeader("Content-Type", "application/json");
    yield return req.SendWebRequest();
    if (req.result != UnityWebRequest.Result.Success) { SupabaseAuth.Clear(); done(false); yield break; }
    SupabaseAuth.SetSession(JsonUtility.FromJson<LoginResp>(req.downloadHandler.text));
    done(true);
}
```

### 4.5 Logout

```csharp
public static IEnumerator SignOut(Action done = null) {
    if (!string.IsNullOrEmpty(SupabaseAuth.AccessToken)) {
        using var req = new UnityWebRequest($"{SnapSpaceConfig.SupabaseUrl}/auth/v1/logout", "POST");
        req.uploadHandler   = new UploadHandlerRaw(Array.Empty<byte>());
        req.downloadHandler = new DownloadHandlerBuffer();
        req.SetRequestHeader("apikey",        SnapSpaceConfig.SupabaseAnonKey);
        req.SetRequestHeader("Authorization", $"Bearer {SupabaseAuth.AccessToken}");
        yield return req.SendWebRequest();
    }
    SupabaseAuth.Clear();
    done?.Invoke();
}
```

### 4.6 Session storage (`SupabaseAuth`)

`PlayerPrefs` is unencrypted on disk. For production builds, layer a per-device key (e.g. `SystemInfo.deviceUniqueIdentifier` + a build-time pepper via AES) on top of these helpers.

```csharp
public static class SupabaseAuth {
    public static string AccessToken   { get; private set; }
    public static string RefreshToken  { get; private set; }
    public static string UserId        { get; private set; }
    public static long   ExpiresAtUnix { get; private set; }

    const string KAccess  = "ss_access_token";
    const string KRefresh = "ss_refresh_token";
    const string KUser    = "ss_user_id";
    const string KExp     = "ss_expires_at";

    public static void SetSession(LoginResp resp) {
        AccessToken   = resp.access_token;
        RefreshToken  = resp.refresh_token;
        UserId        = resp.user?.id;
        ExpiresAtUnix = resp.expires_at > 0
            ? resp.expires_at
            : DateTimeOffset.UtcNow.ToUnixTimeSeconds() + resp.expires_in;
        Save();
    }

    public static void Save() {
        PlayerPrefs.SetString(KAccess,  AccessToken  ?? "");
        PlayerPrefs.SetString(KRefresh, RefreshToken ?? "");
        PlayerPrefs.SetString(KUser,    UserId       ?? "");
        PlayerPrefs.SetString(KExp,     ExpiresAtUnix.ToString());
        PlayerPrefs.Save();
    }

    public static void Load() {
        AccessToken   = PlayerPrefs.GetString(KAccess,  "");
        RefreshToken  = PlayerPrefs.GetString(KRefresh, "");
        UserId        = PlayerPrefs.GetString(KUser,    "");
        ExpiresAtUnix = long.TryParse(PlayerPrefs.GetString(KExp, "0"), out var v) ? v : 0;
        if (string.IsNullOrEmpty(AccessToken)) Clear();
    }

    public static void Clear() {
        AccessToken = RefreshToken = UserId = null;
        ExpiresAtUnix = 0;
        PlayerPrefs.DeleteKey(KAccess);
        PlayerPrefs.DeleteKey(KRefresh);
        PlayerPrefs.DeleteKey(KUser);
        PlayerPrefs.DeleteKey(KExp);
        PlayerPrefs.Save();
    }

    public static bool IsExpiringSoon(int leewaySeconds = 60) {
        if (ExpiresAtUnix <= 0) return true;
        return DateTimeOffset.UtcNow.ToUnixTimeSeconds() >= ExpiresAtUnix - leewaySeconds;
    }
}
```

Call `SupabaseAuth.Load()` once on app start (e.g. in a `[RuntimeInitializeOnLoadMethod]` bootstrapper). If `IsExpiringSoon()` is true, call `Refresh` before showing the main UI; route to the login screen on failure.

### 4.7 Auto-refresh wrapper

```csharp
public static IEnumerator EnsureFreshToken(Action<bool> done) {
    if (string.IsNullOrEmpty(SupabaseAuth.AccessToken)) { done(false); yield break; }
    if (!SupabaseAuth.IsExpiringSoon()) { done(true); yield break; }
    yield return Refresh(done);
}

public static IEnumerator AuthedGet(string url, Action<UnityWebRequest> done) {
    bool ok = false;
    yield return EnsureFreshToken(v => ok = v);
    if (!ok) { done(null); yield break; }
    using var req = UnityWebRequest.Get(url);
    req.SetRequestHeader("Authorization", $"Bearer {SupabaseAuth.AccessToken}");
    yield return req.SendWebRequest();
    done(req);
}
```

### 4.8 Register as owner of a new capture

Call this after the first frame upload so the web viewer can list the capture.

```csharp
public static IEnumerator RegisterOwner(string captureId, Action<bool> done) {
    var body = $"{{\"capture_id\":\"{captureId}\",\"role\":\"owner\"}}";
    using var req = new UnityWebRequest(
        $"{SnapSpaceConfig.SupabaseUrl}/rest/v1/capture_permissions", "POST");
    req.uploadHandler   = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
    req.downloadHandler = new DownloadHandlerBuffer();
    req.SetRequestHeader("apikey",        SnapSpaceConfig.SupabaseAnonKey);
    req.SetRequestHeader("Authorization", $"Bearer {SupabaseAuth.AccessToken}");
    req.SetRequestHeader("Content-Type",  "application/json");
    req.SetRequestHeader("Prefer",        "resolution=merge-duplicates");
    yield return req.SendWebRequest();
    done(req.result == UnityWebRequest.Result.Success);
}
```

### 4.9 List my captures

```csharp
public static IEnumerator ListMyCaptures(Action<CaptureRow[]> done) {
    using var req = UnityWebRequest.Get(
        $"{SnapSpaceConfig.SupabaseUrl}/rest/v1/capture_permissions"
        + "?select=capture_id,role&order=created_at.desc");
    req.SetRequestHeader("apikey",        SnapSpaceConfig.SupabaseAnonKey);
    req.SetRequestHeader("Authorization", $"Bearer {SupabaseAuth.AccessToken}");
    yield return req.SendWebRequest();
    if (req.result != UnityWebRequest.Result.Success) { done(Array.Empty<CaptureRow>()); yield break; }
    var wrapped = "{\"items\":" + req.downloadHandler.text + "}";
    done(JsonUtility.FromJson<CaptureRowList>(wrapped).items);
}

[Serializable] public class CaptureRow     { public string capture_id; public string role; }
[Serializable] class         CaptureRowList { public CaptureRow[] items; }
```

### 4.10 Create a share link

```csharp
public static IEnumerator CreateShareToken(string captureId, Action<string> done) {
    var body = $"{{\"capture_id\":\"{captureId}\",\"created_by\":\"{SupabaseAuth.UserId}\"}}";
    using var req = new UnityWebRequest(
        $"{SnapSpaceConfig.SupabaseUrl}/rest/v1/capture_share_tokens?select=token", "POST");
    req.uploadHandler   = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
    req.downloadHandler = new DownloadHandlerBuffer();
    req.SetRequestHeader("apikey",        SnapSpaceConfig.SupabaseAnonKey);
    req.SetRequestHeader("Authorization", $"Bearer {SupabaseAuth.AccessToken}");
    req.SetRequestHeader("Content-Type",  "application/json");
    req.SetRequestHeader("Prefer",        "return=representation");
    yield return req.SendWebRequest();
    if (req.result != UnityWebRequest.Result.Success) { done(null); yield break; }
    var wrapped = "{\"items\":" + req.downloadHandler.text + "}";
    done(JsonUtility.FromJson<TokenList>(wrapped).items[0].token);
}

[Serializable] class TokenRow  { public string token; }
[Serializable] class TokenList { public TokenRow[] items; }
```

> `created_by` must be set explicitly — the RLS policy requires `created_by = auth.uid()`.

### 4.11 Claim a share link

Returns `null` if the user already has access (no-op).

```csharp
public static IEnumerator ClaimShareToken(string token, Action<string> done) {
    var body = $"{{\"p_token\":\"{token}\"}}";
    using var req = new UnityWebRequest(
        $"{SnapSpaceConfig.SupabaseUrl}/rest/v1/rpc/claim_capture_share", "POST");
    req.uploadHandler   = new UploadHandlerRaw(Encoding.UTF8.GetBytes(body));
    req.downloadHandler = new DownloadHandlerBuffer();
    req.SetRequestHeader("apikey",        SnapSpaceConfig.SupabaseAnonKey);
    req.SetRequestHeader("Authorization", $"Bearer {SupabaseAuth.AccessToken}");
    req.SetRequestHeader("Content-Type",  "application/json");
    yield return req.SendWebRequest();
    if (req.result != UnityWebRequest.Result.Success) { done(null); yield break; }
    var raw = req.downloadHandler.text.Trim();
    done(raw == "null" ? null : raw.Trim('"'));
}
```

### 4.12 Delete / remove a capture

The Astro proxy checks the caller's role in `capture_permissions` and acts accordingly (same logic as the web viewer):

```csharp
public static IEnumerator DeleteCapture(string captureId, Action<bool> done) {
    bool ok = false;
    yield return EnsureFreshToken(v => ok = v);
    if (!ok) { done(false); yield break; }
    using var req = UnityWebRequest.Delete(
        $"{SnapSpaceConfig.SnapSpaceApi}/captures/{captureId}");
    req.SetRequestHeader("Authorization", $"Bearer {SupabaseAuth.AccessToken}");
    yield return req.SendWebRequest();
    done(req.result == UnityWebRequest.Result.Success);
}
```

### 4.13 Get a temporary download URL

```csharp
public static IEnumerator GetDownloadUrl(string relativePath, Action<string> done) {
    bool ok = false;
    yield return EnsureFreshToken(v => ok = v);
    if (!ok) { done(null); yield break; }
    var url = $"{SnapSpaceConfig.SnapSpaceApi}/share/get-download-link"
            + $"?path={UnityWebRequest.EscapeURL(relativePath)}";
    using var req = UnityWebRequest.Get(url);
    req.SetRequestHeader("Authorization", $"Bearer {SupabaseAuth.AccessToken}");
    yield return req.SendWebRequest();
    if (req.result != UnityWebRequest.Result.Success) { done(null); yield break; }
    done(JsonUtility.FromJson<DownloadResp>(req.downloadHandler.text).url);
}

[Serializable] class DownloadResp { public string url; }
```

---

## 5. Security checklist

- Never put the Supabase `service_role` key into any client. Use only the anon key; user identity is carried by the JWT.
- All permission tables must have RLS enabled (`ALTER TABLE … ENABLE ROW LEVEL SECURITY`).
- The claim flow uses a `SECURITY DEFINER` RPC because a collaborator cannot `SELECT` a share token row they did not create.
- The Astro proxy validates `capture_permissions` for every file operation. The browser never sends the SnapSpace API key.
- `created_by` must always be set explicitly in share token inserts — the RLS policy uses it and Postgres does not auto-fill it from the JWT.
- Treat the user JWT as a secret — store it in `HttpOnly` cookies (web) or `PlayerPrefs` with care (Unity) and clear it on logout.

---

## 6. Removed server endpoints

The following endpoints are now handled by direct Supabase calls:

| Method | Path | Replacement |
|---|---|---|
| `GET` | `/captures` | `SELECT capture_id FROM capture_permissions` |
| `GET` | `/captures/mine` | same |
| `POST` | `/captures/{id}/register` | `INSERT INTO capture_permissions` |
| `POST` | `/captures/{id}/share-link` | `INSERT INTO capture_share_tokens` |
| `POST` | `/captures/claim` | `rpc('claim_capture_share')` |

### Still served by the SnapSpace server

| Method | Path | Auth |
|---|---|---|
| `POST` | `/upload` | X-API-Key (device) |
| `DELETE` | `/captures/{id}` | JWT (user) — verified via Astro proxy |
| `POST` | `/captures/{id}/cancel` | X-API-Key (device) |
| `GET` | `/share/get-download-link` | JWT (user) — verified via Astro proxy |
| `GET` | `/share/{token}` | one-time token |
| `POST` | `/merging/*` | X-API-Key (device) |
| `GET` | `/captures/{id}/pointclouds/*` | X-API-Key (device, internal) |

