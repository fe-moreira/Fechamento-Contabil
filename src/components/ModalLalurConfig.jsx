import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { theme, money } from '../lib/theme'
import CampoConta from './CampoConta'

// Cadastro do Lucro Real (LALUR), por cliente. Define o que o card LALUR usa para
// calcular IRPJ/CSLL sobre o resultado acumulado do Comparativo:
//   • Prejuízo a compensar (saldo) — o cálculo aplica o limite de 30%.
//   • Contas de ADIÇÃO e EXCLUSÃO — o sistema soma os lançamentos dessas contas.
//   • Contas de IRRF (retido) e IRRF sobre aplicação financeira — abate do devido.
//   • Contas de contabilização — IRPJ/CSLL despesa e a pagar (a partida do lançamento).
// Guardado em cargas_cadastro (tipo 'lalur') como um objeto — sem vigência versionada
// (é configuração viva; a mais recente vale).

const num = v => { const s = String(v ?? '').replace(/[R$\s.]/g, '').replace(',', '.'); const n = parseFloat(s); return isNaN(n) ? 0 : n }

const CONFIG_VAZIA = { prejuizo: 0, adicao: [], exclusao: [], irrf: [], irrfAplic: [], contas: { irpjDesp: '', irpjPagar: '', csllDesp: '', csllPagar: '' } }

export default function ModalLalurConfig({ empresaId, usuario, competencia, inicial, regime, onClose, onSaved }) {
  const { plano } = useAppData()
  const nomeDe = cod => (plano || []).find(p => String(p.cod) === String(cod))?.nome || ''
  const base = inicial && typeof inicial === 'object' ? inicial : CONFIG_VAZIA
  const [cfg, setCfg] = useState({
    prejuizo: Number(base.prejuizo) || 0,
    adicao: Array.isArray(base.adicao) ? base.adicao : [],
    exclusao: Array.isArray(base.exclusao) ? base.exclusao : [],
    irrf: Array.isArray(base.irrf) ? base.irrf : [],
    irrfAplic: Array.isArray(base.irrfAplic) ? base.irrfAplic : [],
    contas: { ...CONFIG_VAZIA.contas, ...(base.contas || {}) },
  })
  const [salvando, setSalvando] = useState(false)
  const [msg, setMsg] = useState('')

  const setContaFinal = (k, v) => setCfg(c => ({ ...c, contas: { ...c.contas, [k]: v } }))

  async function salvar() {
    setSalvando(true); setMsg('')
    try {
      const limpa = arr => arr.filter(x => String(x.cod || '').trim())
      const dados = {
        prejuizo: Number(cfg.prejuizo) || 0,
        adicao: limpa(cfg.adicao), exclusao: limpa(cfg.exclusao),
        irrf: limpa(cfg.irrf), irrfAplic: limpa(cfg.irrfAplic),
        contas: cfg.contas,
      }
      const { data: ex } = await supabase.from('cargas_cadastro').select('id').eq('cliente_id', empresaId).eq('tipo', 'lalur')
      for (const r of (ex || [])) await supabase.from('cargas_cadastro').delete().eq('id', r.id)
      const { error } = await supabase.from('cargas_cadastro').insert({
        cliente_id: empresaId, tipo: 'lalur', vigencia: competencia || '—', dados, usuario, obs: 'Cadastro do Lucro Real',
      })
      if (error) throw error
      onSaved?.(); onClose()
    } catch (e) { setMsg('Erro ao salvar: ' + (e.message || e)); setSalvando(false) }
  }

  return (
    <div onClick={e => { if (e.target === e.currentTarget && !salvando) onClose() }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(720px,96vw)', maxHeight: '92vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <h2 style={{ fontSize: 18, margin: '0 0 3px' }}>Cadastro do Lucro Real (LALUR)</h2>
            <p style={{ color: theme.sub, fontSize: 12.5, margin: 0 }}>{regime || 'Lucro Real'} · alimenta o card LALUR (IRPJ/CSLL sobre o resultado acumulado do Comparativo).</p>
          </div>
          <i className="ti ti-x" onClick={() => !salvando && onClose()} style={{ cursor: 'pointer', color: theme.sub, fontSize: 20 }} />
        </div>

        {/* Prejuízo a compensar */}
        <Secao titulo="Prejuízo a compensar" dica="Saldo de prejuízos de exercícios anteriores. O cálculo aplica o limite de 30% do lucro fiscal.">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: theme.sub, fontSize: 13 }}>R$</span>
            <input className="input" style={{ maxWidth: 220 }} inputMode="decimal" value={cfg.prejuizo}
              onChange={e => setCfg(c => ({ ...c, prejuizo: e.target.value }))} onBlur={e => setCfg(c => ({ ...c, prejuizo: num(e.target.value) }))} placeholder="0,00" />
            <span style={{ color: theme.sub, fontSize: 12 }}>{money(num(cfg.prejuizo))}</span>
          </div>
        </Secao>

        {/* Adições e Exclusões */}
        <ListaContas titulo="Contas de ADIÇÃO" dica="Contas cujos lançamentos SOMAM ao lucro (adições). Você pode acrescentar itens manuais no card."
          itens={cfg.adicao} comTipo nomeDe={nomeDe} onChange={arr => setCfg(c => ({ ...c, adicao: arr }))} />
        <ListaContas titulo="Contas de EXCLUSÃO" dica="Contas cujos lançamentos DIMINUEM o lucro (exclusões)."
          itens={cfg.exclusao} comTipo nomeDe={nomeDe} onChange={arr => setCfg(c => ({ ...c, exclusao: arr }))} />

        {/* Retenções */}
        <ListaContas titulo="IRRF retido na fonte" dica="Conta(s) do IR retido na fonte — abate do IRPJ devido."
          itens={cfg.irrf} nomeDe={nomeDe} onChange={arr => setCfg(c => ({ ...c, irrf: arr }))} />
        <ListaContas titulo="IRRF sobre aplicação financeira" dica="Conta(s) do IR retido em aplicações financeiras."
          itens={cfg.irrfAplic} nomeDe={nomeDe} onChange={arr => setCfg(c => ({ ...c, irrfAplic: arr }))} />

        {/* Contabilização */}
        <Secao titulo="Contas de contabilização" dica="Onde o lançamento do imposto é contabilizado (partida dobrada). F4 abre o plano.">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
            <ContaFinal label="IRPJ — despesa" cod={cfg.contas.irpjDesp} nomeDe={nomeDe} onChange={v => setContaFinal('irpjDesp', v)} />
            <ContaFinal label="IRPJ — a pagar" cod={cfg.contas.irpjPagar} nomeDe={nomeDe} onChange={v => setContaFinal('irpjPagar', v)} />
            <ContaFinal label="CSLL — despesa" cod={cfg.contas.csllDesp} nomeDe={nomeDe} onChange={v => setContaFinal('csllDesp', v)} />
            <ContaFinal label="CSLL — a pagar" cod={cfg.contas.csllPagar} nomeDe={nomeDe} onChange={v => setContaFinal('csllPagar', v)} />
          </div>
        </Secao>

        {msg && <p style={{ color: theme.red, fontSize: 12.5, margin: '12px 0 0' }}><i className="ti ti-alert-triangle" /> {msg}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={salvando}>Cancelar</button>
          <button className="btn" onClick={salvar} disabled={salvando}>{salvando ? 'Salvando…' : 'Salvar cadastro'}</button>
        </div>
      </div>
    </div>
  )
}

