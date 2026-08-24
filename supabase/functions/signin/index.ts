import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Connexion par pseudo OU e-mail.
// L'endpoint est public par nature (c'est le point d'entrée du login) : il
// implémente sa propre authentification via le grant « password » de GoTrue.
// La résolution pseudo -> e-mail se fait ici avec la clé service_role pour ne
// jamais divulguer d'adresse e-mail au navigateur.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

// Pseudo inconnu et mot de passe faux renvoient exactement la même réponse,
// pour ne pas permettre d'énumérer les pseudos existants.
const invalid = () =>
  json({ error: "invalid_grant", error_description: "Invalid login credentials" }, 400);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let identifier: unknown, password: unknown;
  try {
    ({ identifier, password } = await req.json());
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (typeof identifier !== "string" || typeof password !== "string") return invalid();

  identifier = identifier.trim();
  if (!identifier || !password) return invalid();

  let email = identifier as string;

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
    if (!lookup.ok) return invalid();
    const found = await lookup.json();
    if (typeof found !== "string" || !found) return invalid();
    email = found;
  }

  const auth = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await auth.json();
  if (!auth.ok) return json(data, auth.status);

  return json({ access_token: data.access_token, refresh_token: data.refresh_token });
});
