import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { fechaSozinho } from '../lib/clientes'
import { normalizaCompetencia } from '../lib/balancete'
import { theme } from '../lib/theme'
import InfoTela from '../components/InfoTela'
import { gerarExcelTimbrado } from '../lib/excel'
import { abrePdfTimbrado } from '../lib/pdf'
import { MassaDistribuicao } from './ImportacaoMassa'

const MES_C = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
const byNome = (a, b) => String(a.razao_social).localeCompare(String(b.razao_social), 'pt-BR')

// Meses ANTERIORES à competência-alvo, desde o início do cliente (para o atraso).
function mesesAnteriores(inicio, alvoAno, alvoMes) {
  const m = normalizaCompetencia(inicio).match(/^(\d{2})\/(\d{4})$/)
  if (!m) return []
  let mes = +m[1], ano = +m[2]
  const out = []; let guard = 0
  while ((ano < alvoAno || (ano === alvoAno && mes < alvoMes)) && guard++ < 240) {
    out.push({ ano, mes }); mes++; if (mes > 12) { mes = 1; ano++ }
  }
  return out
}

// Definição dos relatórios. Cada run recebe { empresas, comp, cli } e devolve
// { colunas, rows, resumo }. `comp` = precisa do seletor de competência; `cli` = filtro por cliente.
const REPORTS = [
  {
    key: 'docs', title: 'Pendências de documentação', icon: 'ti-files', comp: true, cli: true,
    desc: 'Documentos "não enviou" e "pendente" por cliente na competência.',
    arquivo: 'pendencias_documentacao',
    run: async ({ empresas, comp, cli }) => {
      const [mes, ano] = comp.split('/').map(Number)
      const { data: comps } = await supabase.from('competencias').select('cliente_id, documentos').eq('ano', ano).eq('mes', mes)
      const byCli = {}; for (const c of (comps || [])) byCli[c.cliente_id] = c
      const situ = d => d?.situacao ?? (d?.rec ? 'recebido' : '')
      const base = cli === 'todos' ? empresas : empresas.filter(e => e.id === cli)
      const rows = []; const cset = new Set()
      for (const emp of [...base].sort(byNome)) {
        const c = byCli[emp.id]; if (!c) continue
        const docs = (Array.isArray(c.documentos) ? c.documentos : []).filter(d => d && ['nao_enviou', ''].includes(situ(d)))
        for (const d of docs) { rows.push([emp.razao_social, d.name || '(sem nome)', situ(d) === 'nao_enviou' ? 'Não enviou' : 'Pendente']); cset.add(emp.id) }
      }
      return { colunas: [{ nome: 'Cliente', largura: 40 }, { nome: 'Documento', largura: 46, wrap: true }, { nome: 'Situação', largura: 16 }], rows, resumo: `${cset.size} cliente(s) com pendência · ${rows.length} documento(s)` }
    },
  },
  {
    key: 'semPlano', title: 'Empresas sem plano de contas', icon: 'ti-table-off',
    desc: 'Clientes que ainda não tiveram o plano de contas implantado.',
    arquivo: 'sem_plano_de_contas',
    run: async () => {
      const [{ data: cli }, { data: pl }] = await Promise.all([
        supabase.from('clientes').select('id, razao_social'),
        supabase.from('cargas_cadastro').select('cliente_id').eq('tipo', 'plano'),
      ])
      const comPlano = new Set((pl || []).map(r => r.cliente_id))
      const rows = (cli || []).filter(c => !comPlano.has(c.id)).sort(byNome).map(c => [c.razao_social])
      return { colunas: [{ nome: 'Cliente', largura: 52 }], rows, resumo: `${rows.length} empresa(s) sem plano de contas` }
    },
  },
  {
    key: 'semCarga', title: 'Empresas sem carga inicial', icon: 'ti-cloud-off',
    desc: 'Clientes sem o saldo de abertura (carga inicial) implantado.',
    arquivo: 'sem_carga_inicial',
    run: async () => {
      const { data: cli } = await supabase.from('clientes').select('razao_social, carga_saldos, carga_inicial_feita')
      const rows = (cli || []).filter(c => !c.carga_inicial_feita).sort(byNome)
        .map(c => [c.razao_social, c.carga_saldos ? 'Requerida — não lançada' : 'Não marcada como necessária'])
      return { colunas: [{ nome: 'Cliente', largura: 44 }, { nome: 'Situação', largura: 30 }], rows, resumo: `${rows.length} empresa(s) sem carga inicial` }
    },
  },
  {
    key: 'particularidades', title: 'Particularidades por empresa', icon: 'ti-notes',
    desc: 'Particularidades cadastradas de cada cliente (em branco destacado).',
    arquivo: 'particularidades',
    run: async () => {
      const { data: cli } = await supabase.from('clientes').select('razao_social, particularidades').order('razao_social')
      const rows = (cli || []).map(c => [c.razao_social, (c.particularidades || '').trim() || '— em branco —'])
      const brancos = (cli || []).filter(c => !(c.particularidades || '').trim()).length
      return { colunas: [{ nome: 'Cliente', largura: 36 }, { nome: 'Particularidades', largura: 62, wrap: true }], rows, resumo: `${rows.length} empresa(s) · ${brancos} em branco` }
    },
  },
  {
    key: 'atrasoMes', title: 'Balancetes em atraso do mês', icon: 'ti-calendar-exclamation', comp: true,
    desc: 'Clientes que não fecharam o balancete da competência escolhida.',
    arquivo: 'atraso_do_mes',
    run: async ({ comp }) => {
      const [mes, ano] = comp.split('/').map(Number)
      const [{ data: cli }, { data: comps }] = await Promise.all([
        supabase.from('clientes').select('id, razao_social, tipo, tipo_fechamento'),
        supabase.from('competencias').select('cliente_id, status, razao_importado').eq('ano', ano).eq('mes', mes),
      ])
      const byCli = {}; for (const c of (comps || [])) byCli[c.cliente_id] = c
      const rows = []
      for (const c of (cli || []).filter(fechaSozinho).sort(byNome)) {
        const cp = byCli[c.id]
        if (cp?.status === 'fechado') continue
        const sit = !cp ? 'Sem fechamento aberto' : cp.razao_importado ? 'Em andamento (não fechado)' : 'Pendente (sem razão)'
        rows.push([c.razao_social, sit])
      }
      return { colunas: [{ nome: 'Cliente', largura: 44 }, { nome: 'Situação', largura: 30 }], rows, resumo: `${rows.length} balancete(s) em atraso em ${comp}` }
    },
  },
  {
    key: 'atrasoAnt', title: 'Balancetes atrasados — períodos anteriores', icon: 'ti-history', comp: true,
    desc: 'Meses anteriores à competência escolhida ainda não fechados, por cliente.',
    arquivo: 'atraso_anteriores',
    run: async ({ comp }) => {
      const [mes, ano] = comp.split('/').map(Number)
      const [{ data: cli }, { data: comps }] = await Promise.all([
        supabase.from('clientes').select('id, razao_social, tipo, tipo_fechamento, competencia_inicio'),
        supabase.from('competencias').select('cliente_id, ano, mes, status'),
      ])
      const fechado = new Set((comps || []).filter(c => c.status === 'fechado').map(c => `${c.cliente_id}|${c.ano}|${c.mes}`))
      const rows = []
      for (const c of (cli || []).filter(fechaSozinho)) {
        let n = 0, oldest = null
        for (const { ano: a, mes: m } of mesesAnteriores(c.competencia_inicio, ano, mes)) {
          if (!fechado.has(`${c.id}|${a}|${m}`)) { n++; if (!oldest) oldest = { ano: a, mes: m } }
        }
        if (n > 0) rows.push([c.razao_social, `${n} ${n === 1 ? 'mês' : 'meses'}`, oldest ? `${MES_C[oldest.mes - 1]}/${oldest.ano}` : ''])
      }
      rows.sort((a, b) => parseInt(b[1]) - parseInt(a[1]))
      return { colunas: [{ nome: 'Cliente', largura: 40 }, { nome: 'Meses em atraso', largura: 16 }, { nome: 'Desde', largura: 14 }], rows, resumo: `${rows.length} empresa(s) com atraso anterior a ${comp}` }
    },
  },
]

