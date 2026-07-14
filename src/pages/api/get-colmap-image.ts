import type { APIRoute } from 'astro';
import { getApiUrl } from '../../lib/endpoint-config';
import { createSupabaseServerClientFromRequest } from '../../lib/supabase-server';
import { getSignedFileUrl, redirectToSignedUrl } from '../../lib/signed-url';
import {
    forbiddenResponse,
    isValidCaptureId,
    requireUser,
    unauthorizedResponse,
    userHasCaptureAccess,
} from '../../lib/capture-permissions';

export const GET: APIRoute = async ({ request }) => {
    const apiKey = import.meta.env.SNAPSPACE_API_KEY;
    const baseUrl = getApiUrl();

    if (!apiKey) {
        return new Response(JSON.stringify({ error: 'API key not configured.' }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
        });
    }

    const url = new URL(request.url);
    const captureId = url.searchParams.get('capture_id');
    const name = url.searchParams.get('name');

    if (!captureId || !name) {
        return new Response(JSON.stringify({ error: 'Missing capture_id or name.' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
        });
    }
    if (!isValidCaptureId(captureId) || !/^color_\d+\.png$/.test(name)) {
        return new Response(JSON.stringify({ error: 'Invalid parameter format.' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
        });
    }

    const responseHeaders = new Headers();
    const supabase = createSupabaseServerClientFromRequest(request, responseHeaders);
    const user = await requireUser(supabase);
    if (!user) return unauthorizedResponse();
    if (!(await userHasCaptureAccess(supabase, captureId))) return forbiddenResponse();

    const signedUrl = await getSignedFileUrl(supabase, baseUrl, `${captureId}/images/${name}`);
    if (signedUrl) return redirectToSignedUrl(signedUrl);

    try {
        const imageUrl = `${baseUrl}/captures/${encodeURIComponent(captureId)}/images/${encodeURIComponent(name)}`;
        const upstream = await fetch(imageUrl, {
            headers: { 'X-API-Key': apiKey },
        });

        if (upstream.status === 404) {
            return new Response(JSON.stringify({ error: 'Image not found.' }), {
                status: 404, headers: { 'Content-Type': 'application/json' },
            });
        }
        if (!upstream.ok) {
            return new Response(JSON.stringify({ error: `Upstream error: ${upstream.status}` }), {
                status: upstream.status, headers: { 'Content-Type': 'application/json' },
            });
        }

        const data = await upstream.arrayBuffer();
        return new Response(data, {
            status: 200,
            headers: {
                'Content-Type': 'image/png',
                'Content-Length': String(data.byteLength),
                'Cache-Control': 'public, max-age=86400, immutable',
            },
        });
    } catch (error) {
        return new Response(JSON.stringify({
            error: 'Internal error.',
            details: error instanceof Error ? error.message : String(error),
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
};

