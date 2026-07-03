import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import { theme, money } from '../lib/theme'

const TABS = [['fiscal', 'Fiscal'], ['folha', 'Folha'], ['patrimonio', 'Patrimônio'], ['financeira', 'Financeira']]
const DESC = {
  fiscal: 'Importe o relatório fiscal (acumuladores) para cruzar com o razão.',
  folha: 'Importe os relatórios da folha (salários, encargos, 13º e férias) para cruzar com o razão.',
  patrimonio: 'Importe o resumo do patrimônio (depreciação e movimentação) para cruzar com o razão.',
}

// soma a primeira coluna numérica de cada linha (parse pt-BR tolerante)
function somaNumerica(linhas) {
  let tot = 0
  for (const r of linhas) for (const c of r) {
    if (typeof c === 'number') { tot += c; break }
    const s = String(c ?? '').trim()
    if (/^-?[\d.]+,\d{2}$/.test(s)) { tot += parseFloat(s.replace(/\./g, '').replace(',', '.')); break }
  }
  return tot
}

export default function Integracao() {
  const { empresas, empresaId, empresaNome, competencia, getCompetenciaId } = useAppData()
  const { user } = useAuth()
  const cliente = empresas.find(e => e.id === empresaId)
  const integ = cliente?.integracao_financeira || 'Não usa'
  const sistema = (cliente?.sistema_financeiro || '').trim()
  const [tab, setTab] = useState('fiscal')
  const [dados, setDados] = useState({}) // { tab: { nome, linhas } }
  const [estado, setEstado] = useState({}) // integrações validadas/sem movimento salvas na competência
  const [erro, setErro] = useState('')

  // Carrega o estado das integrações já salvas nesta competência.
  useEffect(() => {
    if (!empresaId) { setEstado({}); return }
    const [mes, ano] = (competencia || '').split('/').map(Number)
    supabase.from('competencias').select('integracoes')
      .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
      .then(({ data }) => setEstado(data?.integracoes || {}))
  }, [empresaId, competencia])

  if (!empresaId) {
    return <Wrapper><Aviso texto="Selecione uma empresa no menu lateral para usar a integração." /></Wrapper>
  }

  async function importar(alvo, file) {
    if (!file) return
    setErro('')
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
      const arr = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
      const linhas = arr.slice(1).filter(r => r.some(c => c !== '' && c != null)).slice(0, 300)
      setDados(d => ({ ...d, [alvo]: { nome: file.name, linhas } }))
      // Persiste: integração validada (documento importado) na competência → some do Status.
      const id = await getCompetenciaId()
      if (id) {
        const novo = { ...estado, [alvo]: { estado: 'validado', doc: file.name, usuario: user?.email || null } }
        await supabase.from('competencias').update({ integracoes: novo }).eq('id', id)
        setEstado(novo)
      }
    } catch (err) { setErro('Não consegui ler: ' + err.message) }
  }

  return (
    <Wrapper>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 16 }}>
        <b style={{ color: theme.text }}>{empresaNome}</b> · competência <b style={{ color: theme.text }}>{competencia}</b>
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{ borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 500, border: tab === id ? 'none' : `1px solid ${theme.border}`, background: tab === id ? theme.accent : 'transparent', color: tab === id ? '#fff' : theme.text, cursor: 'pointer' }}>{label}</button>
        ))}
      </div>

      {erro && <p style={{ color: theme.red, fontSize: 13, marginBottom: 12 }}>{erro}</p>}

      {tab === 'financeira'
        ? (integ === 'Excel'
          ? <Financeira dados={dados.financeira} onImport={f => importar('financeira', f)} competencia={competencia} est={estado.financeira} />
          : <FinanceiraViaSistema integ={integ} sistema={sistema} />)
        : <Cruzamento tab={tab} dados={dados[tab]} onImport={f => importar(tab, f)} est={estado[tab]} />}
    </Wrapper>
  )
}

function EstadoBadge({ est }) {
  if (!est?.estado) return null
  const semMov = est.estado === 'sem_movimento'
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: semMov ? theme.sub : theme.green, background: theme.card, border: `1px solid ${theme.cb}`, borderRadius: 20, padding: '5px 12px', marginBottom: 12 }}>
      <i className={`ti ${semMov ? 'ti-circle-minus' : 'ti-circle-check'}`} />
      {semMov ? 'Sem movimento no período' : `Validado${est.doc ? ` · ${est.doc}` : ''}`}
    </div>
  )
}

function Cruzamento({ tab, dados, onImport, est }) {
  const total = dados ? somaNumerica(dados.linhas) : 0
  return (
    <>
      <div><EstadoBadge est={est} /></div>
      <ImpCard titulo={`Importar — ${DESC[tab].split(' ')[1] || 'relatório'}`} desc={DESC[tab]} onImport={onImport} nome={dados?.nome} qtd={dados?.linhas.length} />
      {dados && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 12, marginTop: 16 }}>
          <Metric label="Total do relatório" valor={money(total)} icon="ti-receipt" />
          <Metric label="Linhas importadas" valor={dados.linhas.length} icon="ti-list-details" />
          <Metric label="Cruzar com o razão" valor="manual" icon="ti-arrows-diff" cor={theme.yellow} sub="confira na Conciliação" />
        </div>
      )}
    </>
  )
}

