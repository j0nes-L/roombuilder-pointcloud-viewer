import type {APIRoute} from 'astro';
import {createSupabaseServerClientFromRequest} from '../../../lib/supabase-server';

export const GET: APIRoute = async ({request}) => {
    const responseHeaders = new Headers({'Content-Type': 'application/json'});
    const supabase = createSupabaseServerClientFromRequest(request, responseHeaders);

    const {data: {user}} = await supabase.auth.getUser();

    if (!user) {
        return new Response(JSON.stringify({loggedIn: false, role: null, display_name: null}), {
            status: 200,
            headers: responseHeaders,
        });
    }

    const {data: profile} = await supabase
        .from('profiles')
        .select('role, display_name')
        .eq('id', user.id)
        .single();

    responseHeaders.set('Content-Type', 'application/json');
    return new Response(JSON.stringify({
        loggedIn: true,
        role: profile?.role ?? null,
        display_name: profile?.display_name ?? null,
    }), {
        status: 200,
        headers: responseHeaders,
    });
};

