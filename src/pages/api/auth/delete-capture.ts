import type {APIRoute} from 'astro';
import {getApiUrl} from '../../../lib/endpoint-config';
import {createSupabaseServerClientFromRequest} from '../../../lib/supabase-server';

export const DELETE: APIRoute = async ({request}) => {
    const responseHeaders = new Headers({'Content-Type': 'application/json'});
    const supabase = createSupabaseServerClientFromRequest(request, responseHeaders);

    const {data: {user}} = await supabase.auth.getUser();
    if (!user) {
        responseHeaders.set('Content-Type', 'application/json');
        return new Response(JSON.stringify({error: 'Unauthorized. Please log in.'}), {
            status: 401,
            headers: responseHeaders,
        });
    }

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

    if (!captureId) {
        return new Response(JSON.stringify({error: 'Missing capture_id parameter.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }

    if (!/^[A-Za-z0-9_-]+$/.test(captureId)) {
        return new Response(JSON.stringify({error: 'Invalid capture_id format.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }

    try {
        const response = await fetch(`${baseUrl}/captures/${encodeURIComponent(captureId)}`, {
            method: 'DELETE',
            headers: {
                'X-API-Key': apiKey,
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            return new Response(JSON.stringify({
                error: 'Failed to delete capture on SnapSpace API.',
                status: response.status,
                details: errorText,
            }), {
                status: response.status,
                headers: {'Content-Type': 'application/json'},
            });
        }

        const data = await response.json();
        responseHeaders.set('Content-Type', 'application/json');
        return new Response(JSON.stringify(data), {
            status: 200,
            headers: responseHeaders,
        });

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