function Financeira({ dados, onImport, competencia, est }) {
  function gerar() {
    const linhas = dados?.linhas || []
    const csv = '﻿' + linhas.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
    a.download = `financeiro_${competencia.replace('/', '-')}.csv`
    a.click(); URL.revokeObjectURL(a.href)
  }
  return (
    <>
      <div><EstadoBadge est={est} /></div>
      <ImpCard titulo="Importar extrato financeiro" desc="Importe o extrato; o que a plataforma identificar é contabilizado automaticamente, o resto fica para classificar." onImport={onImport} nome={dados?.nome} qtd={dados?.linhas.length} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
        <Balde titulo="Contabilizado automaticamente" cor={theme.green} icon="ti-circle-check" linhas={[]} vazio="A classificação automática (de/para) entra na próxima onda." />
        <Balde titulo="Não identificado" cor={theme.yellow} icon="ti-alert-triangle" linhas={dados?.linhas || []} vazio="Importe um extrato para listar os lançamentos a classificar." />
      </div>
      <button className="btn btn-ghost" disabled={!dados} onClick={gerar} style={{ marginTop: 18, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <i className="ti ti-file-export" /> Gerar arquivo financeiro
      </button>
    </>
  )
}

// Cliente sem integração por Excel: não habilita a importação, só informa a origem.
function FinanceiraViaSistema({ integ, sistema }) {
  const usaSistema = integ === 'Sistema' || (integ !== 'Excel' && sistema)
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '26px 24px', display: 'flex', alignItems: 'center', gap: 16, maxWidth: 640 }}>
      <span style={{ background: 'rgba(74,124,255,0.15)', borderRadius: 12, width: 48, height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <i className={`ti ${usaSistema ? 'ti-plug-connected' : 'ti-plug-off'}`} style={{ color: theme.accent, fontSize: 24 }} />
      </span>
      <div>
        {usaSistema ? (
          <>
            <p style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Financeiro importado via sistema</p>
            <p style={{ color: theme.sub, fontSize: 13.5, margin: '6px 0 0', lineHeight: 1.5 }}>
              Este cliente utiliza o sistema <b style={{ color: theme.text }}>{sistema || 'não informado'}</b>. A importação por Excel fica desabilitada — o financeiro vem direto do sistema.
              {!sistema && <span style={{ display: 'block', color: theme.yellow, marginTop: 6 }}>Informe o sistema no cadastro do cliente (campo “Sistema financeiro”).</span>}
            </p>
          </>
        ) : (
          <>
            <p style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Sem integração financeira</p>
            <p style={{ color: theme.sub, fontSize: 13.5, margin: '6px 0 0', lineHeight: 1.5 }}>
              Este cliente está marcado como <b style={{ color: theme.text }}>“Não usa”</b> integração financeira. Para habilitar a importação por Excel, ajuste o campo “Integração financeira” do cliente para <b style={{ color: theme.text }}>Excel</b>.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

function ImpCard({ titulo, desc, onImport, nome, qtd }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 18, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
      <span style={{ background: 'rgba(74,124,255,0.15)', borderRadius: 10, width: 42, height: 42, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <i className="ti ti-cloud-upload" style={{ color: theme.accent, fontSize: 20 }} />
      </span>
      <div style={{ flex: 1, minWidth: 180 }}>
        <p style={{ color: theme.text, fontSize: 14, fontWeight: 600, margin: 0 }}>{titulo}</p>
        <p style={{ color: theme.sub, fontSize: 12.5, margin: '2px 0 0' }}>{nome ? `${nome} — ${qtd} linha(s)` : desc}</p>
      </div>
      <label className="btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
        <i className="ti ti-file-spreadsheet" /> Importar
        <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => onImport(e.target.files?.[0])} />
      </label>
    </div>
  )
}

function Balde({ titulo, cor, icon, linhas, vazio }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ padding: '13px 16px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: `1px solid ${theme.border}` }}>
        <i className={`ti ${icon}`} style={{ color: cor }} />
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{titulo}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: theme.sub }}>{linhas.length}</span>
      </div>
      {linhas.length === 0
        ? <p style={{ padding: 18, color: theme.sub, fontSize: 12.5 }}>{vazio}</p>
        : <div style={{ maxHeight: 320, overflow: 'auto' }}>
          {linhas.map((l, i) => (
            <div key={i} style={{ padding: '9px 16px', borderTop: i ? `1px solid ${theme.border}` : 'none', fontSize: 12.5, color: theme.text, display: 'flex', gap: 12 }}>
              {l.slice(0, 4).map((c, j) => (
                <span key={j} style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: typeof c === 'number' ? 'right' : 'left', color: typeof c === 'number' ? theme.text : theme.sub }}>
                  {typeof c === 'number' ? money(c) : String(c ?? '')}
                </span>
              ))}
            </div>
          ))}
        </div>}
    </div>
  )
}

function Metric({ label, valor, icon, cor, sub }) {
  return (
    <div style={{ background: theme.input, borderRadius: 10, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: theme.sub, fontSize: 11, textTransform: 'uppercase', letterSpacing: .5 }}>{label}</span>
        <i className={`ti ${icon}`} style={{ color: theme.accent, fontSize: 16 }} />
      </div>
      <p style={{ fontSize: 20, fontWeight: 700, margin: '8px 0 0', color: cor || theme.text }}>{valor}</p>
      {sub && <p style={{ color: theme.sub, fontSize: 11, margin: '3px 0 0' }}>{sub}</p>}
    </div>
  )
}

function Wrapper({ children }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Integração</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 22 }}>As quatro integrações para o contábil. Tem que dar zero.</p>
      {children}
    </div>
  )
}
function Aviso({ texto }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '28px 24px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 560 }}>
      <i className="ti ti-building" style={{ fontSize: 24, color: theme.accent }} />
      <p style={{ fontSize: 14, color: theme.text }}>{texto}</p>
    </div>
  )
}
