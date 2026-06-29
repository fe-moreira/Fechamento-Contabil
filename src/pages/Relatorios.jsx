import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { apurarDistribuicao } from '../lib/distribuicao'
import { apurarBancoResultado } from '../lib/bancoResultado'
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

// Data pt-BR a partir de um created_at (ISO).
function dataPtBR(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return String(iso)
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Catálogo de relatórios (ordem das abas/cards).
const RELATORIOS = [
  { id: 'balancete', nome: 'Balancete', icon: 'ti-table', desc: 'Saldos por conta (inicial, movimento e final).' },
  { id: 'dre', nome: 'DRE (resumo)', icon: 'ti-report-money', desc: 'Demonstração de resultado simplificada por prefixo de conta.' },
  { id: 'book', nome: 'Book de Composições', icon: 'ti-book', desc: 'Contas do balancete com saldo final diferente de zero.' },
  { id: 'balanco', nome: 'Balanço Patrimonial', icon: 'ti-scale', desc: 'Ativo e Passivo + Patrimônio Líquido por conta (saldo final).' },
  { id: 'pendencias', nome: 'Relatório de Pendências', icon: 'ti-alert-triangle', desc: 'Documentos da competência ainda não recebidos.' },
  { id: 'bancoresult', nome: 'Banco × Resultado', icon: 'ti-building-bank', desc: 'Lançamentos de banco direto em conta de resultado não liberada.' },
  { id: 'distribuicao', nome: 'Distribuição de lucros · IRRF 2026', icon: 'ti-cash', desc: 'Apuração por sócio: total recebido, limite e IRRF estimado.' },
  { id: 'auditoria', nome: 'Justificativas e correções do fechamento', icon: 'ti-clipboard-check', desc: 'Consolida toda a auditoria registrada nesta competência.' },
]

export default function Relatorios() {
  const { empresaId, empresaNome, competencia } = useAppData()
  const [carregando, setCarregando] = useState(false)
  const [temComp, setTemComp] = useState(null) // null = não checado, false = sem competência
  const [linhas, setLinhas] = useState([])      // balancete
  const [documentos, setDocumentos] = useState([]) // competencias.documentos
  const [auditoria, setAuditoria] = useState([])    // auditoria desta competência
  const [dist, setDist] = useState(null)            // apuração de distribuição de lucros
  const [br, setBr] = useState(null)                // apuração banco × resultado
  const [aba, setAba] = useState('balancete')

  // Resolve a competência (READ-ONLY) e lê balancete + documentos + auditoria.
  useEffect(() => {
    setLinhas([]); setDocumentos([]); setAuditoria([]); setDist(null); setBr(null); setTemComp(null)
    if (!empresaId) return
    let vivo = true
    ;(async () => {
      setCarregando(true)
      try {
        const [mes, ano] = competencia.split('/').map(Number)
        const { data: comp } = await supabase.from('competencias').select('id, documentos')
          .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
        if (!vivo) return
        if (!comp) { setTemComp(false); return }
        setTemComp(true)
        setDocumentos(Array.isArray(comp.documentos) ? comp.documentos : [])

        const [{ data: bal }, { data: aud }] = await Promise.all([
          supabase.from('balancete')
            .select('conta, nome, saldo_inicial, debito, credito, saldo_final')
            .eq('competencia_id', comp.id)
            .order('conta', { ascending: true }),
          supabase.from('auditoria')
            .select('modulo, item, tipo, detalhe, dedutibilidade, usuario, created_at')
            .eq('competencia_id', comp.id)
            .order('created_at', { ascending: false }),
        ])
        if (!vivo) return
        setLinhas(bal || [])
        setAuditoria(aud || [])
        const d = await apurarDistribuicao(empresaId, comp.id)
        if (vivo) setDist(d)
        const b = await apurarBancoResultado(empresaId, comp.id)
        if (vivo) setBr(b)
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

  // Book de Composições: contas com saldo final != 0.
  const book = linhas.filter(l => Math.abs(Number(l.saldo_final) || 0) >= 0.005)

  // Balanço: Ativo (prefixo 1) × Passivo + PL (prefixo 2).
  const ativo = linhas.filter(l => String(l.conta || '').startsWith('1'))
  const passivo = linhas.filter(l => String(l.conta || '').startsWith('2'))
  const totAtivo = ativo.reduce((s, l) => s + (Number(l.saldo_final) || 0), 0)
  const totPassivo = passivo.reduce((s, l) => s + (Number(l.saldo_final) || 0), 0)

  // Pendências: documentos não recebidos (rec === false).
  const pendencias = documentos.filter(d => d && d.rec === false)

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

  function exportarBook() {
    const dados = [
      ['Conta', 'Nome', 'Saldo final'],
      ...book.map(l => [l.conta, l.nome, csvNum(l.saldo_final)]),
    ]
    baixarCSV(`book_composicoes_${compSlug}.csv`, dados)
  }

  function exportarPendencias() {
    const dados = [
      ['Documento', 'Categoria'],
      ...pendencias.map(d => [d.name, d.cat]),
    ]
    baixarCSV(`pendencias_${compSlug}.csv`, dados)
  }

  function exportarAuditoria() {
    const dados = [
      ['Módulo', 'Item', 'Tipo', 'Detalhe', 'Dedutibilidade', 'Usuário', 'Data'],
      ...auditoria.map(a => [a.modulo, a.item, a.tipo, a.detalhe, a.dedutibilidade, a.usuario, dataPtBR(a.created_at)]),
    ]
    baixarCSV(`auditoria_${compSlug}.csv`, dados)
  }

  function exportarBancoResult() {
    const dados = [
      ['Data', 'Banco', 'Conta resultado', 'Valor', 'Despesa (LALUR)', 'Histórico'],
      ...(br?.lancamentos || []).map(l => [
        l.data ? l.data.split('-').reverse().join('/') : '', l.banco, l.resultado, csvNum(l.valor), l.despesa ? 'Sim' : 'Não', l.historico,
      ]),
    ]
    baixarCSV(`banco_x_resultado_${compSlug}.csv`, dados)
  }

  function exportarDistribuicao() {
    const dados = [
      ['Sócio', 'Identificação', 'Total recebido', 'Limite', 'Acima do limite', 'IRRF estimado'],
      ...(dist?.socios || []).map(s => [s.nome, s.ident, csvNum(s.total), csvNum(dist.limite), s.excede ? 'Sim' : 'Não', csvNum(s.irrf)]),
    ]
    baixarCSV(`distribuicao_lucros_${compSlug}.csv`, dados)
  }

  function exportarBalanco() {
    const dados = [
      ['Grupo', 'Conta', 'Nome', 'Saldo final'],
      ...ativo.map(l => ['Ativo', l.conta, l.nome, csvNum(l.saldo_final)]),
      ['', '', 'TOTAL ATIVO', csvNum(totAtivo)],
      ...passivo.map(l => ['Passivo + PL', l.conta, l.nome, csvNum(l.saldo_final)]),
      ['', '', 'TOTAL PASSIVO + PL', csvNum(totPassivo)],
    ]
    baixarCSV(`balanco_${compSlug}.csv`, dados)
  }

  const semBalancete = !carregando && temComp && linhas.length === 0
  // Relatórios que dependem só do balancete.
  const dependeBalancete = aba === 'balancete' || aba === 'dre' || aba === 'book' || aba === 'balanco'

  return (
    <Wrapper>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 18 }}>
        <b style={{ color: theme.text }}>{empresaNome}</b> · competência <b style={{ color: theme.text }}>{competencia}</b>
      </p>

      {/* Cards de relatório (escolha) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 12, marginBottom: 22 }}>
        {RELATORIOS.map(r => (
          <button
            key={r.id}
            onClick={() => setAba(r.id)}
            style={{
              textAlign: 'left',
              background: aba === r.id ? theme.input : theme.card,
              border: `1px solid ${aba === r.id ? theme.accent : theme.cb}`,
              borderRadius: 12,
              padding: 16,
              cursor: 'pointer',
              display: 'flex',
              gap: 12,
              alignItems: 'flex-start',
            }}
          >
            <i className={`ti ${r.icon}`} style={{ fontSize: 20, color: theme.accent, marginTop: 2 }} />
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: theme.text, marginBottom: 4 }}>{r.nome}</div>
              <div style={{ fontSize: 12, color: theme.sub, lineHeight: 1.4 }}>{r.desc}</div>
            </div>
          </button>
        ))}
      </div>

      {carregando && <p style={{ color: theme.sub, fontSize: 13 }}>Carregando…</p>}

      {temComp === false && (
        <Aviso icon="ti-file-import" texto="Importe o razão primeiro." />
      )}

      {/* Aviso de balancete vazio só afeta os relatórios que dependem dele. */}
      {semBalancete && dependeBalancete && (
        <Aviso icon="ti-database-off" texto="Sem dados no balancete desta competência. Importe o razão primeiro." />
      )}

      {/* Balancete */}
      {!carregando && temComp && linhas.length > 0 && aba === 'balancete' && (
        <Secao titulo="Balancete" onExportar={exportarBalancete}>
          <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
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
        </Secao>
      )}

      {/* DRE */}
      {!carregando && temComp && linhas.length > 0 && aba === 'dre' && (
        <Secao titulo="DRE (resumo)" onExportar={exportarDRE}>
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
        </Secao>
      )}

      {/* Book de Composições */}
      {!carregando && temComp && linhas.length > 0 && aba === 'book' && (
        <Secao titulo="Book de Composições" onExportar={book.length ? exportarBook : null}>
          {book.length === 0 ? (
            <Aviso icon="ti-circle-check" texto="Nenhuma conta com saldo final em aberto nesta competência." />
          ) : (
            <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: theme.input }}>
                    <th style={th}>Conta</th>
                    <th style={th}>Nome</th>
                    <th style={thNum}>Saldo final</th>
                  </tr>
                </thead>
                <tbody>
                  {book.map((l, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                      <td style={td}>{l.conta}</td>
                      <td style={td}>{l.nome || '—'}</td>
                      <td style={tdNum}>{money(l.saldo_final)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Secao>
      )}

      {/* Balanço Patrimonial */}
      {!carregando && temComp && linhas.length > 0 && aba === 'balanco' && (
        <Secao titulo="Balanço Patrimonial" onExportar={exportarBalanco}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
            <GrupoBalanco titulo="Ativo" contas={ativo} total={totAtivo} />
            <GrupoBalanco titulo="Passivo + Patrimônio Líquido" contas={passivo} total={totPassivo} />
          </div>
        </Secao>
      )}

      {/* Relatório de Pendências */}
      {!carregando && temComp && aba === 'pendencias' && (
        <Secao titulo="Relatório de Pendências" onExportar={pendencias.length ? exportarPendencias : null}>
          {pendencias.length === 0 ? (
            <Aviso icon="ti-circle-check" texto="Nenhum documento pendente nesta competência." />
          ) : (
            <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: theme.input }}>
                    <th style={th}>Documento</th>
                    <th style={th}>Categoria</th>
                  </tr>
                </thead>
                <tbody>
                  {pendencias.map((d, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                      <td style={td}>{d.name || '—'}</td>
                      <td style={td}>{d.cat || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Secao>
      )}

      {/* Banco × Resultado */}
      {!carregando && temComp && aba === 'bancoresult' && (
        <Secao titulo="Banco × Resultado" onExportar={br?.lancamentos?.length ? exportarBancoResult : null}>
          {!br?.temCarga ? (
            <Aviso icon="ti-settings" texto="Importe a amarração banco × resultado em Base de Informações." />
          ) : br.lancamentos.length === 0 ? (
            <Aviso icon="ti-circle-check" texto="Nenhum lançamento de banco direto em resultado não liberado." />
          ) : (
            <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
              <table style={{ width: '100%', minWidth: 700, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: theme.input }}>
                    <th style={th}>Data</th><th style={th}>Banco</th><th style={th}>Conta resultado</th>
                    <th style={thNum}>Valor</th><th style={th}>LALUR</th><th style={th}>Histórico</th>
                  </tr>
                </thead>
                <tbody>
                  {br.lancamentos.map((l, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{l.data ? l.data.split('-').reverse().join('/') : ''}</td>
                      <td style={td}>{l.banco}</td>
                      <td style={td}>{l.resultado}</td>
                      <td style={tdNum}>{money(l.valor)}</td>
                      <td style={td}>{l.despesa ? <span style={{ color: theme.yellow }}>despesa</span> : '—'}</td>
                      <td style={{ ...td, maxWidth: 280, whiteSpace: 'normal' }}>{l.historico}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Secao>
      )}

      {/* Distribuição de lucros */}
      {!carregando && temComp && aba === 'distribuicao' && (
        <Secao titulo="Distribuição de lucros · IRRF 2026" onExportar={dist?.socios?.length ? exportarDistribuicao : null}>
          {!dist?.temConfig ? (
            <Aviso icon="ti-settings" texto="Configure limite, alíquota e sócios em Base de Informações → Distribuição de lucros." />
          ) : !dist.socios.length ? (
            <Aviso icon="ti-users" texto="Nenhum sócio configurado. Adicione os sócios na Base de Informações." />
          ) : (
            <>
              <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 12 }}>
                Limite mensal: <b style={{ color: theme.text }}>{money(dist.limite)}</b> · Alíquota IRRF: <b style={{ color: theme.text }}>{dist.aliquota}%</b>. Estimativa para revisão humana.
              </p>
              <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: theme.input }}>
                      <th style={th}>Sócio</th>
                      <th style={thNum}>Total recebido</th>
                      <th style={th}>Situação</th>
                      <th style={thNum}>IRRF estimado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dist.socios.map((s, i) => (
                      <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                        <td style={td}>{s.nome}</td>
                        <td style={tdNum}>{money(s.total)}</td>
                        <td style={{ ...td, color: s.excede ? theme.red : theme.green }}>{s.excede ? 'Acima do limite' : 'Dentro do limite'}</td>
                        <td style={{ ...tdNum, color: s.excede ? theme.red : theme.sub, fontWeight: s.excede ? 700 : 400 }}>{money(s.irrf)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Secao>
      )}

      {/* Justificativas e correções (auditoria) */}
      {!carregando && temComp && aba === 'auditoria' && (
        <Secao titulo="Justificativas e correções do fechamento" onExportar={auditoria.length ? exportarAuditoria : null}>
          {auditoria.length === 0 ? (
            <Aviso icon="ti-clipboard-off" texto="Nenhuma justificativa ou correção registrada nesta competência." />
          ) : (
            <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
              <table style={{ width: '100%', minWidth: 820, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: theme.input }}>
                    <th style={th}>Módulo</th>
                    <th style={th}>Item</th>
                    <th style={th}>Tipo</th>
                    <th style={th}>Detalhe</th>
                    <th style={th}>Usuário</th>
                    <th style={th}>Data</th>
                  </tr>
                </thead>
                <tbody>
                  {auditoria.map((a, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                      <td style={td}>{a.modulo || '—'}</td>
                      <td style={td}>{a.item || '—'}</td>
                      <td style={td}>{a.tipo || '—'}</td>
                      <td style={{ ...td, maxWidth: 360, whiteSpace: 'normal' }}>{a.detalhe || '—'}</td>
                      <td style={td}>{a.usuario || '—'}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{dataPtBR(a.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Secao>
      )}
    </Wrapper>
  )
}

const th = { textAlign: 'left', padding: '10px 14px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3 }
const thNum = { ...th, textAlign: 'right' }
const td = { padding: '9px 14px', fontSize: 12.5, color: theme.text, whiteSpace: 'nowrap', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }
const tdNum = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }

// Cabeçalho de seção com botões Excel (CSV) e PDF (window.print).
function Secao({ titulo, onExportar, children }) {
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>{titulo}</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn-ghost"
            onClick={() => onExportar && onExportar()}
            disabled={!onExportar}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, opacity: onExportar ? 1 : .5, cursor: onExportar ? 'pointer' : 'not-allowed' }}
          >
            <i className="ti ti-file-spreadsheet" /> Excel (CSV)
          </button>
          <button
            className="btn-ghost"
            onClick={() => window.print()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
          >
            <i className="ti ti-file-type-pdf" /> PDF
          </button>
        </div>
      </div>
      {children}
    </>
  )
}

function Wrapper({ children }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Relatórios</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 22 }}>Relatórios da competência (a partir do balancete e da auditoria).</p>
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

function GrupoBalanco({ titulo, contas, total }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden' }}>
      <p style={{ fontSize: 14, fontWeight: 600, padding: '14px 16px', margin: 0, borderBottom: `1px solid ${theme.border}` }}>{titulo}</p>
      {contas.length === 0 ? (
        <p style={{ color: theme.sub, fontSize: 12.5, padding: 16 }}>Sem contas neste grupo.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {contas.map((l, i) => (
              <tr key={i} style={{ borderTop: i ? `1px solid ${theme.border}` : 'none' }}>
                <td style={td}><span style={{ color: theme.sub, fontSize: 11 }}>{l.conta}</span> {l.nome || ''}</td>
                <td style={tdNum}>{money(l.saldo_final)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: `1px solid ${theme.border}`, background: theme.input }}>
              <td style={{ ...td, fontWeight: 700 }}>Total</td>
              <td style={{ ...tdNum, fontWeight: 700 }}>{money(total)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  )
}