function Secao({ titulo, dica, children }) {
  return (
    <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${theme.border}` }}>
      <p style={{ fontSize: 13.5, fontWeight: 600, margin: '0 0 2px' }}>{titulo}</p>
      {dica && <p style={{ color: theme.sub, fontSize: 12, margin: '0 0 10px' }}>{dica}</p>}
      {children}
    </div>
  )
}

// Lista editável de contas (código F4 + nome auto + opcional tipo Permanente/Temporário).
function ListaContas({ titulo, dica, itens, comTipo, nomeDe, onChange }) {
  const add = () => onChange([...itens, comTipo ? { cod: '', nome: '', tipo: 'Temporário' } : { cod: '', nome: '' }])
  const del = i => onChange(itens.filter((_, j) => j !== i))
  const setItem = (i, patch) => onChange(itens.map((x, j) => j === i ? { ...x, ...patch } : x))
  return (
    <Secao titulo={titulo} dica={dica}>
      {itens.length === 0 && <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 8px' }}>Nenhuma conta.</p>}
      <div style={{ display: 'grid', gap: 8 }}>
        {itens.map((it, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ width: 150 }}>
              <CampoConta value={it.cod} placeholder="Conta (F4)"
                onChange={v => setItem(i, { cod: v, nome: nomeDe(v) })}
                onPick={p => setItem(i, { cod: p.cod, nome: p.nome })} />
            </div>
            <span style={{ flex: 1, minWidth: 120, fontSize: 12.5, color: theme.sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.nome || nomeDe(it.cod) || '—'}</span>
            {comTipo && (
              <select className="input" style={{ width: 'auto', padding: '6px 8px', fontSize: 12 }} value={it.tipo || 'Temporário'} onChange={e => setItem(i, { tipo: e.target.value })}>
                <option>Temporário</option><option>Permanente</option>
              </select>
            )}
            <i className="ti ti-trash" onClick={() => del(i)} style={{ cursor: 'pointer', color: theme.sub, fontSize: 16 }} title="Remover" />
          </div>
        ))}
      </div>
      <button className="btn btn-ghost" style={{ fontSize: 12.5, marginTop: 8 }} onClick={add}><i className="ti ti-plus" /> Adicionar conta</button>
    </Secao>
  )
}

function ContaFinal({ label, cod, nomeDe, onChange }) {
  return (
    <div>
      <p style={{ fontSize: 12, color: theme.sub, margin: '0 0 4px' }}>{label}</p>
      <CampoConta value={cod} placeholder="Conta (F4)" onChange={onChange} onPick={p => onChange(p.cod)} />
      {cod && <p style={{ fontSize: 11, color: theme.sub, margin: '3px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nomeDe(cod) || '—'}</p>}
    </div>
  )
}
