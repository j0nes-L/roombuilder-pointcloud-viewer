import type {APIRoute} from 'astro';
import {getApiUrl} from '../../lib/endpoint-config';
import {createSupabaseServerClientFromRequest} from '../../lib/supabase-server';
import {getSignedFileUrl, redirectToSignedUrl} from '../../lib/signed-url';
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

    const captureId = new URL(request.url).searchParams.get('capture_id');
    if (!captureId) {
        return new Response(JSON.stringify({error: 'Missing capture_id parameter.'}), {
            status: 400, headers: {'Content-Type': 'application/json'},
        });
    }
    if (!isValidCaptureId(captureId)) {
        return new Response(JSON.stringify({error: 'Invalid capture_id format.'}), {
            status: 400, headers: {'Content-Type': 'application/json'},
        });
    }

    const responseHeaders = new Headers();
    const supabase = createSupabaseServerClientFromRequest(request, responseHeaders);
    const user = await requireUser(supabase);
    if (!user) return unauthorizedResponse();
    if (!(await userHasCaptureAccess(supabase, captureId))) return forbiddenResponse();

    const signedUrl = await getSignedFileUrl(supabase, baseUrl, `${captureId}/files/mesh.glb`);
    if (signedUrl) return redirectToSignedUrl(signedUrl);

    try {
        const upstream = await fetch(
            `${baseUrl}/captures/${encodeURIComponent(captureId)}/files/mesh.glb`,
            {headers: {'X-API-Key': apiKey}},
        );

        if (!upstream.ok) {
            const text = await upstream.text();
            return new Response(text, {status: upstream.status, headers: {'Content-Type': 'application/json'}});
        }

        const headers = new Headers();
        const cl = upstream.headers.get('Content-Length');
        if (cl) headers.set('Content-Length', cl);
        headers.set('Content-Type', 'model/gltf-binary');
        return new Response(upstream.body, {status: 200, headers});

    } catch (error) {
        return new Response(JSON.stringify({
            error: 'An internal error occurred.',
            details: error instanceof Error ? error.message : String(error),
        }), {status: 500, headers: {'Content-Type': 'application/json'}});
    }
};
