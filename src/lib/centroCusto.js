import { supabase } from './supabase'

const norm = s => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// "Sem centro de custo": vazio, código -1, ou o texto "Sem Centro de Custo".
export const ehSemCentro = v => { const n = String(v ?? '').trim(); return !n || n === '-1' || /^sem\s*centro/i.test(norm(n)) }

// Carrega os centros de custo CADASTRADOS do cliente (carga vigente) e devolve um resolver
// que casa por código OU por nome. `temCadastro` = há algum centro cadastrado.
export async function carregarResolverCC(clienteId) {
  const { data } = await supabase.from('cargas_cadastro').select('dados')
    .eq('cliente_id', clienteId).eq('tipo', 'centro_custo')
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  const kBy = (o, re) => { const k = Object.keys(o || {}).find(k => re.test(norm(k))); return k ? String(o[k] ?? '').trim() : '' }
  const centros = [], byCod = new Map(), byNome = new Map()
  for (const r of (Array.isArray(data?.dados) ? data.dados : [])) {
    const cod = kBy(r, /cod/); const nome = kBy(r, /nome|descri/)
    if (!cod) continue
    centros.push({ cod, nome })
    byCod.set(norm(cod), cod)
    if (nome) byNome.set(norm(nome), cod)
  }
  return { centros, byCod, byNome, temCadastro: centros.length > 0 }
}

// Resolve um valor de CC lido do arquivo para o CÓDIGO cadastrado.
//   { sem: true }           → sem centro (vazio / -1 / "Sem Centro de Custo")
//   { cod }                 → código cadastrado (casou por código ou por nome)
//   { naoCadastrado: raw }  → existe no arquivo mas NÃO está no cadastro
export function resolverCC(raw, resolver) {
  if (ehSemCentro(raw)) return { sem: true }
  const n = norm(raw)
  const cod = resolver?.byCod.get(n) || resolver?.byNome.get(n)
  if (cod) return { cod }
  return { naoCadastrado: String(raw).trim() }
}
