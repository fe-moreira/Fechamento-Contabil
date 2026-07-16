import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { theme } from '../lib/theme'
import { gerarExcelTimbrado } from '../lib/excel'

const fmt = (s) => {
  s = Math.round(s || 0)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(sec).padStart(2, '0')}s`
}

const MES_NOME = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']
const mesCorrente = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}` }
const rotuloMes = mes => { if (!mes) return 'todos os períodos'; const [y, m] = mes.split('-'); return `${MES_NOME[+m - 1]}/${y}` }

export default function Timesheet() {
  const { empresaId, empresaNome } = useAppData()
  const [modo, setModo] = useState('todos') // 'todos' | 'cliente'
  const [mes, setMes] = useState(mesCorrente()) // 'YYYY-MM' ou '' (todos os períodos)
  const [linhas, setLinhas] = useState([])
  const [carregando, setCarregando] = useState(true)

  useEffect(() => {
    let vivo = true
    setCarregando(true)
    // O Supabase devolve no máximo 1000 linhas por consulta. A timesheet tem milhares de
    // registros/mês, então PAGINAMOS (range) até trazer tudo — senão a agregação por cliente
    // fica incompleta e clientes com muitos registros (ex.: Eletros) somem do relatório.
    const construir = () => {
      let q = supabase.from('timesheet').select('cliente_id, cliente_nome, segundos, clientes(razao_social)')
        .order('created_at', { ascending: true })
      if (modo === 'cliente' && empresaId) q = q.eq('cliente_id', empresaId)
      if (mes) {
        const [y, m] = mes.split('-').map(Number)
        q = q.gte('created_at', new Date(y, m - 1, 1).toISOString()).lt('created_at', new Date(y, m, 1).toISOString())
      }
      return q
    }
    ;(async () => {
      const SIZE = 1000; let from = 0; const todas = []
      while (true) {
        const { data, error } = await construir().range(from, from + SIZE - 1)
        if (error || !data) break
        todas.push(...data)
        if (data.length < SIZE) break
        from += SIZE
      }
      if (!vivo) return
      const agg = {}
      for (const r of todas) {
        const k = r.cliente_id || 'sem'
        const nome = r.clientes?.razao_social || r.cliente_nome || '(sem cliente)'
        const a = agg[k] || (agg[k] = { nome, segundos: 0, registros: 0 })
        if (!a.nome || a.nome === '(sem cliente)') a.nome = nome // preenche o nome se a 1ª linha veio vazia
        a.segundos += r.segundos || 0; a.registros += 1
      }
      setLinhas(Object.values(agg).sort((a, b) => b.segundos - a.segundos))
      setCarregando(false)
    })()
    return () => { vivo = false }
  }, [modo, empresaId, mes])

  const total = linhas.reduce((s, l) => s + l.segundos, 0)

  function exportar() {
    gerarExcelTimbrado({
      titulo: 'Tempo por cliente (Timesheet)',
      sub: `${modo === 'cliente' ? (empresaNome || 'Empresa selecionada') : 'Todos os clientes'} · ${rotuloMes(mes)}`,
      colunas: [
        { nome: 'Cliente', largura: 44 },
        { nome: 'Tempo total', alinhar: 'right', largura: 18 },
        { nome: 'Segundos', alinhar: 'right', largura: 14 },
        { nome: 'Registros', alinhar: 'right', largura: 14 },
      ],
      linhas: linhas.map(l => [l.nome, fmt(l.segundos), l.segundos, l.registros]),
      totais: ['Total geral', fmt(total), total, linhas.reduce((s, l) => s + l.registros, 0)],
      arquivo: `timesheet_${modo === 'cliente' ? 'cliente' : 'geral'}_${mes || 'todos'}.xlsx`,
      aba: 'Timesheet',
    })
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 18 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Tempo por cliente (Timesheet)</h1>
          <p style={{ color: theme.sub, fontSize: 13 }}>Tempo trabalhado na plataforma, registrado automaticamente enquanto a empresa está ativa.</p>
        </div>
        <button className="btn" onClick={exportar} disabled={!linhas.length} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <i className="ti ti-file-spreadsheet" /> Exportar Excel
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className={modo === 'todos' ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 13 }} onClick={() => setModo('todos')}>Todos os clientes</button>
        <button className={modo === 'cliente' ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 13 }} onClick={() => setModo('cliente')} disabled={!empresaId}>
          Só {empresaNome || 'a empresa selecionada'}
        </button>
        <span style={{ width: 1, height: 24, background: theme.border, margin: '0 4px' }} />
        <i className="ti ti-calendar-month" style={{ color: theme.sub }} />
        <input type="month" className="input" value={mes} onChange={e => setMes(e.target.value)} style={{ width: 168, fontSize: 13 }} title="Mês do relatório" />
        <button className={mes ? 'btn btn-ghost' : 'btn'} style={{ fontSize: 13 }} onClick={() => setMes('')}>Todos os períodos</button>
        <span style={{ marginLeft: 'auto', fontSize: 13, color: theme.sub }}>{rotuloMes(mes)} · Total: <b style={{ color: theme.accent }}>{fmt(total)}</b></span>
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
