import type { APIRoute } from 'astro';
import { getApiUrl } from '../../lib/endpoint-config';
import { createSupabaseServerClientFromRequest } from '../../lib/supabase-server';
import {
    forbiddenResponse,
    isValidCaptureId,
    requireUser,
    unauthorizedResponse,
    userHasCaptureAccess,
} from '../../lib/capture-permissions';
import { extractFileFromZip } from '../../lib/zip-extract';

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
    if (!isValidCaptureId(captureId) || !/^[A-Za-z0-9._-]+$/.test(name)) {
        return new Response(JSON.stringify({ error: 'Invalid parameter format.' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
        });
    }

    const responseHeaders = new Headers();
    const supabase = createSupabaseServerClientFromRequest(request, responseHeaders);
    const user = await requireUser(supabase);
    if (!user) return unauthorizedResponse();
    if (!(await userHasCaptureAccess(supabase, captureId))) return forbiddenResponse();

    try {
        const zipUrl = `${baseUrl}/captures/${encodeURIComponent(captureId)}/files/colmap.zip`;
        const data = await extractFileFromZip(
            zipUrl,
            { 'X-API-Key': apiKey },
            `images/${name}`,
        );

        if (!data) {
            return new Response(JSON.stringify({ error: 'Image not found in ZIP.' }), {
                status: 404, headers: { 'Content-Type': 'application/json' },
            });
        }

        return new Response(data, {
            status: 200,
            headers: {
                'Content-Type': 'image/png',
                'Content-Length': String(data.byteLength),
                'Cache-Control': 'public, max-age=3600',
            },
        });
    } catch (error) {
        return new Response(JSON.stringify({
            error: 'Internal error.',
            details: error instanceof Error ? error.message : String(error),
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
};

