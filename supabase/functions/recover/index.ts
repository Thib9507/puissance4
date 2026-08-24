import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Mot de passe oublié, à partir d'un pseudo OU d'un e-mail.
// Public par nature (l'utilisateur n'est pas connecté). La réponse est
// toujours la même, que le compte existe ou non : sinon l'endpoint
// permettrait de savoir quels pseudos et quelles adresses sont inscrits.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ok = () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return ok();

  let identifier: unknown, redirect_to: unknown;
  try {
    ({ identifier, redirect_to } = await req.json());
  } catch {
    return ok();
  }
  if (typeof identifier !== "string" || !identifier.trim()) return ok();

  let email = identifier.trim();

  if (!email.includes("@")) {
    const lookup = await fetch(`${SUPABASE_URL}/rest/v1/rpc/email_for_username`, {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_username: email }),
    });
    if (!lookup.ok) return ok();
    const found = await lookup.json();
    if (typeof found !== "string" || !found) return ok();
    email = found;
  }

  const url = new URL(`${SUPABASE_URL}/auth/v1/recover`);
  if (typeof redirect_to === "string" && redirect_to.startsWith("http")) {
    url.searchParams.set("redirect_to", redirect_to);
  }

  // GoTrue valide lui-même redirect_to contre la liste autorisée du projet.
  await fetch(url, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  }).catch(() => {});

  return ok();
});
