import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import { theme, money } from '../lib/theme'

// ---- Leitura do histórico: extrai NF e entidade (cliente/fornecedor) com confiança ----
const RUIDO = /\b(VENDA|VENDAS|COMPRA|COMPRAS|PAGTO|PAGAMENTO|RECEBIMENTO|RECEBTO|REF|REFERENTE|NOTA|FISCAL|DUPLICATA|DUPL|BOLETO|TITULO|TÍTULO|VLR|VALOR|PARCELA|PARC|CONF|S\/|A|DE|DA|DO|DOS|DAS|E|NO|NA|EM)\b/ig
function lerHistorico(h) {
  const s = String(h || '').trim()
  const nfm = s.match(/\bN[ºo°]?\.?\s*F?-?[Ee]?\.?\s*[:nº]*\s*(\d{2,9})/i) || s.match(/\bNOTA\s*(?:FISCAL)?\s*N?[ºo°]?\.?\s*(\d{2,9})/i)
  const nf = nfm ? nfm[1] : (s.match(/\b(\d{3,9})\b/)?.[1] || '')
  const entidade = s.replace(nfm ? nfm[0] : '', ' ').replace(/\b\d+\b/g, ' ').replace(RUIDO, ' ').replace(/[.\-/]+/g, ' ').replace(/\s+/g, ' ').trim()
  let conf = 'baixa'
  if (entidade.length >= 4 && nf) conf = 'alta'
  else if (entidade.length >= 4 || nf) conf = 'media'
  return { nf, entidade: entidade || '(não identificado)', conf }
}

