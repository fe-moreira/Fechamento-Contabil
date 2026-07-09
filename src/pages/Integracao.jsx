import { Fragment, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import { theme, money } from '../lib/theme'
import CampoConta from '../components/CampoConta'
import { normHist, casarHistorico, aprender, parseValor, dataISO, aplicarPerfil, extrairEntidade, ehEmpresa, catByRowDeMerges } from '../lib/financeiro'
import { gerarExcelTimbrado } from '../lib/excel'
import { gerarDominioCSV } from '../lib/dominio'

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

// ---- Integração FISCAL: cruzamento acumulador × razão ----------------------
const TIPOS_FISCAL = [['entradas', 'Entradas', 'ti-arrow-down-left'], ['saidas', 'Saídas', 'ti-arrow-up-right'], ['servicos', 'Serviços prestados', 'ti-briefcase']]
const CHAVES_FISCAL = TIPOS_FISCAL.map(t => t[0])
// Colunas do arquivo do acumulador por tipo (letras da planilha). O acumulador muda de
// coluna conforme o relatório: Entradas=R, Saídas=AC, Serviços=Q.
const COLS_FISCAL = {
  entradas: { nf: 'K', data: 'N', acum: 'R', forn: 'U', valor: 'AH' },
  saidas: { nf: 'K', data: 'N', acum: 'AC', forn: 'U', valor: 'AH' },
  servicos: { nf: 'K', data: 'N', acum: 'Q', forn: 'U', valor: 'AH' },
}
// NF só com dígitos, sem zeros à esquerda ("05602823" → "5602823").
const normNF = v => String(v ?? '').replace(/\D/g, '').replace(/^0+/, '')
const normAcum = v => String(v ?? '').replace(/\D/g, '').replace(/^0+/, '')
const numFis = v => { if (typeof v === 'number') return v; const n = parseValor(v); return Number.isFinite(n) ? n : 0 }
// Todas as NFs citadas no histórico do razão (após "NF").
function nfsDoHistorico(h) {
  const out = new Set()
  for (const m of String(h || '').matchAll(/nf[\s.ºn°o:_-]*(\d{1,})/gi)) { const d = m[1].replace(/^0+/, ''); if (d) out.add(d) }
  return out
}
// Acumulador citado no histórico (vem depois de "Acum.").
function acumDoHistorico(h) {
  const m = /acum[\s.ºn°o:_-]*(\d{1,})/i.exec(String(h || ''))
  return m ? m[1].replace(/^0+/, '') : ''
}
const normNome = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
const STOP_NOME = new Set(['LTDA', 'ME', 'EPP', 'EIRELI', 'SA', 'CIA', 'DE', 'DA', 'DO', 'DOS', 'DAS', 'E', 'COMERCIO', 'SERVICOS', 'SERVICO', 'BRASIL', 'INDUSTRIA', 'IMPORTACAO', 'EXPORTACAO'])
// Nome do fornecedor/cliente aparece no histórico do razão? (1º token significativo)
function nomeCombina(nome, hist) {
  const toks = normNome(nome).split(' ').filter(t => t.length >= 3 && !STOP_NOME.has(t))
  if (!toks.length) return true
  return normNome(hist).includes(toks[0])
}
// A linha do acumulador (arquivo) foi identificada no razão? SÓ cruza com históricos
// que têm "Acum." + número — assim ignora a contrapartida de banco (que não tem
// acumulador); só entram os lançamentos integrados pela fiscal. Dentro do mesmo
// acumulador, casa pela NF; sem NF, confirma por valor + nome.
function achadoNoRazao(row, idx) {
  const cands = idx.byAcum[row.acum] || []
  if (!cands.length) return false
  const nf = normNF(row.nf)
  if (nf && cands.some(r => r.nfs.has(nf))) return true
  return cands.some(r => Math.abs(r.valor - row.valor) <= 0.05 && nomeCombina(row.forn, r.hist))
}
const brDataIso = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || '') }

// Índice do razão E dos lançamentos ajustados (correções feitas no sistema também
// carregam o acumulador no histórico) — agrupado por acumulador, só históricos com "Acum.".
async function carregarIndiceFiscal(empresaId, competencia) {
  const [mes, ano] = (competencia || '').split('/').map(Number)
  const { data: comp } = await supabase.from('competencias').select('id')
    .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
  const byAcum = {}
  if (!comp) return { byAcum, compId: null }
  const compId = comp.id
  const add = (hist, valor, data) => {
    const acum = acumDoHistorico(hist); if (!acum) return
    ;(byAcum[acum] ||= []).push({ valor, hist: hist || '', nfs: nfsDoHistorico(hist), data: data || '' })
  }
  const { data: rz } = await supabase.from('razao').select('id, data, historico, debito, credito').eq('competencia_id', comp.id)
  // Correções de leitura sobrescrevem o histórico exibido (ex.: acumulador ajustado
  // de 1602 → 614) sem mudar o razão. Usa o histórico corrigido quando existir.
  const ajuste = {}
  const { data: aj } = await supabase.from('ajuste_leitura').select('razao_id, historico')
  for (const a of (aj || [])) if (a.historico) ajuste[a.razao_id] = a.historico
  for (const r of (rz || [])) add(ajuste[r.id] || r.historico, (Number(r.debito) || 0) + (Number(r.credito) || 0), r.data)
  const { data: lc } = await supabase.from('lancamentos').select('data, historico, valor').eq('competencia_id', comp.id)
  for (const l of (lc || [])) add(l.historico, Math.abs(Number(l.valor) || 0), l.data)
  return { byAcum, compId }
}

// Cruza as linhas do arquivo (acumulador) com o índice → resumo por acumulador.
function cruzarFiscal(rows, idx) {
  const porAcum = {}
  for (const row of rows) {
    const a = (porAcum[row.acum] ||= { acum: row.acum, docTotal: 0, idTotal: 0, qtd: 0, qtdId: 0, divs: [] })
    a.qtd++; a.docTotal = Math.round((a.docTotal + row.valor) * 100) / 100
    if (achadoNoRazao(row, idx)) { a.idTotal = Math.round((a.idTotal + row.valor) * 100) / 100; a.qtdId++ }
    else a.divs.push({ nf: row.nf, data: row.data, forn: row.forn, valor: row.valor })
  }
  return Object.values(porAcum)
    .map(a => ({ ...a, dif: Math.round((a.docTotal - a.idTotal) * 100) / 100 }))
    .sort((x, y) => Math.abs(y.dif) - Math.abs(x.dif) || Number(x.acum) - Number(y.acum))
}

// Lê o arquivo do acumulador (colunas conforme o tipo) → linhas normalizadas.
async function parseAcumulador(file, sub) {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
  const arr = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
  const c = COLS_FISCAL[sub] || COLS_FISCAL.entradas
  const col = { nf: XLSX.utils.decode_col(c.nf), data: XLSX.utils.decode_col(c.data), acum: XLSX.utils.decode_col(c.acum), forn: XLSX.utils.decode_col(c.forn), valor: XLSX.utils.decode_col(c.valor) }
  const rows = []
  for (const r of arr) {
    const valor = numFis(r[col.valor]); const acum = normAcum(r[col.acum])
    if (!acum || !valor) continue // pula cabeçalho e linhas sem acumulador/valor
    rows.push({ nf: String(r[col.nf] ?? '').trim(), data: dataISO(r[col.data]), acum, forn: String(r[col.forn] ?? '').trim(), valor })
  }
  return rows
}

// Lê os totais por seção (Entradas/Saídas/Serviços) do "Resumo por Acumulador" (PDF com
// texto): acha cada cabeçalho e pega o "Total:" da seção (Vlr Contábil).
function totaisResumoPdf(texto) {
  const t = String(texto || '')
  const secs = [['entradas', /entradas/i], ['saidas', /sa[ií]das/i], ['servicos', /servi[cç]os/i]]
  const pos = {}
  for (const [k, re] of secs) { const m = re.exec(t); if (m) pos[k] = m.index }
  const keys = Object.keys(pos).sort((a, b) => pos[a] - pos[b])
  const out = {}
  for (let i = 0; i < keys.length; i++) {
    const tr = t.slice(pos[keys[i]], i + 1 < keys.length ? pos[keys[i + 1]] : t.length)
    const m = /total[^0-9-]*(-?\d{1,3}(?:\.\d{3})*,\d{2})/i.exec(tr)
    if (m) out[keys[i]] = parseFloat(m[1].replace(/\./g, '').replace(',', '.'))
  }
  return out
}

