import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { theme } from '../lib/theme'
import { gerarExcelTimbrado } from '../lib/excel'
import { abrePdfTimbrado } from '../lib/pdf'

// Relatórios que varrem TODOS os clientes de uma vez (sem entrar cliente por cliente).
// Primeiro relatório: pendências de documentação por cliente na competência escolhida.
export default function RelatoriosMassa() {
  const { empresas, competencia, competencias } = useAppData()
  const [comp, setComp] = useState(competencia)
  const [gerando, setGerando] = useState(false)
  const [res, setRes] = useState(null)  // { rows:[[cliente, doc]], nClientes, semFechamento }
  const [erro, setErro] = useState('')

  async function gerar() {
    setGerando(true); setErro(''); setRes(null)
    try {
      const [mes, ano] = comp.split('/').map(Number)
      const { data: comps, error } = await supabase.from('competencias')
        .select('cliente_id, documentos').eq('ano', ano).eq('mes', mes)
      if (error) throw error
      const byCli = {}; for (const c of (comps || [])) byCli[c.cliente_id] = c
      const rows = []
      const clientesPend = new Set()
      let semFechamento = 0
      const ordenadas = [...(empresas || [])].sort((a, b) => String(a.razao_social).localeCompare(String(b.razao_social), 'pt-BR'))
      for (const emp of ordenadas) {
        const c = byCli[emp.id]
        if (!c) { semFechamento++; continue }
        const docs = Array.isArray(c.documentos) ? c.documentos.filter(d => d && d.rec === false) : []
        for (const d of docs) { rows.push([emp.razao_social, d.name || '(sem nome)']); clientesPend.add(emp.id) }
      }
      setRes({ rows, nClientes: clientesPend.size, semFechamento })
    } catch (e) { setErro(String(e?.message || e)) } finally { setGerando(false) }
  }

  function exportar(fmt) {
    if (!res?.rows.length) return
    const titulo = `Pendências de documentação — competência ${comp}`
    const sub = `${res.nClientes} cliente(s) com pendência · ${res.rows.length} documento(s)`
    if (fmt === 'excel') {
      gerarExcelTimbrado({
        titulo, sub,
        colunas: [{ nome: 'Cliente', largura: 42 }, { nome: 'Documento pendente', largura: 52, wrap: true }],
        linhas: res.rows, totais: null, arquivo: `pendencias_documentacao_${comp.replace('/', '-')}.xlsx`, aba: 'Documentação',
      })
    } else {
      abrePdfTimbrado({ titulo, sub, colunas: [{ nome: 'Cliente' }, { nome: 'Documento pendente' }], linhas: res.rows })
    }
  }

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 9 }}>
        <i className="ti ti-report-analytics" style={{ color: theme.accent }} /> Relatórios em massa
      </h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 18 }}>
        Relatórios que varrem <b style={{ color: theme.text }}>todos os clientes</b> de uma vez — sem precisar entrar um por um.
      </p>

      {/* Bloco: Pendências de documentação */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '18px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 14 }}>
          <div style={{ width: 42, height: 42, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(74,124,255,0.12)', border: `0.5px solid ${theme.cb}` }}>
            <i className="ti ti-files" style={{ fontSize: 20, color: theme.accent }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Pendências de documentação</p>
            <p style={{ fontSize: 12.5, color: theme.sub, margin: '3px 0 0' }}>Lista, por cliente, os documentos ainda não recebidos/conferidos na competência.</p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <label>Competência</label>
            <select className="input" style={{ width: 'auto', padding: '9px 12px' }} value={comp} onChange={e => { setComp(e.target.value); setRes(null) }}>
              {(competencias || []).map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <button className="btn" disabled={gerando} onClick={gerar}>
            <i className="ti ti-search" /> {gerando ? 'Gerando…' : 'Gerar relatório'}
          </button>
        </div>

        {erro && <p style={{ color: theme.red, fontSize: 12.5, margin: '12px 0 0' }}><i className="ti ti-alert-triangle" /> {erro}</p>}

        {res && (
          <div style={{ marginTop: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
              <p style={{ fontSize: 13, color: theme.sub, margin: 0 }}>
                <b style={{ color: theme.text }}>{res.nClientes}</b> cliente(s) com pendência · <b style={{ color: theme.text }}>{res.rows.length}</b> documento(s){res.semFechamento ? ` · ${res.semFechamento} sem fechamento nesta competência` : ''}
              </p>
              {res.rows.length > 0 && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-ghost" style={{ fontSize: 12.5, padding: '6px 12px' }} onClick={() => exportar('excel')}><i className="ti ti-file-spreadsheet" /> Excel</button>
                  <button className="btn btn-ghost" style={{ fontSize: 12.5, padding: '6px 12px' }} onClick={() => exportar('pdf')}><i className="ti ti-file-type-pdf" /> PDF</button>
                </div>
              )}
            </div>

            {res.rows.length === 0 ? (
              <p style={{ color: theme.green, fontSize: 13.5, margin: 0 }}><i className="ti ti-circle-check" /> Nenhuma pendência de documentação nesta competência. 🎉</p>
            ) : (
              <div style={{ overflowX: 'auto', border: `0.5px solid ${theme.cb}`, borderRadius: 10 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
                  <thead>
                    <tr style={{ background: theme.input }}>
                      <th style={thS}>Cliente</th><th style={thS}>Documento pendente</th>
                    </tr>
                  </thead>
                  <tbody>
                    {res.rows.map((r, i) => (
                      <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                        <td style={{ ...tdS, fontWeight: 600 }}>{r[0]}</td>
                        <td style={{ ...tdS, color: theme.sub }}>{r[1]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const thS = { textAlign: 'left', padding: '10px 12px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3, whiteSpace: 'nowrap' }
const tdS = { padding: '9px 12px', fontSize: 13, color: theme.text, verticalAlign: 'top' }
