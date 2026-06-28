import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { theme, money } from '../lib/theme'

const ANO = 2026
const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']

export default function CompMovimento() {
  const { empresaId, empresaNome } = useAppData()

  const [carregando, setCarregando] = useState(false)
  const [comps, setComps] = useState([])        // [{ id, mes }] dos meses com balancete
  const [contas, setContas] = useState([])      // [{ conta, nome }] união de contas
  const [matriz, setMatriz] = useState({})      // { conta: { mes: saldo_final } }
  const [detalhe, setDetalhe] = useState(null)  // { conta, nome, mes, compId }

  useEffect(() => {
    setComps([]); setContas([]); setMatriz({}); setDetalhe(null)
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
        const nomesPorConta = {}
        const m = {}

        for (const c of competencias) {
          const { data: bal } = await supabase
            .from('balancete').select('conta, nome, saldo_final')
            .eq('competencia_id', c.id)
          if (!vivo) return
          if (!bal || !bal.length) continue

          compsComDados.push({ id: c.id, mes: c.mes })
          for (const b of bal) {
            if (!b.conta) continue
            if (!m[b.conta]) m[b.conta] = {}
            m[b.conta][c.mes] = Number(b.saldo_final) || 0
            if (b.nome && !nomesPorConta[b.conta]) nomesPorConta[b.conta] = b.nome
          }
        }

        if (!vivo) return
        const listaContas = Object.keys(m)
          .sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }))
          .map(conta => ({ conta, nome: nomesPorConta[conta] || '' }))

        setComps(compsComDados)
        setContas(listaContas)
        setMatriz(m)
      } finally {
        if (vivo) setCarregando(false)
      }
    })()
    return () => { vivo = false }
  }, [empresaId])

  // Uma célula desvia se difere mais de 10% da média da conta nos meses carregados.
  function desviante(conta, valor) {
    const linha = matriz[conta] || {}
    const valores = comps.map(c => linha[c.mes]).filter(v => v != null)
    if (valores.length < 2) return false
    const media = valores.reduce((s, v) => s + v, 0) / valores.length
    if (media === 0) return valor !== 0
    return Math.abs(valor - media) / Math.abs(media) > 0.1
  }

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
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 18 }}>
        <b style={{ color: theme.text }}>{empresaNome}</b> · ano <b style={{ color: theme.text }}>{ANO}</b>
      </p>

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
          <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 14 }}>
            Valores em <b style={{ color: theme.red }}>vermelho</b> desviam mais de 10% da média da conta nos meses carregados. Clique em um valor para ver o razão da conta no mês.
          </p>
          <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto', maxWidth: '100%' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr style={{ background: theme.input }}>
                  <th style={{ ...th, position: 'sticky', left: 0, background: theme.input, minWidth: 220 }}>Conta</th>
                  {comps.map(c => (
                    <th key={c.mes} style={{ ...th, textAlign: 'right' }}>{MESES[c.mes - 1]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {contas.map(({ conta, nome }) => {
                  const linha = matriz[conta] || {}
                  return (
                    <tr key={conta} style={{ borderTop: `1px solid ${theme.border}` }}>
                      <td style={{ ...td, position: 'sticky', left: 0, background: theme.card, maxWidth: 260 }}>
                        <span style={{ color: theme.text }}>{conta}</span>
                        {nome && <span style={{ color: theme.sub }}> · {nome}</span>}
                      </td>
                      {comps.map(c => {
                        const v = linha[c.mes]
                        if (v == null) return <td key={c.mes} style={{ ...td, textAlign: 'right' }} />
                        const red = desviante(conta, v)
                        return (
                          <td key={c.mes} style={{ ...td, textAlign: 'right' }}>
                            <button
                              onClick={() => setDetalhe({ conta, nome, mes: c.mes, compId: c.id })}
                              style={{
                                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                                fontSize: 12.5, fontFamily: 'inherit',
                                color: red ? theme.red : theme.text,
                                fontWeight: red ? 700 : 400,
                              }}
                              title="Ver razão da conta neste mês"
                            >
                              {money(v)}
                            </button>
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {detalhe && <ModalRazao detalhe={detalhe} onClose={() => setDetalhe(null)} />}
    </Wrapper>
  )
}

function ModalRazao({ detalhe, onClose }) {
  const { conta, nome, mes, compId } = detalhe
  const [carregando, setCarregando] = useState(true)
  const [linhas, setLinhas] = useState([])

  useEffect(() => {
    let vivo = true
    ;(async () => {
      setCarregando(true)
      const { data } = await supabase
        .from('razao').select('data, conta, historico, debito, credito')
        .eq('competencia_id', compId).eq('conta', conta)
        .order('data', { ascending: true })
      if (!vivo) return
      setLinhas(data || [])
      setCarregando(false)
    })()
    return () => { vivo = false }
  }, [compId, conta])

  let saldo = 0
  const totDeb = linhas.reduce((s, l) => s + (Number(l.debito) || 0), 0)
  const totCred = linhas.reduce((s, l) => s + (Number(l.credito) || 0), 0)

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
                    <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{l.data || ''}</td>
                      <td style={{ ...td, maxWidth: 360 }}>{l.historico || ''}</td>
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
