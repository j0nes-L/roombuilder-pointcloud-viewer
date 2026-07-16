import type {APIRoute} from 'astro';
import {getApiUrl} from '../../lib/endpoint-config';
import {createSupabaseServerClientFromRequest} from '../../lib/supabase-server';
import {
    forbiddenResponse,
    isValidCaptureId,
    requireUser,
    unauthorizedResponse,
    userHasCaptureAccess,
} from '../../lib/capture-permissions';

export const GET: APIRoute = async ({request}) => {
    const apiKey = import.meta.env.SNAPSPACE_API_KEY;
    const baseUrl = getApiUrl();

    if (!apiKey) {
        return new Response(JSON.stringify({error: 'API key is not configured.'}), {
            status: 500,
            headers: {'Content-Type': 'application/json'},
        });
    }

    const url = new URL(request.url);
    const captureId = url.searchParams.get('capture_id');
    const filename = url.searchParams.get('filename');

    if (!captureId || !filename) {
        return new Response(JSON.stringify({error: 'Missing capture_id or filename parameter.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }
    if (!isValidCaptureId(captureId) || !/^[A-Za-z0-9._/-]+$/.test(filename)) {
        return new Response(JSON.stringify({error: 'Invalid parameter format.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }

    const responseHeaders = new Headers();
    const supabase = createSupabaseServerClientFromRequest(request, responseHeaders);
    const user = await requireUser(supabase);
    if (!user) return unauthorizedResponse();
    if (!(await userHasCaptureAccess(supabase, captureId))) return forbiddenResponse();

    try {
        const upstream = await fetch(
            `${baseUrl}/captures/${encodeURIComponent(captureId)}/files/${filename}`,
            {headers: {'X-API-Key': apiKey}},
        );

        if (!upstream.ok) {
            const text = await upstream.text();
            return new Response(text, {
                status: upstream.status,
                headers: {'Content-Type': 'application/json'},
            });
        }

        const headers = new Headers();
        const contentLength = upstream.headers.get('Content-Length');
        if (contentLength) headers.set('Content-Length', contentLength);
        headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream');
        return new Response(upstream.body, {status: 200, headers});

    } catch (error) {
        return new Response(JSON.stringify({
            error: 'An internal error occurred.',
            details: error instanceof Error ? error.message : String(error),
        }), {
            status: 500,
            headers: {'Content-Type': 'application/json'},
        });
    }
};

