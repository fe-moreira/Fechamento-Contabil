import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import { theme, money } from '../lib/theme'
import { montarBalancete, parsePlano } from '../lib/balancete'

// ---- Leitura do histórico: extrai NF e entidade (cliente/fornecedor) com confiança ----
const RUIDO = /\b(VENDA|VENDAS|COMPRA|COMPRAS|PAGTO|PAGAMENTO|RECEBIMENTO|RECEBTO|REF|REFERENTE|NOTA|FISCAL|DUPLICATA|DUPL|BOLETO|TITULO|TÍTULO|VLR|VALOR|PARCELA|PARC|CONF|S\/|A|DE|DA|DO|DOS|DAS|E|NO|NA|EM)\b/ig
// Remove o sufixo societário (S.A, LTDA, EIRELI, ME, EPP) e o que vier depois.
const tiraSufixo = e => e.replace(/\s+(S[./]?\s?A\.?|LTDA\.?|EIRELI|EPP|ME)\b.*$/i, '').replace(/\s+/g, ' ').trim()

// ---- Unificação de nomes parecidos (mesmo cliente/fornecedor escrito de formas diferentes) ----
// Palavras genéricas de razão social: não distinguem uma empresa de outra, então são ignoradas
// na comparação (senão "...DE FORCA E LUZ" casaria empresas distintas).
const GENERICAS = new Set(['COMPANHIA', 'CIA', 'DISTRIBUIDORA', 'DISTRIBUIDOR', 'ENERGIA', 'ENERGIAS', 'ELETRICA', 'ELETRICAS', 'FORCA', 'LUZ', 'COMERCIO', 'COMERCIAL', 'INDUSTRIA', 'INDUSTRIAL', 'SERVICO', 'SERVICOS', 'BRASIL', 'NACIONAL', 'GRUPO', 'HOLDING', 'PARTICIPACOES', 'EMPREENDIMENTOS', 'TRANSPORTE', 'TRANSPORTES', 'LOGISTICA', 'SOLUCOES', 'TECNOLOGIA', 'SISTEMAS', 'ASSOCIACAO', 'INSTITUTO', 'FUNDACAO', 'BANCO', 'SUPERMERCADO', 'SUPERMERCADOS', 'ALIMENTOS', 'DO', 'DA', 'DE', 'DOS', 'DAS', 'E', 'EM'])
const normNome = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
// Tokens distintivos de um nome (>=3 letras, sem genéricas). Se sobrar vazio, usa todos.
function tokensNome(nome) {
  const todos = normNome(nome).split(' ').filter(Boolean)
  const dist = todos.filter(t => t.length >= 3 && !GENERICAS.has(t))
  return dist.length ? dist : todos
}
// Dois nomes são o mesmo cliente se um conjunto de tokens é subconjunto do outro,
// ou a interseção cobre a maioria do menor e há um token forte (>=4 letras) em comum.
function mesmoCliente(a, b) {
  const inter = a.filter(t => b.includes(t))
  if (!inter.length) return false
  const menor = Math.min(a.length, b.length)
  if (inter.length === menor) return true
  return inter.length / menor >= 0.6 && inter.some(t => t.length >= 4)
}

function lerHistorico(h) {
  const s = String(h || '').trim()
  const nfm = s.match(/\bNF\.?\s*(?:N[ºo°.]*\s*)?(\d{2,9})/i) || s.match(/\bNOTA\s*(?:FISCAL)?\s*N?[ºo°.]*\s*(\d{2,9})/i) || s.match(/\bN[ºo°]\.?\s*(\d{2,9})/i)
  const nf = nfm ? nfm[1] : (s.match(/\b(\d{3,9})\b/)?.[1] || '')

  // O nome do cliente/fornecedor vem antes do bloco fiscal (CF./NF/NOTA/RPS).
  const corpo = s.split(/\s(?:CF\b|NF\b|NOTA\s+FISCAL|RPS\b)/i)[0].trim()
  let entidade = '', ident = false
  const mRec = corpo.match(/\b(?:RECEBIMENTO|RECEBTO|PAGAMENTO|PAGTO)\s+(?:A\s+|DE\s+|AO\s+)?(.+)$/i)
  if (mRec) {
    // "VALOR REF. RECEBIMENTO <NOME> NF ..."
    entidade = tiraSufixo(mRec[1].trim()); ident = true
  } else if (/\s[-–]\s/.test(corpo)) {
    // "... - ACUM. N - <NOME> CF. NF. ..." → último segmento entre travessões
    const segs = corpo.split(/\s[-–]\s/).map(x => x.trim()).filter(Boolean)
    entidade = tiraSufixo(segs[segs.length - 1]); ident = true
  }
  // Fallback: heurística antiga de remoção de ruído (leitura incerta).
  if (!entidade || entidade.length < 3) {
    entidade = s.replace(nfm ? nfm[0] : '', ' ').replace(/\b\d+\b/g, ' ').replace(RUIDO, ' ').replace(/[.\-/]+/g, ' ').replace(/\s+/g, ' ').trim()
    ident = false
  }
  // Confiança: alta = nome confiável + NF; média = nome confiável sem NF; baixa = leitura incerta.
  let conf = 'baixa'
  if (ident && entidade.length >= 4 && nf) conf = 'alta'
  else if (ident && entidade.length >= 4) conf = 'media'
  return { nf, entidade: entidade || '', ident, conf }
}

