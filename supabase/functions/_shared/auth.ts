import { createClient } from "jsr:@supabase/supabase-js@2";
import { jsonResponse } from "./cors.ts";

/**
 * Verify the caller is a logged-in user.
 *
 * We deploy with --no-verify-jwt because Supabase Auth now issues asymmetric
 * (ES256) session tokens that the Edge Function gateway can't always verify.
 * Instead we ask Supabase Auth itself, via getUser(), whether the token in the
 * Authorization header is a valid session. The bare anon key is NOT a user
 * session, so it is rejected here.
 *
 * Returns the user on success, or a 401 Response to send back.
 */
export async function requireAuth(
    req: Request,
): Promise<{ user: { id: string; email?: string } } | { error: Response }> {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
        return { error: jsonResponse({ error: "Missing Authorization header" }, 401) };
    }

    const supabase = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_ANON_KEY") ?? "",
        { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) {
        return { error: jsonResponse({ error: "Invalid or expired session" }, 401) };
    }
    return { user };
}
