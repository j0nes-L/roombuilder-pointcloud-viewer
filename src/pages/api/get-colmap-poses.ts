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

export interface ColmapCameraEntry {
    imageId: number;
    qw: number; qx: number; qy: number; qz: number;
    tx: number; ty: number; tz: number;
    cameraId: number;
    name: string;
}

function parseImagesText(text: string): ColmapCameraEntry[] {
    const entries: ColmapCameraEntry[] = [];
    const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    for (let i = 0; i < lines.length; i++) {
        const p = lines[i].trim().split(/\s+/);
        if (p.length < 10) continue;
        const last = p[p.length - 1];
        if (!/[A-Za-z]/.test(last)) continue;
        const imageId = parseInt(p[0], 10);
        const cameraId = parseInt(p[8], 10);
        const qw = parseFloat(p[1]);
        if (!Number.isInteger(imageId) || !Number.isInteger(cameraId) || !Number.isFinite(qw)) continue;
        entries.push({
            imageId,
            qw,
            qx: parseFloat(p[2]),
            qy: parseFloat(p[3]),
            qz: parseFloat(p[4]),
            tx: parseFloat(p[5]),
            ty: parseFloat(p[6]),
            tz: parseFloat(p[7]),
            cameraId,
            name: p.slice(9).join(' '),
        });
    }
    return entries;
}

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

    const zipUrl = `${baseUrl}/captures/${encodeURIComponent(captureId)}/files/colmap.zip`;
    const upstreamHeaders = { 'X-API-Key': apiKey };

    try {
        const data = await extractFileFromZip(zipUrl, upstreamHeaders, 'sparse/0/images.txt');
        if (!data) {
            return new Response(JSON.stringify({ error: 'images.txt not found in ZIP.' }), {
                status: 404, headers: { 'Content-Type': 'application/json' },
            });
        }
        const text = new TextDecoder().decode(data);
        const cameras = parseImagesText(text);
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

