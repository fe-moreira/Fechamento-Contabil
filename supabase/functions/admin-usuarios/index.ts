import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

// Gestão de usuários (tipo único: ADM). Roda no servidor com a service_role
// (nunca vai ao front). verify_jwt garante que só usuário logado chama.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } })

// Redirect FIXO para produção — não confia na origem do front (evita link apontando
// para localhost quando o convite é gerado em dev). Pode ser sobrescrito por APP_URL.
const APP_URL = (Deno.env.get("APP_URL") || "https://fechamento-contabil-eight.vercel.app").replace(/\/+$/, "")
const REDIRECT = `${APP_URL}/definir-senha`

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    )
    const body = await req.json().catch(() => ({} as Record<string, unknown>))
    const acao = String((body as Record<string, unknown>).acao || "")
    const email = String((body as Record<string, unknown>).email || "").trim().toLowerCase()

    if (acao === "listar") {
      const { data, error } = await admin.auth.admin.listUsers({ perPage: 500 })
      if (error) throw error
      const usuarios = data.users
        .map((u) => ({ id: u.id, email: u.email, criado: u.created_at, ultimo_acesso: u.last_sign_in_at, confirmado: !!u.email_confirmed_at }))
        .sort((a, b) => String(a.email).localeCompare(String(b.email)))
      return json({ usuarios })
    }

    if (acao === "convidar") {
      if (!email || !email.includes("@")) return json({ error: "Informe um e-mail válido." }, 400)
      const { data, error } = await admin.auth.admin.generateLink({
        type: "invite", email, options: { redirectTo: REDIRECT },
      })
      if (error) throw error
      return json({ ok: true, email, link: data.properties?.action_link || null })
    }

    if (acao === "link_senha") {
      if (!email) return json({ error: "Informe o e-mail." }, 400)
      const { data, error } = await admin.auth.admin.generateLink({
        type: "recovery", email, options: { redirectTo: REDIRECT },
      })
      if (error) throw error
      return json({ ok: true, email, link: data.properties?.action_link || null })
    }

    if (acao === "excluir") {
      const id = String((body as Record<string, unknown>).id || "")
      if (!id) return json({ error: "Informe o id do usuário." }, 400)
      const { error } = await admin.auth.admin.deleteUser(id)
      if (error) throw error
      return json({ ok: true })
    }

    return json({ error: "Ação inválida." }, 400)
  } catch (e) {
    return json({ error: (e as Error).message || String(e) }, 400)
  }
})