function tipoConta(nome) {
  const n = (nome || '').toLowerCase()
  if (/(icms|pis|cofins|iss|imposto|tribut|darf|das\b)/.test(n)) return 'Imposto'
  if (/(cliente|duplicata|receber|fornecedor|pagar|estoque|mercadoria)/.test(n)) return 'Composição'
  return 'Saldo'
}

const baixaTxt = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// Deriva o tipo de tratamento (Composição/Imposto/Saldo) a partir da classificação do plano.
function tipoPorClassif(c) {
  const n = baixaTxt(c)
  if (!n) return ''
  if (/imposto|icms|pis|cofins|tribut/.test(n)) return 'Imposto'
  if (/composi/.test(n)) return 'Composição'
  if (/saldo|banco|simples/.test(n)) return 'Saldo'
  return ''
}

export default function Conciliacao() {
  const { empresaId, empresaNome, competencia, getCompetenciaId } = useAppData()
  const { user } = useAuth()
  const [compId, setCompId] = useState(null)
  const [contas, setContas] = useState([])
  const [carregando, setCarregando] = useState(true)
  const [sel, setSel] = useState(null) // conta selecionada (detalhe)

  useEffect(() => {
    setSel(null); setContas([]); setCompId(null)
    if (!empresaId) { setCarregando(false); return }
    setCarregando(true)
    const [mes, ano] = competencia.split('/').map(Number)
    supabase.from('competencias').select('id').eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
      .then(async ({ data: comp }) => {
        if (!comp) { setCarregando(false); return }
        setCompId(comp.id)
        const { linhas } = await montarBalancete(empresaId, comp.id)
        // Conciliação trata só Ativo (1) e Passivo (2). Receita/Custos/Despesa vão no Comparativo.
        const ap = linhas.filter(l => { const d = String(l.classifRaw || l.classif).trim()[0]; return d === '1' || d === '2' })
        setContas(ap.map(l => ({
          ...l, conta: l.reduzido,
          tipo: tipoPorClassif(l.classif) || tipoConta(l.nome || l.classif),
        })))
        setCarregando(false)
      })
  }, [empresaId, competencia])

  if (!empresaId) return <Wrapper><Aviso texto="Selecione uma empresa no menu lateral." /></Wrapper>
  if (carregando) return <Wrapper><p style={{ color: theme.sub, fontSize: 13 }}>Carregando…</p></Wrapper>
  if (!compId || contas.length === 0) return <Wrapper><Aviso icon="ti-table-off" texto="Nenhum balancete nesta competência. Importe o razão primeiro." /></Wrapper>

  if (sel) return <Detalhe conta={sel} compId={compId} empresaId={empresaId} usuario={user?.email} getCompetenciaId={getCompetenciaId} onVoltar={() => setSel(null)} />

  const farol = (c) => Math.abs(c.saldo_final) < 0.01 ? theme.green : Math.abs(c.saldo_final) < 1000 ? theme.yellow : theme.red

  return (
    <Wrapper nome={empresaNome} comp={competencia}>
      <div style={{ display: 'flex', gap: 16, marginBottom: 14, fontSize: 12, color: theme.sub }}>
        <span><Dot c={theme.red} /> Não conciliada</span>
        <span><Dot c={theme.yellow} /> Sem documento</span>
        <span><Dot c={theme.green} /> Conciliada</span>
      </div>
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
        <table style={{ width: '100%', minWidth: 860, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: theme.input }}>
              <th style={th}>Conta</th><th style={th}>Classificação</th><th style={th}>Nome da Conta</th>
              <th style={thR}>Saldo inicial</th><th style={thR}>Débito</th>
              <th style={thR}>Crédito</th><th style={thR}>Saldo atual</th><th style={{ ...th, textAlign: 'center' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {contas.map((c, i) => {
              const sint = c.sintetica
              const peso = sint ? 700 : 400 // só as sintéticas em negrito
              return (
                <tr key={i} onClick={() => !sint && setSel(c)}
                  style={{ borderTop: `1px solid ${theme.border}`, cursor: sint ? 'default' : 'pointer', background: sint ? theme.input : 'transparent', fontWeight: peso }}>
                  <td style={{ ...td, color: theme.sub, fontSize: 11, whiteSpace: 'nowrap' }}>{c.reduzido || ''}</td>
                  <td style={{ ...td, color: theme.sub, fontSize: 11, whiteSpace: 'nowrap' }}>{c.classif}</td>
                  <td style={{ ...td, fontWeight: peso }}>{c.nome || '—'}</td>
                  <td style={{ ...tdR, fontWeight: peso }}>{money(c.saldo_inicial)}</td>
                  <td style={{ ...tdR, fontWeight: peso }}>{money(c.debito)}</td>
                  <td style={{ ...tdR, fontWeight: peso }}>{money(c.credito)}</td>
                  <td style={{ ...tdR, fontWeight: peso }}>{money(c.saldo_final)}</td>
                  <td style={{ ...td, textAlign: 'center' }}>{sint ? '' : <Dot c={farol(c)} />}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Wrapper>
  )
}

function Detalhe({ conta, compId, empresaId, usuario, getCompetenciaId, onVoltar }) {
  const [lanc, setLanc] = useState([])
  const [carregando, setCarregando] = useState(true)
  const [acao, setAcao] = useState(null)   // lançamento clicado (justificar/corrigir)
  const [plano, setPlano] = useState([])   // [{ cod, nome }] para os seletores de conta
  const [msg, setMsg] = useState('')

  useEffect(() => {
    setCarregando(true)
    supabase.from('razao').select('data, historico, debito, credito').eq('competencia_id', compId).eq('conta', conta.conta).order('data')
      .then(({ data }) => { setLanc((data || []).map(l => ({ ...l, leitura: lerHistorico(l.historico) }))); setCarregando(false) })
  }, [compId, conta.conta])

  useEffect(() => {
    supabase.from('cargas_cadastro').select('dados').eq('cliente_id', empresaId).eq('tipo', 'plano')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
      .then(({ data }) => setPlano(parsePlano(data?.dados).map(p => ({ cod: p.reduzido, nome: p.nome })).filter(p => p.cod)))
  }, [empresaId])

  // Natureza pela classificação: Ativo (1) é devedora (clientes); Passivo (2) credora (fornecedores).
  const natCredito = String(conta.classifRaw || conta.classif || '').replace(/\D/g, '')[0] === '2'
  const lab = natCredito ? 'fornecedor' : 'cliente'
  const ov = l => natCredito ? ((Number(l.credito) || 0) - (Number(l.debito) || 0)) : ((Number(l.debito) || 0) - (Number(l.credito) || 0))

  const somaComp = lanc.reduce((s, l) => s + (Number(l.debito) || 0) - (Number(l.credito) || 0), 0)
  const dif = conta.saldo_final - somaComp

  // Agrupa por nome exato; leitura incerta cai em "(não identificado)".
  const grupos = {}, nomes = []
  for (const l of lanc) {
    if (Math.abs(ov(l)) < 0.005) continue
    const key = l.leitura.ident && l.leitura.entidade ? l.leitura.entidade : '(não identificado)'
    if (!grupos[key]) { grupos[key] = []; nomes.push(key) }
    grupos[key].push(l)
  }
  // Unifica nomes parecidos (mesmo cliente escrito de formas diferentes) em um cluster.
  const idents = nomes.filter(k => k !== '(não identificado)')
  const tk = Object.fromEntries(idents.map(k => [k, tokensNome(k)]))
  const clusters = []
  for (const k of idents) {
    const alvo = clusters.find(cl => cl.membros.some(m => mesmoCliente(tk[k], tk[m])))
    if (alvo) alvo.membros.push(k); else clusters.push({ membros: [k] })
  }
  const lista = clusters.map(cl => {
    const membros = cl.membros.slice().sort((a, b) => b.length - a.length)
    const lancs = cl.membros.flatMap(m => grupos[m])
    return { nome: membros[0], variacoes: membros, lancs, total: lancs.reduce((s, l) => s + ov(l), 0), unido: membros.length > 1, unk: false }
  })
  if (grupos['(não identificado)']) {
    const lancs = grupos['(não identificado)']
    lista.push({ nome: '(não identificado)', variacoes: [], lancs, total: lancs.reduce((s, l) => s + ov(l), 0), unido: false, unk: true })
  }
  lista.sort((a, b) => (a.unk ? 1 : 0) - (b.unk ? 1 : 0) || a.nome.localeCompare(b.nome, 'pt-BR'))

  const revs = lanc.filter(l => Math.abs(ov(l)) >= 0.005 && l.leitura.conf !== 'alta').length

  // Anomalia de natureza: conta de cliente (Ativo) deve ficar devedora; fornecedor (Passivo) credora.
  // Um grupo com total na natureza invertida (total < 0) é estranho e precisa ser verificado.
  const natAnom = natCredito ? 'devedor' : 'credor'   // saldo que é ANÔMALO nesta conta
  const natOk = natCredito ? 'credora' : 'devedora'   // natureza esperada da conta
  const anomalos = lista.filter(x => x.total < -0.005).map(x => x.nome)
  const unificados = lista.filter(x => x.unido).length
  const contaInvertida = Number(conta.saldo_final) * (natCredito ? -1 : 1) < -0.005

  // Casamento por NF: o título nasce de um lado (cliente=débito; fornecedor=crédito) e
  // a baixa vem do outro. Para o saldo zerar, a NF da baixa tem que ser a mesma do título.
  // Uma baixa com NF que não casa com nenhum título do mesmo cliente/fornecedor é um erro.
  const ladoOrigem = natCredito ? 'credito' : 'debito'
  const ladoBaixa = natCredito ? 'debito' : 'credito'
  const baixaSemTitulo = g => {
    const nfsTitulo = new Set(g.lancs.filter(l => Number(l[ladoOrigem]) > 0.005 && l.leitura.nf).map(l => l.leitura.nf))
    return new Set(g.lancs.filter(l => Number(l[ladoBaixa]) > 0.005 && l.leitura.nf && !nfsTitulo.has(l.leitura.nf)))
  }
  const totalSemTitulo = lista.reduce((n, g) => n + baixaSemTitulo(g).size, 0)

  async function registrar(tipo, payload) {
    const id = await getCompetenciaId()
    const item = `${conta.conta} · ${acao?.data || ''} · NF ${acao?.leitura.nf || '—'}`
    await supabase.from('auditoria').insert({ competencia_id: id, modulo: 'Conciliação', item, tipo, detalhe: payload.detalhe || null, usuario })
    let virouLancamento = false
    if (tipo === 'Correção' && payload.lancamento && (payload.lancamento.conta_debito || payload.lancamento.conta_credito)) {
      const L = payload.lancamento
      await supabase.from('lancamentos').insert({
        competencia_id: id, data: L.data || null,
        conta_debito: L.conta_debito || null, conta_credito: L.conta_credito || null,
        valor: Number(L.valor) || 0, historico: L.historico || null,
        documento: acao?.leitura.nf ? `NF ${acao.leitura.nf}` : null,
        origem: 'correcao', usuario,
      })
      virouLancamento = true
    }
    setMsg(virouLancamento ? 'Correção registrada — lançamento enviado para o painel Contabilizar.' : `${tipo} registrada na auditoria.`)
    setAcao(null)
  }

  return (
    <Wrapper>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span onClick={onVoltar} style={{ color: '#8FB0FF', fontSize: 13, cursor: 'pointer' }}><i className="ti ti-chevron-left" /> Conciliação</span>
          <span style={{ color: theme.sub }}>/</span>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{conta.conta} · {conta.nome}</span>
        </div>
        <span style={{ color: theme.sub, fontSize: 12 }}><i className="ti ti-click" /> Clique num lançamento para justificar ou corrigir.</span>
      </div>

      {msg && <p style={{ color: theme.green, fontSize: 13, marginBottom: 12 }}><i className="ti ti-circle-check" /> {msg}</p>}

      {/* Resumo + amarração */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 12, marginBottom: 16 }}>
        <Tile label="Saldo inicial" v={money(conta.saldo_inicial)} />
        <Tile label="Débito" v={money(conta.debito)} cor={theme.green} />
        <Tile label="Crédito" v={money(conta.credito)} cor={theme.red} />
        <Tile label="Saldo atual" v={money(conta.saldo_final)} />
        <Tile label="Diferença (amarração)" v={money(dif)} cor={Math.abs(dif) < 0.01 ? theme.green : theme.yellow} />
      </div>

      {/* Impostos: baixa do mês anterior + memória de cálculo */}
      {conta.tipo === 'Imposto' && <ImpostoCards conta={conta} />}

      {/* Composição agrupada por cliente/fornecedor */}
      <p style={{ color: theme.sub, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .5, margin: '4px 0 10px' }}>
        O que compõe o saldo — por {lab}
      </p>

      {(contaInvertida || anomalos.length > 0) && (
        <div style={{ background: 'rgba(229,72,77,0.10)', border: `1px solid ${theme.red}`, borderRadius: 12, display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', marginBottom: 12 }}>
          <i className="ti ti-alert-octagon" style={{ color: theme.red, fontSize: 18, marginTop: 1 }} />
          <span style={{ color: theme.text, fontSize: 13 }}>
            {contaInvertida && <><b>Saldo da conta {natAnom}</b> — conta de {lab} deveria ficar {natOk}. </>}
            {anomalos.length > 0 && <>{anomalos.length} {lab}(s) com saldo <b>{natAnom}</b> (natureza invertida) — verifique{anomalos.length <= 4 ? `: ${anomalos.join(', ')}` : ''}.</>}
          </span>
        </div>
      )}

      {totalSemTitulo > 0 && (
        <div style={{ background: 'rgba(229,72,77,0.10)', border: `1px solid ${theme.red}`, borderRadius: 12, display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', marginBottom: 12 }}>
          <i className="ti ti-receipt-off" style={{ color: theme.red, fontSize: 18, marginTop: 1 }} />
          <span style={{ color: theme.text, fontSize: 13 }}>{totalSemTitulo} baixa(s) com NF que não confere com nenhum título deste {lab} — para o saldo zerar, a NF do recebimento tem que ser a mesma do faturamento.</span>
        </div>
      )}

      {unificados > 0 && (
        <div style={{ background: 'rgba(74,124,255,0.10)', border: `1px solid ${theme.accent}`, borderRadius: 12, display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', marginBottom: 12 }}>
          <i className="ti ti-arrows-join" style={{ color: theme.accent, fontSize: 18, marginTop: 1 }} />
          <span style={{ color: theme.text, fontSize: 13 }}>{unificados} {lab}(s) com nomes parecidos foram <b>unificados</b> — confira se é mesmo o mesmo {lab} (veja “nomes unidos” em cada card).</span>
        </div>
      )}

      {revs > 0 && (
        <div style={{ background: 'rgba(245,166,35,0.10)', border: `1px solid ${theme.yellow}`, borderRadius: 12, display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', marginBottom: 12 }}>
          <i className="ti ti-alert-triangle" style={{ color: theme.yellow, fontSize: 18 }} />
          <span style={{ color: theme.text, fontSize: 13 }}>{revs} lançamento(s) com leitura incerta — corrija o {lab} para o sistema aprender.</span>
        </div>
      )}

      {carregando ? (
        <p style={{ color: theme.sub, fontSize: 13 }}>Carregando…</p>
      ) : lista.length === 0 ? (
        <Aviso icon="ti-inbox" texto="Sem lançamentos nesta conta." />
      ) : lista.map((g, gi) => {
        const grp = g.lancs
        const gt = g.total
        const unk = g.unk
        const semTit = baixaSemTitulo(g) // baixas com NF que não casa com título
        const hasRev = grp.some(l => l.leitura.conf !== 'alta')
        const anom = gt < -0.005 // natureza invertida (cliente credor / fornecedor devedor)
        const borda = (anom || semTit.size > 0) ? theme.red : hasRev ? theme.yellow : theme.cb
        return (
          <div key={gi} style={{ background: theme.card, border: `1px solid ${borda}`, borderRadius: 12, overflow: 'hidden', marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '13px 16px', background: theme.input, flexWrap: 'wrap', gap: 8 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ color: unk ? theme.yellow : theme.text, fontSize: 14, fontWeight: 600, fontStyle: unk ? 'italic' : 'normal' }}>{g.nome}</span>
                {g.unido && <span title={`Nomes unidos: ${g.variacoes.join(' · ')}`} style={{ background: 'rgba(74,124,255,0.18)', color: theme.accent, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, textTransform: 'uppercase', letterSpacing: .3, cursor: 'help' }}><i className="ti ti-arrows-join" /> {g.variacoes.length} nomes unidos</span>}
                {anom && <span style={{ background: 'rgba(229,72,77,0.18)', color: theme.red, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, textTransform: 'uppercase', letterSpacing: .3 }}><i className="ti ti-alert-octagon" /> saldo {natAnom}</span>}
              </span>
              <span style={{ color: anom ? theme.red : theme.text, fontSize: 14, fontWeight: 600 }}>{money(gt)}</span>
            </div>
            {g.unido && (
              <div style={{ padding: '8px 16px', borderTop: `1px solid ${theme.border}`, background: 'rgba(74,124,255,0.05)', fontSize: 11.5, color: theme.sub }}>
                <i className="ti ti-arrows-join" style={{ color: theme.accent, marginRight: 6 }} />
                Unificado de: {g.variacoes.join(' · ')}
              </div>
            )}
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderTop: `1px solid ${theme.border}` }}>
                  <th style={th}>Data</th><th style={th}>NF</th><th style={th}>Histórico</th>
                  <th style={thR}>Débito</th><th style={thR}>Crédito</th><th style={{ ...th, textAlign: 'center' }}>Conf.</th>
                </tr>
              </thead>
              <tbody>
                {grp.map((l, i) => {
                  const rev = l.leitura.conf !== 'alta'
                  const semNF = semTit.has(l)
                  return (
                    <tr key={i} onClick={() => { setMsg(''); setAcao(l) }}
                      style={{ borderTop: `1px solid ${theme.border}`, cursor: 'pointer', background: semNF ? 'rgba(229,72,77,0.08)' : 'transparent' }}
                      title={semNF ? 'Baixa com NF que não confere com o título — justifique ou corrija' : 'Justificar ou corrigir este lançamento'}>
                      <td style={{ ...td, color: theme.sub, fontSize: 11, whiteSpace: 'nowrap' }}>{l.data || '—'}</td>
                      <td style={{ ...td, color: semNF ? theme.red : theme.sub, fontWeight: 600 }}>NF {l.leitura.nf || '—'}</td>
                      <td style={{ ...td, color: theme.sub, fontFamily: 'monospace', fontSize: 11, maxWidth: 320 }}>{l.historico}</td>
                      <td style={{ ...tdR, color: theme.green }}>{Number(l.debito) ? money(l.debito) : '—'}</td>
                      <td style={{ ...tdR, color: theme.red }}>{Number(l.credito) ? money(l.credito) : '—'}</td>
                      <td style={{ ...td, textAlign: 'center' }}>
                        {semNF
                          ? <span title="NF não confere com nenhum título" style={{ color: theme.red, fontSize: 10.5, fontWeight: 700 }}>NF s/ título</span>
                          : rev
                            ? <span style={{ color: theme.yellow, fontSize: 11, fontWeight: 600 }}>revisar</span>
                            : <span style={{ color: theme.green, fontSize: 14 }}><i className="ti ti-circle-check" /></span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      })}

      {acao && (
        <ModalLancamento lanc={acao} conta={conta} lab={lab} plano={plano}
          onClose={() => setAcao(null)} onRegistrar={registrar} />
      )}
    </Wrapper>
  )
}

// Menu de ação de um lançamento: Justificar (texto) ou Corrigir (já informa a partida
// contábil de acerto, que vai para o painel Contabilizar gerar o arquivo do Domínio).
function ModalLancamento({ lanc, conta, lab, plano, onClose, onRegistrar }) {
  const [tipo, setTipo] = useState(null) // 'Justificativa' | 'Correção'
  const [txt, setTxt] = useState('')
  const valorLan = Number(lanc.debito) || Number(lanc.credito) || 0
  const valor = Number(lanc.debito) ? `D ${money(lanc.debito)}` : Number(lanc.credito) ? `C ${money(lanc.credito)}` : ''
  // Sugestão de partida de acerto: a conta sendo conciliada entra como estorno do lado oposto ao original.
  const ehDeb = Number(lanc.debito) > 0
  const [form, setForm] = useState({
    data: lanc.data || '', valor: valorLan,
    conta_debito: ehDeb ? '' : conta.conta,
    conta_credito: ehDeb ? conta.conta : '',
    historico: `Ajuste conciliação · NF ${lanc.leitura.nf || '—'} · ${conta.nome}`,
  })
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }))
  const podeRegistrar = tipo === 'Justificativa' ? txt.trim() : (form.conta_debito && form.conta_credito && Number(form.valor) > 0)

  function registrar() {
    if (tipo === 'Justificativa') return onRegistrar('Justificativa', { detalhe: txt.trim() })
    onRegistrar('Correção', { detalhe: txt.trim() || form.historico, lancamento: form })
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(560px,96vw)', maxHeight: '90vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
        <h2 style={{ fontSize: 17, marginBottom: 4 }}>{tipo || 'Tratar lançamento'}</h2>
        <div style={{ background: theme.input, borderRadius: 10, padding: '10px 12px', margin: '8px 0 14px', fontSize: 12.5 }}>
          <span style={{ color: theme.sub }}>{lanc.data || '—'} · NF {lanc.leitura.nf || '—'} · {valor}</span>
          <div style={{ color: theme.sub, fontFamily: 'monospace', fontSize: 11, marginTop: 4 }}>{lanc.historico}</div>
        </div>

        {!tipo ? (
          <>
            <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 12 }}>O que você quer fazer com este lançamento?</p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setTipo('Justificativa')}><i className="ti ti-flag" /> Justificar</button>
              <button className="btn" style={{ flex: 1 }} onClick={() => setTipo('Correção')}><i className="ti ti-pencil-bolt" /> Corrigir</button>
            </div>
          </>
        ) : tipo === 'Justificativa' ? (
          <>
            <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 10 }}>Fica registrada na auditoria com seu usuário e a data.</p>
            <textarea className="input" rows={3} value={txt} onChange={e => setTxt(e.target.value)} autoFocus placeholder="Por que este lançamento está assim (variação esperada, etc.)…" />
          </>
        ) : (
          <>
            <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 12 }}>Informe a <b style={{ color: theme.text }}>partida de acerto</b>. Ela vai para o painel <b style={{ color: theme.text }}>Contabilizar</b> e entra no arquivo do Domínio. <span style={{ color: theme.accent }}>Sugestão pré-preenchida abaixo</span> — ajuste as contas.</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div><label>Data</label><input className="input" type="date" value={form.data} onChange={set('data')} /></div>
              <div><label>Valor</label><input className="input" type="number" step="0.01" value={form.valor} onChange={set('valor')} /></div>
              <div><label>Conta débito</label><ContaSelect value={form.conta_debito} onChange={set('conta_debito')} plano={plano} /></div>
              <div><label>Conta crédito</label><ContaSelect value={form.conta_credito} onChange={set('conta_credito')} plano={plano} /></div>
              <div style={{ gridColumn: '1 / -1' }}><label>Histórico</label><textarea className="input" rows={2} value={form.historico} onChange={set('historico')} /></div>
              <div style={{ gridColumn: '1 / -1' }}><label>Observação na auditoria (opcional)</label><input className="input" value={txt} onChange={e => setTxt(e.target.value)} placeholder="O que estava errado / o que foi corrigido…" /></div>
            </div>
          </>
        )}

        {tipo && (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 18 }}>
            <button className="btn btn-ghost" onClick={() => setTipo(null)}><i className="ti ti-chevron-left" /> Voltar</button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
              <button className="btn" disabled={!podeRegistrar} onClick={registrar}>Registrar</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ContaSelect({ value, onChange, plano }) {
  if (plano?.length) return (
    <select className="input" value={value} onChange={onChange}>
      <option value="">— conta —</option>
      {plano.map(p => <option key={p.cod} value={p.cod}>{p.cod} · {p.nome}</option>)}
    </select>
  )
  return <input className="input" value={value} onChange={onChange} placeholder="Código da conta" />
}

const numCell = v => { if (typeof v === 'number') return v; const s = String(v ?? '').trim(); if (/^-?[\d.]+,\d{2}$/.test(s)) return parseFloat(s.replace(/\./g, '').replace(',', '.')); const n = parseFloat(s.replace(/[^\d.-]/g, '')); return isNaN(n) ? 0 : n }
function Mini({ label, v, cor }) {
  return <div><p style={{ color: theme.sub, fontSize: 10.5, textTransform: 'uppercase', margin: 0 }}>{label}</p><p style={{ color: cor || theme.text, fontSize: 15, fontWeight: 600, margin: '2px 0 0' }}>{v}</p></div>
}

function ImpostoCards({ conta }) {
  const [mem, setMem] = useState(null)
  const [erro, setErro] = useState('')
  const baixaAnterior = Number(conta.saldo_inicial) || 0
  const recolhido = Number(conta.debito) || 0
  const baixaDif = baixaAnterior - recolhido
  const baixaOk = Math.abs(baixaDif) < 0.01
  const aRecolher = Number(conta.saldo_final) || 0

  async function aoEscolher(e) {
    const f = e.target.files?.[0]; if (!f) return; setErro('')
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' })
      const arr = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
      let tot = 0
      for (const r of arr) for (const c of r) { const n = numCell(c); if (n) { tot += n; break } }
      setMem({ nome: f.name, total: tot })
    } catch (err) { setErro('Não consegui ler: ' + err.message) }
  }

  const memDif = mem ? mem.total - aRecolher : 0
  const memOk = mem && Math.abs(memDif) < 0.01

  return (
    <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
      <div style={{ background: theme.card, border: `1px solid ${baixaOk ? 'rgba(48,164,108,0.4)' : 'rgba(229,72,77,0.4)'}`, borderRadius: 12, padding: 16 }}>
        <p style={{ fontSize: 14, fontWeight: 600, margin: '0 0 10px' }}>Baixa do imposto do mês anterior</p>
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
          <Mini label="Saldo anterior (a recolher)" v={money(baixaAnterior)} />
          <Mini label="Recolhido no mês (débito)" v={money(recolhido)} />
          <Mini label="Diferença" v={money(baixaDif)} cor={baixaOk ? theme.green : theme.red} />
        </div>
        <p style={{ fontSize: 12.5, color: baixaOk ? theme.green : theme.red, margin: '10px 0 0' }}>
          <i className={`ti ${baixaOk ? 'ti-circle-check' : 'ti-alert-triangle'}`} /> {baixaOk ? 'Baixa conferida — o imposto do mês anterior foi recolhido e zerou.' : 'Divergência na baixa — justifique ou corrija (gera D imposto / C banco).'}
        </p>
      </div>

      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 16 }}>
        <p style={{ fontSize: 14, fontWeight: 600, margin: '0 0 6px' }}>Memória de cálculo</p>
        <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 10px' }}>Importe a memória e compare com o balancete (imposto a recolher: {money(aRecolher)}).</p>
        <input type="file" accept=".xlsx,.xls,.csv" onChange={aoEscolher} style={{ fontSize: 13, color: theme.sub }} />
        {erro && <p style={{ color: theme.red, fontSize: 12.5, marginTop: 8 }}>{erro}</p>}
        {mem && (
          <div style={{ marginTop: 12 }}>
            <p style={{ color: theme.sub, fontSize: 12, margin: '0 0 8px' }}><i className="ti ti-file-spreadsheet" /> {mem.nome}</p>
            <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
              <Mini label="Memória" v={money(mem.total)} />
              <Mini label="Balancete" v={money(aRecolher)} />
              <Mini label="Diferença" v={money(memDif)} cor={memOk ? theme.green : theme.yellow} />
            </div>
            {memOk
              ? <p style={{ color: theme.green, fontSize: 12.5, margin: '10px 0 0' }}><i className="ti ti-circle-check" /> Memória bate com o balancete.</p>
              : <p style={{ color: theme.yellow, fontSize: 12.5, margin: '10px 0 0' }}><i className="ti ti-alert-triangle" /> Divergência: houve recolhimento no mês? houve PER/DCOMP? Justifique ou corrija acima.</p>}
          </div>
        )}
      </div>
    </div>
  )
}

const th ={ textAlign: 'left', padding: '11px 14px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3, whiteSpace: 'nowrap' }
const thR = { ...th, textAlign: 'right' }
const td = { padding: '11px 14px', fontSize: 12.5, color: theme.text, verticalAlign: 'top' }
const tdR = { ...td, textAlign: 'right', whiteSpace: 'nowrap' }

function Dot({ c }) { return <span style={{ display: 'inline-block', width: 11, height: 11, borderRadius: '50%', background: c }} /> }
function Tile({ label, v, cor }) {
  return (
    <div style={{ background: theme.input, borderRadius: 10, padding: 14 }}>
      <p style={{ color: theme.sub, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: .4, margin: 0 }}>{label}</p>
      <p style={{ color: cor || theme.text, fontSize: 15, fontWeight: 600, margin: '4px 0 0' }}>{v}</p>
    </div>
  )
}
function Wrapper({ children, nome, comp }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Conciliação de Contas</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 16 }}>
        {nome ? <>Estrutura de balancete (Ativo e Passivo) com contas sintéticas e analíticas. <b style={{ color: theme.text }}>{nome}</b> · {comp}. Clique numa conta analítica para ver a composição.</> : 'Estrutura de balancete (Ativo e Passivo).'}
      </p>
      {children}
    </div>
  )
}
function Aviso({ texto, icon = 'ti-building' }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '28px 24px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 580 }}>
      <i className={`ti ${icon}`} style={{ fontSize: 24, color: theme.accent }} />
      <p style={{ fontSize: 14, color: theme.text }}>{texto}</p>
    </div>
  )
}
