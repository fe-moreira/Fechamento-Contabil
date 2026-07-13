import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import { theme, money, moneyDC } from '../lib/theme'
import { montarBalancete, normalizaCompetencia, applyMask, erroContaSintetica } from '../lib/balancete'
import { aprenderDaCorrecao } from '../lib/sugestoesRazao'
import CampoConta from '../components/CampoConta'

// Data (Date do Excel ou "dd/mm/aaaa") → ISO "aaaa-mm-dd".
function toISO(v) {
  if (!v) return null
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  const m = String(v).trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/)
  if (m) { let [, d, mo, y] = m; if (y.length === 2) y = '20' + y; return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}` }
  const iso = String(v).trim().match(/^(\d{4})-(\d{2})-(\d{2})/); return iso ? iso[0] : null
}
function numBR(v) {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return v
  let s = String(v).trim(); if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
  const n = parseFloat(s.replace(/[^\d.-]/g, '')); return isNaN(n) ? 0 : n
}
function limpaContra(v) { const s = String(v ?? '').trim(); return (!s || /^0+([.,]0+)?$/.test(s.replace(/\./g, ''))) ? null : s }

const ANO = 2026
const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']

// Chave estável de uma célula (conta × mês) para o set de justificadas.
const chaveCelula = (conta, mes) => `${conta}|${mes}`
// Chave ano-mês da matriz multi-ano.
const amKey = (ano, mes) => `${ano}-${String(mes).padStart(2, '0')}`

// Tokens significativos do histórico (para detectar recorrência nos meses anteriores).
const STOP = new Set(['VENDA', 'VENDAS', 'COMPRA', 'COMPRAS', 'PAGTO', 'PAGAMENTO', 'RECEB', 'RECEBIMENTO', 'NOTA', 'FISCAL', 'VALOR', 'REFERENTE', 'REF', 'DUPLICATA', 'PARCELA', 'CONTA'])
function tokens(h) {
  return String(h || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/).filter(w => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w))
}

// Aponta o(s) lançamento(s) provável(is) culpado(s) da variação, com motivo.
function analisarCulpados(linhas, historicosAnteriores) {
  const vals = linhas.map(l => (Number(l.debito) || 0) + (Number(l.credito) || 0))
  const positivos = vals.filter(v => v > 0)
  const maxV = positivos.length ? Math.max(...positivos) : 0
  const ord = [...positivos].sort((a, b) => a - b)
  const mediana = ord.length ? ord[Math.floor(ord.length / 2)] : 0
  const tokensAnt = new Set()
  for (const h of historicosAnteriores) for (const t of tokens(h)) tokensAnt.add(t)

  return linhas.map((l, i) => {
    const v = vals[i]
    const h = (l.historico || '').toUpperCase()
    const motivos = []
    if (v > 0 && v === maxV && mediana > 0 && v >= mediana * 3) motivos.push('valor fora do padrão mensal desta conta')
    const palavras = h.replace(/[^A-ZÀ-Ú ]/g, ' ').split(/\s+/).filter(Boolean)
    if (h.includes('?') || /\b(DIVERSOS?|DIVERSA|AVULS[OA]|OUTR[OA]S?|GERAL|V[AÁ]RIOS)\b/.test(h) || palavras.length <= 1) motivos.push('histórico genérico')
    const ht = tokens(l.historico)
    if (ht.length && tokensAnt.size && !ht.some(t => tokensAnt.has(t))) motivos.push('não recorre nos meses anteriores')
    return { ...l, suspeito: motivos.length > 0, motivo: motivos.join(' · ') }
  })
}

// Chave de agrupamento por entidade a partir do histórico: tira números (NF, datas),
// acentos e palavras genéricas, sobrando o nome distintivo (cliente/fornecedor). Assim
// as várias NFs de um mesmo cliente caem no mesmo grupo.
const RUIDO_ENT = new Set(['NF', 'NFE', 'NFSE', 'NOTA', 'NOTAS', 'FISCAL', 'FISCAIS', 'REF', 'RECTO', 'RECEBIMENTO', 'RECEITA', 'VENDA', 'VENDAS', 'FATURAMENTO', 'SERV', 'SERVICO', 'SERVICOS', 'PREST', 'PRESTACAO', 'DUPL', 'DUPLICATA', 'BAIXA', 'PAGTO', 'PAGAMENTO', 'DE', 'DA', 'DO', 'DAS', 'DOS', 'E', 'LTDA', 'ME', 'EPP', 'SA', 'CIA', 'COMERCIO', 'INDUSTRIA', 'EIRELI'])
function chaveEntidade(h) {
  const toks = String(h || '')
    .toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z ]+/g, ' ').split(/\s+/)
    .filter(t => t.length > 1 && !RUIDO_ENT.has(t))
  return toks.slice(0, 4).join(' ').trim()
}

// Compara os lançamentos da conta em dois meses, agrupados por entidade, e devolve as
// entidades que mais explicam a variação (maior mudança de valor entre os meses).
// Retorna [{ rep, movAtual, movAnterior, delta }] ordenado pela relevância.
function analisarMovers(linhasAtual, linhasAnterior) {
  const acc = new Map() // chave -> { movAtual, movAnterior, rep, repVal }
  const somar = (linhas, campo) => {
    for (const l of linhas) {
      const k = chaveEntidade(l.historico)
      if (!k) continue
      const mov = (Number(l.debito) || 0) - (Number(l.credito) || 0)
      const g = acc.get(k) || { movAtual: 0, movAnterior: 0, rep: '', repVal: 0 }
      g[campo] += mov
      if (Math.abs(mov) >= Math.abs(g.repVal)) { g.rep = l.historico || k; g.repVal = mov }
      acc.set(k, g)
    }
  }
  somar(linhasAtual, 'movAtual')
  somar(linhasAnterior, 'movAnterior')
  // Grupo único = a conta não tem quebra por cliente no histórico (ex.: linha
  // acumuladora). Nesse caso não há entidade a nomear — devolve vazio.
  if (acc.size <= 1) return []
  const lista = [...acc.entries()]
    .map(([key, g]) => ({ key, rep: g.rep, movAtual: g.movAtual, movAnterior: g.movAnterior, delta: g.movAtual - g.movAnterior }))
    .filter(g => Math.abs(g.delta) > 0.005)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  if (!lista.length) return []
  // Só mantém quem é relevante frente ao maior movimento (evita citar ruído).
  const topo = Math.abs(lista[0].delta)
  return lista.filter(g => Math.abs(g.delta) >= topo * 0.4).slice(0, 2)
}

// Para as entidades que CAÍRAM nesta conta, procura a mesma entidade em OUTRA conta no
// mesmo mês (todos os lançamentos da competência): se o valor reaparece em outra conta,
// é provável reclassificação (o valor "saiu de uma conta e caiu em outra").
function anotarReclass(movers, mesTodo, contaAtual, plano) {
  const idx = new Map() // entidade -> (conta -> movimento no mês)
  for (const l of mesTodo) {
    if (String(l.conta) === String(contaAtual)) continue
    const k = chaveEntidade(l.historico)
    if (!k) continue
    const mov = (Number(l.debito) || 0) - (Number(l.credito) || 0)
    const porConta = idx.get(k) || new Map()
    porConta.set(String(l.conta), (porConta.get(String(l.conta)) || 0) + mov)
    idx.set(k, porConta)
  }
  return movers.map(m => {
    const caiu = Math.abs(m.movAtual) < Math.abs(m.movAnterior)
    if (!caiu || !m.key) return m
    const porConta = idx.get(m.key)
    if (!porConta) return m
    let best = null
    for (const [c, v] of porConta) if (!best || Math.abs(v) > Math.abs(best.v)) best = { c, v }
    if (!best || Math.abs(best.v) < 0.005) return m
    const nomeC = (plano || []).find(p => String(p.cod) === best.c)?.nome
    return { ...m, reclass: { conta: best.c, nome: nomeC || '', valor: best.v } }
  })
}

// Seletor de MÚLTIPLOS meses (marque os que quer ver). Vazio = todos. Por número do
// mês (aplica a todos os anos — útil para comparar o mesmo mês entre anos).
function MultiMesSelect({ meses, sel, onChange }) {
  const [aberto, setAberto] = useState(false)
  const toggle = m => { const n = new Set(sel); n.has(m) ? n.delete(m) : n.add(m); onChange(n) }
  const marcados = meses.filter(m => sel.has(m)).map(m => MESES[m - 1])
  const label = sel.size === 0 ? 'Todos os meses' : marcados.length <= 3 ? marcados.join(', ') : `${marcados.length} meses`
  const linha = { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 12.5, cursor: 'pointer', borderRadius: 6 }
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button className="btn btn-ghost" onClick={() => setAberto(a => !a)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '6px 12px' }}>
        {label} <i className="ti ti-chevron-down" style={{ fontSize: 14 }} />
      </button>
      {aberto && (
        <>
          <div onClick={() => setAberto(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, background: theme.card, border: `1px solid ${theme.cb}`, borderRadius: 10, padding: 8, zIndex: 41, minWidth: 180, maxHeight: 320, overflow: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,.28)' }}>
            <label style={{ ...linha, fontWeight: 600 }} onClick={() => onChange(new Set())}>
              <input type="checkbox" readOnly checked={sel.size === 0} /> Todos os meses
            </label>
            <div style={{ height: 1, background: theme.border, margin: '6px 0' }} />
            {meses.map(m => (
              <label key={m} style={linha} onClick={() => toggle(m)}>
                <input type="checkbox" readOnly checked={sel.has(m)} /> {MESES[m - 1]}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export default function CompMovimento() {
  const { empresaId, empresaNome, getCompetenciaId, plano } = useAppData()
  const { user } = useAuth()

  const [carregando, setCarregando] = useState(false)
  const [comps, setComps] = useState([])        // [{ id, mes }] dos meses com balancete
  const [contas, setContas] = useState([])      // [{ reduzido, classif, nome, grau, sintetica }] união (sint. + analít.)
  const [matriz, setMatriz] = useState({})      // { classif: { mes: saldo_final } }
  const [detalhe, setDetalhe] = useState(null)  // { conta, nome, mes, compId }
  const [justificadas, setJustificadas] = useState(() => new Set()) // 'conta|mes' já justificadas/corrigidas localmente
  const [justTextos, setJustTextos] = useState(() => ({}))          // 'conta|mes' -> texto da justificativa (p/ tooltip)
  const [nivel, setNivel] = useState('tudo')                        // 'tudo' = todas; número N = sintéticas até o nível N
  const [agrupar, setAgrupar] = useState('mes')                     // 'mes' | 'trimestre' | 'semestre' | 'ano'
  const [anosMeses, setAnosMeses] = useState([])                    // [{ ano, mes, id }] de TODOS os anos com dados
  const [refresh, setRefresh] = useState(0)     // recarrega após importar meses anteriores
  const [impBusy, setImpBusy] = useState(false)
  const [impMsg, setImpMsg] = useState('')
  const [mesesSel, setMesesSel] = useState(() => new Set()) // vazio = todos os meses

  // Importa o razão dos MESES ANTERIORES (ex.: jan–abr) num único arquivo, agrupando por
  // mês (coluna de competência/mês ou o mês da data). Cria a competência de cada mês e
  // grava razão + balancete — só para meses ANTES do início do cliente (não mexe nos
  // fechamentos reais). Depois o comparativo já traz a régua dos 10% com histórico.
  async function importarMeses(file) {
    if (!file || !empresaId) return
    setImpBusy(true); setImpMsg('')
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
      const arr = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
      let h = 0
      for (let i = 0; i < Math.min(arr.length, 25); i++) { if ((arr[i] || []).filter(c => typeof c === 'string' && c.trim().length > 1).length >= 3) { h = i; break } }
      const headers = (arr[h] || []).map(x => String(x ?? ''))
      const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      const findCol = (...dicas) => headers.findIndex(hd => { const hl = norm(hd); return dicas.some(d => hl.includes(d)) })
      const col = {
        data: findCol('data'),
        // CÓDIGO REDUZIDO da conta (col. D · "codic") — é o que casa com o código do plano.
        reduzido: headers.findIndex(hd => { const hl = norm(hd); return hl === 'codic' || hl.includes('reduz') || (hl.includes('codigo') && hl.includes('conta')) }),
        // Classificação (col. B · "clasc") — fallback quando não houver o código reduzido.
        clasc: headers.findIndex(hd => { const hl = norm(hd); return hl === 'clasc' || (hl.includes('conta') && !hl.includes('contra') && !hl.includes('nome') && !hl.includes('cod')) }),
        nome: headers.findIndex(hd => { const hl = norm(hd); return hl === 'nomec' || hl.includes('nome da conta') || hl.includes('nome conta') }),
        contrapartida: findCol('contrapartida', 'contra partida', 'contrap'),
        historico: findCol('histor', 'complemento'),
        debito: findCol('debito', 'valdeb', 'vlr deb'),
        credito: findCol('credito', 'valcre', 'vlr cred'),
        comp: findCol('compet', 'mes', 'mês'),
        mascara: findCol('mascara', 'máscara'),
      }
      if ((col.reduzido < 0 && col.clasc < 0) || (col.debito < 0 && col.credito < 0)) { setImpMsg('Não identifiquei as colunas (preciso do Código da conta e Débito/Crédito).'); setImpBusy(false); return }
      const { data: cli } = await supabase.from('clientes').select('competencia_inicio').eq('id', empresaId).maybeSingle()
      const iniM = String(normalizaCompetencia(cli?.competencia_inicio) || '').match(/^(\d{2})\/(\d{4})$/)
      const mesInicio = iniM ? Number(iniM[1]) : 99 // sem início definido → importa todos os meses do arquivo
      const porMes = {}
      for (const r of arr.slice(h + 1)) {
        // A conta é o CÓDIGO REDUZIDO (casa com o plano por reduzido). Sem o reduzido, usa a
        // classificação (aplicando a máscara quando vier só em dígitos).
        let conta
        if (col.reduzido >= 0) conta = String(r[col.reduzido] ?? '').trim()
        else { conta = String(r[col.clasc] ?? '').trim(); if (col.mascara >= 0 && /^\d+$/.test(conta)) conta = applyMask(conta, r[col.mascara]) }
        const debito = col.debito >= 0 ? numBR(r[col.debito]) : 0
        const credito = col.credito >= 0 ? numBR(r[col.credito]) : 0
        if (!conta || (!debito && !credito)) continue // linha sem conta ou sem valor não entra
        let mes = null
        if (col.comp >= 0) { const mm = String(r[col.comp] ?? '').match(/(\d{1,2})/); if (mm) mes = Number(mm[1]) }
        if (!mes) { const iso = toISO(r[col.data]); if (iso) mes = Number(iso.slice(5, 7)) }
        if (!mes || mes < 1 || mes > 12 || mes >= mesInicio) continue // só meses ANTERIORES ao início
        ;(porMes[mes] ||= []).push({
          data: toISO(r[col.data]), conta,
          nome: col.nome >= 0 ? String(r[col.nome] ?? '').trim() : null,
          contrapartida: col.contrapartida >= 0 ? limpaContra(r[col.contrapartida]) : null,
          historico: col.historico >= 0 ? String(r[col.historico] ?? '').trim() : '',
          debito, credito,
        })
      }
      const meses = Object.keys(porMes).map(Number).sort((a, b) => a - b)
      if (!meses.length) { setImpMsg(`Nenhum mês anterior a ${mesInicio <= 12 ? MESES[mesInicio - 1] : 'início'} reconhecido no arquivo.`); setImpBusy(false); return }
      for (const mes of meses) {
        let compId
        const { data: ex } = await supabase.from('competencias').select('id').eq('cliente_id', empresaId).eq('ano', ANO).eq('mes', mes).maybeSingle()
        if (ex) compId = ex.id
        else { const { data: cr, error } = await supabase.from('competencias').insert({ cliente_id: empresaId, ano: ANO, mes }).select('id').single(); if (error) throw error; compId = cr.id }
        const itens = porMes[mes]
        // A tabela `razao` NÃO tem coluna `nome` (igual à conciliação): grava sem o nome.
        const paraRazao = itens.map(x => ({ competencia_id: compId, data: x.data, conta: x.conta, contrapartida: x.contrapartida, historico: x.historico, debito: x.debito, credito: x.credito }))
        await supabase.from('razao').delete().eq('competencia_id', compId)
        for (let i = 0; i < paraRazao.length; i += 500) { const { error } = await supabase.from('razao').insert(paraRazao.slice(i, i + 500)); if (error) throw error }
        const porConta = {}
        for (const r of itens) { const c = porConta[r.conta] || (porConta[r.conta] = { conta: r.conta, nome: r.nome || null, debito: 0, credito: 0 }); if (!c.nome && r.nome) c.nome = r.nome; c.debito += r.debito; c.credito += r.credito }
        const bal = Object.values(porConta).map(c => ({ competencia_id: compId, conta: c.conta, nome: c.nome || null, saldo_inicial: 0, debito: c.debito, credito: c.credito, saldo_final: c.debito - c.credito }))
        await supabase.from('balancete').delete().eq('competencia_id', compId)
        for (let i = 0; i < bal.length; i += 500) { const { error } = await supabase.from('balancete').insert(bal.slice(i, i + 500)); if (error) throw error }
      }
      setImpMsg(`Importado(s) ${meses.length} mês(es): ${meses.map(m => MESES[m - 1]).join(', ')}.`)
      setRefresh(x => x + 1)
    } catch (e) { setImpMsg('Erro ao importar: ' + (e.message || e)) }
    setImpBusy(false)
  }

  useEffect(() => {
    setComps([]); setAnosMeses([]); setContas([]); setMatriz({}); setDetalhe(null); setJustificadas(new Set())
    if (!empresaId) return
    let vivo = true
    ;(async () => {
      setCarregando(true)
      try {
        // Todos os anos com dados (para comparação multi-ano/por período).
        const { data: competencias } = await supabase
          .from('competencias').select('id, ano, mes')
          .eq('cliente_id', empresaId)
          .order('ano', { ascending: true }).order('mes', { ascending: true })

        if (!vivo) return
        if (!competencias || !competencias.length) { setCarregando(false); return }

        const compsComDados = []   // meses do ANO de fechamento (fluxo de justificar)
        const amArr = []           // [{ ano, mes, id }] de todos os anos com dados
        const meta = {}            // classifRaw → { reduzido, classif, classifRaw, nome, grau, sintetica }
        const m = {}               // classifRaw → { 'ano-mm': saldo_final }

        for (const c of competencias) {
          // Razão VIVO: o balancete importado + os lançamentos confirmados (correções da
          // Conciliação, estornos, apropriações). Assim o ajuste feito em qualquer tela
          // (ex.: estorno de rendimento em dobro na 759) aparece aqui no débito da conta.
          const { linhas } = await montarBalancete(empresaId, c.id, 0, { comLancamentos: true })
          if (!vivo) return
          // Comparativo trata só contas de resultado: Receita (3), Custos (4) e Despesas (5).
          const res = linhas.filter(l => { const d = String(l.classifRaw || l.classif).trim()[0]; return d === '3' || d === '4' || d === '5' })
          if (!res.length) continue

          amArr.push({ ano: c.ano, mes: c.mes, id: c.id })
          if (c.ano === ANO) compsComDados.push({ id: c.id, mes: c.mes })
          for (const l of res) {
            const key = l.classifRaw || l.classif
            if (!meta[key]) {
              meta[key] = { reduzido: l.reduzido, classif: l.classif, classifRaw: key, nome: l.nome, grau: l.grau, sintetica: l.sintetica }
            } else {
              if (!meta[key].nome && l.nome) meta[key].nome = l.nome
              if (!meta[key].reduzido && l.reduzido) meta[key].reduzido = l.reduzido
              // analítica (folha) em qualquer mês → conta é clicável (não sintética).
              meta[key].sintetica = meta[key].sintetica && l.sintetica
            }
            if (!m[key]) m[key] = {}
            m[key][amKey(c.ano, c.mes)] = l.saldo_final
          }
        }

        if (!vivo) return
        const listaContas = Object.values(meta)
          .sort((a, b) => a.classifRaw < b.classifRaw ? -1 : a.classifRaw > b.classifRaw ? 1 : 0)

        setComps(compsComDados)
        setAnosMeses(amArr)
        setContas(listaContas)
        setMatriz(m)

        // Pré-carrega justificativas/correções já registradas na auditoria deste módulo,
        // para o contador refletir o que já foi tratado em sessões anteriores.
        const compIds = compsComDados.map(c => c.id)
        if (compIds.length) {
          const { data: audits } = await supabase
            .from('auditoria').select('item, competencia_id, tipo, detalhe')
            .in('competencia_id', compIds).eq('modulo', 'Comparativo')
          if (!vivo) return
          if (audits && audits.length) {
            const set = new Set(), textos = {}
            for (const a of audits) {
              // item no formato `${conta} · ${MES}/${ano}` — o mês vem do PRÓPRIO item
              // (fonte da verdade, igual ao desfazer e à célula), não da competência anexada.
              const [contaPart, periodo] = String(a.item || '').split(' · ')
              const conta = (contaPart || '').trim()
              const idx = MESES.indexOf((periodo || '').trim().slice(0, 3))
              if (conta && idx >= 0) {
                const ch = chaveCelula(conta, idx + 1)
                set.add(ch)
                if (a.detalhe) textos[ch] = a.detalhe
                else if (a.tipo) textos[ch] = a.tipo
              }
            }
            setJustificadas(set)
            setJustTextos(textos)
          }
        }
      } finally {
        if (vivo) setCarregando(false)
      }
    })()
    return () => { vivo = false }
  }, [empresaId, refresh])

  // Uma célula desvia se difere mais de 10% do MÊS ANTERIOR (mês a mês: fev × jan,
  // mar × fev…). O primeiro mês nunca fica vermelho — não há com o que comparar.
  // Mês sem saldo conta como 0: sumir de um mês que tinha movimento é variação (justificar).
  function desviante(conta, mes) {
    const idx = comps.findIndex(c => c.mes === mes)
    if (idx <= 0) return false // primeiro mês (ou fora da lista) — sem mês anterior
    const linha = matriz[conta] || {}
    const a = linha[amKey(ANO, mes)] == null ? 0 : Number(linha[amKey(ANO, mes)]) || 0
    const p = linha[amKey(ANO, comps[idx - 1].mes)] == null ? 0 : Number(linha[amKey(ANO, comps[idx - 1].mes)]) || 0
    if (a === 0 && p === 0) return false // sem movimento nos dois meses
    if (p === 0) return a !== 0          // apareceu do zero
    return Math.abs(a - p) / Math.abs(p) > 0.1
  }

  // Dados da variação de uma conta num mês (atual × mês anterior) — alimenta a sugestão
  // automática de justificativa no modal.
  function infoVariacao(classifRaw, mes) {
    const idx = comps.findIndex(c => c.mes === mes)
    const linha = matriz[classifRaw] || {}
    const atual = Number(linha[amKey(ANO, mes)] || 0) || 0
    const mesAntObj = idx > 0 ? comps[idx - 1] : null
    const anterior = mesAntObj ? (Number(linha[amKey(ANO, mesAntObj.mes)] || 0) || 0) : null
    return { atual, anterior, mesAtual: mes, mesAnterior: mesAntObj ? mesAntObj.mes : null }
  }

  // Conta por CONTA (não por célula/mês): uma conta com qualquer mês desviante ainda
  // não justificado conta 1 — mesmo conceito do Status e do badge do menu.
  // Só nas analíticas — as sintéticas são totais (não se justificam diretamente).
  let pendentes = 0
  for (const { reduzido, classifRaw, sintetica } of contas) {
    if (sintetica) continue
    if (comps.some(c => desviante(classifRaw, c.mes) && !justificadas.has(chaveCelula(reduzido, c.mes)))) pendentes++
  }

  // Níveis de sintéticas disponíveis (grau), para o filtro por nível do comparativo.
  const niveisSint = [...new Set(contas.filter(c => c.sintetica).map(c => c.grau))].sort((a, b) => a - b)

  // Marca uma célula como justificada/corrigida localmente (atualiza o contador na hora).
  function marcarJustificada(conta, mes, texto) {
    setJustificadas(prev => {
      const next = new Set(prev)
      next.add(chaveCelula(conta, mes))
      return next
    })
    if (texto) setJustTextos(prev => ({ ...prev, [chaveCelula(conta, mes)]: texto }))
  }

  // Desfaz o ajuste: devolve a célula à contagem de pendências (atualiza na hora).
  function marcarNaoJustificada(conta, mes) {
    setJustificadas(prev => {
      const next = new Set(prev)
      next.delete(chaveCelula(conta, mes))
      return next
    })
  }

  // Anos e meses disponíveis (para os filtros).
  const anosDisp = [...new Set(anosMeses.map(a => a.ano))].sort((a, b) => a - b)
  const mesesDisp = [...new Set(anosMeses.map(a => a.mes))].sort((a, b) => a - b)
  const compId2026 = Object.fromEntries(comps.map(c => [c.mes, c.id]))

  // Colunas do comparativo conforme o agrupamento (mês/trimestre/semestre/ano) e o filtro
  // de meses. Cada coluna soma os meses que a compõem; só a coluna de UM mês do ano de
  // fechamento é "justificável" (mantém o fluxo de clicar/justificar).
  const colunas = (() => {
    let base = mesesSel.size ? anosMeses.filter(a => mesesSel.has(a.mes)) : anosMeses
    base = [...base].sort((a, b) => a.ano - b.ano || a.mes - b.mes)
    if (agrupar === 'mes') {
      return base.map(a => ({
        key: amKey(a.ano, a.mes), label: `${MESES[a.mes - 1]}/${String(a.ano).slice(2)}`,
        meses: [a], mesJust: a.ano === ANO ? a.mes : null, compId: a.ano === ANO ? compId2026[a.mes] : null,
      }))
    }
    const per = agrupar === 'trimestre' ? 3 : agrupar === 'semestre' ? 6 : 12
    const bk = new Map()
    for (const a of base) {
      const idx = per === 12 ? 1 : Math.floor((a.mes - 1) / per) + 1
      const k = `${a.ano}-${idx}`
      if (!bk.has(k)) bk.set(k, { ano: a.ano, idx, meses: [] })
      bk.get(k).meses.push(a)
    }
    return [...bk.values()].sort((x, y) => x.ano - y.ano || x.idx - y.idx).map(b => ({
      key: `${b.ano}-${b.idx}`,
      label: agrupar === 'ano' ? `${b.ano}` : `${agrupar === 'trimestre' ? 'T' : 'S'}${b.idx}/${String(b.ano).slice(2)}`,
      meses: b.meses, mesJust: null, compId: null,
    }))
  })()

  const mostraTotal = colunas.length > 1
  // Valor de uma conta numa coluna = soma dos meses da coluna (null se nenhum tem dado).
  const valorCol = (key, col) => {
    const linha = matriz[key] || {}; let has = false, s = 0
    for (const a of col.meses) { const v = linha[amKey(a.ano, a.mes)]; if (v != null) { has = true; s += Number(v) || 0 } }
    return has ? s : null
  }
  const totalConta = key => colunas.reduce((s, col) => s + (valorCol(key, col) || 0), 0)
  // Lucro (ou prejuízo) do período = −(soma dos saldos das contas de resultado analíticas).
  const lucroCol = col => -contas.filter(c => !c.sintetica).reduce((s, c) => s + (valorCol(c.classifRaw, col) || 0), 0)
  const lucroTotal = colunas.reduce((s, col) => s + lucroCol(col), 0)

  if (!empresaId) {
    return (
      <Wrapper>
        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '28px 24px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 560 }}>
          <i className="ti ti-building" style={{ fontSize: 24, color: theme.accent }} />
          <p style={{ fontSize: 14, color: theme.text }}>Selecione uma empresa no menu lateral.</p>
        </div>
      </Wrapper>
    )
  }

  const semDados = !carregando && anosMeses.length === 0

  return (
    <Wrapper>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 12 }}>
        <b style={{ color: theme.text }}>{empresaNome}</b> · {anosDisp.length ? (anosDisp.length === 1 ? `ano ${anosDisp[0]}` : `anos ${anosDisp[0]}–${anosDisp[anosDisp.length - 1]}`) : `ano ${ANO}`}
      </p>

      {/* Carga dos meses anteriores (ex.: jan–abr) — dá histórico para a régua dos 10% */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 18, background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 10, padding: '10px 14px' }}>
        <i className="ti ti-calendar-plus" style={{ color: theme.accent, fontSize: 18 }} />
        <span style={{ fontSize: 12.5, color: theme.sub, flex: 1, minWidth: 200 }}>Comecei depois do início do ano? Importe o razão dos <b style={{ color: theme.text }}>meses anteriores</b> (um arquivo com os meses) para ter a comparação de oscilação.</span>
        <label className="btn btn-ghost" style={{ fontSize: 12.5, cursor: impBusy ? 'wait' : 'pointer' }}>
          <i className="ti ti-file-import" /> {impBusy ? 'Importando…' : 'Importar meses anteriores'}
          <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} disabled={impBusy} onChange={e => importarMeses(e.target.files?.[0])} />
        </label>
      </div>
      {impMsg && <p style={{ fontSize: 12.5, margin: '-8px 0 16px', color: impMsg.startsWith('Erro') ? theme.red : theme.green }}><i className={`ti ${impMsg.startsWith('Erro') ? 'ti-alert-triangle' : 'ti-circle-check'}`} /> {impMsg}</p>}

      {carregando && (
        <p style={{ color: theme.sub, fontSize: 13 }}><i className="ti ti-loader" /> Carregando balancetes…</p>
      )}

      {semDados && (
        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '28px 24px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 620 }}>
          <i className="ti ti-table-off" style={{ fontSize: 24, color: theme.accent }} />
          <p style={{ fontSize: 14, color: theme.text }}>Nenhum balancete importado ainda. Importe o razão em ao menos uma competência.</p>
        </div>
      )}

      {!carregando && anosMeses.length > 0 && (
        <>
          <div style={{ marginBottom: 14 }}>
            {pendentes > 0 ? (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                background: 'rgba(229,72,77,0.12)', color: theme.red,
                border: `0.5px solid ${theme.red}`, borderRadius: 999,
                padding: '6px 13px', fontSize: 12.5, fontWeight: 600,
              }}>
                <i className="ti ti-alert-triangle" />
                {pendentes} conta(s) com variação a justificar
              </span>
            ) : (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                background: 'rgba(48,164,108,0.12)', color: theme.green,
                border: `0.5px solid ${theme.green}`, borderRadius: 999,
                padding: '6px 13px', fontSize: 12.5, fontWeight: 600,
              }}>
                <i className="ti ti-circle-check" />
                Tudo dentro da faixa ou justificado
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
            <p style={{ color: theme.sub, fontSize: 12.5, margin: 0, flex: 1, minWidth: 240 }}>
              Contas de resultado. Valores em <b style={{ color: theme.red }}>vermelho</b> desviam mais de 10% do <b>mês anterior</b> (fev × jan, mar × fev…) — o primeiro mês não é comparado. Mês sem saldo aparece como <b>—</b>; fica vermelho quando o mês anterior tinha movimento. Clique num valor para ver o razão e o provável culpado.
            </p>
            <label style={{ fontSize: 12, color: theme.sub, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <i className="ti ti-calendar-stats" /> Agrupar:
              <select className="input" style={{ width: 'auto', fontSize: 12, padding: '6px 10px' }} value={agrupar} onChange={e => setAgrupar(e.target.value)}>
                <option value="mes">Mês</option>
                <option value="trimestre">Trimestre</option>
                <option value="semestre">Semestre</option>
                <option value="ano">Ano</option>
              </select>
            </label>
            <label style={{ fontSize: 12, color: theme.sub, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <i className="ti ti-stack-2" /> Nível:
              <select className="input" style={{ width: 'auto', fontSize: 12, padding: '6px 10px' }}
                value={String(nivel)} onChange={e => setNivel(e.target.value === 'tudo' ? 'tudo' : Number(e.target.value))}>
                {niveisSint.map(n => <option key={n} value={n}>Até o nível {n}</option>)}
                <option value="tudo">Tudo (todas as contas)</option>
              </select>
            </label>
            <div style={{ fontSize: 12, color: theme.sub, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <i className="ti ti-filter" /> Meses:
              <MultiMesSelect meses={mesesDisp} sel={mesesSel} onChange={setMesesSel} />
            </div>
          </div>
          <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto', maxWidth: '100%' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr style={{ background: theme.input }}>
                  <th style={{ ...th, minWidth: 70 }}>Conta</th>
                  <th style={{ ...th, minWidth: 110 }}>Classificação</th>
                  <th style={{ ...th, minWidth: 220 }}>Nome da Conta</th>
                  {colunas.map(col => (
                    <th key={col.key} style={{ ...th, textAlign: 'right' }}>{col.label}</th>
                  ))}
                  {mostraTotal && <th style={{ ...th, textAlign: 'right', color: theme.text }}>Total</th>}
                </tr>
              </thead>
              <tbody>
                {contas.filter(c => nivel === 'tudo' ? true : (c.sintetica && c.grau <= nivel)).map(({ reduzido, classif, classifRaw, nome, sintetica, grau }) => {
                  const tot = totalConta(classifRaw)
                  // Destaque por nível: sintética de 1º nível mais forte; níveis mais fundos, mais leves.
                  const bgNivel = !sintetica ? 'transparent' : grau <= 1 ? theme.input : grau === 2 ? 'rgba(74,124,255,0.07)' : 'rgba(74,124,255,0.035)'
                  const pesoNivel = sintetica ? (grau <= 1 ? 800 : grau === 2 ? 700 : 600) : 400
                  const recuo = 14 + Math.max(0, (grau || 1) - 1) * 16
                  return (
                    <tr key={classifRaw} style={{ borderTop: `1px solid ${theme.border}`, background: bgNivel, fontWeight: pesoNivel }}>
                      <td style={{ ...td, color: theme.sub, fontSize: 11 }}>{reduzido || ''}</td>
                      <td style={{ ...td, color: theme.sub, fontSize: 11 }}>{classif}</td>
                      <td style={{ ...td, fontWeight: pesoNivel, maxWidth: 320, paddingLeft: recuo }}>
                        {sintetica && <span style={{ fontSize: 9.5, fontWeight: 700, color: theme.accent, background: 'rgba(74,124,255,0.14)', borderRadius: 4, padding: '1px 5px', marginRight: 6 }}>N{grau}</span>}
                        {nome || '—'}
                      </td>
                      {colunas.map(col => {
                        const v = valorCol(classifRaw, col)
                        const vazio = v == null || Number(v) === 0
                        // Sintética: total do grupo — "—" quando não há saldo, sem clique.
                        if (sintetica) {
                          return <td key={col.key} style={{ ...td, textAlign: 'right', fontWeight: 700, color: vazio ? theme.sub : undefined }}>{vazio ? '—' : moneyDC(v)}</td>
                        }
                        // Coluna agrupada ou de outro ano: só comparação (sem desvio/clique de justificar).
                        if (col.mesJust == null) {
                          return <td key={col.key} style={{ ...td, textAlign: 'right', color: vazio ? theme.sub : theme.text }}>{vazio ? '—' : moneyDC(v)}</td>
                        }
                        const mes = col.mesJust
                        const red = desviante(classifRaw, mes)
                        const ok = red && justificadas.has(chaveCelula(reduzido, mes))
                        // Sem saldo e sem variação: traço apagado, sem clique.
                        if (vazio && !red) {
                          return <td key={col.key} style={{ ...td, textAlign: 'right', color: theme.sub }}>—</td>
                        }
                        return (
                          <td key={col.key} style={{ ...td, textAlign: 'right' }}>
                            <button
                              onClick={() => setDetalhe({ conta: reduzido, classif, nome, mes, compId: col.compId, varInfo: infoVariacao(classifRaw, mes) })}
                              style={{
                                display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end',
                                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                                fontSize: 12.5, fontFamily: 'inherit',
                                color: (red && !ok) ? theme.red : theme.text,
                                fontWeight: (red && !ok) ? 700 : 400,
                              }}
                              title={ok
                                ? `Variação justificada${justTextos[chaveCelula(reduzido, mes)] ? ' — ' + justTextos[chaveCelula(reduzido, mes)] : ''} · clique para ver o razão`
                                : (vazio ? 'Mês sem movimento nesta conta — variação a justificar' : 'Ver razão da conta neste mês')}
                            >
                              {ok && <i className="ti ti-circle-check" style={{ color: theme.green, fontSize: 13 }} />}
                              {vazio ? '—' : moneyDC(v)}
                            </button>
                          </td>
                        )
                      })}
                      {mostraTotal && (
                        (sintetica || tot === 0)
                          ? <td style={{ ...td, textAlign: 'right', fontWeight: sintetica ? 700 : 600, color: tot === 0 ? theme.sub : undefined }}>{tot === 0 ? '—' : moneyDC(tot)}</td>
                          : <td style={{ ...td, textAlign: 'right' }}>
                              <button
                                onClick={() => setDetalhe({ conta: reduzido, classif, nome, todos: true, compIds: comps.map(x => x.id), mesPorComp: Object.fromEntries(comps.map(x => [x.id, x.mes])) })}
                                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12.5, fontFamily: 'inherit', fontWeight: 600, color: theme.text, textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 }}
                                title="Ver todos os lançamentos da conta (todos os meses)"
                              >{moneyDC(tot)}</button>
                            </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: `2px solid ${theme.border}`, background: theme.input }}>
                  <td style={{ ...td, fontWeight: 700 }} colSpan={3}>Lucro / Prejuízo do período</td>
                  {colunas.map(col => { const L = lucroCol(col); return (
                    <td key={col.key} style={{ ...td, textAlign: 'right', fontWeight: 700, color: L >= 0 ? theme.green : theme.red }}>{money(L)}</td>
                  ) })}
                  {mostraTotal && <td style={{ ...td, textAlign: 'right', fontWeight: 800, color: lucroTotal >= 0 ? theme.green : theme.red }}>{money(lucroTotal)}</td>}
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}

      {detalhe && (
        <ModalRazao
          detalhe={detalhe}
          empresaId={empresaId}
          compsAnteriores={comps.filter(c => c.mes < detalhe.mes).map(c => c.id)}
          compIdAnterior={comps.find(c => c.mes === detalhe.varInfo?.mesAnterior)?.id || null}
          usuario={user?.email}
          getCompetenciaId={getCompetenciaId}
          jaJustificada={justificadas.has(chaveCelula(detalhe.conta, detalhe.mes))}
          justTextoAtual={justTextos[chaveCelula(detalhe.conta, detalhe.mes)] || ''}
          onJustificada={(texto) => marcarJustificada(detalhe.conta, detalhe.mes, texto)}
          onDesfeita={() => marcarNaoJustificada(detalhe.conta, detalhe.mes)}
          onCorrigido={() => setRefresh(x => x + 1)}
          plano={plano}
          onClose={() => setDetalhe(null)}
        />
      )}
    </Wrapper>
  )
}

function ModalRazao({ detalhe, empresaId, compsAnteriores, compIdAnterior, usuario, jaJustificada, justTextoAtual, onJustificada, onDesfeita, onCorrigido, plano, onClose }) {
  const { conta, nome, mes, compId, todos, compIds, mesPorComp } = detalhe
  const [carregando, setCarregando] = useState(true)
  const [linhas, setLinhas] = useState([])
  const [movers, setMovers] = useState([]) // entidades que mais explicam a variação (mês × mês anterior)
  const [correcoes, setCorrecoes] = useState({}) // razao_id → lançamento de correção
  const [dedut, setDedut] = useState({})         // razao_id → 'Dedutível' | 'Indedutível'
  const [registro, setRegistro] = useState(null) // 'Justificativa'
  const [salvando, setSalvando] = useState(false)
  const [tratada, setTratada] = useState(jaJustificada)
  const [msg, setMsg] = useState('')
  const [acaoLanc, setAcaoLanc] = useState(null) // { modo:'novo'|'ver', linha, corr }

  const mesDoLanc = l => todos ? (mesPorComp?.[l.competencia_id]) : mes

  async function carregarLinhas() {
    setCarregando(true)
    const ids = todos ? compIds : [compId]
    const { data } = await supabase
      .from('razao').select('id, competencia_id, data, conta, contrapartida, historico, debito, credito')
      .in('competencia_id', ids).eq('conta', conta)
      .order('data', { ascending: true })
    const rows = data || []
    // Correções já geradas para estes lançamentos (para marcar/desfazer).
    const razaoIds = rows.map(r => r.id)
    let corrMap = {}
    if (razaoIds.length) {
      const { data: corr } = await supabase.from('lancamentos')
        .select('id, competencia_id, conta_debito, conta_credito, valor, historico, razao_id')
        .in('razao_id', razaoIds).eq('origem', 'correcao')
      for (const c of (corr || [])) corrMap[c.razao_id] = c
    }
    // Classificação dedutível/indedutível já marcada (LALUR) para estes lançamentos.
    let dedutMap = {}
    if (razaoIds.length) {
      const { data: dd } = await supabase.from('auditoria').select('razao_id, dedutibilidade')
        .in('razao_id', razaoIds).eq('modulo', 'Comparativo').not('dedutibilidade', 'is', null)
      for (const d of (dd || [])) if (d.dedutibilidade) dedutMap[d.razao_id] = d.dedutibilidade
    }
    let anteriores = []
    if (!todos && compsAnteriores && compsAnteriores.length) {
      const { data: ant } = await supabase.from('razao').select('historico')
        .in('competencia_id', compsAnteriores).eq('conta', conta)
      anteriores = (ant || []).map(r => r.historico)
    }
    // Comparação por entidade (cliente/fornecedor) com o mês anterior: agrupa os
    // lançamentos por entidade nos dois meses e aponta quem mais explica a variação.
    let mv = []
    if (!todos && compIdAnterior) {
      const { data: ant } = await supabase.from('razao').select('historico, debito, credito')
        .eq('competencia_id', compIdAnterior).eq('conta', conta)
      mv = analisarMovers(rows, ant || [])
      // Se alguma entidade caiu, procura ela em outras contas no mês (reclassificação).
      if (mv.some(m => Math.abs(m.movAtual) < Math.abs(m.movAnterior))) {
        const { data: mesTodo } = await supabase.from('razao').select('conta, historico, debito, credito')
          .eq('competencia_id', compId)
        mv = anotarReclass(mv, mesTodo || [], conta, plano)
      }
    }
    // Razão VIVO: além do razão importado, traz os LANÇAMENTOS confirmados que tocam esta
    // conta (correções/estornos da Conciliação, apropriações, contabilizações) como linhas
    // próprias — o estorno aparece no lado que zera a duplicidade e o Total fecha no valor
    // certo. É o que faz este drill-down bater com a célula do comparativo (razão vivo).
    const { data: lancs } = await supabase.from('lancamentos')
      .select('id, competencia_id, data, conta_debito, conta_credito, valor, historico, origem')
      .in('competencia_id', ids)
      .or(`conta_debito.eq.${conta},conta_credito.eq.${conta}`)
    const lancRows = (lancs || []).map(l => {
      const ehDeb = String(l.conta_debito || '').trim() === String(conta)
      const v = Number(l.valor) || 0
      return {
        id: `lanc-${l.id}`, competencia_id: l.competencia_id, data: l.data || '',
        conta, contrapartida: ehDeb ? (l.conta_credito || '') : (l.conta_debito || ''),
        historico: l.historico || 'Lançamento de ajuste',
        debito: ehDeb ? v : 0, credito: ehDeb ? 0 : v,
        suspeito: false, ehLancamento: true, origem: l.origem || 'lancamento',
      }
    })
    setCorrecoes(corrMap)
    setDedut(dedutMap)
    setMovers(mv)
    setLinhas([...analisarCulpados(rows, anteriores), ...lancRows])
    setCarregando(false)
  }

  // Marca (ou limpa) a dedutibilidade de um lançamento — grava em auditoria; o indedutível
  // alimenta o LALUR (adições) e o relatório de despesas indedutíveis.
  async function marcarDedut(linha, valor) {
    if (!linha?.id || linha.ehLancamento) return
    // Remove marca anterior deste lançamento (tem razao_id + dedutibilidade). Não toca em
    // correções (dedutibilidade null) nem em justificativas de conta (sem razao_id).
    await supabase.from('auditoria').delete().eq('razao_id', linha.id).eq('modulo', 'Comparativo').not('dedutibilidade', 'is', null)
    if (valor) {
      await supabase.from('auditoria').insert({
        competencia_id: linha.competencia_id, modulo: 'Comparativo', tipo: 'Justificativa',
        item: `${conta} · dedutibilidade`, detalhe: linha.historico || '', dedutibilidade: valor, razao_id: linha.id, usuario,
      })
    }
    setDedut(m => { const n = { ...m }; if (valor) n[linha.id] = valor; else delete n[linha.id]; return n })
  }

  useEffect(() => {
    let vivo = true
    ;(async () => { if (vivo) await carregarLinhas() })()
    return () => { vivo = false }
  }, [compId, conta, todos]) // eslint-disable-line react-hooks/exhaustive-deps

  async function registrar(tipo, detalheTxt) {
    setSalvando(true)
    try {
      // Remove uma justificativa anterior do mesmo item (evita duplicar e permite EDITAR).
      await supabase.from('auditoria').delete()
        .eq('competencia_id', compId).eq('modulo', 'Comparativo')
        .eq('item', `${conta} · ${MESES[mes - 1]}/${ANO}`).eq('tipo', tipo)
      // Grava na competência DA CÉLULA (compId) — o mês do registro casa com o item.
      const { error } = await supabase.from('auditoria').insert({
        competencia_id: compId, modulo: 'Comparativo',
        item: `${conta} · ${MESES[mes - 1]}/${ANO}`, tipo, detalhe: detalheTxt, usuario,
      })
      if (error) throw error
      setMsg(`${tipo} ${tratada ? 'atualizada' : 'registrada'} na auditoria.`)
      setRegistro(null); setTratada(true); onJustificada(detalheTxt)
    } catch (e) { setMsg('Erro ao registrar: ' + (e.message || e)) } finally { setSalvando(false) }
  }

  async function desfazer() {
    if (!window.confirm(`Desfazer o ajuste da conta ${conta} em ${MESES[mes - 1]}/${ANO}? A variação volta a contar como pendência.`)) return
    setSalvando(true)
    try {
      const { error } = await supabase.from('auditoria').delete()
        .eq('modulo', 'Comparativo').eq('item', `${conta} · ${MESES[mes - 1]}/${ANO}`)
      if (error) throw error
      setMsg('Ajuste desfeito — variação voltou a pendente.'); setTratada(false); onDesfeita()
    } catch (e) { setMsg('Erro ao desfazer: ' + (e.message || e)) } finally { setSalvando(false) }
  }

  // Gera o lançamento de CORREÇÃO (partida dobrada) que reclassifica o valor da conta
  // errada para a conta certa — é o lançamento que vai ser importado no Domínio.
  async function gerarCorrecao(l, { contaCerta, valor, historico }) {
    setSalvando(true)
    try {
      const eSint = erroContaSintetica(plano, contaCerta, conta)
      if (eSint) { setMsg(eSint); setSalvando(false); return }
      const v = Number(valor) || 0
      if (v <= 0) { setMsg('Erro: informe um valor maior que zero.'); setSalvando(false); return }
      const foiDebito = Number(l.debito) > 0
      // Débito na conta errada → credita a errada e debita a certa (e vice-versa).
      const conta_debito = foiDebito ? contaCerta : conta
      const conta_credito = foiDebito ? conta : contaCerta
      const cid = l.competencia_id
      const mesL = mesDoLanc(l)
      const { error } = await supabase.from('lancamentos').insert({
        competencia_id: cid, data: l.data || null,
        conta_debito, conta_credito, valor: v,
        historico: historico || `Reclassificação ref. ${l.historico || ''}`.trim(),
        origem: 'correcao', razao_id: l.id, usuario,
      })
      if (error) throw error
      // A correção vive SÓ no lançamento (origem 'correcao'). Todos os relatórios (este
      // comparativo, conciliação, cockpit) leem o razão VIVO e já sobrepõem o lançamento —
      // não se mexe no balancete importado, para não contar o ajuste em dobro.
      // Trilha de auditoria.
      await supabase.from('auditoria').insert({
        competencia_id: cid, modulo: 'Comparativo',
        item: `${conta} · ${MESES[(mesL || 1) - 1]}/${ANO}`, tipo: 'Correção',
        detalhe: `Reclassificação ${conta} → ${contaCerta} · ${money(v)}${historico ? ' · ' + historico : ''}`,
        razao_id: l.id, usuario,
      })
      // Aprendizado: contra banco → memória da integração; senão → memória de correção
      // contábil (que vira sugestão quando a mesma conta errada reaparecer no razão).
      const aprendido = await aprenderDaCorrecao({ clienteId: empresaId, historico: l.historico, contrapartida: l.contrapartida, contaErrada: conta, contaCerta, usuario })
      setMsg('Correção gerada — lançamento no painel Contabilizar e refletido no comparativo.' + (aprendido ? ` · Aprendido: ${aprendido}` : ''))
      setAcaoLanc(null)
      await carregarLinhas()
      onCorrigido && onCorrigido()
    } catch (e) { setMsg('Erro ao gerar correção: ' + (e.message || e)) } finally { setSalvando(false) }
  }


  // Desfaz a correção: remove o lançamento e apaga a auditoria. O comparativo lê o razão
  // vivo, então basta sumir com o lançamento — os saldos voltam sozinhos.
  async function desfazerCorrecao(l, corr) {
    if (!window.confirm('Desfazer esta correção? O lançamento de correção será removido e os saldos revertidos.')) return
    setSalvando(true)
    try {
      await supabase.from('lancamentos').delete().eq('id', corr.id)
      await supabase.from('auditoria').delete()
        .eq('modulo', 'Comparativo').eq('tipo', 'Correção').eq('razao_id', l.id)
      setMsg('Correção desfeita — saldos revertidos.')
      setAcaoLanc(null)
      await carregarLinhas()
      onCorrigido && onCorrigido()
    } catch (e) { setMsg('Erro ao desfazer correção: ' + (e.message || e)) } finally { setSalvando(false) }
  }

  let saldo = 0
  const totDeb = linhas.reduce((s, l) => s + (Number(l.debito) || 0), 0)
  const totCred = linhas.reduce((s, l) => s + (Number(l.credito) || 0), 0)
  const suspeitos = linhas.filter(l => l.suspeito)

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, zIndex: 50 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, width: 'min(940px, 96vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '18px 22px', borderBottom: `0.5px solid ${theme.cb}` }}>
          <div>
            <h3 style={{ fontSize: 15, marginBottom: 4 }}>Razão — conta {conta}</h3>
            <p style={{ color: theme.sub, fontSize: 12.5 }}>
              {nome ? `${nome} · ` : ''}{todos ? 'Todos os meses' : `${MESES[mes - 1]}/${ANO}`}
            </p>
          </div>
          <button className="btn-ghost" onClick={onClose} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <i className="ti ti-x" /> Fechar
          </button>
        </div>

        <div style={{ margin: '14px 22px 0', background: 'rgba(74,124,255,0.08)', border: `1px solid ${theme.accent}`, borderRadius: 10, padding: '10px 14px' }}>
          <p style={{ color: theme.text, fontSize: 12.5, margin: 0 }}>
            <i className="ti ti-click" style={{ color: theme.accent }} /> Clique num lançamento para <b>corrigir</b> — o sistema gera um lançamento de reclassificação (para importar no Domínio) e atualiza os saldos.
          </p>
        </div>

        {!carregando && suspeitos.length > 0 && (
          <div style={{ margin: '10px 22px 0', background: 'rgba(245,166,35,0.10)', border: '1px solid rgba(245,166,35,0.4)', borderRadius: 10, padding: '12px 14px' }}>
            <p style={{ color: theme.yellow, fontSize: 13, fontWeight: 600, margin: 0 }}>
              <i className="ti ti-alert-triangle" /> {suspeitos.length} lançamento(s) provável(is) culpado(s) desta variação
            </p>
            <p style={{ color: theme.sub, fontSize: 12, margin: '4px 0 0' }}>Destacados abaixo. Clique no lançamento para reclassificar, ou “Justificar” se a variação é esperada.</p>
          </div>
        )}

        <div style={{ overflow: 'auto', padding: '10px 0 4px' }}>
          {carregando ? (
            <p style={{ color: theme.sub, fontSize: 13, padding: '18px 22px' }}><i className="ti ti-loader" /> Carregando…</p>
          ) : linhas.length === 0 ? (
            <p style={{ color: theme.sub, fontSize: 13, padding: '18px 22px' }}>Nenhum lançamento de razão para esta conta.</p>
          ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr style={{ background: theme.input }}>
                  {todos && <th style={th}>Mês</th>}
                  <th style={th}>Data</th>
                  <th style={th}>Histórico</th>
                  <th style={{ ...th, textAlign: 'right' }}>Débito</th>
                  <th style={{ ...th, textAlign: 'right' }}>Crédito</th>
                  <th style={{ ...th, textAlign: 'right' }}>Saldo</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((l, i) => {
                  saldo += (Number(l.debito) || 0) - (Number(l.credito) || 0)
                  const corr = correcoes[l.id]
                  const ehLanc = l.ehLancamento
                  return (
                    <tr key={l.id || i}
                      onClick={ehLanc ? undefined : () => { setMsg(''); setAcaoLanc(corr ? { modo: 'ver', linha: l, corr } : { modo: 'novo', linha: l }) }}
                      style={{ borderTop: `1px solid ${theme.border}`, cursor: ehLanc ? 'default' : 'pointer', background: ehLanc ? 'rgba(74,124,255,0.08)' : corr ? 'rgba(48,164,108,0.08)' : l.suspeito ? 'rgba(245,166,35,0.07)' : undefined }}
                      title={ehLanc ? 'Lançamento de ajuste (correção/estorno) — reflete no razão vivo' : corr ? 'Corrigido — clique para ver/desfazer' : 'Clique para corrigir (reclassificar)'}
                    >
                      {todos && <td style={{ ...td, whiteSpace: 'nowrap', color: theme.sub }}>{MESES[(mesDoLanc(l) || 1) - 1]}</td>}
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{l.data || ''}</td>
                      <td style={{ ...td, maxWidth: 360, whiteSpace: 'normal' }}>
                        {ehLanc && <span style={{ fontSize: 9.5, fontWeight: 700, color: theme.accent, background: 'rgba(74,124,255,0.14)', borderRadius: 4, padding: '1px 5px', marginRight: 6 }}>AJUSTE</span>}
                        {corr && <i className="ti ti-circle-check" style={{ color: theme.green, marginRight: 6 }} title="Corrigido" />}
                        {l.suspeito && !corr && <i className="ti ti-alert-triangle" style={{ color: theme.yellow, marginRight: 6 }} title="Provável culpado" />}
                        {l.historico || ''}
                        {corr && <div style={{ color: theme.green, fontSize: 11, marginTop: 2 }}>corrigido — {corr.conta_debito} (D) / {corr.conta_credito} (C) · {money(corr.valor)}</div>}
                        {l.suspeito && !corr && <div style={{ color: theme.yellow, fontSize: 11, marginTop: 2 }}>provável culpado — {l.motivo}</div>}
                      </td>
                      <td style={{ ...td, textAlign: 'right' }}>{Number(l.debito) ? money(l.debito) : ''}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{Number(l.credito) ? money(l.credito) : ''}</td>
                      <td style={{ ...td, textAlign: 'right', color: saldo < 0 ? theme.red : theme.text }}>{money(saldo)}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: `1px solid ${theme.border}`, background: theme.input }}>
                  <td style={{ ...td, fontWeight: 700 }} colSpan={todos ? 3 : 2}>Total</td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{money(totDeb)}</td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{money(totCred)}</td>
                  <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{money(totDeb - totCred)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>

        <div style={{ borderTop: `0.5px solid ${theme.cb}`, padding: '14px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, minHeight: 16, color: msg ? (msg.startsWith('Erro') ? theme.red : theme.green) : theme.sub }}>
            {msg
              ? <><i className={`ti ${msg.startsWith('Erro') ? 'ti-alert-triangle' : 'ti-circle-check'}`} /> {msg}</>
              : todos
                ? 'Todos os lançamentos da conta no ano. Clique num lançamento para corrigir.'
                : tratada
                  ? <><i className="ti ti-circle-check" style={{ color: theme.green }} /> Variação já tratada na auditoria.</>
                  : 'Justifique a variação, ou clique num lançamento para corrigir.'}
          </span>
          {!todos && (
            <div style={{ display: 'flex', gap: 8 }}>
              {tratada && (
                <button className="btn btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: theme.red }} disabled={salvando} onClick={desfazer}>
                  <i className="ti ti-arrow-back-up" /> {salvando ? 'Desfazendo…' : 'Desfazer ajuste'}
                </button>
              )}
              <button className="btn btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => { setMsg(''); setRegistro('Justificativa') }}>
                <i className={`ti ${tratada ? 'ti-pencil' : 'ti-flag'}`} /> {tratada ? 'Editar justificativa' : 'Justificar'}
              </button>
            </div>
          )}
        </div>
      </div>

      {registro && (
        <ModalRegistro
          tipo={registro} salvando={salvando} conta={conta} mes={mes}
          textoAtual={registro === 'Justificativa' && tratada ? justTextoAtual : ''}
          sugestao={registro === 'Justificativa' ? montarSugestaoJust({ varInfo: detalhe.varInfo, nome, conta, suspeitos, movers, linhas }) : ''}
          onClose={() => setRegistro(null)} onConfirmar={txt => registrar(registro, txt)}
        />
      )}

      {acaoLanc && (
        <ModalCorrecao
          acao={acaoLanc} conta={conta} salvando={salvando}
          dedutAtual={dedut[acaoLanc.linha.id] || ''}
          onDedut={v => marcarDedut(acaoLanc.linha, v)}
          onClose={() => setAcaoLanc(null)}
          onGerar={dados => gerarCorrecao(acaoLanc.linha, dados)}
          onDesfazer={() => desfazerCorrecao(acaoLanc.linha, acaoLanc.corr)}
        />
      )}
    </div>
  )
}

// Correção de um lançamento: gera um NOVO lançamento (partida dobrada) reclassificando
// o valor da conta errada para a conta certa — o que será importado no Domínio.
function ModalCorrecao({ acao, conta, salvando, dedutAtual, onDedut, onClose, onGerar, onDesfazer }) {
  const { modo, linha, corr } = acao
  const foiDebito = Number(linha.debito) > 0
  const valorBase = foiDebito ? Number(linha.debito) : Number(linha.credito)
  const [contaCerta, setContaCerta] = useState('')
  const [valor, setValor] = useState(valorBase ? valorBase.toFixed(2).replace('.', ',') : '')
  const [historico, setHistorico] = useState(`Reclassificação ref. ${linha.historico || ''}`.trim())
  const v = numBR(valor)
  const contaDeb = foiDebito ? (contaCerta || '—') : conta
  const contaCred = foiDebito ? conta : (contaCerta || '—')

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(520px,96vw)', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
        <h2 style={{ fontSize: 17, marginBottom: 4 }}>{modo === 'ver' ? 'Correção do lançamento' : 'Corrigir lançamento'}</h2>
        <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 14 }}>
          {linha.data || ''} · {linha.historico || ''} · {foiDebito ? 'Débito' : 'Crédito'} {money(valorBase)} na conta <b style={{ color: theme.text }}>{conta}</b>.
        </p>

        {/* Dedutibilidade (LALUR): indedutível vira adição no LALUR e no relatório. */}
        {onDedut && (
          <div style={{ background: theme.input, border: `0.5px solid ${theme.cb}`, borderRadius: 10, padding: '10px 14px', marginBottom: 14 }}>
            <label style={{ fontSize: 12, color: theme.sub, display: 'block', marginBottom: 6 }}>Despesa — para o LALUR</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {['Dedutível', 'Indedutível'].map(op => (
                <button key={op} type="button" className={dedutAtual === op ? 'btn' : 'btn btn-ghost'} disabled={salvando}
                  style={{ fontSize: 12.5, padding: '6px 12px', ...(op === 'Indedutível' && dedutAtual === op ? { background: theme.yellow, borderColor: theme.yellow } : {}) }}
                  onClick={() => onDedut(op)}>{op}</button>
              ))}
              {dedutAtual && <button type="button" className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 10px', color: theme.sub }} disabled={salvando} onClick={() => onDedut('')}>limpar</button>}
            </div>
            <p style={{ color: theme.sub, fontSize: 11.5, margin: '8px 0 0' }}><b style={{ color: theme.yellow }}>Indedutível</b> entra como <b>adição</b> no LALUR e no relatório de despesas indedutíveis.</p>
          </div>
        )}

        {modo === 'ver' ? (
          <>
            <div style={{ background: theme.input, border: `0.5px solid ${theme.cb}`, borderRadius: 10, padding: '12px 14px', fontSize: 13 }}>
              <p style={{ margin: 0, color: theme.text }}>Lançamento de correção gerado:</p>
              <p style={{ margin: '6px 0 0', color: theme.sub }}>Débito <b style={{ color: theme.text }}>{corr.conta_debito}</b> · Crédito <b style={{ color: theme.text }}>{corr.conta_credito}</b> · <b style={{ color: theme.text }}>{money(corr.valor)}</b></p>
              {corr.historico && <p style={{ margin: '6px 0 0', color: theme.sub }}>{corr.historico}</p>}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button className="btn btn-ghost" onClick={onClose} disabled={salvando}>Fechar</button>
              <button className="btn btn-ghost" style={{ color: theme.red }} onClick={onDesfazer} disabled={salvando}>
                <i className="ti ti-arrow-back-up" /> {salvando ? 'Desfazendo…' : 'Desfazer correção'}
              </button>
            </div>
          </>
        ) : (
          <>
            <label style={{ fontSize: 12.5, color: theme.sub }}>Conta certa (reclassificar para)</label>
            <div style={{ marginTop: 4 }}>
              <CampoConta value={contaCerta} onChange={setContaCerta} autoFocus />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10, marginTop: 12 }}>
              <div>
                <label style={{ fontSize: 12.5, color: theme.sub }}>Valor</label>
                <input className="input" value={valor} onChange={e => setValor(e.target.value)} placeholder="0,00" style={{ marginTop: 4 }} />
              </div>
              <div>
                <label style={{ fontSize: 12.5, color: theme.sub }}>Histórico</label>
                <textarea className="input" rows={2} value={historico} onChange={e => setHistorico(e.target.value)} style={{ marginTop: 4 }} />
              </div>
            </div>
            <div style={{ background: theme.input, border: `0.5px solid ${theme.cb}`, borderRadius: 10, padding: '10px 14px', fontSize: 12.5, marginTop: 12 }}>
              <p style={{ margin: 0, color: theme.sub }}>Lançamento que será gerado:</p>
              <p style={{ margin: '5px 0 0', color: theme.text }}>Débito <b>{contaDeb}</b> · Crédito <b>{contaCred}</b> · <b>{money(v)}</b></p>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button className="btn btn-ghost" onClick={onClose} disabled={salvando}>Cancelar</button>
              <button className="btn" disabled={salvando || !contaCerta.trim() || v <= 0}
                onClick={() => onGerar({ contaCerta: contaCerta.trim(), valor: v, historico: historico.trim() })}>
                {salvando ? 'Gerando…' : 'Gerar correção'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// Monta uma sugestão de justificativa a partir dos dados da variação (magnitude,
// direção e comparação com o mês anterior) e do provável lançamento culpado. O
// contador confirma ou reescreve — serve só para ganhar tempo.
// Frase do MOTIVO por entidade (cliente/fornecedor): já escreve a causa provável, com
// o valor do impacto — é o que preenche o "em razão de" para o contador só confirmar.
function fraseRazao(m) {
  const a = Math.abs(m.movAtual), p = Math.abs(m.movAnterior)
  const rep = String(m.rep || '').trim().replace(/\s+/g, ' ').slice(0, 48)
  let s
  if (p < 0.005) s = `entrada de ${rep} (${money(a)})`
  else if (a < 0.005) s = `saída de ${rep} (antes ${money(p)})`
  else s = `${a < p ? 'redução' : 'aumento'} de ${rep} (${a < p ? '−' : '+'}${money(Math.abs(a - p))})`
  if (m.reclass) s += ` — reclassificado para a conta ${m.reclass.conta}${m.reclass.nome ? ` · ${m.reclass.nome}` : ''}`
  return s
}

// Quando a diferença bate (±2%) com o valor de UM lançamento do mês, é quase certo que a
// variação é aquele lançamento — retorna-o para apontar direto na justificativa.
function lancDaDiferenca(linhas, delta) {
  const alvo = Math.abs(delta || 0)
  if (!linhas || !linhas.length || alvo < 0.005) return null
  let best = null
  for (const l of linhas) {
    const v = Math.abs((Number(l.debito) || 0) - (Number(l.credito) || 0))
    if (v < 0.005) continue
    const dif = Math.abs(v - alvo)
    if (dif <= Math.max(0.02, alvo * 0.02) && (!best || dif < best.dif)) best = { l, v, dif }
  }
  return best ? best.l : null
}

function montarSugestaoJust({ varInfo, nome, conta, suspeitos, movers, linhas }) {
  if (!varInfo) return ''
  const { atual, anterior, mesAtual, mesAnterior } = varInfo
  const nm = nome ? `A conta ${nome}` : `A conta ${conta}`
  const deltaAbs = Math.abs(Math.abs(atual) - Math.abs(anterior == null ? 0 : anterior))
  const valLanc = l => Math.abs((Number(l.debito) || 0) - (Number(l.credito) || 0))
  const lanc = lancDaDiferenca(linhas, deltaAbs)
  // Maior lançamento do mês — fallback claro quando nada bate exatamente (sempre traz algo).
  const maiorLanc = (linhas || []).filter(l => l.historico && valLanc(l) > 0.005).sort((a, b) => valLanc(b) - valLanc(a))[0]
  // Prioridade: (1) a diferença bate com um lançamento → aponta ele; (2) quebra por cliente;
  // (3) o maior lançamento do mês; (4) provável culpado; senão deixa em branco.
  let razao
  if (lanc) {
    razao = ` Variação em razão do lançamento de ${money(valLanc(lanc))} — ${lanc.historico || 'sem histórico'}.`
  } else if (movers && movers.length) {
    razao = ` Variação em razão de: ${movers.map(fraseRazao).join('; ')}.`
  } else if (maiorLanc) {
    razao = ` Variação principalmente pelo lançamento de ${money(valLanc(maiorLanc))} — ${maiorLanc.historico}.`
  } else {
    const culpado = (suspeitos || []).find(s => s.suspeito && s.historico)
    razao = (culpado ? ` Possível origem: ${culpado.historico}${culpado.motivo ? ` (${culpado.motivo})` : ''}.` : '')
      + ` Variação esperada em razão de ______.`
  }

  // Sem mês anterior (primeiro mês) ou conta que surgiu do zero.
  if (anterior == null || Math.abs(anterior) < 0.005) {
    return `${nm} passou a apresentar movimento de ${money(Math.abs(atual))} em ${MESES[mesAtual - 1]}/${ANO}.${razao}`
  }
  const delta = Math.abs(atual) - Math.abs(anterior)
  const subiu = delta > 0
  const pct = Math.round(Math.abs(delta) / Math.abs(anterior) * 100)
  return `${nm} ${subiu ? 'aumentou' : 'reduziu'} ${money(Math.abs(delta))} (${subiu ? '+' : '−'}${pct}%) em `
    + `${MESES[mesAtual - 1]}/${ANO} na comparação com ${MESES[(mesAnterior || 1) - 1]}/${ANO} `
    + `(de ${money(Math.abs(anterior))} para ${money(Math.abs(atual))}).${razao}`
}

function ModalRegistro({ tipo, salvando, conta, mes, sugestao = '', textoAtual = '', onClose, onConfirmar }) {
  // Editando: abre com o texto já salvo. Novo: abre com a sugestão automática.
  const [txt, setTxt] = useState(textoAtual || (tipo === 'Justificativa' ? sugestao : ''))
  const editando = !!textoAtual
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(480px,96vw)', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
        <h2 style={{ fontSize: 17, marginBottom: 4 }}>{editando ? `Editar ${tipo.toLowerCase()}` : tipo}</h2>
        <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 14 }}>
          Conta <b style={{ color: theme.text }}>{conta}</b> · {MESES[mes - 1]}/{ANO}. Fica registrada na auditoria com seu usuário e a data.
        </p>
        {tipo === 'Justificativa' && sugestao && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 11.5, color: theme.accent, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <i className="ti ti-sparkles" /> {editando ? 'Edite o texto ou restaure a sugestão automática.' : 'Sugestão automática — confirme ou edite o texto.'}
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              {txt !== sugestao && <button type="button" className="btn-ghost" style={{ fontSize: 11, padding: '3px 9px' }} onClick={() => setTxt(sugestao)}>Restaurar sugestão</button>}
              <button type="button" className="btn-ghost" style={{ fontSize: 11, padding: '3px 9px' }} onClick={() => setTxt('')}>Limpar</button>
            </div>
          </div>
        )}
        <textarea className="input" rows={4} value={txt} onChange={e => setTxt(e.target.value)} autoFocus
          placeholder={tipo === 'Correção' ? 'O que foi corrigido (ex.: reclassificação, lançamento ajustado)…' : 'Por que esta variação é esperada…'} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={salvando}>Cancelar</button>
          <button className="btn" onClick={() => txt.trim() && onConfirmar(txt.trim())} disabled={salvando || !txt.trim()}>
            {salvando ? 'Salvando…' : editando ? 'Salvar alterações' : 'Registrar'}
          </button>
        </div>
      </div>
    </div>
  )
}

const th = { textAlign: 'left', padding: '10px 14px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3, whiteSpace: 'nowrap' }
const td = { padding: '9px 14px', fontSize: 12.5, color: theme.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }

function Wrapper({ children }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Comp. Movimento</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 22 }}>
        Comparativo mês a mês do ano: saldos de cada conta ao longo das competências, destacando variações relevantes.
      </p>
      {children}
    </div>
  )
}
