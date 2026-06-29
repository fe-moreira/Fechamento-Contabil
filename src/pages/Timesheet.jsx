import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { theme } from '../lib/theme'

const fmt = (s) => {
  s = Math.round(s || 0)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(sec).padStart(2, '0')}s`
}

export default function Timesheet() {
  const { empresaId, empresaNome } = useAppData()
  const [modo, setModo] = useState('todos') // 'todos' | 'cliente'
  const [linhas, setLinhas] = useState([])
  const [carregando, setCarregando] = useState(true)

  useEffect(() => {
    setCarregando(true)
    let q = supabase.from('timesheet').select('cliente_id, cliente_nome, segundos, clientes(razao_social)')
    if (modo === 'cliente' && empresaId) q = q.eq('cliente_id', empresaId)
    q.then(({ data }) => {
      const agg = {}
      for (const r of (data || [])) {
        const k = r.cliente_id || 'sem'
        const nome = r.clientes?.razao_social || r.cliente_nome || '(sem cliente)'
        const a = agg[k] || (agg[k] = { nome, segundos: 0, registros: 0 })
        a.segundos += r.segundos || 0; a.registros += 1
      }
      setLinhas(Object.values(agg).sort((a, b) => b.segundos - a.segundos))
      setCarregando(false)
    })
  }, [modo, empresaId])

  const total = linhas.reduce((s, l) => s + l.segundos, 0)

  function exportar() {
    const linhasCsv = [['Cliente', 'Tempo', 'Segundos', 'Registros'],
      ...linhas.map(l => [l.nome, fmt(l.segundos), l.segundos, l.registros])]
    const csv = '﻿' + linhasCsv.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
    a.download = `timesheet_${modo === 'cliente' ? 'cliente' : 'geral'}.csv`
    a.click(); URL.revokeObjectURL(a.href)
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 18 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Tempo por cliente (Timesheet)</h1>
          <p style={{ color: theme.sub, fontSize: 13 }}>Tempo trabalhado na plataforma, registrado automaticamente enquanto a empresa está ativa.</p>
        </div>
        <button className="btn" onClick={exportar} disabled={!linhas.length} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <i className="ti ti-file-spreadsheet" /> Exportar CSV
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
        <button className={modo === 'todos' ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 13 }} onClick={() => setModo('todos')}>Todos os clientes</button>
        <button className={modo === 'cliente' ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 13 }} onClick={() => setModo('cliente')} disabled={!empresaId}>
          Só {empresaNome || 'a empresa selecionada'}
        </button>
        <span style={{ marginLeft: 'auto', fontSize: 13, color: theme.sub }}>Total: <b style={{ color: theme.accent }}>{fmt(total)}</b></span>
      </div>

      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: theme.input }}>
              <th style={th}>Cliente</th>
              <th style={{ ...th, textAlign: 'right' }}>Tempo total</th>
              <th style={{ ...th, textAlign: 'right' }}>Registros</th>
            </tr>
          </thead>
          <tbody>
            {carregando ? (
              <tr><td colSpan={3} style={{ ...td, color: theme.sub }}>Carregando…</td></tr>
            ) : linhas.length === 0 ? (
              <tr><td colSpan={3} style={{ ...td, color: theme.sub }}>Ainda não há tempo registrado. Selecione uma empresa e trabalhe na plataforma — o tempo é contado sozinho.</td></tr>
            ) : linhas.map((l, i) => (
              <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                <td style={td}>{l.nome}</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{fmt(l.segundos)}</td>
                <td style={{ ...td, textAlign: 'right', color: theme.sub }}>{l.registros}</td>
              </tr>
            ))}
          </tbody>
          {linhas.length > 0 && (
            <tfoot>
              <tr style={{ borderTop: `1px solid ${theme.border}`, background: theme.input }}>
                <td style={{ ...td, fontWeight: 700 }}>Total geral</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{fmt(total)}</td>
                <td style={td} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  )
}

const th = { textAlign: 'left', padding: '11px 14px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3 }
const td = { padding: '11px 14px', fontSize: 13, color: theme.text }
