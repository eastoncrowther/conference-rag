import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/auth.ts";

// Bounds on what one request may send to GPT-4o, so a logged-in user can't run up the bill.
// Three full talks are ~45k characters, well under these limits.
const MAX_QUESTION_CHARS = 1000;
const MAX_TALKS = 5;
const MAX_CONTEXT_CHARS = 80_000;

const SYSTEM_PROMPT = `You answer questions about General Conference talks of The Church of Jesus Christ of Latter-day Saints.

Rules:
- Use ONLY the conference talks provided by the user as your source. Do not add outside facts.
- Cite the talks you draw from by title and speaker, e.g. (“Title,” Speaker).
- If the talks don't address the question, say so plainly instead of guessing.
- Write 2–4 short paragraphs of plain text separated by blank lines. No Markdown, headings, or bullet symbols.`;

type ContextTalk = { title?: unknown; speaker?: unknown; text?: unknown };

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const auth = await requireAuth(req);
    if ("error" in auth) return auth.error;

    try {
        const { question, context_talks } = await req.json();
        if (typeof question !== "string" || !question.trim()) {
            return jsonResponse({ error: "Missing or invalid 'question' field" }, 400);
        }
        if (question.length > MAX_QUESTION_CHARS) {
            return jsonResponse({ error: `Question must be under ${MAX_QUESTION_CHARS} characters` }, 400);
        }
        // Also what the app's readiness check sends; answered without calling OpenAI.
        if (!Array.isArray(context_talks) || context_talks.length === 0) {
            return jsonResponse({ error: "'context_talks' must be a non-empty array" }, 400);
        }

        const talks = (context_talks as ContextTalk[]).slice(0, MAX_TALKS).map((t, i) => ({
            title: String(t.title ?? `Talk ${i + 1}`),
            speaker: String(t.speaker ?? "Unknown").replace(/^By\s+/i, ""),
            text: String(t.text ?? ""),
        }));
        let context = talks
            .map((t, i) => `[Talk ${i + 1}] “${t.title}” by ${t.speaker}\n${t.text}`)
            .join("\n\n---\n\n");
        if (context.length > MAX_CONTEXT_CHARS) context = context.slice(0, MAX_CONTEXT_CHARS);

        const openaiKey = Deno.env.get("OPENAI_API_KEY");
        if (!openaiKey) {
            return jsonResponse({ error: "OPENAI_API_KEY not configured" }, 500);
        }

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${openaiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "gpt-4o",
                temperature: 0.3,
                max_tokens: 700,
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content: `Conference talks:\n\n${context}\n\nQuestion: ${question.trim()}` },
                ],
            }),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            return jsonResponse({ error: err.error?.message || "OpenAI API error" }, response.status);
        }

        const data = await response.json();
        return jsonResponse({ answer: data.choices[0].message.content, usage: data.usage });
    } catch (err) {
        return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
});
