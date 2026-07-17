import { supabase } from './supabase'

// Lê TODAS as linhas de uma consulta, paginando — o Supabase/PostgREST corta em 1000 linhas
// por página. Sem isso, num razão grande (ex.: Confetti) os totais/relatórios ficavam curtos
// e parecia que "não subiu tudo". Use passando uma FÁBRICA de query (para reaplicar o range
// a cada página):  await lerTudo(() => supabase.from('razao').select('...').eq('competencia_id', id))
export async function lerTudo(build, size = 1000) {
  let from = 0
  const out = []
  for (;;) {
    const { data, error } = await build().range(from, from + size - 1)
    if (error) throw error
    const bloco = data || []
    out.push(...bloco)
    if (bloco.length < size) break
    from += size
  }
  return out
}
