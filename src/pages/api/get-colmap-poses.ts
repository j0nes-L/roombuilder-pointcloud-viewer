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

export const GET: APIRoute = async ({ request }) => {
    const apiKey = import.meta.env.SNAPSPACE_API_KEY;
    const baseUrl = getApiUrl();

    if (!apiKey) {
        return new Response(JSON.stringify({ error: 'API key not configured.' }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
        });
    }

    const captureId = new URL(request.url).searchParams.get('capture_id');
    if (!captureId || !isValidCaptureId(captureId)) {
        return new Response(JSON.stringify({ error: 'Invalid capture_id.' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
        });
    }

    const responseHeaders = new Headers();
    const supabase = createSupabaseServerClientFromRequest(request, responseHeaders);
    const user = await requireUser(supabase);
    if (!user) return unauthorizedResponse();
    if (!(await userHasCaptureAccess(supabase, captureId))) return forbiddenResponse();

    try {
        const posesUrl = `${baseUrl}/captures/${encodeURIComponent(captureId)}/poses`;
        const upstream = await fetch(posesUrl, { headers: { 'X-API-Key': apiKey } });

        if (upstream.status === 400) {
            return new Response(JSON.stringify({ error: 'Not a COLMAP capture.' }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }
        if (upstream.status === 404) {
            return new Response(JSON.stringify({ error: 'Capture or metadata not found.' }), {
                status: 404, headers: { 'Content-Type': 'application/json' },
            });
        }
        if (!upstream.ok) {
            return new Response(JSON.stringify({ error: `Upstream error: ${upstream.status}` }), {
                status: upstream.status, headers: { 'Content-Type': 'application/json' },
            });
        }

        const posesData = await upstream.json() as {
            frames: Record<string, { pose: { px: number; py: number; pz: number; rx: number; ry: number; rz: number; rw: number } }>;
        };

        const cameras = Object.entries(posesData.frames)
            .sort(([a], [b]) => parseInt(a, 10) - parseInt(b, 10))
            .map(([idx, frame]) => ({
                px: frame.pose.px,
                py: frame.pose.py,
                pz: frame.pose.pz,
                rx: frame.pose.rx,
                ry: frame.pose.ry,
                rz: frame.pose.rz,
                rw: frame.pose.rw,
                name: `color_${idx}.png`,
            }));

        return new Response(JSON.stringify({ cameras }), {
            status: 200,
            headers: { ...Object.fromEntries(responseHeaders), 'Content-Type': 'application/json' },
        });
    } catch (err) {
        return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
        });
    }
};

