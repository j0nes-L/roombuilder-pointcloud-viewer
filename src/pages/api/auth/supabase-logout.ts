import type {APIRoute} from 'astro';
import {createSupabaseServerClientFromRequest} from '../../../lib/supabase-server';

export const POST: APIRoute = async ({request}) => {
    const responseHeaders = new Headers({'Content-Type': 'application/json'});
    const supabase = createSupabaseServerClientFromRequest(request, responseHeaders);

    await supabase.auth.signOut();

    responseHeaders.set('Content-Type', 'application/json');
    return new Response(JSON.stringify({ok: true}), {
        status: 200,
        headers: responseHeaders,
    });
};