export default function RelatoriosMassa() {
  const { empresas, competencia, competencias } = useAppData()
  const [sel, setSel] = useState(null)
  const [comp, setComp] = useState(competencia)
  const [cli, setCli] = useState('todos')
  const [res, setRes] = useState(null)
  const [gerando, setGerando] = useState(false)
  const [erro, setErro] = useState('')

  const rep = REPORTS.find(r => r.key === sel)

  function abrir(r) { setSel(r.key); setRes(null); setErro(''); setCli('todos') }

  async function gerar() {
    if (!rep) return
    setGerando(true); setErro(''); setRes(null)
    try {
      const out = await rep.run({ empresas: empresas || [], comp, cli })
      setRes(out)
    } catch (e) { setErro(String(e?.message || e)) } finally { setGerando(false) }
  }

  function exportar(fmt) {
    if (!res?.rows.length || !rep) return
    const suf = rep.comp ? `_${comp.replace('/', '-')}` : ''
    const titulo = `${rep.title}${rep.comp ? ` — ${comp}` : ''}`
    if (fmt === 'excel') {
      gerarExcelTimbrado({ titulo, sub: res.resumo, colunas: res.colunas, linhas: res.rows, totais: null, arquivo: `${rep.arquivo}${suf}.xlsx`, aba: 'Relatório' })
    } else {
      abrePdfTimbrado({ titulo, sub: res.resumo, competencia, colunas: res.colunas.map(c => ({ nome: c.nome })), linhas: res.rows })
    }
  }

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 9 }}>
        <i className="ti ti-report-analytics" style={{ color: theme.accent }} /> Relatórios em massa
        <InfoTela titulo="Relatórios em massa">Gera relatórios de vários clientes num lote só — escolha o relatório, o período e os clientes e baixe tudo de uma vez.</InfoTela>
      </h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 18 }}>
        Relatórios que varrem <b style={{ color: theme.text }}>todos os clientes</b> de uma vez. Clique num bloco para gerar.
      </p>

      {/* Blocos */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 12, marginBottom: sel ? 18 : 0 }}>
        {REPORTS.map(r => {
          const ativo = sel === r.key
          return (
            <div key={r.key} onClick={() => abrir(r)} style={{
              background: theme.card, border: `${ativo ? 1 : 0.5}px solid ${ativo ? theme.accent : theme.cb}`, borderRadius: 12,
              padding: '16px 16px', cursor: 'pointer', display: 'flex', gap: 12, alignItems: 'flex-start',
            }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(74,124,255,0.12)', border: `0.5px solid ${theme.cb}` }}>
                <i className={`ti ${r.icon}`} style={{ fontSize: 19, color: theme.accent }} />
              </div>
              <div style={{ minWidth: 0 }}>
                <p style={{ fontSize: 13.5, fontWeight: 600, margin: 0 }}>{r.title}</p>
                <p style={{ fontSize: 12, color: theme.sub, margin: '3px 0 0' }}>{r.desc}</p>
              </div>
            </div>
          )
        })}
        {(() => {
          const ativo = sel === 'distribuicao'
          return (
            <div onClick={() => { setSel('distribuicao'); setRes(null); setErro('') }} style={{
              background: theme.card, border: `${ativo ? 1 : 0.5}px solid ${ativo ? theme.accent : theme.cb}`, borderRadius: 12,
              padding: '16px 16px', cursor: 'pointer', display: 'flex', gap: 12, alignItems: 'flex-start',
            }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(74,124,255,0.12)', border: `0.5px solid ${theme.cb}` }}>
                <i className="ti ti-file-invoice" style={{ fontSize: 19, color: theme.accent }} />
              </div>
              <div style={{ minWidth: 0 }}>
                <p style={{ fontSize: 13.5, fontWeight: 600, margin: 0 }}>Distribuição de Lucros</p>
                <p style={{ fontSize: 12, color: theme.sub, margin: '3px 0 0' }}>Por sócio (Normal + Ata / lucros até 2025), em massa. Período e saída à sua escolha.</p>
              </div>
            </div>
          )
        })()}
      </div>

      {/* Painel do relatório selecionado */}
      {rep && (
        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '18px 20px' }}>
          <p style={{ fontSize: 15, fontWeight: 600, margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <i className={`ti ${rep.icon}`} style={{ color: theme.accent }} /> {rep.title}
          </p>

          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
            {rep.comp && (
              <div>
                <label>Competência</label>
                <select className="input" style={{ width: 'auto', padding: '9px 12px' }} value={comp} onChange={e => { setComp(e.target.value); setRes(null) }}>
                  {(competencias || []).map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            )}
            {rep.cli && (
              <div style={{ minWidth: 220, flex: '1 1 260px' }}>
                <label>Cliente</label>
                <select className="input" style={{ padding: '9px 12px' }} value={cli} onChange={e => { setCli(e.target.value); setRes(null) }}>
                  <option value="todos">Todos os clientes</option>
                  {[...(empresas || [])].sort(byNome).map(e => <option key={e.id} value={e.id}>{e.razao_social}</option>)}
                </select>
              </div>
            )}
            <button className="btn" disabled={gerando} onClick={gerar}><i className="ti ti-search" /> {gerando ? 'Gerando…' : 'Gerar relatório'}</button>
          </div>

          {erro && <p style={{ color: theme.red, fontSize: 12.5, margin: '12px 0 0' }}><i className="ti ti-alert-triangle" /> {erro}</p>}

          {res && (
            <div style={{ marginTop: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
                <p style={{ fontSize: 13, color: theme.sub, margin: 0 }}>{res.resumo}</p>
                {res.rows.length > 0 && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-ghost" style={{ fontSize: 12.5, padding: '6px 12px' }} onClick={() => exportar('excel')}><i className="ti ti-file-spreadsheet" /> Excel</button>
                    <button className="btn btn-ghost" style={{ fontSize: 12.5, padding: '6px 12px' }} onClick={() => exportar('pdf')}><i className="ti ti-file-type-pdf" /> PDF</button>
                  </div>
                )}
              </div>

              {res.rows.length === 0 ? (
                <p style={{ color: theme.green, fontSize: 13.5, margin: 0 }}><i className="ti ti-circle-check" /> Nada a listar. 🎉</p>
              ) : (
                <div style={{ overflowX: 'auto', border: `0.5px solid ${theme.cb}`, borderRadius: 10 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
                    <thead>
                      <tr style={{ background: theme.input }}>
                        {res.colunas.map((c, i) => <th key={i} style={thS}>{c.nome}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {res.rows.map((r, i) => (
                        <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                          {r.map((cel, j) => (
                            <td key={j} style={{ ...tdS, fontWeight: j === 0 ? 600 : 400, color: j === 0 ? theme.text : (String(cel).includes('branco') || String(cel) === 'Não enviou') ? theme.red : theme.sub }}>{cel}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Distribuição de Lucros — abre ao clicar no bloco, igual aos demais relatórios. */}
      {sel === 'distribuicao' && <MassaDistribuicao competencia={competencia} />}
    </div>
  )
}

const thS = { textAlign: 'left', padding: '10px 12px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3, whiteSpace: 'nowrap' }
const tdS = { padding: '9px 12px', fontSize: 13, color: theme.text, verticalAlign: 'top' }
