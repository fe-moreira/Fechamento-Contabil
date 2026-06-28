import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { theme, money } from '../lib/theme'

// Valor pt-BR para CSV ("1234.56" -> "1234,56").
function csvNum(v) {
  return (Number(v) || 0).toFixed(2).replace('.', ',')
}

// Escapa um campo de CSV (separador ';').
function csvCampo(v) {
  const s = String(v ?? '')
  if (s.includes(';') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

// Gera e baixa um CSV (separador ';', BOM, decimais pt-BR) via Blob + <a> temporário.
function baixarCSV(nome, linhas) {
  const conteudo = '﻿' + linhas.map(l => l.map(csvCampo).join(';')).join('\r\n')
  const blob = new Blob([conteudo], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = nome
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export default function Relatorios() {
  const { empresaId, empresaNome, competencia } = useAppData()
  const [carregando, setCarregando] = useState(false)
  const [temComp, setTemComp] = useState(null) // null = não checado, false = sem competência
  const [linhas, setLinhas] = useState([])
  const [aba, setAba] = useState('balancete')

  // Resolve a competência (READ-ONLY) e lê o balancete.
  useEffect(() => {
    setLinhas([]); setTemComp(null)
    if (!empresaId) return
    let vivo = true
    ;(async () => {
      setCarregando(true)
      try {
        const [mes, ano] = competencia.split('/').map(Number)
        const { data: comp } = await supabase.from('competencias').select('id')
          .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
        if (!vivo) return
        if (!comp) { setTemComp(false); return }
        setTemComp(true)
        const { data } = await supabase.from('balancete')
          .select('conta, nome, saldo_inicial, debito, credito, saldo_final')
          .eq('competencia_id', comp.id)
          .order('conta', { ascending: true })
        if (vivo) setLinhas(data || [])
      } finally {
        if (vivo) setCarregando(false)
      }
    })()
    return () => { vivo = false }
  }, [empresaId, competencia])

  if (!empresaId) {
    return (
      <Wrapper>
        <Aviso icon="ti-building" texto="Selecione uma empresa no menu lateral." />
      </Wrapper>
    )
  }

  const compSlug = competencia.replace('/', '-')

  // Totais do balancete.
  const totDeb = linhas.reduce((s, l) => s + (Number(l.debito) || 0), 0)
  const totCred = linhas.reduce((s, l) => s + (Number(l.credito) || 0), 0)

  // DRE simplificada por prefixo de conta.
  const receitas = linhas.filter(l => String(l.conta || '').startsWith('3'))
    .reduce((s, l) => s + (Number(l.saldo_final) || 0), 0)
  const despesas = linhas.filter(l => String(l.conta || '').startsWith('4'))
    .reduce((s, l) => s + (Number(l.saldo_final) || 0), 0)
  const custos = linhas.filter(l => String(l.conta || '').startsWith('5'))
    .reduce((s, l) => s + (Number(l.saldo_final) || 0), 0)
  const resultado = receitas - despesas - custos

  function exportarBalancete() {
    const dados = [
      ['Conta', 'Nome', 'Saldo inicial', 'Débito', 'Crédito', 'Saldo final'],
      ...linhas.map(l => [
        l.conta, l.nome, csvNum(l.saldo_inicial), csvNum(l.debito), csvNum(l.credito), csvNum(l.saldo_final),
      ]),
      ['', 'TOTAIS', '', csvNum(totDeb), csvNum(totCred), ''],
    ]
    baixarCSV(`balancete_${compSlug}.csv`, dados)
  }

  function exportarDRE() {
    const dados = [
      ['Grupo', 'Valor'],
      ['Receitas', csvNum(receitas)],
      ['(-) Despesas', csvNum(despesas)],
      ['(-) Custos/Outras', csvNum(custos)],
      ['Resultado', csvNum(resultado)],
    ]
    baixarCSV(`dre_${compSlug}.csv`, dados)
  }

  const vazio = !carregando && temComp && linhas.length === 0

  return (
    <Wrapper>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 18 }}>
        <b style={{ color: theme.text }}>{empresaNome}</b> · competência <b style={{ color: theme.text }}>{competencia}</b>
      </p>

      {/* Abas */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        <button
          className={aba === 'balancete' ? 'btn' : 'btn-ghost'}
          onClick={() => setAba('balancete')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
        >
          <i className="ti ti-table" /> Balancete
        </button>
        <button
          className={aba === 'dre' ? 'btn' : 'btn-ghost'}
          onClick={() => setAba('dre')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
        >
          <i className="ti ti-report-money" /> DRE (resumo)
        </button>
      </div>

      {carregando && <p style={{ color: theme.sub, fontSize: 13 }}>Carregando…</p>}

      {temComp === false && (
        <Aviso icon="ti-file-import" texto="Importe o razão primeiro." />
      )}

      {vazio && (
        <Aviso icon="ti-database-off" texto="Sem dados no balancete desta competência. Importe o razão primeiro." />
      )}

      {/* Balancete */}
      {!carregando && temComp && linhas.length > 0 && aba === 'balancete' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button className="btn-ghost" onClick={exportarBalancete} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <i className="ti ti-download" /> Exportar CSV
            </button>
          </div>
          <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: theme.input }}>
                  <th style={th}>Conta</th>
                  <th style={th}>Nome</th>
                  <th style={thNum}>Saldo inicial</th>
                  <th style={thNum}>Débito</th>
                  <th style={thNum}>Crédito</th>
                  <th style={thNum}>Saldo final</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((l, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                    <td style={td}>{l.conta}</td>
                    <td style={td}>{l.nome || '—'}</td>
                    <td style={tdNum}>{money(l.saldo_inicial)}</td>
                    <td style={tdNum}>{money(l.debito)}</td>
                    <td style={tdNum}>{money(l.credito)}</td>
                    <td style={tdNum}>{money(l.saldo_final)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: `1px solid ${theme.border}`, background: theme.input }}>
                  <td style={{ ...td, fontWeight: 700 }} colSpan={3}>Totais</td>
                  <td style={{ ...tdNum, fontWeight: 700 }}>{money(totDeb)}</td>
                  <td style={{ ...tdNum, fontWeight: 700 }}>{money(totCred)}</td>
                  <td style={tdNum}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}

      {/* DRE */}
      {!carregando && temComp && linhas.length > 0 && aba === 'dre' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button className="btn-ghost" onClick={exportarDRE} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <i className="ti ti-download" /> Exportar CSV
            </button>
          </div>
          <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 22, maxWidth: 520 }}>
            <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 18 }}>DRE simplificada por prefixo de conta</p>
            <LinhaDRE label="Receitas" valor={money(receitas)} />
            <LinhaDRE label="(-) Despesas" valor={money(despesas)} />
            <LinhaDRE label="(-) Custos/Outras" valor={money(custos)} />
            <div style={{ borderTop: `1px solid ${theme.border}`, marginTop: 10, paddingTop: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 14, fontWeight: 700 }}>Resultado</span>
              <span style={{ fontSize: 18, fontWeight: 700, color: resultado >= 0 ? theme.green : theme.red }}>{money(resultado)}</span>
            </div>
          </div>
        </>
      )}
    </Wrapper>
  )
}

const th = { textAlign: 'left', padding: '10px 14px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3 }
const thNum = { ...th, textAlign: 'right' }
const td = { padding: '9px 14px', fontSize: 12.5, color: theme.text, whiteSpace: 'nowrap', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }
const tdNum = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }

function Wrapper({ children }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Relatórios</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 22 }}>Relatórios da competência (a partir do balancete).</p>
      {children}
    </div>
  )
}

function Aviso({ icon, texto }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '28px 24px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 560 }}>
      <i className={`ti ${icon}`} style={{ fontSize: 24, color: theme.accent }} />
      <p style={{ fontSize: 14, color: theme.text }}>{texto}</p>
    </div>
  )
}

function LinhaDRE({ label, valor }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0' }}>
      <span style={{ fontSize: 13.5, color: theme.sub }}>{label}</span>
      <span style={{ fontSize: 14, color: theme.text, fontVariantNumeric: 'tabular-nums' }}>{valor}</span>
    </div>
  )
}
