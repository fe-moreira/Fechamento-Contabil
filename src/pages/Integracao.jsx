import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import { theme, money } from '../lib/theme'
import CampoConta from '../components/CampoConta'

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
  const { empresas, empresaId, empresaNome, competencia, getCompetenciaId, plano } = useAppData()
  const { user } = useAuth()
  const cliente = empresas.find(e => e.id === empresaId)
  const integ = cliente?.integracao_financeira || 'Não usa'
  const sistema = (cliente?.sistema_financeiro || '').trim()
  const planoMap = Object.fromEntries((plano || []).map(p => [String(p.cod), p]))

  // Marca a integração financeira como validada na competência (some do Status).
  async function validarFinanceira(nomeDoc) {
    const id = await getCompetenciaId()
    if (!id) return
    const novo = { ...estado, financeira: { estado: 'validado', doc: nomeDoc, usuario: user?.email || null } }
    await supabase.from('competencias').update({ integracoes: novo }).eq('id', id)
    setEstado(novo)
  }
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
          ? <Financeira competencia={competencia} est={estado.financeira} empresaId={empresaId} planoMap={planoMap} user={user} onValidado={validarFinanceira} />
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

function Financeira({ competencia, est, empresaId, planoMap, user, onValidado }) {
  const [contas, setContas] = useState([])       // [{ conta_contabil, agencia, conta }]
  const [carregReg, setCarregReg] = useState(true)
  const [novo, setNovo] = useState({ conta_contabil: '', agencia: '', conta: '' })
  const [modo, setModo] = useState('porBanco')   // 'porBanco' | 'combinado'
  const [bancoSel, setBancoSel] = useState('')    // conta_contabil escolhida (modo por banco)
  const [dados, setDados] = useState(null)        // { nome, linhas:[{cells, conta_contabil}], naoIdent }
  const [erro, setErro] = useState('')
  const [msg, setMsg] = useState('')

  const nomeBanco = cod => planoMap[String(cod)]?.nome || (cod ? `Conta ${cod}` : '—')

  useEffect(() => {
    setCarregReg(true); setDados(null); setBancoSel('')
    supabase.from('cargas_cadastro').select('dados').eq('cliente_id', empresaId).eq('tipo', 'contas_bancarias')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
      .then(({ data }) => { setContas(Array.isArray(data?.dados) ? data.dados : []); setCarregReg(false) })
  }, [empresaId])

  async function salvarContas(arr) {
    setContas(arr)
    await supabase.from('cargas_cadastro').delete().eq('cliente_id', empresaId).eq('tipo', 'contas_bancarias')
    await supabase.from('cargas_cadastro').insert({ cliente_id: empresaId, tipo: 'contas_bancarias', vigencia: competencia, dados: arr, usuario: user?.email || null, obs: 'Contas bancárias' })
  }
  function addConta() {
    const cod = String(novo.conta_contabil || '').trim()
    if (!cod) return
    if (contas.some(c => String(c.conta_contabil).trim() === cod)) { setErro('Essa conta já está cadastrada.'); return }
    setErro(''); salvarContas([...contas, { conta_contabil: cod, agencia: novo.agencia.trim(), conta: novo.conta.trim() }])
    setNovo({ conta_contabil: '', agencia: '', conta: '' })
  }
  const removeConta = i => salvarContas(contas.filter((_, j) => j !== i))

  async function importar(file) {
    if (!file) return
    setErro(''); setMsg('')
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
      const arr = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
      const linhasRaw = arr.slice(1).filter(r => r.some(c => c !== '' && c != null)).slice(0, 1000)
      const codigos = new Set(contas.map(c => String(c.conta_contabil).trim()))
      let linhas = [], naoIdent = 0
      if (modo === 'porBanco') {
        if (!bancoSel) { setErro('Selecione a conta bancária deste arquivo antes de importar.'); return }
        linhas = linhasRaw.map(cells => ({ cells, conta_contabil: bancoSel }))
      } else {
        if (!codigos.size) { setErro('Cadastre as contas bancárias antes de importar uma planilha combinada.'); return }
        for (const cells of linhasRaw) {
          let cod = ''
          for (const c of cells) { const v = String(c ?? '').trim(); if (codigos.has(v)) { cod = v; break } }
          linhas.push({ cells, conta_contabil: cod }); if (!cod) naoIdent++
        }
      }
      setDados({ nome: file.name, linhas, naoIdent })
      setMsg(`${linhas.length} linha(s) importada(s)${naoIdent ? ` · ${naoIdent} sem conta identificada` : ''}.`)
      onValidado(file.name)
    } catch (e) { setErro('Não consegui ler: ' + e.message) }
  }

  function gerar() {
    if (!dados) return
    const rows = [['Conta contábil', 'Banco (plano)', 'Extrato…'].join(';')]
    for (const l of dados.linhas) {
      const campos = [l.conta_contabil || '(não identificado)', nomeBanco(l.conta_contabil), ...l.cells]
      rows.push(campos.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';'))
    }
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8;' }))
    a.download = `financeiro_${competencia.replace('/', '-')}.csv`
    a.click(); URL.revokeObjectURL(a.href)
  }

  // Agrupa as linhas importadas por conta bancária identificada.
  const grupos = {}
  for (const l of (dados?.linhas || [])) { const k = l.conta_contabil || ''; (grupos[k] = grupos[k] || []).push(l.cells) }

  return (
    <>
      <div><EstadoBadge est={est} /></div>

      {/* Cadastro das contas bancárias do cliente */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 18, marginBottom: 16 }}>
        <p style={{ fontSize: 14, fontWeight: 600, margin: '0 0 4px' }}>Contas bancárias do cliente</p>
        <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 12px' }}>Informe a <b style={{ color: theme.text }}>conta contábil</b> de cada banco (o nome vem do plano de contas). É essa conta que entra no lançamento do extrato. <span style={{ color: theme.accent }}>F4</span> abre o plano.</p>
        {carregReg ? <p style={{ color: theme.sub, fontSize: 12.5 }}>Carregando…</p> : (
          <>
            {contas.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                {contas.map((c, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: i ? `1px solid ${theme.border}` : 'none', fontSize: 13 }}>
                    <i className="ti ti-building-bank" style={{ color: theme.accent }} />
                    <span style={{ fontWeight: 600, minWidth: 70 }}>{c.conta_contabil}</span>
                    <span style={{ flex: 1, color: theme.sub }}>{nomeBanco(c.conta_contabil)}{(c.agencia || c.conta) ? ` · ag ${c.agencia || '—'} / cc ${c.conta || '—'}` : ''}</span>
                    <i className="ti ti-trash" title="Remover" onClick={() => removeConta(i)} style={{ color: theme.sub, cursor: 'pointer' }} />
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ minWidth: 170 }}><label>Conta contábil</label><CampoConta value={novo.conta_contabil} onChange={v => setNovo(n => ({ ...n, conta_contabil: v }))} /></div>
              <div><label>Agência (opc.)</label><input className="input" style={{ maxWidth: 120 }} value={novo.agencia} onChange={e => setNovo(n => ({ ...n, agencia: e.target.value }))} /></div>
              <div><label>Conta (opc.)</label><input className="input" style={{ maxWidth: 130 }} value={novo.conta} onChange={e => setNovo(n => ({ ...n, conta: e.target.value }))} /></div>
              <button className="btn" onClick={addConta}><i className="ti ti-plus" /> Adicionar</button>
            </div>
          </>
        )}
      </div>

      {/* Como o extrato vem */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <button className={modo === 'porBanco' ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 13 }} onClick={() => setModo('porBanco')}><i className="ti ti-file" /> Um arquivo por banco</button>
        <button className={modo === 'combinado' ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 13 }} onClick={() => setModo('combinado')}><i className="ti ti-files" /> Planilha combinada</button>
      </div>

      {modo === 'porBanco' ? (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
          <div><label>Conta bancária deste arquivo</label>
            <select className="input" style={{ padding: '9px 12px' }} value={bancoSel} onChange={e => setBancoSel(e.target.value)}>
              <option value="">Selecione…</option>
              {contas.map(c => <option key={c.conta_contabil} value={c.conta_contabil}>{c.conta_contabil} · {nomeBanco(c.conta_contabil)}</option>)}
            </select>
          </div>
        </div>
      ) : (
        <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 12px' }}>A planilha traz todos os bancos juntos — cada linha deve ter a <b style={{ color: theme.text }}>conta contábil</b> numa das colunas. A plataforma casa com o cadastro acima e separa por banco.</p>
      )}

      <ImpCard titulo="Importar extrato financeiro" desc="Importe o extrato do cliente (Excel/CSV)." onImport={importar} nome={dados?.nome} qtd={dados?.linhas.length} />
      {erro && <p style={{ color: theme.red, fontSize: 12.5, margin: '10px 0 0' }}>{erro}</p>}
      {msg && <p style={{ color: theme.green, fontSize: 12.5, margin: '10px 0 0' }}><i className="ti ti-circle-check" /> {msg}</p>}

      {dados && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 12, marginTop: 16 }}>
          {Object.keys(grupos).sort().map(cod => (
            <Balde key={cod || 'x'} titulo={cod ? `${cod} · ${nomeBanco(cod)}` : 'Não identificado (sem conta contábil)'} cor={cod ? theme.green : theme.yellow} icon={cod ? 'ti-building-bank' : 'ti-alert-triangle'} linhas={grupos[cod]} vazio="—" />
          ))}
        </div>
      )}

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
