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

    const captureId = new URL(request.url).searchParams.get('capture_id');
    if (!captureId) {
        return new Response(JSON.stringify({error: 'Missing capture_id parameter.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }
    if (!isValidCaptureId(captureId)) {
        return new Response(JSON.stringify({error: 'Invalid capture_id format.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }

    const responseHeaders = new Headers();
    const supabase = createSupabaseServerClientFromRequest(request, responseHeaders);
    const user = await requireUser(supabase);
    if (!user) return unauthorizedResponse();
    if (!(await userHasCaptureAccess(supabase, captureId))) return forbiddenResponse();

    const apiUrl = `${baseUrl}/captures/${captureId}/pointclouds/mesh.glb`;

    const json = (body: Record<string, unknown>, status = 200) =>
        new Response(JSON.stringify(body), {
            status,
            headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
        });

    try {
        const head = await fetch(apiUrl, {
            method: 'HEAD',
            headers: {'X-API-Key': apiKey},
        });

        if (head.status === 405 || head.status === 501) {
            const range = await fetch(apiUrl, {
                method: 'GET',
                headers: {'X-API-Key': apiKey, Range: 'bytes=0-0'},
            });

            try {
                range.body?.cancel();
            } catch { /* ignore */
            }

            if (!range.ok && range.status !== 206) {
                if (range.status === 404) return json({available: false, size_bytes: null});
                return json({available: false, size_bytes: null, status: range.status});
            }

            const cr = range.headers.get('Content-Range');
            let size: number | null = null;
            if (cr) {
                const m = cr.match(/\/(\d+)\s*$/);
                if (m) size = parseInt(m[1], 10);
            }
            if (size == null) {
                const cl = range.headers.get('Content-Length');
                if (cl && range.status !== 206) size = parseInt(cl, 10);
            }
            return json({available: true, size_bytes: size});
        }

        if (!head.ok) {
            if (head.status === 404) return json({available: false, size_bytes: null});
            return json({available: false, size_bytes: null, status: head.status});
        }

        const cl = head.headers.get('Content-Length');
        return json({available: true, size_bytes: cl ? parseInt(cl, 10) : null});
    } catch (error) {
        return json({
            available: false,
            size_bytes: null,
            error: error instanceof Error ? error.message : String(error),
        }, 500);
    }
};

