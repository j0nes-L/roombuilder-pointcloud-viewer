import type {SupabaseClient} from '@supabase/supabase-js';

export async function getSignedFileUrl(
    supabase: SupabaseClient,
    baseUrl: string,
    storagePath: string,
): Promise<string | null> {
    const {data: {session}} = await supabase.auth.getSession();
    const accessToken = session?.access_token;
    if (!accessToken) return null;

    try {
        const upstream = await fetch(
            `${baseUrl}/share/get-download-link?path=${encodeURIComponent(storagePath)}`,
            {headers: {Authorization: `Bearer ${accessToken}`}},
        );
        if (!upstream.ok) return null;
        const data = await upstream.json() as {url?: string};
        return data.url ?? null;
    } catch {
        return null;
    }
}

export function redirectToSignedUrl(url: string): Response {
    return new Response(null, {
        status: 302,
        headers: {Location: url, 'Cache-Control': 'no-store'},
    });
}
