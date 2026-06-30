import type {APIRoute} from 'astro';
import type {EmailOtpType} from '@supabase/supabase-js';
import {createSupabaseServerClientFromRequest} from '../../../lib/supabase-server';

export const POST: APIRoute = async ({request}) => {
    const buildRedirect = (location: string, extraHeaders?: Headers) => {
        const headers = new Headers(extraHeaders);
        headers.set('Location', location);
        return new Response(null, {status: 303, headers});
    };

    let tokenHash = '';
    let type: EmailOtpType = 'signup';
    let flow = 'signup';
    try {
        const form = await request.formData();
        tokenHash = String(form.get('token_hash') ?? '');
        type = (String(form.get('type') ?? 'signup') || 'signup') as EmailOtpType;
        flow = String(form.get('flow') ?? '') || (type === 'recovery' ? 'recovery' : 'signup');
    } catch {
        return buildRedirect(
            `/account?toast=error&msg=${encodeURIComponent('Invalid or missing confirmation link.')}`
        );
    }

    if (!tokenHash) {
        return buildRedirect(
            `/account?toast=error&msg=${encodeURIComponent('Invalid or missing confirmation link.')}`
        );
    }

    const responseHeaders = new Headers();
    const supabase = createSupabaseServerClientFromRequest(request, responseHeaders);

    let errorMessage: string | null = null;
    try {
        const {error} = await supabase.auth.verifyOtp({type, token_hash: tokenHash});
        if (error) errorMessage = error.message;
    } catch (err) {
        errorMessage = err instanceof Error ? err.message : 'Unexpected error during confirmation.';
    }

    if (errorMessage) {
        const isExpired = /expired|invalid/i.test(errorMessage);
        const msg = isExpired
            ? 'This link has expired or is invalid. Please request a new one.'
            : errorMessage;
        const params = new URLSearchParams({type, flow, error: msg});
        return buildRedirect(`/confirm?${params.toString()}`);
    }

    if (flow === 'recovery') {
        return buildRedirect(
            `/account?mode=update-password&toast=info&msg=${encodeURIComponent('Please set your new password below.')}`,
            responseHeaders
        );
    }

    await supabase.auth.signOut({scope: 'local'});

    return buildRedirect(
        `/account?toast=success&msg=${encodeURIComponent('Email confirmed! You can now log in.')}`
    );
};

