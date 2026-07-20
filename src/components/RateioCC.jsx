import { useEffect } from 'react'
import { theme, money } from '../lib/theme'

// Rateio de centro de custo de um lançamento (só conta de resultado exige — ver
// `lancamentoExigeCC`). value = array [{cod, nome, valor}]: um centro com o valor cheio, ou
// vários centros somando o valor do lançamento (rateio). `centros` = [{cod, nome}] do cadastro.
export default function RateioCC({ valor, value, onChange, centros = [] }) {
  const total = Number(valor) || 0
  const rows = Array.isArray(value) && value.length ? value : [{ cod: '', nome: '', valor: total }]
  const semCadastro = !centros.length
  const nomeDe = cod => centros.find(c => String(c.cod) === String(cod))?.nome || ''

  // Com um único centro, o valor é sempre o total do lançamento (mantém sincronizado quando
  // o valor do lançamento muda). No rateio (>1), cada centro tem o seu próprio valor.
  useEffect(() => {
    if (rows.length <= 1) {
      const r = rows[0] || {}
      if (Math.abs((Number(r.valor) || 0) - total) >= 0.005) {
        onChange([{ cod: r.cod || '', nome: r.nome || nomeDe(r.cod), valor: total }])
      }
    }
  }, [total]) // eslint-disable-line react-hooks/exhaustive-deps

  const emit = novo => onChange(novo.length ? novo : [{ cod: '', nome: '', valor: total }])
  const setRow = (i, patch) => emit(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const addRow = () => onChange([...rows, { cod: '', nome: '', valor: 0 }])
  const delRow = i => emit(rows.filter((_, j) => j !== i))

  const soma = Math.round(rows.reduce((s, r) => s + (Number(r.valor) || 0), 0) * 100) / 100
  const bate = Math.abs(soma - total) < 0.005
  const multi = rows.length > 1

  return (
    <div style={{ gridColumn: '1 / -1', border: `1px solid ${theme.cb}`, borderRadius: 10, padding: 12, background: theme.input }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
        <label style={{ margin: 0 }}>Centro de custo <span style={{ color: theme.red }}>*</span></label>
        {!semCadastro && (
          <button type="button" className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={addRow}>
            <i className="ti ti-plus" /> Ratear em outro centro
          </button>
        )}
      </div>
      {semCadastro ? (
        <p style={{ color: theme.red, fontSize: 12.5, margin: 0 }}>
          <i className="ti ti-alert-triangle" /> Nenhum centro de custo cadastrado para este cliente. Cadastre em <b>Base de Informações → Centro de custo</b> para poder lançar.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select className="input" value={r.cod} onChange={e => setRow(i, { cod: e.target.value, nome: nomeDe(e.target.value) })} style={{ flex: 1, minWidth: 0 }}>
                <option value="">— escolha o centro —</option>
                {centros.map(c => (
                  <option key={c.cod} value={c.cod}>{c.cod} · {c.nome || 'sem nome'}</option>
                ))}
              </select>
              {multi && (
                <input className="input" type="number" step="0.01" value={r.valor} onChange={e => setRow(i, { valor: e.target.value })} style={{ width: 130 }} placeholder="Valor" />
              )}
              {multi && (
                <i className="ti ti-trash" title="Remover este centro" onClick={() => delRow(i)} style={{ color: theme.red, cursor: 'pointer' }} />
              )}
            </div>
          ))}
          {multi && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: bate ? theme.sub : theme.red, fontWeight: 600 }}>
              <span>Soma dos centros</span>
              <span>{money(soma)} / {money(total)} {bate ? '✓' : '⚠ precisa bater com o valor'}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
