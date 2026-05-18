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
    if (!isValidCaptureId(captureId) || !/^[A-Za-z0-9._-]+$/.test(filename)) {
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
        const path = `Capture_${captureId}/pointclouds/${filename}`;
        const fetchUrl = `${baseUrl}/share/get-download-link?path=${encodeURIComponent(path)}`;

        const linkResponse = await fetch(fetchUrl, {
            headers: {'X-API-Key': apiKey},
        });

        if (!linkResponse.ok) {
            const errorText = await linkResponse.text();
            return new Response(errorText, {
                status: linkResponse.status,
                headers: {'Content-Type': 'application/json'},
            });
        }

        const data = await linkResponse.json();
        const downloadUrl = data.url;

        if (!downloadUrl) {
            return new Response(JSON.stringify({error: 'No download URL returned from API.'}), {
                status: 500,
                headers: {'Content-Type': 'application/json'},
            });
        }

        // Direkt den Dateiinhalt streamen statt zu redirecten, damit Content-Length erhalten bleibt
        const fileResponse = await fetch(downloadUrl);
        if (!fileResponse.ok) {
            return new Response(JSON.stringify({error: 'Failed to fetch file from storage.'}), {
                status: fileResponse.status,
                headers: {'Content-Type': 'application/json'},
            });
        }
        const headers = new Headers();
        const contentLength = fileResponse.headers.get('Content-Length');
        if (contentLength) headers.set('Content-Length', contentLength);
        const contentType = fileResponse.headers.get('Content-Type') || 'application/octet-stream';
        headers.set('Content-Type', contentType);
        return new Response(fileResponse.body, {status: 200, headers});

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

