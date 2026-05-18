import type {APIRoute} from 'astro';
import {createSupabaseServerClientFromRequest} from '../../../lib/supabase-server';

export const GET: APIRoute = async ({request}) => {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const flow = url.searchParams.get('flow') ?? 'signup';

    const buildRedirect = (location: string, extraHeaders?: Headers) => {
        const headers = new Headers(extraHeaders);
        headers.set('Location', location);
        return new Response(null, {status: 302, headers});
    };

    if (!code) {
        return buildRedirect(
            `/account?toast=error&msg=${encodeURIComponent('Invalid or missing confirmation link.')}`
        );
    }

    const responseHeaders = new Headers();
    const supabase = createSupabaseServerClientFromRequest(request, responseHeaders);

    const {error} = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
        const isExpired = /expired|invalid/i.test(error.message);
        const msg = isExpired
            ? 'This link has expired or is invalid. Please request a new one.'
            : error.message;
        return buildRedirect(
            `/account?toast=error&msg=${encodeURIComponent(msg)}`,
            responseHeaders
        );
    }

    if (flow === 'recovery') {
        return buildRedirect(
            `/account?mode=update-password&toast=info&msg=${encodeURIComponent('Please set your new password below.')}`,
            responseHeaders
        );
    }

    return buildRedirect(
        `/account?toast=success&msg=${encodeURIComponent('Email confirmed! You are now logged in.')}`,
        responseHeaders
    );
};

