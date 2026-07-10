import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import { theme, money, moneyDC } from '../lib/theme'
import { montarBalancete, normalizaCompetencia, applyMask } from '../lib/balancete'

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

export default function CompMovimento() {
  const { empresaId, empresaNome, getCompetenciaId } = useAppData()
  const { user } = useAuth()

  const [carregando, setCarregando] = useState(false)
  const [comps, setComps] = useState([])        // [{ id, mes }] dos meses com balancete
  const [contas, setContas] = useState([])      // [{ reduzido, classif, nome, grau, sintetica }] união (sint. + analít.)
  const [matriz, setMatriz] = useState({})      // { classif: { mes: saldo_final } }
  const [detalhe, setDetalhe] = useState(null)  // { conta, nome, mes, compId }
  const [justificadas, setJustificadas] = useState(() => new Set()) // 'conta|mes' já justificadas/corrigidas localmente
  const [refresh, setRefresh] = useState(0)     // recarrega após importar meses anteriores
  const [impBusy, setImpBusy] = useState(false)
  const [impMsg, setImpMsg] = useState('')
  const [filtroMes, setFiltroMes] = useState('todos') // 'todos' | número do mês

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
    setComps([]); setContas([]); setMatriz({}); setDetalhe(null); setJustificadas(new Set())
    if (!empresaId) return
    let vivo = true
    ;(async () => {
      setCarregando(true)
      try {
        const { data: competencias } = await supabase
          .from('competencias').select('id, mes')
          .eq('cliente_id', empresaId).eq('ano', ANO)
          .order('mes', { ascending: true })

        if (!vivo) return
        if (!competencias || !competencias.length) { setCarregando(false); return }

        const compsComDados = []
        const meta = {}   // classifRaw → { reduzido, classif, classifRaw, nome, grau, sintetica }
        const m = {}      // classifRaw → { mes: saldo_final }

        for (const c of competencias) {
          const { linhas } = await montarBalancete(empresaId, c.id)
          if (!vivo) return
          // Comparativo trata só contas de resultado: Receita (3), Custos (4) e Despesas (5).
          const res = linhas.filter(l => { const d = String(l.classifRaw || l.classif).trim()[0]; return d === '3' || d === '4' || d === '5' })
          if (!res.length) continue

          compsComDados.push({ id: c.id, mes: c.mes })
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
            m[key][c.mes] = l.saldo_final
          }
        }

        if (!vivo) return
        const listaContas = Object.values(meta)
          .sort((a, b) => a.classifRaw < b.classifRaw ? -1 : a.classifRaw > b.classifRaw ? 1 : 0)

        setComps(compsComDados)
        setContas(listaContas)
        setMatriz(m)

        // Pré-carrega justificativas/correções já registradas na auditoria deste módulo,
        // para o contador refletir o que já foi tratado em sessões anteriores.
        const compIds = compsComDados.map(c => c.id)
        if (compIds.length) {
          const { data: audits } = await supabase
            .from('auditoria').select('item, competencia_id')
            .in('competencia_id', compIds).eq('modulo', 'Comparativo')
          if (!vivo) return
          if (audits && audits.length) {
            const mesPorComp = {}
            for (const c of compsComDados) mesPorComp[c.id] = c.mes
            const set = new Set()
            for (const a of audits) {
              // item no formato `${conta} · ${MES}/${ano}` — extrai a conta e usa o mês da competência.
              const conta = String(a.item || '').split(' · ')[0].trim()
              const mes = mesPorComp[a.competencia_id]
              if (conta && mes) set.add(chaveCelula(conta, mes))
            }
            setJustificadas(set)
          }
        }
      } finally {
        if (vivo) setCarregando(false)
      }
    })()
    return () => { vivo = false }
  }, [empresaId, refresh])

  // Uma célula desvia se difere mais de 10% da média da conta nos meses carregados.
  function desviante(conta, valor) {
    const linha = matriz[conta] || {}
    const valores = comps.map(c => linha[c.mes]).filter(v => v != null)
    if (valores.length < 2) return false
    const media = valores.reduce((s, v) => s + v, 0) / valores.length
    if (media === 0) return valor !== 0
    return Math.abs(valor - media) / Math.abs(media) > 0.1
  }

  // Conta as células desviantes (vermelhas) ainda não justificadas/corrigidas.
  // Só nas analíticas — as sintéticas são totais (não se justificam diretamente).
  let pendentes = 0
  for (const { reduzido, classifRaw, sintetica } of contas) {
    if (sintetica) continue
    const linha = matriz[classifRaw] || {}
    for (const c of comps) {
      const v = linha[c.mes]
      if (v == null) continue
      if (desviante(classifRaw, v) && !justificadas.has(chaveCelula(reduzido, c.mes))) pendentes++
    }
  }

  // Marca uma célula como justificada/corrigida localmente (atualiza o contador na hora).
  function marcarJustificada(conta, mes) {
    setJustificadas(prev => {
      const next = new Set(prev)
      next.add(chaveCelula(conta, mes))
      return next
    })
  }

  // Desfaz o ajuste: devolve a célula à contagem de pendências (atualiza na hora).
  function marcarNaoJustificada(conta, mes) {
    setJustificadas(prev => {
      const next = new Set(prev)
      next.delete(chaveCelula(conta, mes))
      return next
    })
  }

  // Filtro por mês (todos ou um só). A coluna "Total" só faz sentido com >1 mês.
  const mesesVis = filtroMes === 'todos' ? comps : comps.filter(c => c.mes === Number(filtroMes))
  const mostraTotal = mesesVis.length > 1
  const totalConta = key => { const linha = matriz[key] || {}; return mesesVis.reduce((s, c) => s + (linha[c.mes] || 0), 0) }
  // Lucro (ou prejuízo) do mês = −(soma dos saldos das contas de resultado analíticas).
  // Receita fica com saldo credor (negativo); despesa/custo devedor (positivo) → negar dá o lucro.
  const lucroDe = mes => -contas.filter(c => !c.sintetica).reduce((s, c) => s + ((matriz[c.classifRaw] || {})[mes] || 0), 0)
  const lucroTotal = mesesVis.reduce((s, c) => s + lucroDe(c.mes), 0)

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

  const semDados = !carregando && comps.length === 0

  return (
    <Wrapper>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 12 }}>
        <b style={{ color: theme.text }}>{empresaNome}</b> · ano <b style={{ color: theme.text }}>{ANO}</b>
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

      {!carregando && comps.length > 0 && (
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
                {pendentes} variação(ões) a justificar
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
              Contas de resultado. Valores em <b style={{ color: theme.red }}>vermelho</b> desviam mais de 10% da média da conta. Clique num valor para ver o razão e o provável culpado.
            </p>
            <label style={{ fontSize: 12, color: theme.sub, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <i className="ti ti-filter" /> Mês:
              <select className="input" style={{ width: 'auto', fontSize: 12, padding: '6px 10px' }} value={filtroMes} onChange={e => setFiltroMes(e.target.value)}>
                <option value="todos">Todos os meses</option>
                {comps.map(c => <option key={c.mes} value={c.mes}>{MESES[c.mes - 1]}</option>)}
              </select>
            </label>
          </div>
          <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto', maxWidth: '100%' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr style={{ background: theme.input }}>
                  <th style={{ ...th, minWidth: 70 }}>Conta</th>
                  <th style={{ ...th, minWidth: 110 }}>Classificação</th>
                  <th style={{ ...th, minWidth: 220 }}>Nome da Conta</th>
                  {mesesVis.map(c => (
                    <th key={c.mes} style={{ ...th, textAlign: 'right' }}>{MESES[c.mes - 1]}</th>
                  ))}
                  {mostraTotal && <th style={{ ...th, textAlign: 'right', color: theme.text }}>Total</th>}
                </tr>
              </thead>
              <tbody>
                {contas.map(({ reduzido, classif, classifRaw, nome, sintetica }) => {
                  const linha = matriz[classifRaw] || {}
                  return (
                    <tr key={classifRaw} style={{ borderTop: `1px solid ${theme.border}`, background: sintetica ? theme.input : 'transparent', fontWeight: sintetica ? 700 : 400 }}>
                      <td style={{ ...td, color: theme.sub, fontSize: 11 }}>{reduzido || ''}</td>
                      <td style={{ ...td, color: theme.sub, fontSize: 11 }}>{classif}</td>
                      <td style={{ ...td, fontWeight: sintetica ? 700 : 400, maxWidth: 320 }}>{nome || '—'}</td>
                      {mesesVis.map(c => {
                        const v = linha[c.mes]
                        if (v == null) return <td key={c.mes} style={{ ...td, textAlign: 'right' }} />
                        if (sintetica) {
                          return <td key={c.mes} style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{moneyDC(v)}</td>
                        }
                        const red = desviante(classifRaw, v)
                        const ok = red && justificadas.has(chaveCelula(reduzido, c.mes))
                        return (
                          <td key={c.mes} style={{ ...td, textAlign: 'right' }}>
                            <button
                              onClick={() => setDetalhe({ conta: reduzido, classif, nome, mes: c.mes, compId: c.id })}
                              style={{
                                display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end',
                                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                                fontSize: 12.5, fontFamily: 'inherit',
                                color: red ? theme.red : theme.text,
                                fontWeight: red ? 700 : 400,
                              }}
                              title={ok ? 'Variação justificada — ver razão da conta neste mês' : 'Ver razão da conta neste mês'}
                            >
                              {ok && <i className="ti ti-circle-check" style={{ color: theme.green, fontSize: 13 }} />}
                              {moneyDC(v)}
                            </button>
                          </td>
                        )
                      })}
                      {mostraTotal && <td style={{ ...td, textAlign: 'right', fontWeight: sintetica ? 700 : 600 }}>{moneyDC(totalConta(classifRaw))}</td>}
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: `2px solid ${theme.border}`, background: theme.input }}>
                  <td style={{ ...td, fontWeight: 700 }} colSpan={3}>Lucro / Prejuízo do período</td>
                  {mesesVis.map(c => { const L = lucroDe(c.mes); return (
                    <td key={c.mes} style={{ ...td, textAlign: 'right', fontWeight: 700, color: L >= 0 ? theme.green : theme.red }}>{money(L)}</td>
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
          compsAnteriores={comps.filter(c => c.mes < detalhe.mes).map(c => c.id)}
          usuario={user?.email}
          getCompetenciaId={getCompetenciaId}
          jaJustificada={justificadas.has(chaveCelula(detalhe.conta, detalhe.mes))}
          onJustificada={() => marcarJustificada(detalhe.conta, detalhe.mes)}
          onDesfeita={() => marcarNaoJustificada(detalhe.conta, detalhe.mes)}
          onClose={() => setDetalhe(null)}
        />
      )}
    </Wrapper>
  )
}

function ModalRazao({ detalhe, compsAnteriores, usuario, getCompetenciaId, jaJustificada, onJustificada, onDesfeita, onClose }) {
  const { conta, nome, mes, compId } = detalhe
  const [carregando, setCarregando] = useState(true)
  const [linhas, setLinhas] = useState([])
  const [registro, setRegistro] = useState(null) // 'Justificativa' | 'Correção'
  const [salvando, setSalvando] = useState(false)
  const [tratada, setTratada] = useState(jaJustificada)
  const [msg, setMsg] = useState('')

  async function registrar(tipo, detalheTxt) {
    setSalvando(true)
    try {
      const competencia_id = await getCompetenciaId()
      const { error } = await supabase.from('auditoria').insert({
        competencia_id,
        modulo: 'Comparativo',
        item: `${conta} · ${MESES[mes - 1]}/${ANO}`,
        tipo,
        detalhe: detalheTxt,
        usuario,
      })
      if (error) throw error
      setMsg(`${tipo} registrada na auditoria.`)
      setRegistro(null)
      setTratada(true)
      onJustificada()
    } catch (e) {
      setMsg('Erro ao registrar: ' + (e.message || e))
    } finally {
      setSalvando(false)
    }
  }

  // Desfaz o ajuste: apaga o(s) registro(s) desta conta/mês na auditoria do Comparativo
  // (o item identifica unicamente conta + mês). A célula volta a contar como pendência.
  async function desfazer() {
    setSalvando(true)
    try {
      const { error } = await supabase.from('auditoria').delete()
        .eq('modulo', 'Comparativo')
        .eq('item', `${conta} · ${MESES[mes - 1]}/${ANO}`)
      if (error) throw error
      setMsg('Ajuste desfeito — variação voltou a pendente.')
      setTratada(false)
      onDesfeita()
    } catch (e) {
      setMsg('Erro ao desfazer: ' + (e.message || e))
    } finally {
      setSalvando(false)
    }
  }

  useEffect(() => {
    let vivo = true
    ;(async () => {
      setCarregando(true)
      const { data } = await supabase
        .from('razao').select('data, conta, historico, debito, credito')
        .eq('competencia_id', compId).eq('conta', conta)
        .order('data', { ascending: true })
      let anteriores = []
      if (compsAnteriores && compsAnteriores.length) {
        const { data: ant } = await supabase.from('razao').select('historico')
          .in('competencia_id', compsAnteriores).eq('conta', conta)
        anteriores = (ant || []).map(r => r.historico)
      }
      if (!vivo) return
      setLinhas(analisarCulpados(data || [], anteriores))
      setCarregando(false)
    })()
    return () => { vivo = false }
  }, [compId, conta]) // eslint-disable-line react-hooks/exhaustive-deps

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
        style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, width: 'min(900px, 96vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '18px 22px', borderBottom: `0.5px solid ${theme.cb}` }}>
          <div>
            <h3 style={{ fontSize: 15, marginBottom: 4 }}>Razão — conta {conta}</h3>
            <p style={{ color: theme.sub, fontSize: 12.5 }}>
              {nome ? `${nome} · ` : ''}{MESES[mes - 1]}/{ANO}
            </p>
          </div>
          <button className="btn-ghost" onClick={onClose} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <i className="ti ti-x" /> Fechar
          </button>
        </div>

        {!carregando && suspeitos.length > 0 && (
          <div style={{ margin: '14px 22px 0', background: 'rgba(245,166,35,0.10)', border: '1px solid rgba(245,166,35,0.4)', borderRadius: 10, padding: '12px 14px' }}>
            <p style={{ color: theme.yellow, fontSize: 13, fontWeight: 600, margin: 0 }}>
              <i className="ti ti-alert-triangle" /> {suspeitos.length} lançamento(s) provável(is) culpado(s) desta variação
            </p>
            <p style={{ color: theme.sub, fontSize: 12, margin: '4px 0 0' }}>Destacados abaixo. Use “Corrigir” para reclassificar, ou “Justificar” se a variação é esperada.</p>
          </div>
        )}

        <div style={{ overflow: 'auto', padding: '0 0 4px' }}>
          {carregando ? (
            <p style={{ color: theme.sub, fontSize: 13, padding: '18px 22px' }}><i className="ti ti-loader" /> Carregando…</p>
          ) : linhas.length === 0 ? (
            <p style={{ color: theme.sub, fontSize: 13, padding: '18px 22px' }}>Nenhum lançamento de razão para esta conta neste mês.</p>
          ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr style={{ background: theme.input }}>
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
                  return (
                    <tr key={i} style={{ borderTop: `1px solid ${theme.border}`, background: l.suspeito ? 'rgba(245,166,35,0.07)' : undefined }}>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{l.data || ''}</td>
                      <td style={{ ...td, maxWidth: 380, whiteSpace: 'normal' }}>
                        {l.suspeito && <i className="ti ti-alert-triangle" style={{ color: theme.yellow, marginRight: 6 }} title="Provável culpado" />}
                        {l.historico || ''}
                        {l.suspeito && <div style={{ color: theme.yellow, fontSize: 11, marginTop: 2 }}>provável culpado — {l.motivo}</div>}
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
                  <td style={{ ...td, fontWeight: 700 }} colSpan={2}>Total</td>
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
              : tratada
                ? <><i className="ti ti-circle-check" style={{ color: theme.green }} /> Variação já tratada na auditoria.</>
                : 'Justifique ou corrija esta variação — fica registrada na auditoria.'}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            {tratada && (
              <button className="btn btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: theme.red }} disabled={salvando} onClick={desfazer}>
                <i className="ti ti-arrow-back-up" /> {salvando ? 'Desfazendo…' : 'Desfazer ajuste'}
              </button>
            )}
            <button className="btn btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => { setMsg(''); setRegistro('Justificativa') }}>
              <i className="ti ti-flag" /> Justificar
            </button>
            <button className="btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => { setMsg(''); setRegistro('Correção') }}>
              <i className="ti ti-pencil-bolt" /> Corrigir
            </button>
          </div>
        </div>
      </div>

      {registro && (
        <ModalRegistro
          tipo={registro}
          salvando={salvando}
          conta={conta}
          mes={mes}
          onClose={() => setRegistro(null)}
          onConfirmar={txt => registrar(registro, txt)}
        />
      )}
    </div>
  )
}

function ModalRegistro({ tipo, salvando, conta, mes, onClose, onConfirmar }) {
  const [txt, setTxt] = useState('')
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(480px,96vw)', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
        <h2 style={{ fontSize: 17, marginBottom: 4 }}>{tipo}</h2>
        <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 14 }}>
          Conta <b style={{ color: theme.text }}>{conta}</b> · {MESES[mes - 1]}/{ANO}. Fica registrada na auditoria com seu usuário e a data.
        </p>
        <textarea className="input" rows={3} value={txt} onChange={e => setTxt(e.target.value)} autoFocus
          placeholder={tipo === 'Correção' ? 'O que foi corrigido (ex.: reclassificação, lançamento ajustado)…' : 'Por que esta variação é esperada…'} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={salvando}>Cancelar</button>
          <button className="btn" onClick={() => txt.trim() && onConfirmar(txt.trim())} disabled={salvando || !txt.trim()}>
            {salvando ? 'Registrando…' : 'Registrar'}
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
