// Edge Function: lê um documento (PDF/imagem) e extrai os campos por bloco,
// usando a API da Anthropic (Claude) com structured outputs.
// A chave ANTHROPIC_API_KEY fica como segredo do projeto — nunca vai ao front.

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

// Schema de extração por tipo de bloco (structured outputs).
const SCHEMAS: Record<string, { schema: unknown; hint: string }> = {
  seguro: {
    hint: "apólice de seguro",
    schema: obj({
      seguradora: "string", apolice: "string", ramo: "string",
      vigencia_inicio: "string", vigencia_fim: "string",
      premio_total: "number", num_parcelas: "integer", valor_parcela: "number",
    }),
  },
  importacao: {
    hint: "processo de importação (DI / invoice)",
    schema: obj({
      numero: "string", di: "string", fornecedor: "string", mercadoria: "string",
      invoice_moeda: "string", invoice_valor: "number", cambio: "number", custo_total: "number",
    }),
  },
  emprestimo: {
    hint: "contrato de empréstimo / financiamento",
    schema: obj({
      banco: "string", contrato: "string", modalidade: "string",
      valor: "number", prazo: "integer", taxa_mensal: "number",
      valor_parcela: "number", saldo_devedor: "number",
    }),
  },
  parcelamento: {
    hint: "termo de parcelamento de impostos",
    schema: obj({
      orgao: "string", numero: "string", tributo: "string",
      consolidado: "number", num_parcelas: "integer", valor_parcela: "number",
      saldo_devedor: "number", juros_multa_mes: "number",
    }),
  },
  participacao: {
    hint: "balancete/contrato de participação societária (equivalência patrimonial)",
    schema: obj({
      investida: "string", vinculo: "string",
      participacao_pct: "number", valor_investimento: "number",
    }),
  },
}

function obj(props: Record<string, string>) {
  const properties: Record<string, unknown> = {}
  for (const [k, t] of Object.entries(props)) properties[k] = { type: t }
  return { type: "object", properties, required: Object.keys(props), additionalProperties: false }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } })

  if (!ANTHROPIC_API_KEY) {
    return json({ error: "IA não configurada: defina o segredo ANTHROPIC_API_KEY no projeto Supabase." }, 501)
  }

  try {
    const { tipo, arquivo_base64, mime } = await req.json()
    const cfg = SCHEMAS[tipo]
    if (!cfg) return json({ error: `Tipo desconhecido: ${tipo}` }, 400)
    if (!arquivo_base64) return json({ error: "Envie o arquivo (arquivo_base64)." }, 400)

    const ehPdf = (mime || "").includes("pdf")
    const bloco = ehPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: arquivo_base64 } }
      : { type: "image", source: { type: "base64", media_type: mime || "image/png", data: arquivo_base64 } }

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 1024,
        output_config: { format: { type: "json_schema", schema: cfg.schema } },
        messages: [{
          role: "user",
          content: [
            bloco,
            { type: "text", text: `Este documento é ${cfg.hint}. Extraia os campos solicitados. Datas no formato AAAA-MM-DD; valores como número (ponto decimal). Se um campo não constar, use "" para texto ou 0 para número.` },
          ],
        }],
      }),
    })

    const data = await resp.json()
    if (!resp.ok) return json({ error: data?.error?.message || "Falha na leitura." }, 502)
    if (data.stop_reason === "refusal") return json({ error: "A leitura foi recusada pela IA." }, 422)

    const texto = (data.content || []).find((b: { type: string }) => b.type === "text")?.text || "{}"
    return json({ dados: JSON.parse(texto) })
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500)
  }
})