export default function Integracao() {
  const { empresas, empresaId, empresaNome, competencia, getCompetenciaId, plano, isAdmin } = useAppData()
  const { user } = useAuth()
  const cliente = empresas.find(e => e.id === empresaId)
  const integ = cliente?.integracao_financeira || 'Não usa'
  const sistema = (cliente?.sistema_financeiro || '').trim()
  const planoMap = Object.fromEntries((plano || []).map(p => [String(p.cod), p]))

  // Persiste o estado da integração financeira (por banco) na competência.
  async function salvarFinanceira(novoFin) {
    const id = await getCompetenciaId()
    if (!id) return
    const novo = { ...estado, financeira: novoFin }
    await supabase.from('competencias').update({ integracoes: novo }).eq('id', id)
    setEstado(novo)
  }
  // Persiste o estado da integração fiscal (3 tipos + cruzamento) na competência.
  async function salvarFiscal(novoFis) {
    const id = await getCompetenciaId()
    if (!id) return
    const novo = { ...estado, fiscal: novoFis }
    await supabase.from('competencias').update({ integracoes: novo }).eq('id', id)
    setEstado(novo)
  }
  // Ao vir do painel ("Continuar" um rascunho), já abre na aba indicada.
  const location = useLocation()
  const [tab, setTab] = useState(location.state?.tab || 'fiscal')
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

  // Marca uma integração (folha/patrimônio) como sem movimento no período.
  async function marcarSemMov(key) {
    const id = await getCompetenciaId()
    if (!id) return
    const novo = { ...estado, [key]: { estado: 'sem_movimento', usuario: user?.email || null } }
    await supabase.from('competencias').update({ integracoes: novo }).eq('id', id)
    setEstado(novo)
  }
  // Uma integração está OK (verde) quando validada ou marcada sem movimento.
  function integracaoOk(key) {
    if (key === 'financeira') {
      const arr = estado.financeira?.bancos ? Object.values(estado.financeira.bancos) : []
      return arr.length > 0 && arr.every(x => x.estado === 'validado' || x.estado === 'sem_movimento')
    }
    return ['validado', 'sem_movimento'].includes(estado[key]?.estado)
  }

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

      <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        {TABS.map(([id, label]) => {
          const ok = integracaoOk(id)
          const ativa = tab === id
          return (
            <button key={id} onClick={() => setTab(id)} style={{ borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 500, border: ativa ? 'none' : `1px solid ${theme.border}`, background: ativa ? theme.accent : 'transparent', color: ativa ? '#fff' : theme.text, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              {label}
              <i className={`ti ${ok ? 'ti-circle-check' : 'ti-alert-triangle'}`} style={{ color: ativa ? '#fff' : ok ? theme.green : theme.yellow, fontSize: 15 }} title={ok ? 'OK' : 'Falta fazer'} />
            </button>
          )
        })}
      </div>

      {erro && <p style={{ color: theme.red, fontSize: 13, marginBottom: 12 }}>{erro}</p>}

      {tab === 'financeira'
        ? (integ === 'Excel'
          ? <Financeira competencia={competencia} est={estado.financeira || {}} empresaId={empresaId} planoMap={planoMap} user={user} onEstado={salvarFinanceira} isAdmin={isAdmin} usaCC={!!cliente?.usa_centro_custo} />
          : <FinanceiraViaSistema integ={integ} sistema={sistema} />)
        : tab === 'fiscal'
          ? <Fiscal competencia={competencia} empresaId={empresaId} user={user} est={estado.fiscal || {}} onEstado={salvarFiscal} />
          : <Cruzamento tab={tab} dados={dados[tab]} onImport={f => importar(tab, f)} onSemMov={() => marcarSemMov(tab)} est={estado[tab]} />}
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

function Cruzamento({ tab, dados, onImport, onSemMov, est }) {
  const total = dados ? somaNumerica(dados.linhas) : 0
  const semMov = est?.estado === 'sem_movimento'
  return (
    <>
      <div><EstadoBadge est={est} /></div>
      <ImpCard titulo={`Importar — ${DESC[tab].split(' ')[1] || 'relatório'}`} desc={DESC[tab]} onImport={onImport} nome={dados?.nome} qtd={dados?.linhas.length} />
      {!semMov && !dados && <button className="btn btn-ghost" style={{ marginTop: 10, fontSize: 12.5 }} onClick={onSemMov} title="Marca esta integração como sem movimento no período (fica verde no Status)"><i className="ti ti-circle-minus" /> Marcar sem movimento</button>}
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

// Integração FISCAL: importa o acumulador (Entradas/Saídas/Serviços) e cruza NF a NF
// com o razão. Resumo por acumulador (total do documento × identificado × diferença);
// clicando numa linha com diferença, mostra as NFs do acumulador que não achei no razão.
function Fiscal({ competencia, empresaId, user, est, onEstado }) {
  const [sub, setSub] = useState('entradas')
  const [razIdx, setRazIdx] = useState(null)   // { byAcum, compId }
  const [compId, setCompId] = useState(null)
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState('')
  const [busy, setBusy] = useState(false)
  const [expand, setExpand] = useState(null)   // acumulador expandido

  const tipos = est?.tipos || {}
  const atual = tipos[sub]
  const nomeLabel = sub === 'entradas' ? 'Fornecedor' : 'Cliente'
  // Resumo recalculado AO VIVO com o índice atual (razão + lançamentos + ajustes) — assim
  // atualiza sozinho ao abrir, sem reimportar. Se o arquivo foi importado numa versão antiga
  // (sem as linhas guardadas), cai no resumo salvo.
  const resumoAtual = (atual?.rows && razIdx) ? cruzarFiscal(atual.rows, razIdx) : (atual?.resumo || [])

  // Índice do razão + lançamentos ajustados da competência, para cruzar o arquivo.
  useEffect(() => {
    let ativo = true
    setCarregando(true); setRazIdx(null); setExpand(null)
    carregarIndiceFiscal(empresaId, competencia).then(idx => { if (ativo) { setRazIdx(idx); setCompId(idx.compId); setCarregando(false) } })
    return () => { ativo = false }
  }, [empresaId, competencia])

  async function importar(file) {
    if (!file || !razIdx) return
    setErro(''); setBusy(true); setExpand(null)
    try {
      const rows = await parseAcumulador(file, sub)
      if (!rows.length) { setErro(`Não encontrei linhas com Acumulador (coluna ${COLS_FISCAL[sub].acum}) e Valor (coluna ${COLS_FISCAL[sub].valor}). Confira o arquivo/colunas.`); setBusy(false); return }
      // Guarda o arquivo no Storage — assim qualquer usuário pode extrair/atualizar depois.
      let path = tipos[sub]?.path || ''
      if (compId) {
        const ext = (file.name.match(/\.[a-z0-9]+$/i) || ['.xlsx'])[0].toLowerCase()
        path = `fiscal/${compId}/${sub}${ext}`
        const { error: eUp } = await supabase.storage.from('extratos').upload(path, file, { upsert: true, contentType: file.type || undefined })
        if (eUp) { setErro('Li o arquivo, mas não consegui guardá-lo p/ extrair depois: ' + eUp.message); path = '' }
      }
      const novoTipos = { ...tipos, [sub]: { doc: file.name, path, rows, resumo: cruzarFiscal(rows, razIdx) } }
      const done = CHAVES_FISCAL.every(k => novoTipos[k])
      await onEstado({ ...est, tipos: novoTipos, estado: done ? 'validado' : null, doc: done ? 'Fiscal · 3 tipos importados' : null, usuario: user?.email || null })
    } catch (e) { setErro('Não consegui ler: ' + e.message) }
    setBusy(false)
  }

  // Extrair (baixar) o arquivo que foi importado — inclusive por outro usuário. Usa a
  // opção de download do Storage + âncora para forçar o download (não abre aba em branco).
  async function extrairArquivo() {
    const t = tipos[sub]
    if (!t?.path) { setErro('Este acumulador foi importado numa versão anterior e o arquivo não ficou salvo. Reimporte uma vez para poder extrair.'); return }
    const nome = t.doc || `acumulador-${sub}.xls`
    const { data, error } = await supabase.storage.from('extratos').createSignedUrl(t.path, 300, { download: nome })
    if (error) { setErro('Não consegui abrir o arquivo: ' + error.message); return }
    const a = document.createElement('a')
    a.href = data.signedUrl; a.download = nome
    document.body.appendChild(a); a.click(); a.remove()
  }

  // Marca / desfaz "sem movimento" para o tipo atual (ex.: cliente sem Saídas).
  async function marcarSemMovTipo() {
    const novoTipos = { ...tipos, [sub]: { semMovimento: true } }
    const done = CHAVES_FISCAL.every(k => novoTipos[k])
    await onEstado({ ...est, tipos: novoTipos, estado: done ? 'validado' : null, doc: done ? 'Fiscal · 3 tipos' : null, usuario: user?.email || null })
  }
  async function desfazerSemMov() {
    const novoTipos = { ...tipos }; delete novoTipos[sub]
    const done = CHAVES_FISCAL.every(k => novoTipos[k])
    await onEstado({ ...est, tipos: novoTipos, estado: done ? 'validado' : null, doc: null, usuario: user?.email || null })
  }

  // Resumo final: importa o "Resumo por Acumulador" (PDF-texto) → totais por tipo.
  async function importarResumo(file) {
    if (!file) return
    setErro(''); setBusy(true)
    try {
      if (!/\.pdf$/i.test(file.name)) { setErro('Envie o "Resumo por Acumulador" do Domínio em PDF (com texto).'); setBusy(false); return }
      const { extrairTextoPdf } = await import('../lib/pdfText')
      const texto = await extrairTextoPdf(file)
      const totais = totaisResumoPdf(texto)
      if (!Object.keys(totais).length) { setErro('Não identifiquei os totais (Entradas/Saídas/Serviços) no resumo. Confira se o PDF tem texto (não é imagem).'); setBusy(false); return }
      let path = est.resumoPdf?.path || ''
      if (compId) {
        path = `fiscal/${compId}/resumo.pdf`
        await supabase.storage.from('extratos').upload(path, file, { upsert: true, contentType: file.type || 'application/pdf' })
      }
      await onEstado({ ...est, resumoPdf: { doc: file.name, path, totais } })
    } catch (e) { setErro('Não consegui ler o resumo: ' + e.message) }
    setBusy(false)
  }
  // Total importado do acumulador por tipo (null = ainda pendente).
  const totalImportado = k => {
    const t = tipos[k]
    if (t?.semMovimento) return 0
    if (t?.rows && razIdx) return cruzarFiscal(t.rows, razIdx).reduce((s, a) => s + a.docTotal, 0)
    if (t?.resumo) return t.resumo.reduce((s, a) => s + a.docTotal, 0)
    return null
  }

  if (carregando) return <p style={{ color: theme.sub, fontSize: 13 }}>Carregando razão…</p>
  const semMov = atual?.semMovimento

  const totDoc = resumoAtual.reduce((s, a) => s + a.docTotal, 0)
  const totId = resumoAtual.reduce((s, a) => s + a.idTotal, 0)
  const totDif = Math.round((totDoc - totId) * 100) / 100
  const totQtd = resumoAtual.reduce((s, a) => s + a.qtd, 0)
  const totQtdId = resumoAtual.reduce((s, a) => s + a.qtdId, 0)

  return (
    <>
      <div><EstadoBadge est={est} /></div>
      {/* seletor dos 3 tipos de movimento + resumo final */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {TIPOS_FISCAL.map(([k, label, icon]) => (
          <button key={k} onClick={() => { setSub(k); setExpand(null) }} className="btn btn-ghost"
            style={{ fontSize: 12.5, padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 7, fontWeight: sub === k ? 700 : 400, borderColor: sub === k ? theme.accent : theme.cb, background: sub === k ? 'rgba(74,124,255,0.10)' : 'transparent' }}>
            <i className={`ti ${icon}`} /> {label} {tipos[k]?.semMovimento ? <i className="ti ti-circle-minus" style={{ color: theme.sub }} title="Sem movimento" /> : tipos[k] ? <i className="ti ti-circle-check" style={{ color: theme.green }} /> : <span style={{ color: theme.sub }}>·</span>}
          </button>
        ))}
        <button onClick={() => { setSub('resumo'); setExpand(null) }} className="btn btn-ghost"
          style={{ fontSize: 12.5, padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 7, fontWeight: sub === 'resumo' ? 700 : 400, borderColor: sub === 'resumo' ? theme.accent : theme.cb, background: sub === 'resumo' ? 'rgba(74,124,255,0.10)' : 'transparent' }}>
          <i className="ti ti-clipboard-check" /> Resumo final
        </button>
      </div>

      {sub === 'resumo' && <ResumoFinal est={est} totalImportado={totalImportado} onImport={importarResumo} busy={busy} />}

      {sub !== 'resumo' && <>
      <ImpCard titulo={`Importar acumulador — ${TIPOS_FISCAL.find(t => t[0] === sub)[1]}`}
        desc={`Colunas: NF (${COLS_FISCAL[sub].nf}), Data (${COLS_FISCAL[sub].data}), Acumulador (${COLS_FISCAL[sub].acum}), ${nomeLabel} (${COLS_FISCAL[sub].forn}), Valor (${COLS_FISCAL[sub].valor}). Cruza NF a NF com o razão.`}
        onImport={importar} nome={atual?.doc} qtd={atual ? resumoAtual.reduce((s, a) => s + a.qtd, 0) : undefined} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '10px 0 0', flexWrap: 'wrap' }}>
        {atual?.path && <button className="btn btn-ghost" style={{ fontSize: 12.5 }} onClick={extrairArquivo} title="Baixar o arquivo do acumulador importado"><i className="ti ti-download" /> Extrair arquivo</button>}
        {!semMov && !atual?.resumo && <button className="btn btn-ghost" style={{ fontSize: 12.5 }} onClick={marcarSemMovTipo} title="Este cliente não tem esse tipo de movimento no período"><i className="ti ti-circle-minus" /> Marcar sem movimento</button>}
        {busy && <span style={{ color: theme.sub, fontSize: 12.5 }}><i className="ti ti-loader" /> Cruzando com razão + lançamentos + ajustes…</span>}
      </div>

      {semMov && <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '16px 0', flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: theme.sub, background: theme.card, border: `1px solid ${theme.cb}`, borderRadius: 20, padding: '5px 12px' }}><i className="ti ti-circle-minus" /> {TIPOS_FISCAL.find(t => t[0] === sub)[1]} — sem movimento no período</span>
        <button className="btn btn-ghost" style={{ fontSize: 12.5 }} onClick={desfazerSemMov}><i className="ti ti-rotate" /> Tem movimento (importar)</button>
      </div>}

      {atual && !semMov && <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 12, margin: '16px 0' }}>
          <Metric label="Total do documento" valor={money(totDoc)} icon="ti-receipt" />
          <Metric label="Razão / contabilidade" valor={money(totId)} icon="ti-checks" cor={theme.green} />
          <Metric label="Diferença" valor={money(totDif)} icon="ti-arrows-diff" cor={Math.abs(totDif) < 0.005 ? theme.green : theme.red} sub={Math.abs(totDif) < 0.005 ? 'tudo identificado' : 'clique no acumulador p/ ver'} />
        </div>

        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
          <table style={{ width: '100%', minWidth: 640, borderCollapse: 'collapse' }}>
            <thead><tr style={{ background: theme.input }}>
              <th style={FS.th}>Acumulador</th><th style={FS.th}>NFs</th><th style={FS.thR}>Total documento</th><th style={FS.thR}>Razão</th><th style={FS.thR}>Diferença</th><th style={FS.th}></th>
            </tr></thead>
            <tbody>
              {resumoAtual.map((a, i) => {
                const bate = Math.abs(a.dif) < 0.005
                const aberto = expand === a.acum
                return (
                  <Fragment key={a.acum}>
                    <tr onClick={() => a.divs.length && setExpand(aberto ? null : a.acum)}
                      style={{ borderTop: `1px solid ${theme.border}`, cursor: a.divs.length ? 'pointer' : 'default', background: bate ? 'transparent' : 'rgba(229,72,77,0.06)' }}>
                      <td style={FS.td}>{a.acum}</td>
                      <td style={FS.td}>{a.qtdId}/{a.qtd}</td>
                      <td style={FS.tdR}>{money(a.docTotal)}</td>
                      <td style={{ ...FS.tdR, color: theme.green }}>{money(a.idTotal)}</td>
                      <td style={{ ...FS.tdR, color: bate ? theme.sub : theme.red, fontWeight: 600 }}>{money(a.dif)}</td>
                      <td style={{ ...FS.td, textAlign: 'center', color: theme.sub }}>{a.divs.length ? <i className={`ti ti-chevron-${aberto ? 'up' : 'down'}`} /> : <i className="ti ti-circle-check" style={{ color: theme.green }} />}</td>
                    </tr>
                    {aberto && a.divs.length > 0 && (
                      <tr><td colSpan={6} style={{ padding: 0, background: theme.input }}>
                        <div style={{ padding: '4px 0' }}>
                          <p style={{ fontSize: 11.5, color: theme.sub, margin: '6px 14px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: .3 }}>Lançado no acumulador e não identificado no razão ({a.divs.length})</p>
                          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead><tr>
                              <th style={FS.thS}>NF</th><th style={FS.thS}>Data</th><th style={FS.thS}>{nomeLabel}</th><th style={FS.thSR}>Valor</th>
                            </tr></thead>
                            <tbody>
                              {a.divs.map((d, j) => (
                                <tr key={j} style={{ borderTop: `1px solid ${theme.border}` }}>
                                  <td style={FS.tdS}>{d.nf || '—'}</td>
                                  <td style={FS.tdS}>{brDataIso(d.data)}</td>
                                  <td style={FS.tdS}>{d.forn || '—'}</td>
                                  <td style={{ ...FS.tdS, textAlign: 'right', color: theme.red }}>{money(d.valor)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </td></tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: `2px solid ${theme.border}`, background: theme.input, fontWeight: 700 }}>
                <td style={FS.td}>Total</td>
                <td style={FS.td}>{totQtdId}/{totQtd}</td>
                <td style={FS.tdR}>{money(totDoc)}</td>
                <td style={{ ...FS.tdR, color: theme.green }}>{money(totId)}</td>
                <td style={{ ...FS.tdR, color: Math.abs(totDif) < 0.005 ? theme.sub : theme.red }}>{money(totDif)}</td>
                <td style={FS.td}></td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p style={{ color: theme.sub, fontSize: 11.5, margin: '10px 0 0' }}>
          Cruzamento pelo acumulador (coluna {COLS_FISCAL[sub].acum}) × "Acum." no histórico do razão <b style={{ color: theme.text }}>e dos lançamentos ajustados</b> — atualiza sozinho ao abrir. A fiscal vira <b style={{ color: theme.text }}>validada</b> no Status quando os 3 tipos forem importados.
        </p>
      </>}
      </>}
      {erro && <p style={{ color: theme.red, fontSize: 13, margin: '12px 0 0' }}>{erro}</p>}
    </>
  )
}

// Tela de Resumo Final: importa o "Resumo por Acumulador" (Domínio) e cruza o total
// de cada tipo (Entradas/Saídas/Serviços) com o que foi importado do acumulador.
function ResumoFinal({ est, totalImportado, onImport, busy }) {
  const totais = est?.resumoPdf?.totais || {}
  const temResumo = !!est?.resumoPdf
  const linhas = TIPOS_FISCAL.map(([k, label]) => {
    const imp = totalImportado(k)          // total importado do acumulador (0 = sem movimento; null = pendente)
    const ref = totais[k]                  // total do resumo do Domínio
    const dif = (imp != null && ref != null) ? Math.round((imp - ref) * 100) / 100 : null
    return { k, label, imp, ref, dif }
  })
  const tudoOk = temResumo && linhas.every(l => l.dif != null && Math.abs(l.dif) < 0.005)
  return (
    <>
      <ImpCard titulo="Importar Resumo por Acumulador (Domínio)"
        desc={'PDF (com texto) do "Resumo por Acumulador". Leio os totais de Entradas, Saídas e Serviços e confiro com o que foi importado.'}
        onImport={onImport} nome={est?.resumoPdf?.doc} qtd={temResumo ? Object.keys(totais).length : undefined} />
      {busy && <p style={{ color: theme.sub, fontSize: 12.5, margin: '10px 0 0' }}><i className="ti ti-loader" /> Lendo o resumo…</p>}

      <div style={{ margin: '16px 0', padding: 16, borderRadius: 12, border: `1px solid ${tudoOk ? theme.green : theme.cb}`, background: theme.card }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <i className={`ti ${tudoOk ? 'ti-circle-check' : 'ti-clipboard-list'}`} style={{ color: tudoOk ? theme.green : theme.accent, fontSize: 18 }} />
          <span style={{ fontSize: 14, fontWeight: 700 }}>{tudoOk ? 'Tudo bateu — fiscal conferida' : temResumo ? 'Conferência do resumo × acumulador' : 'Importe o resumo para conferir'}</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 560, borderCollapse: 'collapse' }}>
            <thead><tr style={{ background: theme.input }}>
              <th style={FS.th}>Tipo</th><th style={FS.thR}>Resumo (Domínio)</th><th style={FS.thR}>Acumulador importado</th><th style={FS.thR}>Diferença</th><th style={{ ...FS.th, textAlign: 'center' }}>Status</th>
            </tr></thead>
            <tbody>
              {linhas.map(l => {
                const bate = l.dif != null && Math.abs(l.dif) < 0.005
                return (
                  <tr key={l.k} style={{ borderTop: `1px solid ${theme.border}` }}>
                    <td style={FS.td}>{l.label}</td>
                    <td style={FS.tdR}>{l.ref != null ? money(l.ref) : '—'}</td>
                    <td style={FS.tdR}>{l.imp != null ? money(l.imp) : <span style={{ color: theme.yellow }}>pendente</span>}</td>
                    <td style={{ ...FS.tdR, color: l.dif == null ? theme.sub : bate ? theme.sub : theme.red, fontWeight: 600 }}>{l.dif != null ? money(l.dif) : '—'}</td>
                    <td style={{ ...FS.td, textAlign: 'center' }}>{l.dif == null ? <i className="ti ti-minus" style={{ color: theme.sub }} /> : bate ? <i className="ti ti-circle-check" style={{ color: theme.green }} /> : <i className="ti ti-alert-triangle" style={{ color: theme.red }} />}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p style={{ color: theme.sub, fontSize: 11.5, margin: '10px 2px 0' }}>Compara o total do "Resumo por Acumulador" (Domínio) com o total do acumulador que você importou em cada tipo. Verde quando bate (≤ 5 centavos).</p>
      </div>
    </>
  )
}
const FS = {
  th: { textAlign: 'left', padding: '10px 12px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3, whiteSpace: 'nowrap' },
  thR: { textAlign: 'right', padding: '10px 12px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3, whiteSpace: 'nowrap' },
  td: { padding: '9px 12px', fontSize: 13, color: theme.text },
  tdR: { padding: '9px 12px', fontSize: 13, color: theme.text, textAlign: 'right' },
  thS: { textAlign: 'left', padding: '6px 14px', fontSize: 10.5, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3 },
  thSR: { textAlign: 'right', padding: '6px 14px', fontSize: 10.5, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3 },
  tdS: { padding: '6px 14px', fontSize: 12, color: theme.text },
}

// Índice da coluna que melhor casa com um regex no cabeçalho; senão -1.
function achaColuna(header, re) {
  const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  return (header || []).findIndex(h => re.test(norm(h)))
}

// Trava de competência: toda data do extrato precisa cair no mês do fechamento.
// Retorna a mensagem de erro (string vazia = ok).
function validarCompetencia(linhas, mapa, comp) {
  const [mm, yyyy] = String(comp || '').split('/')
  if (!mm || !yyyy) return ''
  const alvo = `${yyyy}-${mm.padStart(2, '0')}`
  if (mapa.data < 0) return `Não identifiquei a coluna de Data no arquivo. Selecione a coluna "Data" abaixo — o extrato precisa ser todo de ${comp}.`
  const fora = linhas.filter(l => l.data && l.data.slice(0, 7) !== alvo)
  if (fora.length) {
    const ex = [...new Set(fora.map(l => l.data.split('-').reverse().join('/')))].slice(0, 3).join(', ')
    return `O extrato tem ${fora.length} lançamento(s) fora de ${comp} (ex.: ${ex}). Importe apenas o extrato da competência ${comp}.`
  }
  const semData = linhas.filter(l => !l.data).length
  if (semData) return `${semData} linha(s) sem data reconhecida. Confira a coluna de Data — todas precisam ser de ${comp}.`
  return ''
}

function Financeira({ competencia, est, empresaId, planoMap, user, onEstado, isAdmin, usaCC }) {
  const [contas, setContas] = useState([])       // [{ conta_contabil, agencia, conta }]
  const [memoria, setMemoria] = useState([])     // [{ termo, conta }]
  const [memMeta, setMemMeta] = useState({ nomeArquivo: '', semCarga: false })
  const [carregReg, setCarregReg] = useState(true)
  const [novo, setNovo] = useState({ conta_contabil: '', agencia: '', conta: '' })
  const [modo, setModo] = useState('porBanco')   // 'porBanco' | 'combinado'
  const [raw, setRaw] = useState(null)           // { nome, header, linhasRaw, banco, viaPerfil }
  const [map, setMap] = useState({ hist: -1, valor: -1, data: -1 })
  const [linhas, setLinhas] = useState([])       // classificação: [{ banco, historico, valor, entrada, contra, data }]
  const [erro, setErro] = useState('')
  const [msg, setMsg] = useState('')
  const [perfil, setPerfil] = useState(null)     // perfil de leitura do extrato deste cliente
  const [cfg, setCfg] = useState(null)           // { raw, banco, perfil } — painel de mapeamento aberto
  const [fSem, setFSem] = useState(false)        // filtro: só linhas sem contrapartida
  const [fHist, setFHist] = useState('')         // filtro por histórico
  const [fMode, setFMode] = useState('contem')   // 'contem' | 'exato'
  const [fData, setFData] = useState('')         // filtro por data (dd/mm)
  const [fES, setFES] = useState('')             // filtro entrada/saída ('' | 'entrada' | 'saida')
  const [fConta, setFConta] = useState('')       // filtro por conta de contrapartida
  const [lote, setLote] = useState('')           // conta para preencher em lote nas selecionadas
  const [sel, setSel] = useState(() => new Set())// linhas selecionadas (índice original)
  const [quebra, setQuebra] = useState(null)      // { i, linha } divisão de um lançamento
  const [saldoAnterior, setSaldoAnterior] = useState(null) // saldo do banco no balancete (abertura)
  const [saldoExtrato, setSaldoExtrato] = useState('')     // saldo do extrato informado pelo usuário
  const [cruza, setCruza] = useState(null)                 // resultado do cruzamento por dia com o extrato
  const [cruzaOpen, setCruzaOpen] = useState(false)        // modal do cruzamento aberto (dá p/ reabrir)
  const [novoLanc, setNovoLanc] = useState(false)          // modal de incluir lançamento manual
  const refsContra = useRef({})                  // foco: Enter pula para a próxima linha

  const nomeBanco = cod => planoMap[String(cod)]?.nome || (cod ? `Conta ${cod}` : '—')
  const bancosEst = est?.bancos || {}
  // Contas de adiantamento (nome contém "adiant") — usadas para a regra: com nota não é adiantamento.
  const adiantContas = new Set(Object.entries(planoMap).filter(([, pl]) => /adiant/i.test(pl?.nome || '')).map(([cod]) => cod))

  useEffect(() => {
    setCarregReg(true); setRaw(null); setLinhas([]); setErro(''); setMsg('')
    Promise.all([
      supabase.from('cargas_cadastro').select('dados, obs').eq('cliente_id', empresaId).eq('tipo', 'contas_bancarias').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('cargas_cadastro').select('dados, obs').eq('cliente_id', empresaId).eq('tipo', 'memoria_financeira').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ]).then(([bc, mem]) => {
      setContas(Array.isArray(bc.data?.dados) ? bc.data.dados : [])
      let perf = null
      try { const o = JSON.parse(bc.data?.obs || ''); if (o && typeof o === 'object' && o.perfil) perf = o.perfil } catch { /* obs antigo em texto */ }
      setPerfil(perf); setCfg(null)
      setMemoria(Array.isArray(mem.data?.dados) ? mem.data.dados : [])
      let meta = { nomeArquivo: '', semCarga: false }
      try { const m = JSON.parse(mem.data?.obs || ''); if (m && typeof m === 'object') meta = { nomeArquivo: m.nomeArquivo || '', semCarga: !!m.semCarga } } catch { /* obs antigo em texto */ }
      setMemMeta(meta)
      setCarregReg(false)
    })
  }, [empresaId])

  // Cadastro de bancos e memória valem para todas as competências (o cliente
  // cadastra uma vez). Por isso é lido sempre pelo registro mais recente, sem
  // filtro de mês, e persiste para os próximos meses.
  async function salvarCarga(tipo, arr, obs) {
    await supabase.from('cargas_cadastro').delete().eq('cliente_id', empresaId).eq('tipo', tipo)
    const { error } = await supabase.from('cargas_cadastro').insert({ cliente_id: empresaId, tipo, vigencia: competencia, dados: arr, usuario: user?.email || null, obs })
    if (error) setErro('Não consegui gravar: ' + error.message)
    return error
  }
  // O perfil de leitura do extrato vive no obs da carga de contas bancárias
  // (uma vez por cliente, vale para todos os meses).
  async function salvarContas(arr, perf = perfil) { setContas(arr); await salvarCarga('contas_bancarias', arr, JSON.stringify({ perfil: perf || null })) }
  async function salvarPerfil(perf) { setPerfil(perf); await salvarCarga('contas_bancarias', contas, JSON.stringify({ perfil: perf || null })) }
  function addConta() {
    const cod = String(novo.conta_contabil || '').trim()
    if (!cod) return
    if (contas.some(c => String(c.conta_contabil).trim() === cod)) { setErro('Essa conta já está cadastrada.'); return }
    setErro(''); salvarContas([...contas, { conta_contabil: cod, agencia: novo.agencia.trim(), conta: novo.conta.trim() }])
    setNovo({ conta_contabil: '', agencia: '', conta: '' })
  }
  const removeConta = i => salvarContas(contas.filter((_, j) => j !== i))
  // Excluir banco do cadastro (só admin): tira o slot e limpa o estado da competência.
  async function excluirBanco(c) {
    if (!window.confirm(`Excluir o banco ${c.conta_contabil} · ${nomeBanco(c.conta_contabil)} do cadastro? Ele deixa de exigir integração nesta e nas próximas competências.`)) return
    marcarBanco(c.conta_contabil, null)
    await salvarContas(contas.filter(x => String(x.conta_contabil) !== String(c.conta_contabil)))
  }

  // Memória: grava entradas + metadados (arquivo de origem / marcado "sem carga").
  async function salvarMemoria(entries, meta) {
    setMemoria(entries); setMemMeta(meta)
    await salvarCarga('memoria_financeira', entries, JSON.stringify(meta))
  }
  async function excluirMemoria() {
    if (!window.confirm('Excluir a memória do financeiro deste cliente? As classificações aprendidas serão perdidas.')) return
    await salvarMemoria([], { nomeArquivo: '', semCarga: false }); setMsg('Memória excluída.')
  }
  async function marcarSemCarga() { await salvarMemoria([], { nomeArquivo: '', semCarga: true }); setMsg('Marcado: não tem carga inicial.') }

  // Estado por banco na competência (importado / sem movimento). Vazio = pendente.
  function marcarBanco(conta, estadoB, doc) {
    const bancos = { ...(est?.bancos || {}) }
    if (estadoB) bancos[conta] = { estado: estadoB, doc: doc || null, usuario: user?.email || null }
    else delete bancos[conta]
    onEstado({ ...est, bancos })
  }
  // Salva o banco com o rascunho da classificação (linhas), para continuar depois.
  // estado 'rascunho' = em andamento (ainda pendente no Status); 'validado' = concluído.
  function salvarBancoDraft(conta, estadoB, doc, draftLinhas) {
    const bancos = { ...(est?.bancos || {}) }
    bancos[conta] = { estado: estadoB, doc: doc || null, usuario: user?.email || null, draft: draftLinhas || null, saldoExtrato: saldoExtrato || null, cruza: cruza || null }
    onEstado({ ...est, bancos })
  }
  function marcarCombinado(doc) { onEstado({ ...est, combinado: { estado: 'validado', doc, usuario: user?.email || null } }) }

  // Reconstroi a classificação a partir do arquivo cru + mapa de colunas + memória.
  function classificar(rawX, mapX, memX, bancoFixo) {
    const codigos = new Set(contas.map(c => String(c.conta_contabil).trim()))
    return rawX.linhasRaw.map(cells => {
      let banco = bancoFixo || ''
      if (modo === 'combinado') { banco = ''; for (const c of cells) { const v = String(c ?? '').trim(); if (codigos.has(v)) { banco = v; break } } }
      const historico = mapX.hist >= 0 ? String(cells[mapX.hist] ?? '').trim() : ''
      const valor = mapX.valor >= 0 ? parseValor(cells[mapX.valor]) : 0
      const data = mapX.data >= 0 ? dataISO(cells[mapX.data]) : ''
      return { banco, historico, valor: Math.abs(valor), entrada: valor >= 0, contra: casarHistorico(historico, memX), data }
    })
  }

  // Palpite inicial do perfil (o usuário confere/ajusta no painel de mapeamento).
  function perfilPadrao(arr) {
    let ini = 1
    for (let i = 0; i < Math.min(arr.length, 40); i++) {
      const r = arr[i] || []
      const filled = r.filter(c => c !== '' && c != null).length
      const hasNum = r.some(c => typeof c === 'number' || parseValor(c) > 1)
      if (filled >= 3 && hasNum) { ini = i; break }
    }
    const rows = arr.slice(ini, ini + 60)
    const nc = arr.reduce((m, r) => Math.max(m, (r || []).length), 0)
    let colValor = -1, colData = -1, colCredor = -1, best = 0, bestLen = 0
    for (let j = 0; j < nc; j++) {
      const nums = rows.filter(r => { const v = parseValor(r?.[j]); return v && Math.abs(v) >= 1 }).length
      if (nums > best) { best = nums; colValor = j }
      if (colData < 0 && rows.filter(r => dataISO(r?.[j])).length > rows.length / 3) colData = j
      const avg = rows.reduce((s, r) => { const t = String(r?.[j] ?? ''); return s + (/[A-Za-z]{3,}/.test(t) ? t.length : 0) }, 0) / (rows.length || 1)
      if (avg > bestLen) { bestLen = avg; colCredor = j }
    }
    return { linhaInicio: ini, colValor, colData, colCredor, colDoc: -1, colCategoria: -1, histCols: [], es: { modo: 'sinal', col: -1, entrada: [] }, filtro: { col: -1, pularVazio: false } }
  }

  // Aplica o perfil já salvo a um extrato por banco e segue (marca o banco).
  function aplicarEProsseguir(arr, nome, bancoFixo, perf, catByRow) {
    const norm = aplicarPerfil(arr, perf, memoria, catByRow, adiantContas).map(l => ({ ...l, banco: bancoFixo }))
    // Reimport do mesmo arquivo: preserva as contrapartidas já preenchidas no
    // rascunho (mesmo arquivo → mesma ordem), atualizando histórico/valor/data.
    const prevBanco = (est?.bancos || {})[bancoFixo]
    const prev = prevBanco?.draft
    let mantidas = 0
    if (Array.isArray(prev) && prev.length === norm.length) {
      norm.forEach((l, i) => { if (prev[i]?.contra) { l.contra = prev[i].contra; mantidas++ } })
    }
    if (prevBanco?.saldoExtrato) setSaldoExtrato(prevBanco.saldoExtrato)
    setCruza(prevBanco?.cruza || null); setCruzaOpen(false)
    setRaw({ nome, banco: bancoFixo, viaPerfil: true, arr, catByRow })
    setLinhas(norm); setSel(new Set())
    if (!norm.length) { setErro('O perfil de leitura não encontrou lançamentos. Clique em “Ajustar leitura” e revise o mapeamento.'); return }
    const erroComp = validarCompetencia(norm, { data: (perf.colData != null && perf.colData >= 0) ? 0 : -1 }, competencia)
    if (erroComp) { setErro(erroComp); return }
    const casadas = norm.filter(l => l.contra).length
    setMsg(`${norm.length} linha(s) · ${casadas} classificada(s)${mantidas ? ` · ${mantidas} do rascunho preservada(s)` : ' pela memória'}. Rascunho salvo — conclua quando tudo estiver contabilizado.`)
    // Salva como rascunho (em andamento); só vira "concluído" ao clicar Concluir.
    salvarBancoDraft(bancoFixo, 'rascunho', nome, norm)
  }

  // Salva o progresso atual (rascunho) sem concluir.
  function salvarRascunho() {
    if (!raw?.banco) return
    salvarBancoDraft(raw.banco, 'rascunho', raw.nome, linhas)
    setMsg('Rascunho salvo — você pode fechar e continuar depois.')
  }
  // Conclui o banco (marca como contabilizado) — some do pendente no Status.
  function concluirBanco() {
    if (!raw?.banco) return
    const faltam = linhas.filter(l => !l.contra).length
    if (faltam && !window.confirm(`Ainda há ${faltam} linha(s) sem contrapartida. Concluir assim mesmo?`)) return
    salvarBancoDraft(raw.banco, 'validado', raw.nome, linhas)
    setMsg('Banco concluído — lançamentos contabilizados.')
  }
  // Continua um rascunho salvo (carrega as linhas para a tela).
  function continuarRascunho(conta) {
    const s = (est?.bancos || {})[conta]
    if (!s?.draft) return
    setRaw({ nome: s.doc || 'Rascunho', banco: conta, viaPerfil: true, resumo: true })
    setLinhas(s.draft); setSel(new Set()); setErro(''); setSaldoExtrato(s.saldoExtrato || ''); setCruza(s.cruza || null); setCruzaOpen(false)
    setMsg(`Rascunho carregado — ${s.draft.length} linha(s). Continue de onde parou.`)
  }

  // Desfaz a importação atual: limpa a prévia/filtros e volta o banco a pendente.
  function desfazerImport() {
    if (raw?.viaPerfil && raw.banco) marcarBanco(raw.banco, null)
    else if (modo === 'combinado') { const e = { ...est }; delete e.combinado; onEstado(e) }
    setRaw(null); setLinhas([]); setSel(new Set())
    setFSem(false); setFHist(''); setFData(''); setFES(''); setFConta(''); setLote('')
    setErro(''); setMsg('Importação desfeita — pode iniciar uma nova.')
  }

  async function importar(file, bancoFixo) {
    if (!file) return
    setErro(''); setMsg('')
    try {
      if (modo === 'combinado' && !contas.length) { setErro('Cadastre as contas bancárias antes de importar uma planilha combinada.'); return }
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
      const catByRow = catByRowDeMerges(ws['!merges'], arr)
      // Extrato por banco: cada cliente exporta diferente → usa o perfil salvo;
      // se ainda não houver, abre o mapeamento (uma vez por cliente).
      if (modo === 'porBanco' && bancoFixo) {
        if (perfil) return aplicarEProsseguir(arr, file.name, bancoFixo, perfil, catByRow)
        setCfg({ arr, catByRow, nome: file.name, banco: bancoFixo, perfil: perfilPadrao(arr) })
        return
      }
      const header = arr[0] || []
      const linhasRaw = arr.slice(1).filter(r => r.some(c => c !== '' && c != null)).slice(0, 1000)
      // Auto-detecta as colunas de histórico, valor e data.
      let hist = achaColuna(header, /hist|descri|lancament|memo|complemento/)
      let valor = achaColuna(header, /valor|montante|r\$|credito|debito/)
      const data = achaColuna(header, /^data|\bdata\b|dt\b/)
      if (hist < 0) {
        let melhor = -1, best = 0
        for (let j = 0; j < (header.length || (linhasRaw[0]?.length || 0)); j++) {
          const avg = linhasRaw.reduce((s, r) => s + (typeof r[j] === 'string' ? r[j].length : 0), 0) / (linhasRaw.length || 1)
          if (avg > best) { best = avg; melhor = j }
        }
        hist = melhor
      }
      if (valor < 0) {
        for (let j = 0; j < (header.length || 0); j++) { if (linhasRaw.filter(r => typeof r[j] === 'number' || parseValor(r[j])).length > linhasRaw.length / 2) { valor = j; break } }
      }
      const mapa = { hist, valor, data }
      const novoRaw = { nome: file.name, header, linhasRaw, banco: bancoFixo || '' }
      setRaw(novoRaw); setMap(mapa)
      const cl = classificar(novoRaw, mapa, memoria, bancoFixo)
      setLinhas(cl)
      // Trava de competência: se houver data fora do mês, mostra a prévia mas NÃO sobe.
      const erroComp = validarCompetencia(cl, mapa, competencia)
      if (erroComp) { setErro(erroComp); return }
      const casadas = cl.filter(l => l.contra).length
      setMsg(`${cl.length} linha(s) · ${casadas} já classificada(s) pela memória · competência ${competencia} conferida.`)
      if (modo === 'combinado') marcarCombinado(file.name)
      else if (bancoFixo) marcarBanco(bancoFixo, 'validado', file.name)
    } catch (e) { setErro('Não consegui ler: ' + e.message) }
  }

  function trocarCol(campo, idx) {
    const mapa = { ...map, [campo]: idx }
    setMap(mapa)
    if (!raw) return
    const cl = classificar(raw, mapa, memoria, raw.banco)
    setLinhas(cl)
    // Reconfere a competência ao trocar a coluna de data (ex.: quando não foi auto-detectada).
    const erroComp = validarCompetencia(cl, mapa, competencia)
    setErro(erroComp)
    if (!erroComp && campo === 'data') {
      if (modo === 'combinado') marcarCombinado(raw.nome)
      else if (raw.banco) marcarBanco(raw.banco, 'validado', raw.nome)
      setMsg(`${cl.length} linha(s) · competência ${competencia} conferida.`)
    }
  }
  const setLinha = (i, patch) => setLinhas(ls => ls.map((l, j) => j === i ? { ...l, ...patch } : l))

  // Salva as linhas no rascunho do banco (mantém estado/doc atuais).
  function persistirLinhas(novas) {
    if (raw?.banco) salvarBancoDraft(raw.banco, bancosEst[raw.banco]?.estado || 'rascunho', raw.nome, novas)
  }
  // Exclui um lançamento (com confirmação) — para corrigir direto antes de gerar.
  function excluirLinha(i) {
    if (!window.confirm('Tem certeza que deseja excluir este lançamento?')) return
    const novas = linhas.filter((_, j) => j !== i)
    setLinhas(novas); setSel(new Set()); persistirLinhas(novas)
    setMsg('Lançamento excluído.')
  }
  // Inclui um lançamento manual (confirmado no modal) — ex.: um que faltou.
  function adicionarLinha(nova) {
    const novas = [...linhas, nova]
    setLinhas(novas); persistirLinhas(novas); setNovoLanc(false)
    setMsg('Lançamento incluído.')
  }

  // Filtros da tabela de classificação + preenchimento em lote.
  const dataBR = iso => iso ? iso.split('-').reverse().join('/') : ''
  const normTxt = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  function linhaVisivel(l) {
    if (fSem && l.contra) return false
    if (fHist) {
      const h = normTxt(l.historico), q = normTxt(fHist)
      if (fMode === 'exato' ? h !== q : !h.includes(q)) return false
    }
    if (fData && !dataBR(l.data).includes(fData.trim())) return false
    if (fES && (fES === 'entrada') !== !!l.entrada) return false
    if (fConta && String(l.contra || '').trim() !== String(fConta).trim()) return false
    return true
  }
  const toggleUm = i => setSel(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n })
  // Saldo de abertura do banco (balancete da competência) para conferência do extrato.
  async function carregarSaldoAnterior(banco) {
    const [mes, ano] = (competencia || '').split('/').map(Number)
    const { data: comp } = await supabase.from('competencias').select('id').eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
    if (!comp) { setSaldoAnterior(null); return }
    const { data: bal } = await supabase.from('balancete').select('saldo_inicial').eq('competencia_id', comp.id).eq('conta', String(banco)).limit(1).maybeSingle()
    setSaldoAnterior(bal ? Number(bal.saldo_inicial) : null)
  }
  useEffect(() => { if (raw?.banco) carregarSaldoAnterior(raw.banco); else { setSaldoAnterior(null); setSaldoExtrato(''); setCruza(null); setCruzaOpen(false) } }, [raw?.banco, competencia]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cruza os lançamentos classificados com o extrato do banco (saldos diários) para
  // achar o dia onde começa a diferença. O sinal é a MUDANÇA da diferença de um dia
  // para o outro (independe do saldo de abertura estar alinhado).
  async function cruzarSaldos(file) {
    if (!file) return
    setErro('')
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
      // Acha a linha de cabeçalho (a que tem Data e Saldo) — extratos costumam ter
      // várias linhas de topo (nome, agência, período) antes da tabela.
      let hIdx = 0, iData = -1, iSaldo = -1
      for (let i = 0; i < Math.min(arr.length, 40); i++) {
        const hd = arr[i] || []
        const d = achaColuna(hd, /^data|\bdata\b|dt\b/)
        const s = achaColuna(hd, /saldo|balance/)
        if (d >= 0 && s >= 0) { hIdx = i; iData = d; iSaldo = s; break }
      }
      const rows = arr.slice(hIdx + 1).filter(r => r.some(c => c !== '' && c != null))
      if (iData < 0) iData = achaColuna(arr[hIdx] || [], /^data|\bdata\b|dt\b/)
      if (iSaldo < 0) { // fallback: última coluna com números na maioria das linhas
        for (let j = ((arr[hIdx] || []).length || (rows[0]?.length || 0)) - 1; j >= 0; j--) {
          if (rows.filter(r => typeof r[j] === 'number' || parseValor(r[j])).length > rows.length / 2) { iSaldo = j; break }
        }
      }
      if (iData < 0 || iSaldo < 0) { setErro('Não identifiquei as colunas de Data e Saldo no extrato. Confira se há uma coluna Data e uma Saldo.'); return }
      // extrato: saldo de fim de dia (último por data, assumindo ordem cronológica)
      const extratoDia = new Map()
      for (const r of rows) { const d = dataISO(r[iData]); if (d) extratoDia.set(d, parseValor(r[iSaldo])) }
      // movimento por dia a partir da classificação
      const movDia = {}
      for (const l of linhas) { if (!l.data) continue; movDia[l.data] = (movDia[l.data] || 0) + (l.entrada ? l.valor : -l.valor) }
      const dias = [...new Set([...extratoDia.keys(), ...Object.keys(movDia)])].sort()
      let corrente = saldoAnterior || 0, prevDif = null, primeiroDiv = null
      const out = []
      for (const d of dias) {
        corrente += (movDia[d] || 0)
        const ext = extratoDia.has(d) ? extratoDia.get(d) : null
        const dif = ext == null ? null : Math.round((corrente - ext) * 100) / 100
        const delta = (dif == null || prevDif == null) ? null : Math.round((dif - prevDif) * 100) / 100
        if (delta != null && Math.abs(delta) >= 0.005 && !primeiroDiv) primeiroDiv = d
        out.push({ data: d, mov: movDia[d] || 0, calc: corrente, ext, dif, delta })
        if (dif != null) prevDif = dif
      }
      const difTotal = out.filter(d => d.dif != null).slice(-1)[0]?.dif ?? null
      setCruza({ dias: out, primeiroDiv, difTotal }); setCruzaOpen(true)
    } catch (e) { setErro('Não consegui ler o extrato: ' + e.message) }
  }
  // Divide um lançamento em vários (ex.: 1 DARF → 3 lançamentos contábeis).
  function confirmarQuebra(i, partes) {
    const base = linhas[i]
    const novas = partes.map(p => ({ ...base, valor: Math.abs(Number(p.valor) || 0), contra: String(p.contra || '').trim() }))
    setLinhas(ls => [...ls.slice(0, i), ...novas, ...ls.slice(i + 1)])
    setSel(new Set()); setQuebra(null)
    setMsg(`Lançamento dividido em ${novas.length}.`)
  }
  function aplicarLote() {
    const cod = String(lote || '').trim()
    if (!cod) { setMsg('Informe a conta para aplicar em lote.'); return }
    if (!sel.size) { setMsg('Selecione as linhas (caixas à esquerda) para aplicar a conta.'); return }
    const n = sel.size
    setLinhas(ls => ls.map((l, j) => sel.has(j) ? { ...l, contra: cod } : l))
    // Volta ao estado original para a próxima aplicação: limpa filtro, seleção e conta.
    setSel(new Set()); setLote(''); setFSem(false); setFHist(''); setFData(''); setFES(''); setFConta('')
    setMsg(`Conta ${cod} aplicada em ${n} linha(s). Pronto para a próxima seleção.`)
  }

  // Aprende: guarda credor/devedor → contrapartida das linhas classificadas
  // (casa pelo nome da empresa; cai no histórico montado se não houver credor).
  async function aprenderSalvar() {
    const novas = linhas.filter(l => l.contra && (l.credor || l.historico)).map(l => ({ historico: l.credor || l.historico, conta: l.contra }))
    if (!novas.length) { setMsg('Classifique ao menos uma linha (contrapartida) antes de salvar.'); return }
    const mem = aprender(memoria, novas)
    await salvarMemoria(mem, { nomeArquivo: memMeta.nomeArquivo, semCarga: false })
    setMsg(`Memória atualizada — ${novas.length} classificação(ões) aprendida(s).`)
  }

  // Semeia/complementa a memória a partir do layout de lançamentos do Domínio
  // (Complemento Histórico + contas de débito/crédito). A contrapartida é o lado
  // que NÃO é o banco. Aceita também uma planilha simples "Histórico | Conta".
  async function importarMemoria(file) {
    if (!file) return
    setErro('')
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const arr = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
      const header = arr[0] || []
      const iCompl = achaColuna(header, /complement/)
      const iDeb = achaColuna(header, /conta.*debito/)
      const iCred = achaColuna(header, /conta.*credito/)
      const novas = []
      if (iCompl >= 0 && iDeb >= 0 && iCred >= 0) {
        // Layout do Domínio: descobre o banco (contas cadastradas; se não houver,
        // infere pelo código de conta mais frequente — o banco aparece em quase
        // toda linha) e aprende histórico → contrapartida (o lado não-banco).
        const rows = arr.slice(1).filter(r => r.some(c => c !== '' && c != null))
        let bancos = new Set(contas.map(c => String(c.conta_contabil).trim()))
        if (!bancos.size) {
          const freq = {}
          for (const r of rows) for (const i of [iDeb, iCred]) { const v = String(r[i] ?? '').trim(); if (v) freq[v] = (freq[v] || 0) + 1 }
          const top = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]
          if (top) bancos = new Set([top[0]])
        }
        for (const r of rows) {
          const compl = String(r[iCompl] ?? '').trim()
          const d = String(r[iDeb] ?? '').trim(), c = String(r[iCred] ?? '').trim()
          if (!compl) continue
          const contra = bancos.has(d) ? c : bancos.has(c) ? d : ''
          const ent = extrairEntidade(compl)
          // Não aprende credor→adiantamento: adiantamento é contextual (sem nota),
          // não é regra fixa do credor. Pula pela conta (nome "adiant") e pela
          // categoria da linha (trecho antes do " - " no complemento).
          const catBase = String(compl).split(/\s-\s/)[0]
          if (contra && ent && ehEmpresa(ent) && !adiantContas.has(String(contra)) && !/adiant/i.test(catBase)) novas.push({ historico: ent, conta: contra })
        }
      } else {
        // Planilha simples: Histórico | Conta contrapartida.
        const iH = achaColuna(header, /hist|descri|memo/)
        const iC = achaColuna(header, /conta|contrapart|codigo/)
        const rows = (iH >= 0 && iC >= 0) ? arr.slice(1) : arr
        for (const r of rows) {
          const h = String((iH >= 0 ? r[iH] : r[0]) ?? '').trim()
          const c = String((iC >= 0 ? r[iC] : r[1]) ?? '').trim()
          if (h && c) novas.push({ historico: h, conta: c })
        }
      }
      if (!novas.length) { setErro('Não reconheci o layout. Baixe o modelo e use as mesmas colunas (Complemento Histórico e as contas de débito/crédito).'); return }
      // A memória casa pelo TEXTO do histórico (sem datas/números). Linhas cujo
      // histórico é só número/código não geram termo — descarta e avisa.
      const validas = novas.filter(n => normHist(n.historico))
      if (!validas.length) { setErro(`Li ${novas.length} linha(s), mas o histórico (Complemento) parece ter só números/códigos — não há texto para a memória aprender. Confira o arquivo.`); return }
      if (!window.confirm(`Importar ${validas.length} histórico(s) para a memória do financeiro deste cliente? Confira antes de confirmar.`)) return
      const mem = aprender(memoria, validas)
      if (!mem.length) { setErro('Nada para gravar na memória.'); return }
      await salvarMemoria(mem, { nomeArquivo: file.name, semCarga: false })
      setMsg(`Memória atualizada — ${mem.length} histórico(s) na memória (${validas.length} do arquivo ${file.name}).`)
    } catch (e) { setErro('Não consegui ler: ' + e.message) }
  }

  // Modelo no layout de lançamentos do Domínio — com as 2 colunas de centro de
  // custo para clientes que usam, e sem elas (igual Aço e Ferro) para os demais.
  async function baixarModeloMemoria() {
    const XLSX = await import('xlsx')
    const base = ['Data', 'Cód. Conta Débito', 'Cód. Conta Crédito', 'Valor', 'Cód. Histórico', 'Complemento Histórico', 'Código Matriz/Filial']
    const head = usaCC ? [...base, 'Centro de Custo Débito', 'Centro de Custo Crédito'] : base
    const ex1 = ['04/05/2026', '204', '14', '3.696,00', '10', 'PGTO. COMPRA DE MERCADORIA - FORNECEDOR EXEMPLO', '6091']
    const ex2 = ['05/05/2026', '763', '14', '48,16', '10', 'PGTO. DESPESAS BANCARIAS', '6091']
    const rows = usaCC ? [head, [...ex1, '', ''], [...ex2, '1', '']] : [head, ex1, ex2]
    const ws = XLSX.utils.aoa_to_sheet(rows)
    ws['!cols'] = head.map((_, i) => ({ wch: i === 5 ? 48 : 16 }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Lançamentos')
    XLSX.writeFile(wb, `modelo_financeiro_${usaCC ? 'com' : 'sem'}_centro_custo.xlsx`)
  }

  // Exporta a classificação atual para Excel (para conferência/validação).
  async function exportarExcel() {
    if (!linhas.length) { setMsg('Nada para exportar.'); return }
    const cols = [
      { nome: 'Data', largura: 12 }, { nome: 'Banco', largura: 34 }, { nome: 'Histórico', largura: 60, wrap: true },
      { nome: 'Valor', largura: 15 }, { nome: 'E/S', largura: 9 }, { nome: 'Contrapartida', largura: 13 }, { nome: 'Conta (nome)', largura: 40 },
    ]
    const rows = linhas.map(l => [
      l.data ? l.data.split('-').reverse().join('/') : '', `${l.banco || ''} ${nomeBanco(l.banco)}`.trim(),
      l.historico || '', Number(l.valor) || 0, l.entrada ? 'Entrada' : 'Saída',
      l.contra || '', planoMap[String(l.contra)]?.nome || (l.contra ? '(fora do plano)' : ''),
    ])
    await gerarExcelTimbrado({
      titulo: `Financeiro classificado · ${competencia}`, sub: `${linhas.length} lançamento(s)`,
      colunas: cols, linhas: rows, totais: null, arquivo: `financeiro_classificado_${competencia.replace('/', '-')}.xlsx`, aba: 'Lançamentos',
    })
  }

  // Gera a partida completa para o Domínio (banco + contrapartida, por entrada/saída).
  function gerar() {
    const prontasL = linhas.filter(l => l.banco && l.contra && l.valor > 0)
    if (!prontasL.length) { setErro('Nenhuma linha com banco e contrapartida para gerar.'); return }
    const lanc = prontasL.map(l => ({
      data: l.data || null,
      conta_debito: l.entrada ? l.banco : l.contra,   // entrada: D banco; saída: D contrapartida
      conta_credito: l.entrada ? l.contra : l.banco,
      valor: l.valor,
      historico: l.historico,
    }))
    gerarDominioCSV(lanc, `financeiro_dominio_${competencia.replace('/', '-')}.csv`)
  }

  const prontas = linhas.filter(l => l.banco && l.contra && l.valor > 0).length
  const semContra = linhas.filter(l => !l.contra).length
  const totEnt = linhas.filter(l => l.entrada).reduce((s, l) => s + (l.valor || 0), 0)
  const totSai = linhas.filter(l => !l.entrada).reduce((s, l) => s + (l.valor || 0), 0)
  const saldoFinal = (saldoAnterior || 0) + totEnt - totSai
  const temExtrato = String(saldoExtrato).trim() !== ''
  const difSaldo = Math.round((saldoFinal - parseValor(saldoExtrato)) * 100) / 100
  const visiveis = linhas.map((l, i) => ({ l, i })).filter(({ l }) => linhaVisivel(l))
  // Totalizador do que está filtrado (útil ao filtrar por dia): quanto de + e de −.
  const filtroAtivo = fSem || !!fHist || !!fData || !!fES || !!fConta
  const totVisEnt = visiveis.filter(({ l }) => l.entrada).reduce((s, { l }) => s + (l.valor || 0), 0)
  const totVisSai = visiveis.filter(({ l }) => !l.entrada).reduce((s, { l }) => s + (l.valor || 0), 0)
  const visIdx = visiveis.map(v => v.i)
  const todosSel = visIdx.length > 0 && visIdx.every(i => sel.has(i))
  const toggleTodos = () => setSel(prev => { const n = new Set(prev); if (todosSel) visIdx.forEach(i => n.delete(i)); else visIdx.forEach(i => n.add(i)); return n })
  const memAtiva = memoria.length > 0

  return (
    <>
      {/* Cadastro das contas bancárias do cliente */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 18, marginBottom: 16 }}>
        <p style={{ fontSize: 14, fontWeight: 600, margin: '0 0 4px' }}>Contas bancárias do cliente</p>
        <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 12px' }}>Informe a <b style={{ color: theme.text }}>conta contábil</b> de cada banco (o nome vem do plano). Cada banco cadastrado vira um slot de importação abaixo. <span style={{ color: theme.accent }}>F4</span> abre o plano.</p>
        {carregReg ? <p style={{ color: theme.sub, fontSize: 12.5 }}>Carregando…</p> : (
          <>
            {contas.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                {contas.map((c, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: i ? `1px solid ${theme.border}` : 'none', fontSize: 13 }}>
                    <i className="ti ti-building-bank" style={{ color: theme.accent }} />
                    <span style={{ fontWeight: 600, minWidth: 70 }}>{c.conta_contabil}</span>
                    <span style={{ flex: 1, color: theme.sub }}>{nomeBanco(c.conta_contabil)}{(c.agencia || c.conta) ? ` · ag ${c.agencia || '—'} / cc ${c.conta || '—'}` : ''}</span>
                    {isAdmin
                      ? <i className="ti ti-trash" title="Excluir banco (admin)" onClick={() => excluirBanco(c)} style={{ color: theme.sub, cursor: 'pointer' }} />
                      : <i className="ti ti-lock" title="Só administradores excluem bancos" style={{ color: theme.border }} />}
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

      {/* Memória do financeiro — verde (ativa) / pendente / sem carga */}
      {!carregReg && (
        <div style={{ background: theme.card, border: `1px solid ${memAtiva ? 'rgba(48,164,108,0.5)' : memMeta.semCarga ? theme.cb : 'rgba(245,166,35,0.5)'}`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <i className="ti ti-brain" style={{ fontSize: 20, color: memAtiva ? theme.green : memMeta.semCarga ? theme.sub : theme.yellow }} />
            <div style={{ flex: 1, minWidth: 200 }}>
              <p style={{ fontSize: 13.5, fontWeight: 600, margin: 0 }}>Memória do financeiro (histórico → contrapartida)</p>
              <p style={{ fontSize: 12, margin: '2px 0 0', color: memAtiva ? theme.green : memMeta.semCarga ? theme.sub : theme.yellow }}>
                {memAtiva ? <><i className="ti ti-circle-check" /> <b>Ativa</b> · {memoria.length} histórico(s){memMeta.nomeArquivo ? ` · arquivo: ${memMeta.nomeArquivo}` : ''}</>
                  : memMeta.semCarga ? <><i className="ti ti-circle-minus" /> Sem carga inicial (marcado)</>
                    : <><i className="ti ti-alert-triangle" /> Pendente — importe a carga inicial ou marque que não tem</>}
              </p>
            </div>
          </div>
          <p style={{ fontSize: 11.5, color: theme.sub, margin: '8px 0 0' }}>Use o <b style={{ color: theme.text }}>layout do Domínio</b> ({usaCC ? 'com' : 'sem'} centro de custo — este cliente {usaCC ? 'usa' : 'não usa'}). A memória aprende pelo <b style={{ color: theme.text }}>Complemento Histórico</b> e pela contrapartida (o lado que não é o banco). Baixe o modelo para acertar as colunas.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <label className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', cursor: 'pointer' }}>
              <i className="ti ti-upload" /> {memAtiva ? 'Complementar' : 'Importar carga inicial'}
              <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => importarMemoria(e.target.files?.[0])} />
            </label>
            <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={baixarModeloMemoria}><i className="ti ti-download" /> Baixar modelo</button>
            {memAtiva && <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: theme.red, borderColor: theme.red }} onClick={excluirMemoria}><i className="ti ti-trash" /> Excluir memória</button>}
            {!memAtiva && !memMeta.semCarga && <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={marcarSemCarga}><i className="ti ti-circle-minus" /> Não tem carga inicial</button>}
            {!memAtiva && memMeta.semCarga && <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => salvarMemoria([], { nomeArquivo: '', semCarga: false })}><i className="ti ti-rotate" /> Desfazer</button>}
          </div>
        </div>
      )}

      {/* Como o extrato vem */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <button className={modo === 'porBanco' ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 13 }} onClick={() => setModo('porBanco')}><i className="ti ti-file" /> Um arquivo por banco</button>
        <button className={modo === 'combinado' ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 13 }} onClick={() => setModo('combinado')}><i className="ti ti-files" /> Planilha combinada</button>
      </div>

      {modo === 'porBanco' ? (
        contas.length === 0
          ? <p style={{ color: theme.yellow, fontSize: 12.5, margin: '0 0 12px' }}>Cadastre as contas bancárias acima para liberar um slot de importação por banco.</p>
          : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 12, marginBottom: 14 }}>
              {contas.map(c => {
                const s = bancosEst[c.conta_contabil]
                const cor = s?.estado === 'validado' ? theme.green : s?.estado === 'sem_movimento' ? theme.sub : s?.estado === 'rascunho' ? theme.yellow : theme.red
                const quem = s?.usuario ? ` · por ${String(s.usuario).split('@')[0]}` : ''
                const txt = s?.estado === 'validado' ? `Concluído${s.doc ? ` · ${s.doc}` : ''}` : s?.estado === 'sem_movimento' ? 'Sem movimento no mês' : s?.estado === 'rascunho' ? `Em andamento${quem}${s.draft ? ` · ${s.draft.length} lançto(s)` : ''}` : 'Pendente'
                const icon = s?.estado === 'validado' ? 'ti-circle-check' : s?.estado === 'sem_movimento' ? 'ti-circle-minus' : s?.estado === 'rascunho' ? 'ti-progress' : 'ti-alert-triangle'
                return (
                  <div key={c.conta_contabil} style={{ background: theme.card, border: `1px solid ${s?.estado === 'sem_movimento' ? theme.cb : cor}`, borderRadius: 12, padding: 14 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <i className="ti ti-building-bank" style={{ color: theme.accent }} />
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{c.conta_contabil} · {nomeBanco(c.conta_contabil)}</span>
                    </div>
                    <p style={{ fontSize: 12, color: cor, margin: '0 0 10px', fontWeight: 500 }}><i className={`ti ${icon}`} /> {txt}</p>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {s?.draft && <button className="btn" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => continuarRascunho(c.conta_contabil)}><i className="ti ti-player-play" /> Continuar</button>}
                      <label className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', cursor: 'pointer' }}>
                        <i className="ti ti-cloud-upload" /> {(s?.estado === 'validado' || s?.estado === 'rascunho') ? 'Reimportar' : 'Importar extrato'}
                        <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => importar(e.target.files?.[0], c.conta_contabil)} />
                      </label>
                      <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => marcarBanco(c.conta_contabil, 'sem_movimento')}><i className="ti ti-circle-minus" /> Sem movimento</button>
                      {s?.estado && <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: theme.sub }} onClick={() => marcarBanco(c.conta_contabil, null)}>limpar</button>}
                      {isAdmin && <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: theme.red, borderColor: theme.red }} onClick={() => excluirBanco(c)}><i className="ti ti-trash" /> Excluir banco</button>}
                    </div>
                  </div>
                )
              })}
            </div>
          )
      ) : (
        <>
          <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 8px' }}>A planilha traz todos os bancos juntos — cada linha deve ter a <b style={{ color: theme.text }}>conta contábil</b> numa das colunas. A plataforma casa com o cadastro e separa por banco.</p>
          <ImpCard titulo="Importar planilha combinada" desc="Importe o extrato com todos os bancos (Excel/CSV)." onImport={f => importar(f)} nome={raw?.nome} qtd={linhas.length} />
        </>
      )}

      {erro && <p style={{ color: theme.red, fontSize: 12.5, margin: '10px 0 0' }}>{erro}</p>}
      {msg && <p style={{ color: theme.green, fontSize: 12.5, margin: '10px 0 0' }}><i className="ti ti-circle-check" /> {msg}</p>}

      {raw && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', margin: '14px 0 4px' }}>
            <span style={{ fontSize: 12.5, color: theme.text }}><i className="ti ti-file-spreadsheet" style={{ color: theme.accent }} /> {raw.nome || 'Extrato importado'} · {linhas.length} linha(s)</span>
            <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: theme.red, borderColor: theme.red }} onClick={desfazerImport}><i className="ti ti-arrow-back-up" /> Desfazer / nova importação</button>
          </div>
          {/* Extrato lido pelo perfil do cliente: layout único, sem mapa manual. */}
          {raw.viaPerfil ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '14px 0 6px' }}>
              <span style={{ fontSize: 12, color: theme.sub }}><i className="ti ti-adjustments" style={{ color: theme.accent }} /> Extrato normalizado pelo perfil de leitura deste cliente.</span>
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => setCfg({ arr: raw.arr, catByRow: raw.catByRow, nome: raw.nome, banco: raw.banco, perfil: perfil || perfilPadrao(raw.arr) })}><i className="ti ti-adjustments" /> Ajustar leitura</button>
            </div>
          ) : (
            /* Mapa de colunas (auto-detectado, ajustável) — modo combinado/legado */
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '14px 0 6px' }}>
              {[['hist', 'Histórico'], ['valor', 'Valor'], ['data', 'Data (opc.)']].map(([campo, lab]) => (
                <div key={campo}><label>{lab}</label>
                  <select className="input" style={{ padding: '8px 10px', fontSize: 12.5 }} value={map[campo]} onChange={e => trocarCol(campo, Number(e.target.value))}>
                    <option value={-1}>—</option>
                    {(raw.header || []).map((h, j) => <option key={j} value={j}>{String(h || `Coluna ${j + 1}`)}</option>)}
                  </select>
                </div>
              ))}
            </div>
          )}

          {/* Filtros + preenchimento em lote */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '6px 0 8px' }}>
            <button className={fSem ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => setFSem(v => !v)}><i className="ti ti-filter" /> Só sem contrapartida</button>
            <input className="input" style={{ maxWidth: 200, fontSize: 12, padding: '6px 10px' }} placeholder="Filtrar histórico…" value={fHist} onChange={e => setFHist(e.target.value)} />
            <select className="input" style={{ maxWidth: 110, fontSize: 12, padding: '6px 8px' }} value={fMode} onChange={e => setFMode(e.target.value)}>
              <option value="contem">Contém</option><option value="exato">Exato</option>
            </select>
            <input className="input" style={{ maxWidth: 130, fontSize: 12, padding: '6px 10px' }} placeholder="Data (dd/mm)" value={fData} onChange={e => setFData(e.target.value)} />
            <select className="input" style={{ maxWidth: 120, fontSize: 12, padding: '6px 8px' }} value={fES} onChange={e => setFES(e.target.value)}>
              <option value="">Entrada/Saída</option><option value="entrada">Só entradas</option><option value="saida">Só saídas</option>
            </select>
            <CampoConta value={fConta} onChange={setFConta} placeholder="Filtrar conta (F4)" style={{ width: 170 }} />
            {(fSem || fHist || fData || fES || fConta) && <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: theme.sub }} onClick={() => { setFSem(false); setFHist(''); setFData(''); setFES(''); setFConta('') }}>limpar filtros</button>}
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 12, color: theme.sub }}>Aplicar às selecionadas:</span>
            <CampoConta value={lote} onChange={setLote} onEnter={aplicarLote} placeholder="Conta (F4)" style={{ width: 190 }} />
            {lote.trim() && <span style={{ fontSize: 11.5, maxWidth: 220, color: planoMap[String(lote).trim()]?.nome ? theme.green : theme.red }}>{planoMap[String(lote).trim()]?.nome || 'conta não encontrada'}</span>}
            <button className="btn" style={{ fontSize: 12, padding: '5px 10px' }} disabled={!sel.size} onClick={aplicarLote}><i className="ti ti-wand" /> Aplicar ({sel.size})</button>
          </div>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12.5, margin: '0 0 6px' }}>
            <span style={{ color: theme.green }}><b>{prontas}</b> pronta(s) p/ contabilizar</span>
            <span style={{ color: theme.yellow }}><b>{semContra}</b> sem contrapartida</span>
            <span style={{ color: theme.sub }}>mostrando <b>{visiveis.length}</b> de {linhas.length}{sel.size ? ` · ${sel.size} selecionada(s)` : ''}</span>
            {filtroAtivo && <span style={{ color: theme.sub }}>{fData ? `dia ${fData}: ` : 'filtro: '}<b style={{ color: theme.green }}>+{money(totVisEnt)}</b> · <b style={{ color: theme.red }}>−{money(totVisSai)}</b> · líquido <b style={{ color: theme.text }}>{money(totVisEnt - totVisSai)}</b></span>}
            {sel.size > 0 && <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: '3px 8px', color: theme.sub }} onClick={() => setSel(new Set())}>limpar seleção</button>}
            <span style={{ flex: 1 }} />
            <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: '3px 9px' }} onClick={() => setNovoLanc(true)}><i className="ti ti-plus" /> Incluir lançamento</button>
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', fontSize: 12.5, margin: '0 0 10px', padding: '10px 12px', background: theme.input, borderRadius: 8 }}>
            <span style={{ color: theme.sub }}>Saldo anterior {raw.banco ? `(${raw.banco} · ${nomeBanco(raw.banco)})` : ''}: <b style={{ color: theme.text }}>{saldoAnterior == null ? '—' : money(saldoAnterior)}</b></span>
            <span style={{ color: theme.green }}>+ Entradas: <b>{money(totEnt)}</b></span>
            <span style={{ color: theme.red }}>− Saídas: <b>{money(totSai)}</b></span>
            <span style={{ color: theme.text }}>= Saldo final: <b>{money(saldoFinal)}</b></span>
            <span style={{ flex: 1 }} />
            <label style={{ color: theme.sub, display: 'flex', alignItems: 'center', gap: 6 }}>Saldo do extrato:
              <input className="input" style={{ width: 130, fontSize: 12, padding: '5px 8px' }} value={saldoExtrato} onChange={e => setSaldoExtrato(e.target.value)}
                onBlur={() => { if (raw.banco) salvarBancoDraft(raw.banco, bancosEst[raw.banco]?.estado || 'rascunho', raw.nome, linhas) }} placeholder="0,00" />
            </label>
            {temExtrato && (Math.abs(difSaldo) < 0.005
              ? <span style={{ color: theme.green, fontWeight: 600 }}><i className="ti ti-circle-check" /> confere</span>
              : <span style={{ color: theme.red, fontWeight: 600 }}><i className="ti ti-alert-triangle" /> diferença {money(difSaldo)}</span>)}
            <label className="btn btn-ghost" style={{ fontSize: 11.5, padding: '4px 9px', cursor: 'pointer' }} title="Importar o extrato do banco (com saldos diários) para achar o dia da diferença">
              <i className="ti ti-file-search" /> {cruza ? 'Trocar extrato' : 'Achar diferença por dia'}
              <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => cruzarSaldos(e.target.files?.[0])} />
            </label>
            {cruza && <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: '4px 9px' }} onClick={() => setCruzaOpen(true)} title="Reabrir o cruzamento por dia"><i className="ti ti-eye" /> Ver cruzamento{cruza.primeiroDiv ? ' ⚠' : ''}</button>}
          </div>
          {saldoAnterior == null && <p style={{ color: theme.yellow, fontSize: 11.5, margin: '-4px 0 10px' }}>Saldo anterior indisponível (balancete da competência não importado) — o saldo final considera abertura zero.</p>}

          {/* Tabela de classificação */}
          <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto', maxHeight: 460 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820 }}>
              <thead>
                <tr style={{ background: theme.input, position: 'sticky', top: 0 }}>
                  <th style={{ ...fth, width: 34, textAlign: 'center' }}><input type="checkbox" checked={todosSel} onChange={toggleTodos} title="Selecionar os visíveis" /></th>
                  <th style={fth}>Data</th><th style={fth}>Banco</th><th style={fth}>Histórico</th><th style={{ ...fth, textAlign: 'right' }}>Valor</th><th style={fth}>E/S</th><th style={fth}>Contrapartida</th><th style={fth}>Conta (nome)</th>
                </tr>
              </thead>
              <tbody>
                {visiveis.map(({ l, i }, pos) => (
                  <tr key={i} style={{ borderTop: `1px solid ${theme.border}`, background: sel.has(i) ? 'rgba(74,124,255,0.10)' : !l.banco ? 'rgba(245,166,35,0.06)' : 'transparent' }}>
                    <td style={{ ...ftd, textAlign: 'center' }}><input type="checkbox" checked={sel.has(i)} onChange={() => toggleUm(i)} /></td>
                    <td style={{ ...ftd, fontSize: 11.5, whiteSpace: 'nowrap', color: theme.sub }}>{dataBR(l.data) || '—'}</td>
                    <td style={{ ...ftd, fontSize: 11.5 }}>{l.banco ? `${l.banco} · ${nomeBanco(l.banco)}` : <span style={{ color: theme.yellow }}>sem banco</span>}</td>
                    <td style={{ ...ftd, minWidth: 240, maxWidth: 340 }}>
                      <input className="input" style={{ fontSize: 11.5, padding: '4px 7px', width: '100%' }} value={l.historico || ''} onChange={e => setLinha(i, { historico: e.target.value })} title="Editar histórico" />
                    </td>
                    <td style={{ ...ftd, textAlign: 'right', whiteSpace: 'nowrap' }}>{money(l.valor)}</td>
                    <td style={{ ...ftd }}>
                      <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px', color: l.entrada ? theme.green : theme.red, borderColor: l.entrada ? theme.green : theme.red }} onClick={() => setLinha(i, { entrada: !l.entrada })}>{l.entrada ? 'Entrada' : 'Saída'}</button>
                    </td>
                    <td style={{ ...ftd, minWidth: 180 }}>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <div style={{ flex: 1 }}><ContraCell value={l.contra} onCommit={v => setLinha(i, { contra: v })}
                          inputRef={el => { refsContra.current[pos] = el }} onEnter={() => refsContra.current[pos + 1]?.focus()} /></div>
                        <i className="ti ti-arrows-split-2" title="Dividir em vários lançamentos" onClick={() => setQuebra({ i, linha: l })} style={{ color: theme.sub, cursor: 'pointer', fontSize: 16, flexShrink: 0 }} />
                        <i className="ti ti-trash" title="Excluir lançamento" onClick={() => excluirLinha(i)} style={{ color: theme.red, cursor: 'pointer', fontSize: 15, flexShrink: 0 }} />
                      </div>
                    </td>
                    <td style={{ ...ftd, fontSize: 11.5, maxWidth: 220 }}>
                      {!l.contra ? <span style={{ color: theme.sub }}>—</span>
                        : planoMap[String(l.contra)]?.nome
                          ? <span style={{ color: theme.green }}>{planoMap[String(l.contra)].nome}</span>
                          : <span style={{ color: theme.red }}><i className="ti ti-alert-triangle" /> conta não encontrada no plano</span>}
                    </td>
                  </tr>
                ))}
                {!visiveis.length && <tr><td colSpan={8} style={{ ...ftd, color: theme.sub, fontSize: 12 }}>Nenhuma linha com os filtros atuais.</td></tr>}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            {raw.banco && <button className="btn btn-ghost" onClick={salvarRascunho}><i className="ti ti-device-floppy" /> Salvar e continuar depois</button>}
            <button className="btn" onClick={aprenderSalvar}><i className="ti ti-brain" /> Aprender e salvar</button>
            {raw.banco && <button className="btn btn-ghost" style={{ color: theme.green, borderColor: theme.green }} onClick={concluirBanco}><i className="ti ti-circle-check" /> Concluir banco</button>}
            <button className="btn btn-ghost" onClick={exportarExcel}><i className="ti ti-file-spreadsheet" /> Exportar Excel</button>
            <button className="btn btn-ghost" disabled={!prontas || (temExtrato && Math.abs(difSaldo) >= 0.005)}
              title={temExtrato && Math.abs(difSaldo) >= 0.005 ? 'O saldo do extrato ainda não confere — zere a diferença antes de gerar.' : ''}
              onClick={gerar}><i className="ti ti-file-export" /> Gerar arquivo do Domínio ({prontas})</button>
          </div>
          <p style={{ color: theme.sub, fontSize: 11.5, margin: '10px 0 0' }}>Preencha a contrapartida das linhas que faltam e clique em <b style={{ color: theme.text }}>Aprender e salvar</b> — no próximo mês elas já vêm classificadas. Entrada = D banco / C contrapartida; Saída = D contrapartida / C banco.</p>
        </>
      )}

      {quebra && (
        <ModalQuebra linha={quebra.linha} nomeBanco={nomeBanco} planoMap={planoMap}
          onClose={() => setQuebra(null)} onConfirmar={partes => confirmarQuebra(quebra.i, partes)} />
      )}

      {cruzaOpen && cruza && <ModalCruzaSaldo cruza={cruza} linhas={linhas} planoMap={planoMap} titulo={raw?.banco ? `${raw.banco} ${nomeBanco(raw.banco)}` : ''} onClose={() => setCruzaOpen(false)}
        onVerDia={iso => { const p = String(iso).split('-'); setFData(`${p[2]}/${p[1]}`); setCruzaOpen(false) }} />}

      {novoLanc && <ModalNovoLancamento banco={raw?.banco} nomeBanco={nomeBanco} competencia={competencia} planoMap={planoMap}
        onClose={() => setNovoLanc(false)} onConfirmar={adicionarLinha} />}

      {cfg && (
        <PerfilExtratoCfg
          arr={cfg.arr} catByRow={cfg.catByRow} adiantContas={adiantContas} nome={cfg.nome} bancoNome={nomeBanco(cfg.banco)} perfilInicial={cfg.perfil} memoria={memoria}
          onCancelar={() => setCfg(null)}
          onSalvar={async (perf) => { await salvarPerfil(perf); setCfg(null); aplicarEProsseguir(cfg.arr, cfg.nome, cfg.banco, perf, cfg.catByRow) }}
        />
      )}
    </>
  )
}

