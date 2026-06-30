import type {APIRoute} from 'astro';
import {createSupabaseServerClientFromRequest} from '../../../lib/supabase-server';
import {getOrigin} from '../../../lib/get-origin';

export const POST: APIRoute = async ({request}) => {
    const responseHeaders = new Headers({'Content-Type': 'application/json'});
    const supabase = createSupabaseServerClientFromRequest(request, responseHeaders);

    let body: {email?: string};
    try {
        body = await request.json();
    } catch {
        return new Response(JSON.stringify({error: 'Invalid request body.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }

    const email = body.email?.trim();
    if (!email) {
        return new Response(JSON.stringify({error: 'Email required.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return new Response(JSON.stringify({error: 'Please enter a valid email address.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }

    let errorMessage: string | null = null;
    try {
        const {error} = await supabase.auth.resend({
            type: 'signup',
            email,
            options: {
                emailRedirectTo: `${getOrigin(request)}/api/auth/callback?flow=signup`,
            },
        });
        if (error) errorMessage = error.message;
    } catch (err) {
        errorMessage = err instanceof Error ? err.message : 'Unexpected error while resending the email.';
    }

    if (errorMessage) {
        let msg = errorMessage;
        if (/rate.limit|too many|after \d+ second/i.test(msg))
            msg = 'Too many attempts. Please wait a moment and try again.';
        else if (/already.*confirmed|already.*registered/i.test(msg))
            msg = 'This email is already confirmed. Please log in instead.';
        else if (/invalid email/i.test(msg))
            msg = 'Please enter a valid email address.';
        return new Response(JSON.stringify({error: msg}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }

    responseHeaders.set('Content-Type', 'application/json');
    return new Response(JSON.stringify({ok: true}), {
        status: 200,
        headers: responseHeaders,
    });
};

