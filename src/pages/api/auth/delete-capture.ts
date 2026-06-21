import type {APIRoute} from 'astro';
import {getApiUrl} from '../../../lib/endpoint-config';
import {createSupabaseServerClientFromRequest} from '../../../lib/supabase-server';
import {getUserCaptureRole, isValidCaptureId} from '../../../lib/capture-permissions';

export const DELETE: APIRoute = async ({request}) => {
    const responseHeaders = new Headers({'Content-Type': 'application/json'});
    const supabase = createSupabaseServerClientFromRequest(request, responseHeaders);

    const {data: {user}} = await supabase.auth.getUser();
    if (!user) {
        return new Response(JSON.stringify({error: 'Unauthorized. Please log in.'}), {
            status: 401,
            headers: responseHeaders,
        });
    }

    const url = new URL(request.url);
    const captureId = url.searchParams.get('capture_id');

    if (!captureId || !isValidCaptureId(captureId)) {
        return new Response(JSON.stringify({error: 'Invalid or missing capture_id.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }

    const role = await getUserCaptureRole(supabase, captureId);
    if (!role) {
        return new Response(JSON.stringify({error: 'You do not have access to this capture.'}), {
            status: 403,
            headers: {'Content-Type': 'application/json'},
        });
    }

    if (role === 'collaborator') {
        const {error} = await supabase
            .from('capture_permissions')
            .delete()
            .eq('capture_id', captureId)
            .eq('user_id', user.id);
        if (error) {
            return new Response(JSON.stringify({error: 'Failed to remove capture from library.'}), {
                status: 500,
                headers: {'Content-Type': 'application/json'},
            });
        }
        return new Response(JSON.stringify({ok: true}), {status: 200, headers: responseHeaders});
    }

    const baseUrl = getApiUrl();

    const {data: {session}} = await supabase.auth.getSession();
    if (!session) {
        return new Response(JSON.stringify({error: 'Unauthorized. Please log in.'}), {
            status: 401,
            headers: responseHeaders,
        });
    }

    try {
        const response = await fetch(`${baseUrl}/captures/${encodeURIComponent(captureId)}`, {
            method: 'DELETE',
            headers: {'Authorization': `Bearer ${session.access_token}`},
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

        await supabase
            .from('capture_permissions')
            .delete()
            .eq('capture_id', captureId);

        const data = await response.json();
        return new Response(JSON.stringify(data), {status: 200, headers: responseHeaders});

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

