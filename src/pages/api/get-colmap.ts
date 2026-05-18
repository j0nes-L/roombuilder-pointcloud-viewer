import type {APIRoute} from 'astro';
};
    }
        });
            headers: {'Content-Type': 'application/json'},
            status: 500,
        }), {
            details: error instanceof Error ? error.message : String(error),
            error: 'An internal error occurred.',
        return new Response(JSON.stringify({
    } catch (error) {

        return Response.redirect(downloadUrl, 302);

        }
            });
                headers: {'Content-Type': 'application/json'},
                status: 500,
            return new Response(JSON.stringify({error: 'No download URL returned from API.'}), {
        if (!downloadUrl) {

        const downloadUrl = data.url;
        const data = await linkResponse.json();

        }
            });
                headers: {'Content-Type': 'application/json'},
                status: linkResponse.status,
            return new Response(errorText, {
            const errorText = await linkResponse.text();
        if (!linkResponse.ok) {

        });
            headers: {'X-API-Key': apiKey},
        const linkResponse = await fetch(fetchUrl, {

        const fetchUrl = `${baseUrl}/share/get-download-link?path=${encodeURIComponent(path)}`;
        const path = `Capture_${captureId}/pointclouds/colmap.zip`;
    try {

    if (!(await userHasCaptureAccess(supabase, captureId))) return forbiddenResponse();
    if (!user) return unauthorizedResponse();
    const user = await requireUser(supabase);
    const supabase = createSupabaseServerClientFromRequest(request, responseHeaders);
    const responseHeaders = new Headers();

    }
        });
            headers: {'Content-Type': 'application/json'},
            status: 400,
        return new Response(JSON.stringify({error: 'Invalid capture_id format.'}), {
    if (!isValidCaptureId(captureId)) {
    }
        });
            headers: {'Content-Type': 'application/json'},
            status: 400,
        return new Response(JSON.stringify({error: 'Missing capture_id parameter.'}), {
    if (!captureId) {
    const captureId = new URL(request.url).searchParams.get('capture_id');

    }
        });
            headers: {'Content-Type': 'application/json'},
            status: 500,
        return new Response(JSON.stringify({error: 'API key is not configured.'}), {
    if (!apiKey) {

    const baseUrl = getApiUrl();
    const apiKey = import.meta.env.SNAPSPACE_API_KEY;
export const GET: APIRoute = async ({request}) => {

} from '../../lib/capture-permissions';
    userHasCaptureAccess,
    unauthorizedResponse,
    requireUser,
    isValidCaptureId,
    forbiddenResponse,
import {
import {createSupabaseServerClientFromRequest} from '../../lib/supabase-server';
import {getApiUrl} from '../../lib/endpoint-config';

