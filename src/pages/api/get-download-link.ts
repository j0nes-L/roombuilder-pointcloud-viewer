import type {APIRoute} from 'astro';
import {getApiUrl} from '../../lib/endpoint-config';
import {createSupabaseServerClientFromRequest} from '../../lib/supabase-server';
import {getSignedFileUrl} from '../../lib/signed-url';
import {
    forbiddenResponse,
    isValidCaptureId,
    requireUser,
    unauthorizedResponse,
    userHasCaptureAccess,
} from '../../lib/capture-permissions';

export const GET: APIRoute = async ({request}) => {
    const baseUrl = getApiUrl();

    const url = new URL(request.url);
    const captureId = url.searchParams.get('capture_id');
    const filename = url.searchParams.get('filename');

    if (!captureId || !filename) {
        return new Response(JSON.stringify({error: 'Missing capture_id or filename parameter.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }
    if (!isValidCaptureId(captureId) || filename.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(filename)) {
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
        const signedUrl = await getSignedFileUrl(supabase, baseUrl, `${captureId}/files/${filename}`);
        if (!signedUrl) {
            return new Response(JSON.stringify({error: 'No download URL returned.'}), {
                status: 502,
                headers: {'Content-Type': 'application/json'},
            });
        }

        return new Response(JSON.stringify({url: signedUrl}), {
            status: 200,
            headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
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