function tipoConta(nome) {
  const n = (nome || '').toLowerCase()
  if (/(icms|pis|cofins|iss|imposto|tribut|darf|das\b)/.test(n)) return 'Imposto'
  if (/(cliente|duplicata|receber|fornecedor|pagar|estoque|mercadoria)/.test(n)) return 'Composição'
  return 'Saldo'
}
const CONF = {
  alta: { cor: theme.green, txt: 'alta' },
  media: { cor: theme.yellow, txt: 'média' },
  baixa: { cor: theme.red, txt: 'baixa' },
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
        const { data } = await supabase.from('balancete').select('conta, nome, saldo_inicial, debito, credito, saldo_final')
          .eq('competencia_id', comp.id).order('conta')
        setContas((data || []).map(b => ({ ...b, tipo: tipoConta(b.nome || b.conta) })))
        setCarregando(false)
      })
  }, [empresaId, competencia])

  if (!empresaId) return <Wrapper><Aviso texto="Selecione uma empresa no menu lateral." /></Wrapper>
  if (carregando) return <Wrapper><p style={{ color: theme.sub, fontSize: 13 }}>Carregando…</p></Wrapper>
  if (!compId || contas.length === 0) return <Wrapper><Aviso icon="ti-table-off" texto="Nenhum balancete nesta competência. Importe o razão primeiro." /></Wrapper>

  if (sel) return <Detalhe conta={sel} compId={compId} usuario={user?.email} getCompetenciaId={getCompetenciaId} onVoltar={() => setSel(null)} />

  const farol = (c) => Math.abs(c.saldo_final) < 0.01 ? theme.green : Math.abs(c.saldo_final) < 1000 ? theme.yellow : theme.red

  return (
    <Wrapper nome={empresaNome} comp={competencia}>
      <div style={{ display: 'flex', gap: 16, marginBottom: 14, fontSize: 12, color: theme.sub }}>
        <span><Dot c={theme.red} /> Não conciliada</span>
        <span><Dot c={theme.yellow} /> Sem documento</span>
        <span><Dot c={theme.green} /> Conciliada</span>
      </div>
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
        <table style={{ width: '100%', minWidth: 760, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: theme.input }}>
              <th style={th}>Conta</th><th style={thR}>Saldo inicial</th><th style={thR}>Débito</th>
              <th style={thR}>Crédito</th><th style={thR}>Saldo atual</th><th style={th}>Tipo</th><th style={{ ...th, textAlign: 'center' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {contas.map((c, i) => (
              <tr key={i} onClick={() => setSel(c)} style={{ borderTop: `1px solid ${theme.border}`, cursor: 'pointer' }}>
                <td style={td}><span style={{ color: theme.sub, fontSize: 11 }}>{c.conta}</span><br />{c.nome}</td>
                <td style={tdR}>{money(c.saldo_inicial)}</td>
                <td style={tdR}>{money(c.debito)}</td>
                <td style={tdR}>{money(c.credito)}</td>
                <td style={{ ...tdR, fontWeight: 600 }}>{money(c.saldo_final)}</td>
                <td style={td}>{c.tipo}</td>
                <td style={{ ...td, textAlign: 'center' }}><Dot c={farol(c)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Wrapper>
  )
}

function Detalhe({ conta, compId, usuario, getCompetenciaId, onVoltar }) {
  const [lanc, setLanc] = useState([])
  const [carregando, setCarregando] = useState(true)
  const [modal, setModal] = useState(null) // 'just' | 'corr'
  const [msg, setMsg] = useState('')

  useEffect(() => {
    setCarregando(true)
    supabase.from('razao').select('data, historico, debito, credito').eq('competencia_id', compId).eq('conta', conta.conta).order('data')
      .then(({ data }) => { setLanc((data || []).map(l => ({ ...l, leitura: lerHistorico(l.historico) }))); setCarregando(false) })
  }, [compId, conta.conta])

  const somaComp = lanc.reduce((s, l) => s + (Number(l.debito) || 0) - (Number(l.credito) || 0), 0)
  const dif = conta.saldo_final - somaComp

  async function registrar(tipo, detalhe) {
    const id = await getCompetenciaId()
    await supabase.from('auditoria').insert({ competencia_id: id, modulo: 'Conciliação', item: `${conta.conta} · ${conta.nome}`, tipo, detalhe, usuario })
    setMsg(`${tipo} registrada na auditoria.`); setModal(null)
  }

  return (
    <Wrapper>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span onClick={onVoltar} style={{ color: '#8FB0FF', fontSize: 13, cursor: 'pointer' }}><i className="ti ti-chevron-left" /> Conciliação</span>
          <span style={{ color: theme.sub }}>/</span>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{conta.conta} · {conta.nome}</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => setModal('just')}><i className="ti ti-flag" /> Justificar</button>
          <button className="btn" style={{ fontSize: 13 }} onClick={() => setModal('corr')}><i className="ti ti-pencil-bolt" /> Corrigir</button>
        </div>
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

      {/* Composição lida do histórico */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
        <div style={{ padding: '12px 16px', fontSize: 12.5, color: theme.sub }}>
          {conta.tipo === 'Composição' ? 'Composição lida do histórico (cliente/fornecedor e NF). Confiança baixa → revise em “Corrigir”.' : 'Lançamentos do razão (conta de saldo).'}
        </div>
        <table style={{ width: '100%', minWidth: 720, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: theme.input }}>
              <th style={th}>Data</th><th style={th}>NF</th><th style={th}>Cliente/Fornecedor (lido)</th>
              <th style={th}>Histórico</th><th style={thR}>Débito</th><th style={thR}>Crédito</th><th style={{ ...th, textAlign: 'center' }}>Confiança</th>
            </tr>
          </thead>
          <tbody>
            {carregando ? (
              <tr><td colSpan={7} style={{ ...td, color: theme.sub }}>Carregando…</td></tr>
            ) : lanc.length === 0 ? (
              <tr><td colSpan={7} style={{ ...td, color: theme.sub }}>Sem lançamentos nesta conta.</td></tr>
            ) : lanc.map((l, i) => (
              <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{l.data || ''}</td>
                <td style={td}>{l.leitura.nf || '—'}</td>
                <td style={td}>{l.leitura.entidade}</td>
                <td style={{ ...td, maxWidth: 280, color: theme.sub }}>{l.historico}</td>
                <td style={tdR}>{Number(l.debito) ? money(l.debito) : ''}</td>
                <td style={tdR}>{Number(l.credito) ? money(l.credito) : ''}</td>
                <td style={{ ...td, textAlign: 'center' }}><span style={{ color: CONF[l.leitura.conf].cor, fontSize: 11.5, fontWeight: 600 }}>{CONF[l.leitura.conf].txt}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal && (
        <ModalRegistro tipo={modal === 'just' ? 'Justificativa' : 'Correção'} onClose={() => setModal(null)}
          onConfirmar={txt => registrar(modal === 'just' ? 'Justificativa' : 'Correção', txt)} />
      )}
    </Wrapper>
  )
}

function ModalRegistro({ tipo, onClose, onConfirmar }) {
  const [txt, setTxt] = useState('')
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(480px,96vw)', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
        <h2 style={{ fontSize: 17, marginBottom: 4 }}>{tipo}</h2>
        <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 14 }}>Fica registrada na auditoria com seu usuário e a data.</p>
        <textarea className="input" rows={3} value={txt} onChange={e => setTxt(e.target.value)} autoFocus placeholder={tipo === 'Correção' ? 'O que foi corrigido (ex.: reclassificação, leitura do histórico)…' : 'Por que esta conta está assim…'} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn" onClick={() => txt.trim() && onConfirmar(txt.trim())}>Registrar</button>
        </div>
      </div>
    </div>
  )
}

const th = { textAlign: 'left', padding: '11px 14px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3, whiteSpace: 'nowrap' }
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
        {nome ? <>Saldo inicial + movimento = saldo atual. <b style={{ color: theme.text }}>{nome}</b> · {comp}. Clique numa conta para ver a composição.</> : 'Saldo inicial + movimento = saldo atual.'}
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