// Resultado do cruzamento do saldo diário calculado vs o saldo do extrato do banco.
// Além de apontar os dias que não bateram, tenta ser ASSERTIVO sobre o erro:
// casa a diferença do dia com um lançamento (valor exato ou E/S trocada) e
// detecta lançamento com data trocada (dois dias com diferença oposta e igual).
function ModalCruzaSaldo({ cruza, linhas, planoMap, titulo, onClose, onVerDia }) {
  const brd = iso => iso ? iso.split('-').reverse().join('/') : '—'
  const eps = v => Math.abs(v) < 0.005
  const r2 = v => Math.round((v || 0) * 100) / 100
  const divergentes = cruza.dias.filter(d => d.delta != null && Math.abs(d.delta) >= 0.005)
  const [soDif, setSoDif] = useState(divergentes.length > 0)
  // Abertura por dia: null | 'todos' (todos os lançamentos) | 'estrela' (só o suspeito).
  const [aberto, setAberto] = useState(() => (divergentes.length === 1 ? { [divergentes[0].data]: 'todos' } : {}))
  const abrir = (data, modo) => setAberto(p => ({ ...p, [data]: p[data] === modo ? null : modo }))

  // Possível troca de data: dois dias divergentes com deltas opostos e iguais.
  const trocaPar = {}
  for (let a = 0; a < divergentes.length; a++) for (let b = a + 1; b < divergentes.length; b++) {
    const A = divergentes[a], B = divergentes[b]
    if (!trocaPar[A.data] && !trocaPar[B.data] && eps(A.delta + B.delta)) { trocaPar[A.data] = B.data; trocaPar[B.data] = A.data }
  }

  // Análise de um dia divergente: lista os lançamentos do dia, destaca os que
  // "explicam" a diferença (mesmo valor, ou o dobro = E/S trocada) e monta a dica.
  function analisarDia(d) {
    const alvo = d.delta                     // + = classificado a mais; − = a menos
    const doDia = linhas.filter(l => l.data === d.data)
    const cand = []
    for (const l of doDia) {
      const v = l.valor || 0
      if (eps(v - Math.abs(alvo))) cand.push({ l, tipo: 'valor' })
      else if (eps(2 * v - Math.abs(alvo)) && ((alvo > 0 && l.entrada) || (alvo < 0 && !l.entrada))) cand.push({ l, tipo: 'sinal' })
    }
    let dica
    if (trocaPar[d.data]) dica = `Provável data trocada: um lançamento de ${money(Math.abs(alvo))} aparece aqui, mas o banco registrou em ${brd(trocaPar[d.data])} (um dia sobra, o outro falta o mesmo valor).`
    else {
      const sinal = cand.find(c => c.tipo === 'sinal'), exato = cand.find(c => c.tipo === 'valor')
      if (sinal) dica = `O lançamento "${sinal.l.historico}" (${money(sinal.l.valor)}) está como ${sinal.l.entrada ? 'Entrada' : 'Saída'} — se for ${sinal.l.entrada ? 'Saída' : 'Entrada'}, zera a diferença do dia.`
      else if (exato) dica = `Confira o lançamento "${exato.l.historico}" (${money(exato.l.valor)}) — bate exatamente com a diferença do dia.`
      else dica = alvo > 0 ? `Classificado ${money(alvo)} a mais — falta uma Saída de ${money(alvo)} (ou há uma entrada a mais) neste dia.` : `Classificado ${money(-alvo)} a menos — falta uma Entrada de ${money(-alvo)} (ou há uma saída a mais) neste dia.`
    }
    return { doDia, cand, dica }
  }

  // Exporta os apontamentos (resumo por dia + lançamentos dos dias com diferença)
  // para Excel, para procurar/filtrar a diferença fora da tela.
  async function exportar() {
    const XLSX = await import('xlsx')
    const resumo = [['Data', 'Movimento classificado', 'Saldo calculado', 'Saldo extrato', 'Diferença acumulada', 'Diferença do dia', 'Situação', 'Provável causa']]
    for (const d of cruza.dias) {
      const div = d.delta != null && Math.abs(d.delta) >= 0.005
      resumo.push([brd(d.data), r2(d.mov), r2(d.calc), d.ext == null ? '' : r2(d.ext), d.dif == null ? '' : r2(d.dif), d.delta == null ? '' : r2(d.delta), div ? 'NÃO BATEU' : 'ok', div ? analisarDia(d).dica : ''])
    }
    const lanc = [['Data', 'Histórico', 'Valor', 'Tipo', 'Contrapartida', 'Conta (nome)', 'Provável causa?']]
    for (const d of divergentes) {
      const a = analisarDia(d)
      if (!a.doDia.length) lanc.push([brd(d.data), '(nenhum lançamento neste dia)', '', '', '', '', 'possível lançamento faltando'])
      for (const l of a.doDia) lanc.push([brd(d.data), l.historico, r2(l.valor), l.entrada ? 'Entrada' : 'Saída', l.contra || '', planoMap[String(l.contra)]?.nome || '', a.cand.some(c => c.l === l) ? 'SIM' : ''])
    }
    const wb = XLSX.utils.book_new()
    const ws1 = XLSX.utils.aoa_to_sheet(resumo); ws1['!cols'] = [{ wch: 12 }, { wch: 20 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 16 }, { wch: 12 }, { wch: 70 }]
    XLSX.utils.book_append_sheet(wb, ws1, 'Resumo por dia')
    const ws2 = XLSX.utils.aoa_to_sheet(lanc); ws2['!cols'] = [{ wch: 12 }, { wch: 46 }, { wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 30 }, { wch: 16 }]
    XLSX.utils.book_append_sheet(wb, ws2, 'Dias com diferença')
    const slug = String(titulo || 'banco').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '')
    XLSX.writeFile(wb, `apontamentos_cruzamento_${slug}.xlsx`)
  }

  const linhasTabela = soDif ? divergentes : cruza.dias
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 16, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(720px,96vw)', maxHeight: '90vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h2 style={{ fontSize: 16, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><i className="ti ti-file-search" style={{ color: theme.accent }} /> Diferença por dia (extrato × classificado)</h2>
          <span onClick={onClose} style={{ cursor: 'pointer', color: theme.sub, fontSize: 20 }}><i className="ti ti-x" /></span>
        </div>
        <p style={{ fontSize: 13, margin: '0 0 12px', color: divergentes.length ? theme.red : theme.green }}>
          {divergentes.length
            ? <><i className="ti ti-alert-triangle" /> Diferença total <b>{cruza.difTotal == null ? '—' : money(cruza.difTotal)}</b> em <b>{divergentes.length}</b> dia(s). Os dias que bateram não aparecem — foque nos de baixo.</>
            : <><i className="ti ti-circle-check" /> Nenhuma divergência de movimento entre os dias. Se ainda há diferença, é no saldo de abertura.</>}
        </p>

        {/* Análise por dia que não bateu: sugestão + lançamentos do dia (expandível) */}
        {divergentes.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            {divergentes.map((d, i) => {
              const { doDia, cand, dica } = analisarDia(d)
              const isCand = l => cand.some(c => c.l === l)
              const modo = aberto[d.data]
              const mostra = modo === 'estrela' ? doDia.filter(isCand) : doDia
              const temSuspeito = cand.length > 0
              const linhaLanc = l => (
                <tr key={l.historico + l.valor + l.entrada} style={{ borderTop: `1px solid ${theme.border}`, background: isCand(l) ? 'rgba(245,166,35,0.14)' : 'transparent' }}>
                  <td style={{ ...ftd, fontSize: 11 }}>{isCand(l) && <i className="ti ti-star-filled" style={{ color: theme.yellow, marginRight: 4 }} title="Provável causa da diferença" />}{l.historico}</td>
                  <td style={{ ...ftd, fontSize: 11, textAlign: 'right', whiteSpace: 'nowrap', color: l.entrada ? theme.green : theme.red }}>{l.entrada ? '+' : '−'}{money(l.valor)}</td>
                  <td style={{ ...ftd, fontSize: 11, whiteSpace: 'nowrap', color: theme.sub }}>{l.contra ? `${l.contra}${planoMap[String(l.contra)]?.nome ? ' · ' + planoMap[String(l.contra)].nome : ''}` : 'sem contrapartida'}</td>
                </tr>
              )
              return (
                <div key={i} style={{ borderRadius: 10, background: 'rgba(229,72,77,0.07)', border: `0.5px solid rgba(229,72,77,0.30)`, marginBottom: 8, overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 11px' }}>
                    <i className="ti ti-alert-triangle" style={{ color: theme.red, marginTop: 2 }} />
                    <div style={{ flex: 1, fontSize: 12.5 }}>
                      <b style={{ color: theme.text }}>{brd(d.data)}</b> · diferença do dia <b style={{ color: theme.red }}>{money(d.delta)}</b>
                      <div style={{ color: theme.sub, marginTop: 3 }}>{dica}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                      <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px', whiteSpace: 'nowrap', borderColor: temSuspeito ? theme.yellow : theme.border, color: temSuspeito ? theme.yellow : theme.sub }} onClick={() => abrir(d.data, 'estrela')} title={temSuspeito ? 'Mostrar o lançamento que provavelmente causa a diferença' : 'Sem lançamento identificado para esta diferença'}><i className={`ti ${temSuspeito ? 'ti-star-filled' : 'ti-star'}`} /> suspeito</button>
                      <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px', whiteSpace: 'nowrap' }} onClick={() => abrir(d.data, 'todos')}><i className={`ti ${modo === 'todos' ? 'ti-chevron-up' : 'ti-chevron-down'}`} /> {doDia.length} lançto(s)</button>
                      {onVerDia && <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px', whiteSpace: 'nowrap' }} onClick={() => onVerDia(d.data)} title="Filtrar a tabela por este dia"><i className="ti ti-filter" /> na tabela</button>}
                    </div>
                  </div>
                  {modo && (
                    <div style={{ borderTop: `0.5px solid rgba(229,72,77,0.25)`, background: theme.card }}>
                      {modo === 'estrela' && !temSuspeito
                        ? <p style={{ color: theme.sub, fontSize: 11.5, margin: 0, padding: '8px 11px' }}><i className="ti ti-help-circle" style={{ marginRight: 4 }} />Não identifiquei um lançamento específico para esta diferença — confira o dia manualmente (botão "{doDia.length} lançto(s)").</p>
                        : doDia.length === 0
                          ? <p style={{ color: theme.sub, fontSize: 11.5, margin: 0, padding: '8px 11px' }}>Nenhum lançamento classificado neste dia — provável lançamento faltando de {money(Math.abs(d.delta))}.</p>
                          : <table style={{ width: '100%', borderCollapse: 'collapse' }}><tbody>{mostra.map(linhaLanc)}</tbody></table>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: theme.sub, cursor: 'pointer' }}>
            <input type="checkbox" checked={soDif} onChange={e => setSoDif(e.target.checked)} disabled={!divergentes.length} /> Mostrar só os dias com diferença
          </label>
        </div>
        <div style={{ border: `0.5px solid ${theme.cb}`, borderRadius: 10, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
            <thead><tr style={{ background: theme.input }}><th style={fth}>Data</th><th style={{ ...fth, textAlign: 'right' }}>Movimento</th><th style={{ ...fth, textAlign: 'right' }}>Saldo calc.</th><th style={{ ...fth, textAlign: 'right' }}>Saldo extrato</th><th style={{ ...fth, textAlign: 'right' }}>Dif. do dia</th></tr></thead>
            <tbody>
              {linhasTabela.map((d, i) => {
                const marca = d.delta != null && Math.abs(d.delta) >= 0.005
                return (
                  <tr key={i} onClick={() => onVerDia && onVerDia(d.data)} style={{ borderTop: `1px solid ${theme.border}`, background: marca ? 'rgba(229,72,77,0.10)' : 'transparent', cursor: onVerDia ? 'pointer' : 'default' }} title={onVerDia ? 'Filtrar os lançamentos deste dia' : ''}>
                    <td style={{ ...ftd, fontSize: 11.5, whiteSpace: 'nowrap' }}>{brd(d.data)}</td>
                    <td style={{ ...ftd, textAlign: 'right', fontSize: 11.5, whiteSpace: 'nowrap', color: theme.sub }}>{money(d.mov)}</td>
                    <td style={{ ...ftd, textAlign: 'right', whiteSpace: 'nowrap' }}>{money(d.calc)}</td>
                    <td style={{ ...ftd, textAlign: 'right', whiteSpace: 'nowrap' }}>{d.ext == null ? '—' : money(d.ext)}</td>
                    <td style={{ ...ftd, textAlign: 'right', whiteSpace: 'nowrap', color: marca ? theme.red : theme.sub }}>{d.delta == null ? '—' : money(d.delta)}</td>
                  </tr>
                )
              })}
              {!linhasTabela.length && <tr><td colSpan={5} style={{ ...ftd, color: theme.sub, fontSize: 12 }}>Sem dias para mostrar.</td></tr>}
            </tbody>
          </table>
        </div>
        <p style={{ color: theme.sub, fontSize: 11, margin: '10px 0 0' }}>"Dif. do dia" é a mudança da diferença de um dia para o outro. A estrela ⭐ marca o lançamento que provavelmente causa a diferença. Clique num dia para filtrar os lançamentos na tabela.</p>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 14 }}>
          <button className="btn btn-ghost" onClick={exportar}><i className="ti ti-file-spreadsheet" /> Exportar apontamentos (Excel)</button>
          <button className="btn" onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
  )
}

// Campo da contrapartida na tabela: só confirma (grava na linha) ao apertar Enter,
// sair do campo ou escolher pelo F4 — enquanto digita não é interpretado como lançado.
function ContraCell({ value, onCommit, onEnter, inputRef }) {
  const [v, setV] = useState(value ?? '')
  useEffect(() => { setV(value ?? '') }, [value])
  const commit = val => { const s = String(val ?? '').trim(); if (s !== String(value ?? '')) onCommit(s) }
  return (
    <CampoConta value={v} onChange={setV} inputRef={inputRef}
      onPick={p => { setV(p.cod); onCommit(p.cod) }}
      onEnter={() => { commit(v); onEnter && onEnter() }}
      onBlur={() => commit(v)} />
  )
}

// Inclui um lançamento manual na classificação (ex.: um que faltou, identificado
// no cruzamento). Confirma antes de subir. Data precisa estar na competência.
function ModalNovoLancamento({ banco, nomeBanco, competencia, planoMap, onClose, onConfirmar }) {
  const [mes, ano] = (competencia || '').split('/').map(Number)
  const ultimo = (mes && ano) ? new Date(ano, mes, 0).getDate() : 1
  const dataPad = (mes && ano) ? `${ano}-${String(mes).padStart(2, '0')}-${String(ultimo).padStart(2, '0')}` : ''
  const [data, setData] = useState(dataPad)
  const [valor, setValor] = useState('')
  const [entrada, setEntrada] = useState(false)
  const [historico, setHistorico] = useState('')
  const [contra, setContra] = useState('')
  const [erro, setErro] = useState('')
  const v = parseValor(valor)
  const nomeC = planoMap[String(contra).trim()]?.nome || ''
  function confirmar() {
    if (!(v > 0)) { setErro('Informe um valor maior que zero.'); return }
    if (!data) { setErro('Informe a data.'); return }
    const [dy, dm] = data.split('-').map(Number)
    if (mes && ano && (dm !== mes || dy !== ano)) { setErro(`A data deve estar na competência ${competencia}.`); return }
    if (!historico.trim()) { setErro('Informe o histórico.'); return }
    onConfirmar({ banco: banco || '', data, historico: historico.trim(), valor: Math.abs(v), entrada, contra: String(contra).trim(), credor: '' })
  }
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 16, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(560px,96vw)', maxHeight: '90vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h2 style={{ fontSize: 16, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><i className="ti ti-plus" style={{ color: theme.accent }} /> Incluir lançamento</h2>
          <span onClick={onClose} style={{ cursor: 'pointer', color: theme.sub, fontSize: 20 }}><i className="ti ti-x" /></span>
        </div>
        <p style={{ color: theme.sub, fontSize: 12, margin: '0 0 12px' }}>{banco ? `${banco} · ${nomeBanco(banco)}` : 'Banco'} · competência {competencia}</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div><label style={{ fontSize: 12, color: theme.sub }}>Data</label><input className="input" type="date" value={data} onChange={e => setData(e.target.value)} /></div>
          <div><label style={{ fontSize: 12, color: theme.sub }}>Valor</label><input className="input" type="number" step="0.01" value={valor} onChange={e => setValor(e.target.value)} placeholder="0,00" /></div>
          <div style={{ gridColumn: 'span 2' }}>
            <label style={{ fontSize: 12, color: theme.sub }}>Tipo</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className={entrada ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 12, flex: 1 }} onClick={() => setEntrada(true)}>Entrada (D banco)</button>
              <button className={!entrada ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 12, flex: 1 }} onClick={() => setEntrada(false)}>Saída (C banco)</button>
            </div>
          </div>
          <div style={{ gridColumn: 'span 2' }}><label style={{ fontSize: 12, color: theme.sub }}>Histórico</label><input className="input" value={historico} onChange={e => setHistorico(e.target.value)} placeholder="Descrição do lançamento" /></div>
          <div style={{ gridColumn: 'span 2' }}>
            <label style={{ fontSize: 12, color: theme.sub }}>Contrapartida {nomeC && <span style={{ color: theme.green }}>· {nomeC}</span>}</label>
            <CampoConta value={contra} onChange={setContra} placeholder="Conta (F4)" />
          </div>
        </div>
        {erro && <p style={{ color: theme.red, fontSize: 12.5, marginTop: 10 }}>{erro}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn" onClick={confirmar}><i className="ti ti-check" /> Confirmar e incluir</button>
        </div>
      </div>
    </div>
  )
}

// Divide um lançamento em várias partes (ex.: 1 DARF → 3 lançamentos contábeis).
// A soma das partes precisa fechar com o valor original.
function ModalQuebra({ linha, nomeBanco, planoMap, onClose, onConfirmar }) {
  const [partes, setPartes] = useState([{ valor: linha.valor, contra: linha.contra || '' }, { valor: 0, contra: '' }])
  const set = (i, patch) => setPartes(ps => ps.map((p, j) => j === i ? { ...p, ...patch } : p))
  const add = () => setPartes(ps => [...ps, { valor: 0, contra: '' }])
  const rem = i => setPartes(ps => ps.length > 2 ? ps.filter((_, j) => j !== i) : ps)
  const soma = partes.reduce((s, p) => s + (Number(p.valor) || 0), 0)
  const dif = Math.round((linha.valor - soma) * 100) / 100
  const ok = Math.abs(dif) < 0.005 && partes.every(p => Number(p.valor) > 0 && String(p.contra).trim())
  const nomeC = c => planoMap[String(c).trim()]?.nome || ''
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 16, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(640px,96vw)', maxHeight: '90vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h2 style={{ fontSize: 16, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><i className="ti ti-arrows-split-2" style={{ color: theme.accent }} /> Dividir lançamento</h2>
          <span onClick={onClose} style={{ cursor: 'pointer', color: theme.sub, fontSize: 20 }}><i className="ti ti-x" /></span>
        </div>
        <p style={{ color: theme.sub, fontSize: 12, margin: '0 0 2px' }}>{linha.banco} · {nomeBanco(linha.banco)} · {linha.entrada ? 'Entrada' : 'Saída'}</p>
        <p style={{ color: theme.sub, fontSize: 11.5, margin: '0 0 10px' }}>{linha.historico}</p>
        <p style={{ fontSize: 13, margin: '0 0 12px' }}>Valor original: <b style={{ color: theme.text }}>{money(linha.valor)}</b></p>
        <div style={{ display: 'grid', gap: 8 }}>
          {partes.map((p, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input className="input" type="number" step="0.01" style={{ width: 130, fontSize: 12 }} value={p.valor} onChange={e => set(i, { valor: e.target.value })} placeholder="Valor" />
              <div style={{ flex: 1, minWidth: 170 }}><CampoConta value={p.contra} onChange={v => set(i, { contra: v })} placeholder="Contrapartida (F4)" /></div>
              <span style={{ fontSize: 11, color: nomeC(p.contra) ? theme.green : theme.sub, minWidth: 110, maxWidth: 160 }}>{nomeC(p.contra)}</span>
              {partes.length > 2 && <i className="ti ti-trash" onClick={() => rem(i)} style={{ color: theme.sub, cursor: 'pointer' }} />}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, flexWrap: 'wrap', gap: 8 }}>
          <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={add}><i className="ti ti-plus" /> Adicionar parte</button>
          <span style={{ fontSize: 12.5, color: Math.abs(dif) < 0.005 ? theme.green : theme.red }}>Soma {money(soma)} · {Math.abs(dif) < 0.005 ? 'confere' : `diferença ${money(dif)}`}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn" disabled={!ok} onClick={() => onConfirmar(partes)}><i className="ti ti-check" /> Dividir</button>
        </div>
      </div>
    </div>
  )
}

// Painel de mapeamento por cliente: define como ler o extrato (linha de início,
// colunas, entrada/saída) e monta o histórico no padrão do Domínio. Prévia ao vivo.
function PerfilExtratoCfg({ arr, catByRow, adiantContas, nome, bancoNome, perfilInicial, memoria, onCancelar, onSalvar }) {
  const [p, setP] = useState(perfilInicial)
  const set = patch => setP(x => ({ ...x, ...patch }))
  const nc = (arr || []).reduce((m, r) => Math.max(m, (r || []).length), 0)
  const ini = Number.isInteger(p.linhaInicio) ? p.linhaInicio : 1
  const amostra = (j) => { for (const r of arr.slice(ini, ini + 60)) { const v = String(r?.[j] ?? '').trim(); if (v) return v } return '' }
  const cols = Array.from({ length: nc }, (_, j) => ({ j, label: `Col ${j + 1} · ${amostra(j).slice(0, 26) || '—'}` }))
  const Sel = ({ val, on, vazio = '—' }) => (
    <select className="input" style={{ padding: '7px 9px', fontSize: 12 }} value={val ?? -1} onChange={e => on(Number(e.target.value))}>
      <option value={-1}>{vazio}</option>
      {cols.map(c => <option key={c.j} value={c.j}>{c.label}</option>)}
    </select>
  )
  const todas = aplicarPerfil(arr, p, memoria, catByRow, adiantContas)
  const prev = todas.slice(0, 6)
  const total = todas.length
  const casadas = todas.filter(l => l.contra).length
  return (
    <div onClick={onCancelar} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 16, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(900px,97vw)', maxHeight: '92vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h2 style={{ fontSize: 16, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><i className="ti ti-adjustments" style={{ color: theme.accent }} /> Perfil de leitura — {bancoNome}</h2>
          <span onClick={onCancelar} style={{ cursor: 'pointer', color: theme.sub, fontSize: 20 }}><i className="ti ti-x" /></span>
        </div>
        <p style={{ color: theme.sub, fontSize: 12, margin: '0 0 14px' }}>Diga como ler <b style={{ color: theme.text }}>{nome}</b>. Salvo no cliente — nos próximos meses o extrato entra sozinho, no layout do Domínio.</p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10 }}>
          <div><label>Linha de início (dados)</label><input className="input" type="number" min="1" style={{ fontSize: 12 }} value={ini + 1} onChange={e => set({ linhaInicio: Math.max(0, (Number(e.target.value) || 1) - 1) })} /></div>
          <div><label>Valor</label><Sel val={p.colValor} on={v => set({ colValor: v })} /></div>
          <div><label>Data</label><Sel val={p.colData} on={v => set({ colData: v })} /></div>
          <div><label>Credor/Devedor (contrapartida)</label><Sel val={p.colCredor} on={v => set({ colCredor: v })} /></div>
          <div><label>Documento (opc.)</label><Sel val={p.colDoc} on={v => set({ colDoc: v })} /></div>
          <div><label>Categoria (coluna mesclada, opc.)</label><Sel val={p.colCategoria} on={v => set({ colCategoria: v })} /></div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 10, marginTop: 12, alignItems: 'end' }}>
          <div>
            <label>Entrada × Saída</label>
            <select className="input" style={{ fontSize: 12 }} value={p.es?.modo || 'sinal'} onChange={e => set({ es: { ...(p.es || {}), modo: e.target.value } })}>
              <option value="sinal">Pelo sinal do valor</option>
              <option value="coluna">Por uma coluna</option>
            </select>
          </div>
          {p.es?.modo === 'coluna' && <div><label>Coluna do indicador</label><Sel val={p.es?.col} on={v => set({ es: { ...(p.es || {}), col: v } })} /></div>}
          {p.es?.modo === 'coluna' && <div><label>Valores que são ENTRADA (vírgula)</label><input className="input" style={{ fontSize: 12 }} placeholder="ex.: CAR, LAN" value={(p.es?.entrada || []).join(', ')} onChange={e => set({ es: { ...(p.es || {}), entrada: e.target.value.split(',').map(s => s.trim()).filter(Boolean) } })} /></div>}
          <div>
            <label>Ignorar linha quando esta coluna estiver vazia</label>
            <Sel val={p.filtro?.col} on={v => set({ filtro: { col: v, pularVazio: v >= 0 } })} vazio="não filtrar" />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12.5, margin: '14px 0 6px' }}>
          <span style={{ color: theme.text }}><b>{total}</b> lançamento(s)</span>
          <span style={{ color: theme.green }}><b>{casadas}</b> classificada(s) pela memória</span>
        </div>
        <div style={{ border: `0.5px solid ${theme.cb}`, borderRadius: 10, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
            <thead><tr style={{ background: theme.input }}><th style={fth}>E/S</th><th style={{ ...fth, textAlign: 'right' }}>Valor</th><th style={fth}>Data</th><th style={fth}>Histórico montado</th><th style={fth}>Contrap.</th></tr></thead>
            <tbody>
              {prev.map((l, i) => (
                <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                  <td style={{ ...ftd, fontSize: 11, color: l.entrada ? theme.green : theme.red }}>{l.entrada ? 'Entrada' : 'Saída'}</td>
                  <td style={{ ...ftd, textAlign: 'right', whiteSpace: 'nowrap' }}>{money(l.valor)}</td>
                  <td style={{ ...ftd, fontSize: 11, color: theme.sub, whiteSpace: 'nowrap' }}>{l.data ? l.data.split('-').reverse().join('/') : '—'}</td>
                  <td style={{ ...ftd, fontSize: 11, color: theme.sub, maxWidth: 320 }}>{l.historico || '—'}</td>
                  <td style={{ ...ftd, fontSize: 11.5 }}>{l.contra || '—'}</td>
                </tr>
              ))}
              {!prev.length && <tr><td colSpan={5} style={{ ...ftd, color: theme.yellow, fontSize: 12 }}>Nenhum lançamento com este mapeamento. Ajuste a linha de início e a coluna de valor.</td></tr>}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={onCancelar}>Cancelar</button>
          <button className="btn" disabled={!total} onClick={() => onSalvar(p)}><i className="ti ti-check" /> Salvar perfil e importar</button>
        </div>
      </div>
    </div>
  )
}

const fth = { textAlign: 'left', padding: '9px 12px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3, whiteSpace: 'nowrap' }
const ftd = { padding: '7px 12px', fontSize: 12.5, color: theme.text, verticalAlign: 'middle' }

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
