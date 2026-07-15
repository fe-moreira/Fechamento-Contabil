import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import { theme, money, moneyDC } from '../lib/theme'
import CampoConta from '../components/CampoConta'
import CampoCentroCusto from '../components/CampoCentroCusto'
import { normHist, casarHistorico, casarHistoricoNivel, aprender, parseValor, dataISO, aplicarPerfil, extrairEntidade, ehEmpresa, catByRowDeMerges, expandirMerges } from '../lib/financeiro'
import { gerarExcelTimbrado } from '../lib/excel'
import { gerarDominioCSV } from '../lib/dominio'
import { contasConciliacaoAbertas, montarBalancete } from '../lib/balancete'

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
// Colunas do arquivo do acumulador por tipo (letras da planilha) e a CHAVE do cruzamento.
// Entradas cruza NF a NF; Saídas e Serviços cruzam SÓ pelo acumulador (o total entra no
// resumo). Colunas mudam por relatório.
const COLS_FISCAL = {
  entradas: { nf: 'K', data: 'N', acum: 'R', forn: 'U', valor: 'AH', chave: 'nf' },
  saidas: { acum: 'AC', forn: 'W', valor: 'AE', chave: 'acum' },
  servicos: { nf: 'K', data: 'N', acum: 'Q', forn: 'T', valor: 'AG', chave: 'acum' },
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
function achadoNoRazao(row, idx, chave) {
  const cands = idx.byAcum[row.acum] || []
  if (!cands.length) return false
  if (chave === 'acum') return true // Saídas/Serviços: basta o acumulador existir no razão
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
function cruzarFiscal(rows, idx, chave) {
  const porAcum = {}
  for (const row of rows) {
    const a = (porAcum[row.acum] ||= { acum: row.acum, docTotal: 0, idTotal: 0, qtd: 0, qtdId: 0, divs: [] })
    a.qtd++; a.docTotal = Math.round((a.docTotal + row.valor) * 100) / 100
    if (achadoNoRazao(row, idx, chave)) { a.idTotal = Math.round((a.idTotal + row.valor) * 100) / 100; a.qtdId++ }
    else a.divs.push({ nf: row.nf, data: row.data, forn: row.forn, valor: row.valor })
  }
  return Object.values(porAcum)
    .map(a => ({ ...a, dif: Math.round((a.docTotal - a.idTotal) * 100) / 100 }))
    .sort((x, y) => Math.abs(y.dif) - Math.abs(x.dif) || Number(x.acum) - Number(y.acum))
}

// Lê o arquivo do acumulador (colunas conforme o tipo) → linhas normalizadas. NF/Data são
// opcionais (Saídas não tem) — só entram se a coluna estiver definida no tipo.
async function parseAcumulador(file, sub) {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
  const arr = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
  const c = COLS_FISCAL[sub] || COLS_FISCAL.entradas
  const col = {
    acum: XLSX.utils.decode_col(c.acum), forn: XLSX.utils.decode_col(c.forn), valor: XLSX.utils.decode_col(c.valor),
    nf: c.nf ? XLSX.utils.decode_col(c.nf) : -1, data: c.data ? XLSX.utils.decode_col(c.data) : -1,
  }
  const rows = []
  for (const r of arr) {
    const valor = numFis(r[col.valor]); const acum = normAcum(r[col.acum])
    if (!acum || !valor) continue // pula cabeçalho e linhas sem acumulador/valor
    rows.push({ nf: col.nf >= 0 ? String(r[col.nf] ?? '').trim() : '', data: col.data >= 0 ? dataISO(r[col.data]) : '', acum, forn: String(r[col.forn] ?? '').trim(), valor })
  }
  return rows
}

// Lê o "Saldo a depreciar" total do "Resumo da Depreciação Fiscal" (PDF com texto) — é o
// imobilizado LÍQUIDO (custo − depreciação acumulada), que deve bater com a conta sintética.
// Pega a linha do "Total:" e devolve o ÚLTIMO valor monetário (última coluna = saldo a depreciar).
function valorDepreciacaoPdf(texto) {
  const linhas = String(texto || '').split('\n')
  const i = linhas.findIndex(l => /total\s*:/i.test(l))
  if (i < 0) return null
  const bloco = `${linhas[i]} ${linhas[i + 1] || ''} ${linhas[i + 2] || ''}`
  const nums = bloco.match(/-?\d{1,3}(?:\.\d{3})*,\d{2}/g)
  if (!nums || !nums.length) return null
  return parseFloat(nums[nums.length - 1].replace(/\./g, '').replace(',', '.'))
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

// ---- Integração FOLHA: cruzamento rubrica × razão --------------------------
// Dois arquivos (folha + adiantamento) unificados. Colunas do relatório do Domínio:
// V = código do evento (rubrica), W = nome do evento, Z = valor calculado, U = P/D/I.
const COLS_FOLHA = { cod: 'V', nome: 'W', valor: 'Z', pd: 'U' }
// Código da rubrica só com dígitos, sem zeros à esquerda.
const normRub = v => String(v ?? '').replace(/\D/g, '').replace(/^0+/, '')
// Código da rubrica citado no histórico do razão — padrão "VALOR REF. <código> - <nome>".
function rubDoHistorico(h) {
  const m = /valor\s*ref\.?\s*(\d+)\s*-/i.exec(String(h || ''))
  return m ? m[1].replace(/^0+/, '') : ''
}
// Lê um arquivo da folha (folha mensal ou adiantamento) → eventos [{ cod, nome, valor, pd }].
async function parseFolha(file) {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
  const arr = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
  const cCod = XLSX.utils.decode_col(COLS_FOLHA.cod), cNome = XLSX.utils.decode_col(COLS_FOLHA.nome)
  const cVal = XLSX.utils.decode_col(COLS_FOLHA.valor), cPd = XLSX.utils.decode_col(COLS_FOLHA.pd)
  const out = []
  for (const r of arr) {
    const cod = normRub(r[cCod]); const valor = numFis(r[cVal])
    if (!cod || !valor) continue // pula cabeçalho, linhas em branco e linhas sem código/valor
    out.push({ cod, nome: String(r[cNome] ?? '').trim(), valor, pd: String(r[cPd] ?? '').trim().toUpperCase() })
  }
  return out
}
// Unifica os eventos dos dois arquivos: agrupa por código somando os valores (a mesma
// rubrica pode aparecer por funcionário / nos dois arquivos). Mantém o nome do evento.
function unificarFolha(...listas) {
  const map = {}
  for (const ev of listas) for (const e of (ev || [])) {
    const m = (map[e.cod] ||= { cod: e.cod, nome: e.nome, valor: 0, pd: e.pd })
    m.valor = Math.round((m.valor + e.valor) * 100) / 100
    if (!m.nome && e.nome) m.nome = e.nome
  }
  return Object.values(map)
}
// Índice do razão (+ lançamentos ajustados) por rubrica: valor por código (o maior lado,
// débito ou crédito — a rubrica entra como partida dobrada) e o conjunto de valores lançados.
async function carregarIndiceFolha(empresaId, competencia) {
  const [mes, ano] = (competencia || '').split('/').map(Number)
  const { data: comp } = await supabase.from('competencias').select('id')
    .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
  const byCod = {}, valores = new Set()
  if (!comp) return { byCod, valores, compId: null }
  const add = (hist, deb, cred) => {
    const cod = rubDoHistorico(hist); if (!cod) return
    const b = (byCod[cod] ||= { cod, deb: 0, cred: 0 })
    b.deb = Math.round((b.deb + (deb || 0)) * 100) / 100
    b.cred = Math.round((b.cred + (cred || 0)) * 100) / 100
    for (const v of [deb, cred]) if (v) valores.add(Math.round(v * 100))
  }
  const { data: rz } = await supabase.from('razao').select('id, historico, debito, credito').eq('competencia_id', comp.id)
  const ajuste = {}
  const { data: aj } = await supabase.from('ajuste_leitura').select('razao_id, historico')
  for (const a of (aj || [])) if (a.historico) ajuste[a.razao_id] = a.historico
  for (const r of (rz || [])) add(ajuste[r.id] || r.historico, Number(r.debito) || 0, Number(r.credito) || 0)
  const { data: lc } = await supabase.from('lancamentos').select('historico, valor').eq('competencia_id', comp.id)
  for (const l of (lc || [])) { const v = Math.abs(Number(l.valor) || 0); add(l.historico, v, v) }
  return { byCod, valores, compId: comp.id }
}
// Cruza os eventos unificados com o índice do razão. Casa pelo código; se o código não
// existir (ex.: código do evento diferente do da rubrica), tenta pelo valor. Rubricas
// justificadas (informativas, ex.: "INF - ...") entram como resolvidas.
function cruzarFolha(eventos, idx, justif = {}) {
  return eventos.map(e => {
    let razao = idx.byCod[e.cod] ? Math.max(idx.byCod[e.cod].deb, idx.byCod[e.cod].cred) : null
    let via = 'codigo'
    if (razao == null) {
      if (idx.valores.has(Math.round(e.valor * 100))) { razao = e.valor; via = 'valor' }
      else { razao = 0; via = null }
    }
    const dif = Math.round((e.valor - razao) * 100) / 100
    const just = justif[e.cod] || ''
    return { ...e, razao, dif, via, just, ok: Math.abs(dif) < 0.005 || !!just }
  }).sort((a, b) => (a.ok === b.ok ? 0 : a.ok ? 1 : -1) || Math.abs(b.dif) - Math.abs(a.dif) || Number(a.cod) - Number(b.cod))
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
  // Persiste o estado da integração da folha (2 arquivos + cruzamento por rubrica).
  async function salvarFolha(novoFolha) {
    const id = await getCompetenciaId()
    if (!id) return
    const novo = { ...estado, folha: novoFolha }
    await supabase.from('competencias').update({ integracoes: novo }).eq('id', id)
    setEstado(novo)
  }
  // Persiste o estado da integração de patrimônio (conta sintética + depreciação).
  async function salvarPatrimonio(novoPat) {
    const id = await getCompetenciaId()
    if (!id) return
    const novo = { ...estado, patrimonio: novoPat }
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
    // Financeira: o próprio componente mantém `estado` = 'validado' só quando TODAS as
    // contas bancárias estão concluídas ou sem movimento (fonte única de verdade).
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
        // Guarda o arquivo no Storage para poder extrair depois (ver o que importaram).
        let path = estado[alvo]?.path || ''
        try {
          const ext = (file.name.match(/\.[a-z0-9]+$/i) || ['.xlsx'])[0].toLowerCase()
          path = `integracao/${id}/${alvo}${ext}`
          await supabase.storage.from('extratos').upload(path, file, { upsert: true, contentType: file.type || undefined })
        } catch { path = '' }
        const novo = { ...estado, [alvo]: { estado: 'validado', doc: file.name, path, usuario: user?.email || null } }
        await supabase.from('competencias').update({ integracoes: novo }).eq('id', id)
        setEstado(novo)
      }
    } catch (err) { setErro('Não consegui ler: ' + err.message) }
  }
  // Baixa o arquivo importado de uma integração (folha/patrimônio) — ver o que subiram.
  async function extrairIntegracao(alvo) {
    const t = estado[alvo]
    if (!t?.path) { setErro('Este arquivo foi importado numa versão anterior e não ficou salvo. Reimporte uma vez para poder extrair.'); return }
    const { data, error } = await supabase.storage.from('extratos').createSignedUrl(t.path, 300, { download: t.doc || `${alvo}.xlsx` })
    if (error) { setErro('Não consegui abrir o arquivo: ' + error.message); return }
    const a = document.createElement('a'); a.href = data.signedUrl; a.download = t.doc || `${alvo}.xlsx`
    document.body.appendChild(a); a.click(); a.remove()
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
          : <FinanceiraViaSistema integ={integ} sistema={sistema} empresaId={empresaId} competencia={competencia} planoMap={planoMap} est={estado.financeira} onEstado={salvarFinanceira} />)
        : tab === 'fiscal'
          ? <Fiscal competencia={competencia} empresaId={empresaId} user={user} est={estado.fiscal || {}} onEstado={salvarFiscal} />
          : tab === 'folha'
            ? <Folha competencia={competencia} empresaId={empresaId} user={user} est={estado.folha || {}} onEstado={salvarFolha} onSemMov={() => marcarSemMov('folha')} />
            : tab === 'patrimonio'
              ? <Patrimonio empresaId={empresaId} competencia={competencia} planoMap={planoMap} est={estado.patrimonio} onEstado={salvarPatrimonio} onSemMov={() => marcarSemMov('patrimonio')} />
              : <Cruzamento tab={tab} dados={dados[tab]} onImport={f => importar(tab, f)} onSemMov={() => marcarSemMov(tab)} onExtrair={() => extrairIntegracao(tab)} est={estado[tab]} />}
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

function Cruzamento({ tab, dados, onImport, onSemMov, onExtrair, est }) {
  const total = dados ? somaNumerica(dados.linhas) : 0
  const semMov = est?.estado === 'sem_movimento'
  return (
    <>
      <div><EstadoBadge est={est} /></div>
      <ImpCard titulo={`Importar — ${DESC[tab].split(' ')[1] || 'relatório'}`} desc={DESC[tab]} onImport={onImport} nome={dados?.nome} qtd={dados?.linhas.length} />
      <div style={{ display: 'flex', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
        {!semMov && !dados && <button className="btn btn-ghost" style={{ fontSize: 12.5 }} onClick={onSemMov} title="Marca esta integração como sem movimento no período (fica verde no Status)"><i className="ti ti-circle-minus" /> Marcar sem movimento</button>}
        {est?.path && <button className="btn btn-ghost" style={{ fontSize: 12.5 }} onClick={onExtrair} title="Baixar o arquivo importado"><i className="ti ti-download" /> Extrair arquivo</button>}
      </div>
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
  const [justAberto, setJustAberto] = useState(false)
  const [justTxt, setJustTxt] = useState('')

  const tipos = est?.tipos || {}
  const atual = tipos[sub]
  const nomeLabel = sub === 'entradas' ? 'Fornecedor' : 'Cliente'
  // Resumo recalculado AO VIVO com o índice atual (razão + lançamentos + ajustes) — assim
  // atualiza sozinho ao abrir, sem reimportar. Se o arquivo foi importado numa versão antiga
  // (sem as linhas guardadas), cai no resumo salvo.
  const resumoAtual = (atual?.rows && razIdx && sub !== 'resumo') ? cruzarFiscal(atual.rows, razIdx, COLS_FISCAL[sub].chave) : (atual?.resumo || [])

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
      const novoTipos = { ...tipos, [sub]: { doc: file.name, path, rows, resumo: cruzarFiscal(rows, razIdx, COLS_FISCAL[sub].chave) } }
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
  // Justificar (só Saídas): ex.: valor no acumulador de operação interna nossa. Marca a
  // Saídas como resolvida. Entradas/Serviços não têm justificar — têm que corrigir.
  async function justificarSaida(texto) {
    const t = texto == null ? '' : texto
    const base = tipos.saidas && !tipos.saidas.semMovimento ? tipos.saidas : {}
    const novoSaidas = t ? { ...base, justificativa: t, justUsuario: user?.email || null } : { ...base }
    if (!t) delete novoSaidas.justificativa
    const novoTipos = { ...tipos, saidas: novoSaidas }
    if (!Object.keys(novoSaidas).length) delete novoTipos.saidas
    const done = CHAVES_FISCAL.every(k => novoTipos[k])
    await onEstado({ ...est, tipos: novoTipos, estado: done ? 'validado' : null, doc: done ? 'Fiscal · 3 tipos' : null, usuario: user?.email || null })
    setJustAberto(false); setJustTxt('')
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
    if (t?.rows && razIdx) return cruzarFiscal(t.rows, razIdx, COLS_FISCAL[k]?.chave).reduce((s, a) => s + a.docTotal, 0)
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
        desc={`Colunas: ${[COLS_FISCAL[sub].nf && `NF (${COLS_FISCAL[sub].nf})`, COLS_FISCAL[sub].data && `Data (${COLS_FISCAL[sub].data})`, `Acumulador (${COLS_FISCAL[sub].acum})`, `${nomeLabel} (${COLS_FISCAL[sub].forn})`, `Valor (${COLS_FISCAL[sub].valor})`].filter(Boolean).join(', ')}. ${COLS_FISCAL[sub].chave === 'nf' ? 'Cruza NF a NF' : 'Cruza pelo acumulador'} com o razão.`}
        onImport={importar} nome={atual?.doc} qtd={atual ? resumoAtual.reduce((s, a) => s + a.qtd, 0) : undefined} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '10px 0 0', flexWrap: 'wrap' }}>
        {atual?.path && <button className="btn btn-ghost" style={{ fontSize: 12.5 }} onClick={extrairArquivo} title="Baixar o arquivo do acumulador importado"><i className="ti ti-download" /> Extrair arquivo</button>}
        {!semMov && !atual?.resumo && <button className="btn btn-ghost" style={{ fontSize: 12.5 }} onClick={marcarSemMovTipo} title="Este cliente não tem esse tipo de movimento no período"><i className="ti ti-circle-minus" /> Marcar sem movimento</button>}
        {sub === 'saidas' && !tipos.saidas?.justificativa && <button className="btn btn-ghost" style={{ fontSize: 12.5 }} onClick={() => { setJustTxt(''); setJustAberto(true) }} title="Só Saídas: justificar valor de operação interna (ex.: rendimento). Entradas/Serviços têm que corrigir."><i className="ti ti-flag" /> Justificar</button>}
        {busy && <span style={{ color: theme.sub, fontSize: 12.5 }}><i className="ti ti-loader" /> Cruzando com razão + lançamentos + ajustes…</span>}
      </div>

      {sub === 'saidas' && tipos.saidas?.justificativa && <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '12px 0 0', flexWrap: 'wrap', background: 'rgba(245,166,35,0.10)', border: `1px solid ${theme.yellow}`, borderRadius: 10, padding: '8px 12px' }}>
        <i className="ti ti-flag" style={{ color: theme.yellow }} />
        <span style={{ fontSize: 12.5, color: theme.text }}><b>Justificada:</b> {tipos.saidas.justificativa}</span>
        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '3px 10px', marginLeft: 'auto' }} onClick={() => { setJustTxt(tipos.saidas.justificativa); setJustAberto(true) }}>editar</button>
        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '3px 10px', color: theme.red, borderColor: theme.red }} onClick={() => justificarSaida('')}>remover</button>
      </div>}

      {sub === 'saidas' && justAberto && <div style={{ margin: '12px 0 0', background: theme.card, border: `1px solid ${theme.cb}`, borderRadius: 10, padding: 14 }}>
        <label style={{ fontSize: 12.5, color: theme.sub }}>Justificativa da Saída (ex.: operação interna — rendimento de aplicação, transferência entre contas…)</label>
        <textarea className="input" rows={2} value={justTxt} onChange={e => setJustTxt(e.target.value)} placeholder="Explique por que este valor de saída não precisa ser corrigido…" style={{ marginTop: 6 }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button className="btn btn-ghost" style={{ fontSize: 12.5 }} onClick={() => { setJustAberto(false); setJustTxt('') }}>Cancelar</button>
          <button className="btn" style={{ fontSize: 12.5 }} disabled={!justTxt.trim()} onClick={() => justificarSaida(justTxt)}>Salvar justificativa</button>
        </div>
      </div>}

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
      <div style={{ display: 'flex', gap: 12, margin: '10px 0 0', flexWrap: 'wrap' }}>
        {est?.resumoPdf?.path && <button className="btn btn-ghost" style={{ fontSize: 12.5 }} onClick={async () => {
          const { data, error } = await supabase.storage.from('extratos').createSignedUrl(est.resumoPdf.path, 300, { download: est.resumoPdf.doc || 'resumo.pdf' })
          if (error) return
          const a = document.createElement('a'); a.href = data.signedUrl; a.download = est.resumoPdf.doc || 'resumo.pdf'
          document.body.appendChild(a); a.click(); a.remove()
        }} title="Baixar o resumo importado"><i className="ti ti-download" /> Extrair arquivo</button>}
        {busy && <span style={{ color: theme.sub, fontSize: 12.5 }}><i className="ti ti-loader" /> Lendo o resumo…</span>}
      </div>

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

// Auto-detecta as colunas do EXTRATO (para o cruzamento por dia): Data + Saldo obrigatórias,
// Valor/movimento opcional. Retorna { linhaInicio, colData, colSaldo, colValor } ou null.
function autoMapaExtrato(arr) {
  for (let i = 0; i < Math.min((arr || []).length, 40); i++) {
    const hd = arr[i] || []
    const d = achaColuna(hd, /^data|\bdata\b|dt\b/)
    const s = achaColuna(hd, /saldo|balance/)
    if (d >= 0 && s >= 0) {
      const v = achaColuna(hd, /valor|movimento|d[eé]bito|cr[eé]dito|entrada|sa[ií]da|lan[çc]/)
      return { linhaInicio: i + 1, colData: d, colSaldo: s, colValor: (v >= 0 && v !== d && v !== s) ? v : null }
    }
  }
  return null
}
// O mapa de colunas do extrato ainda cabe neste arquivo?
function mapaExtratoValido(m, arr) {
  if (!m || !Array.isArray(arr) || !arr.length) return false
  const nc = arr.reduce((mx, r) => Math.max(mx, (r || []).length), 0)
  return m.linhaInicio != null && m.linhaInicio <= arr.length && m.colData >= 0 && m.colData < nc && m.colSaldo >= 0 && m.colSaldo < nc
}

// Integração FOLHA: importa a folha mensal e o adiantamento, unifica por rubrica e cruza
// com o razão pelo padrão "VALOR REF. <código> - <nome>". Resumo por rubrica com total → zero.
// Rubricas informativas (ex.: "INF - SEGURO DE VIDA") que não são contabilizadas podem ser
// justificadas para fechar em zero, do mesmo jeito que a fiscal.
const ARQ_FOLHA = [['folha', 'Folha mensal', 'ti-users'], ['adiant', 'Adiantamento', 'ti-cash']]
function Folha({ competencia, empresaId, user, est, onEstado, onSemMov }) {
  const [idx, setIdx] = useState(null)   // { byCod, valores, compId }
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState('')
  const [busy, setBusy] = useState('')   // qual arquivo está sendo lido
  const [justAberto, setJustAberto] = useState(null) // código com justificativa aberta
  const [justTxt, setJustTxt] = useState('')

  const arquivos = est?.arquivos || {}
  const justif = est?.justif || {}
  const semMov = est?.estado === 'sem_movimento'

  useEffect(() => {
    let ativo = true
    setCarregando(true); setIdx(null)
    carregarIndiceFolha(empresaId, competencia).then(x => { if (ativo) { setIdx(x); setCarregando(false) } })
    return () => { ativo = false }
  }, [empresaId, competencia])

  // Eventos unificados (folha + adiantamento) e o cruzamento AO VIVO com o razão atual.
  const eventos = unificarFolha(arquivos.folha?.eventos, arquivos.adiant?.eventos)
  const resumo = (eventos.length && idx) ? cruzarFolha(eventos, idx, justif) : []
  const totDoc = resumo.reduce((s, r) => s + r.valor, 0)
  const totRaz = resumo.reduce((s, r) => s + r.razao, 0)
  const totDif = Math.round(resumo.filter(r => !r.just).reduce((s, r) => s + r.dif, 0) * 100) / 100
  const pendentes = resumo.filter(r => !r.ok).length

  async function importar(alvo, file) {
    if (!file || !idx) return
    setErro(''); setBusy(alvo)
    try {
      const eventos = await parseFolha(file)
      if (!eventos.length) { setErro(`Não encontrei rubricas (coluna ${COLS_FOLHA.cod}) com valor (coluna ${COLS_FOLHA.valor}) no arquivo. Confira se é o relatório da folha do Domínio.`); setBusy(''); return }
      let path = arquivos[alvo]?.path || ''
      if (idx.compId) {
        const ext = (file.name.match(/\.[a-z0-9]+$/i) || ['.xls'])[0].toLowerCase()
        path = `folha/${idx.compId}/${alvo}${ext}`
        const { error: eUp } = await supabase.storage.from('extratos').upload(path, file, { upsert: true, contentType: file.type || undefined })
        if (eUp) { setErro('Li o arquivo, mas não consegui guardá-lo p/ extrair depois: ' + eUp.message); path = '' }
      }
      const novoArq = { ...arquivos, [alvo]: { doc: file.name, path, eventos } }
      // Folha vira validada no Status quando a folha mensal for importada (adiantamento é opcional).
      const done = !!novoArq.folha
      await onEstado({ ...est, arquivos: novoArq, justif, estado: done ? 'validado' : null, doc: done ? 'Folha · rubricas cruzadas' : null, usuario: user?.email || null })
    } catch (e) { setErro('Não consegui ler: ' + e.message) }
    setBusy('')
  }

  async function extrair(alvo) {
    const a = arquivos[alvo]
    if (!a?.path) { setErro('Este arquivo foi importado numa versão anterior e não ficou salvo. Reimporte uma vez para poder extrair.'); return }
    const { data, error } = await supabase.storage.from('extratos').createSignedUrl(a.path, 300, { download: a.doc || `${alvo}.xls` })
    if (error) { setErro('Não consegui abrir o arquivo: ' + error.message); return }
    const el = document.createElement('a'); el.href = data.signedUrl; el.download = a.doc || `${alvo}.xls`
    document.body.appendChild(el); el.click(); el.remove()
  }
  async function removerArquivo(alvo) {
    const novoArq = { ...arquivos }; delete novoArq[alvo]
    const done = !!novoArq.folha
    await onEstado({ ...est, arquivos: novoArq, justif, estado: done ? 'validado' : null, doc: done ? 'Folha · rubricas cruzadas' : null, usuario: user?.email || null })
  }
  // Marca um arquivo (ex.: adiantamento) como sem movimento no mês — pode não ter havido.
  async function semMovArquivo(alvo) {
    const novoArq = { ...arquivos, [alvo]: { semMovimento: true } }
    const done = !!novoArq.folha
    await onEstado({ ...est, arquivos: novoArq, justif, estado: done ? 'validado' : null, doc: done ? 'Folha · rubricas cruzadas' : null, usuario: user?.email || null })
  }
  async function salvarJustificativa(cod, texto) {
    const novo = { ...justif }
    if (texto && texto.trim()) novo[cod] = texto.trim(); else delete novo[cod]
    await onEstado({ ...est, arquivos, justif: novo, estado: est.estado, doc: est.doc, usuario: user?.email || null })
    setJustAberto(null); setJustTxt('')
  }

  if (carregando) return <p style={{ color: theme.sub, fontSize: 13 }}>Carregando razão…</p>

  if (semMov) return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: theme.sub, background: theme.card, border: `1px solid ${theme.cb}`, borderRadius: 20, padding: '5px 12px' }}><i className="ti ti-circle-minus" /> Folha — sem movimento no período</span>
      <button className="btn btn-ghost" style={{ fontSize: 12.5 }} onClick={() => onEstado({})}><i className="ti ti-rotate" /> Tem movimento</button>
    </div>
  )

  return (
    <>
      <div><EstadoBadge est={est} /></div>
      {/* Dois slots de importação: folha mensal + adiantamento */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 12, marginBottom: 14 }}>
        {ARQ_FOLHA.map(([k, label, icon]) => {
          const a = arquivos[k]
          const semMovK = a?.semMovimento
          const importado = a && !semMovK
          const cor = importado ? theme.green : semMovK ? theme.cb : theme.cb
          return (
            <div key={k} style={{ background: theme.card, border: `1px solid ${cor}`, borderRadius: 12, padding: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <i className={`ti ${icon}`} style={{ color: theme.accent }} />
                <span style={{ fontWeight: 600, fontSize: 13 }}>{label}</span>
                {importado ? <i className="ti ti-circle-check" style={{ color: theme.green, marginLeft: 'auto' }} /> : semMovK ? <i className="ti ti-circle-minus" style={{ color: theme.sub, marginLeft: 'auto' }} /> : <span style={{ marginLeft: 'auto', color: theme.sub, fontSize: 12 }}>{k === 'adiant' ? 'opcional' : 'obrigatório'}</span>}
              </div>
              <p style={{ fontSize: 12, color: importado ? theme.text : theme.sub, margin: '0 0 10px' }}>{importado ? `${a.doc} · ${a.eventos.length} rubrica(s)` : semMovK ? 'Sem movimento no período.' : 'Relatório de rubricas do Domínio (colunas V/W/Z).'}</p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {semMovK
                  ? <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => removerArquivo(k)}><i className="ti ti-rotate" /> Tem movimento</button>
                  : <>
                    <label className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', cursor: 'pointer' }}>
                      <i className="ti ti-cloud-upload" /> {importado ? 'Reimportar' : 'Importar'}
                      <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => importar(k, e.target.files?.[0])} />
                    </label>
                    {a?.path && <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => extrair(k)}><i className="ti ti-download" /> Extrair</button>}
                    {importado && <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: theme.sub }} onClick={() => removerArquivo(k)}>limpar</button>}
                    {k === 'adiant' && !importado && <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => semMovArquivo(k)} title="Não houve adiantamento neste mês"><i className="ti ti-circle-minus" /> Sem movimento</button>}
                  </>}
                {busy === k && <span style={{ color: theme.sub, fontSize: 12 }}><i className="ti ti-loader" /> lendo…</span>}
              </div>
            </div>
          )
        })}
      </div>
      {!arquivos.folha && <button className="btn btn-ghost" style={{ fontSize: 12.5, marginBottom: 12 }} onClick={onSemMov} title="Cliente sem folha no período (fica verde no Status)"><i className="ti ti-circle-minus" /> Marcar sem movimento</button>}

      {eventos.length > 0 && <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 12, margin: '4px 0 16px' }}>
          <Metric label="Total do documento" valor={money(totDoc)} icon="ti-receipt" />
          <Metric label="Razão / contabilidade" valor={money(totRaz)} icon="ti-checks" cor={theme.green} />
          <Metric label="Diferença" valor={money(totDif)} icon="ti-arrows-diff" cor={Math.abs(totDif) < 0.005 ? theme.green : theme.red} sub={Math.abs(totDif) < 0.005 ? 'tudo identificado' : `${pendentes} rubrica(s) a resolver`} />
        </div>

        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
          <table style={{ width: '100%', minWidth: 640, borderCollapse: 'collapse' }}>
            <thead><tr style={{ background: theme.input }}>
              <th style={FS.th}>Rubrica</th><th style={FS.th}>Descrição</th><th style={FS.thR}>Folha</th><th style={FS.thR}>Razão</th><th style={FS.thR}>Diferença</th><th style={{ ...FS.th, textAlign: 'center' }}></th>
            </tr></thead>
            <tbody>
              {resumo.map(r => {
                const aberto = justAberto === r.cod
                return (
                  <Fragment key={r.cod}>
                    <tr style={{ borderTop: `1px solid ${theme.border}`, background: r.ok ? 'transparent' : 'rgba(229,72,77,0.06)' }}>
                      <td style={FS.td}>{r.cod}</td>
                      <td style={FS.td}>{r.nome || '—'}{r.via === 'valor' && <span style={{ color: theme.sub, fontSize: 11 }} title="Identificado pelo valor (código do evento diferente do da rubrica no razão)"> · por valor</span>}{r.just && <span style={{ color: theme.yellow, fontSize: 11 }}> · justificada</span>}</td>
                      <td style={FS.tdR}>{money(r.valor)}</td>
                      <td style={{ ...FS.tdR, color: theme.green }}>{money(r.razao)}</td>
                      <td style={{ ...FS.tdR, color: r.ok ? theme.sub : theme.red, fontWeight: 600 }}>{money(r.dif)}</td>
                      <td style={{ ...FS.td, textAlign: 'center' }}>
                        {Math.abs(r.dif) < 0.005
                          ? <i className="ti ti-circle-check" style={{ color: theme.green }} />
                          : <button className="btn btn-ghost" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => { setJustAberto(aberto ? null : r.cod); setJustTxt(justif[r.cod] || '') }} title="Justificar (ex.: rubrica informativa, não contabilizada)"><i className="ti ti-flag" style={{ color: r.just ? theme.yellow : theme.sub }} /> {r.just ? 'editar' : 'justificar'}</button>}
                      </td>
                    </tr>
                    {aberto && (
                      <tr><td colSpan={6} style={{ padding: '10px 14px', background: theme.input }}>
                        <label style={{ fontSize: 12, color: theme.sub }}>Justificativa da rubrica {r.cod} — {r.nome} (ex.: evento informativo "INF - ...", não gera lançamento contábil)</label>
                        <textarea className="input" rows={2} value={justTxt} onChange={e => setJustTxt(e.target.value)} placeholder="Explique por que esta rubrica não precisa bater com o razão…" style={{ marginTop: 6 }} />
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                          {r.just && <button className="btn btn-ghost" style={{ fontSize: 12, color: theme.red, borderColor: theme.red }} onClick={() => salvarJustificativa(r.cod, '')}>remover</button>}
                          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => { setJustAberto(null); setJustTxt('') }}>cancelar</button>
                          <button className="btn" style={{ fontSize: 12 }} disabled={!justTxt.trim()} onClick={() => salvarJustificativa(r.cod, justTxt)}>salvar</button>
                        </div>
                      </td></tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: `2px solid ${theme.border}`, background: theme.input, fontWeight: 700 }}>
                <td style={FS.td} colSpan={2}>Total ({resumo.length} rubrica(s))</td>
                <td style={FS.tdR}>{money(totDoc)}</td>
                <td style={{ ...FS.tdR, color: theme.green }}>{money(totRaz)}</td>
                <td style={{ ...FS.tdR, color: Math.abs(totDif) < 0.005 ? theme.sub : theme.red }}>{money(totDif)}</td>
                <td style={FS.td}></td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p style={{ color: theme.sub, fontSize: 11.5, margin: '10px 0 0' }}>
          Unifica folha + adiantamento e cruza cada rubrica com o razão pelo padrão <b style={{ color: theme.text }}>"VALOR REF. &lt;código&gt; - &lt;nome&gt;"</b> (lê também os lançamentos ajustados) — atualiza sozinho ao abrir. Rubricas informativas que não são contabilizadas podem ser <b style={{ color: theme.text }}>justificadas</b> para fechar em zero.
        </p>
      </>}
      {erro && <p style={{ color: theme.red, fontSize: 13, margin: '12px 0 0' }}>{erro}</p>}
    </>
  )
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
  const [centros, setCentros] = useState([])     // centros de custo do cliente: [{ cod, nome, resp }]
  const [memMeta, setMemMeta] = useState({ nomeArquivo: '', semCarga: false })
  const [carregReg, setCarregReg] = useState(true)
  const [novo, setNovo] = useState({ conta_contabil: '', agencia: '', conta: '' })
  const [modo, setModo] = useState('porBanco')   // 'porBanco' | 'combinado'
  const [raw, setRaw] = useState(null)           // { nome, header, linhasRaw, banco, viaPerfil }
  const [map, setMap] = useState({ hist: -1, valor: -1, data: -1 })
  const [linhas, setLinhas] = useState([])       // classificação: [{ banco, historico, valor, entrada, contra, data }]
  const [erro, setErro] = useState('')
  const [msg, setMsg] = useState('')
  const [perfil, setPerfil] = useState(null)     // perfil de leitura LEGADO (um só por cliente) — retrocompatibilidade
  const [perfis, setPerfis] = useState({})       // perfil de leitura POR BANCO: { [conta_contabil]: perfil }
  const [cfg, setCfg] = useState(null)           // { raw, banco, perfil } — painel de mapeamento aberto
  const [fSem, setFSem] = useState(false)        // filtro: só linhas sem contrapartida
  const [fHist, setFHist] = useState('')         // filtro por histórico
  const [fMode, setFMode] = useState('contem')   // 'contem' | 'exato'
  const [fData, setFData] = useState('')         // filtro por data (dd/mm)
  const [fES, setFES] = useState('')             // filtro entrada/saída ('' | 'entrada' | 'saida')
  const [fConta, setFConta] = useState('')       // filtro por conta de contrapartida
  const [fNivel, setFNivel] = useState('')       // filtro por nível de confiança ('' | alta | media | manual | sem)
  const [fNome, setFNome] = useState('')         // filtro por NOME da conta de contrapartida
  const [fNomeMode, setFNomeMode] = useState('contem') // 'contem' | 'naocontem'
  const [fSemData, setFSemData] = useState(false) // filtro: só linhas SEM data (ex.: linhas de total)
  const [importPend, setImportPend] = useState(null) // { arr, nome, bancoFixo, perf, catByRow, qtd } — pergunta substituir/complementar
  const [lote, setLote] = useState('')           // conta para preencher em lote nas selecionadas
  const [sel, setSel] = useState(() => new Set())// linhas selecionadas (índice original)
  const [quebra, setQuebra] = useState(null)      // { i, linha } divisão de um lançamento
  const [saldoAnterior, setSaldoAnterior] = useState(null) // saldo do banco no balancete (abertura)
  const [saldoExtrato, setSaldoExtrato] = useState('')     // saldo do extrato informado pelo usuário
  const [cruza, setCruza] = useState(null)                 // resultado do cruzamento por dia com o extrato
  const [cruzaOpen, setCruzaOpen] = useState(false)        // modal do cruzamento aberto (dá p/ reabrir)
  const [colPicker, setColPicker] = useState(null)         // { arr } — "Ajustar colunas" do extrato
  const [cruzaArr, setCruzaArr] = useState(null)           // linhas cruas do último extrato cruzado (p/ reajustar colunas)
  const [novoLanc, setNovoLanc] = useState(false)          // modal de incluir lançamento manual
  const [sugAprend, setSugAprend] = useState(null)         // { itens } sugestões após aprender
  const [editLanc, setEditLanc] = useState(null)           // { i, linha } editar lançamento inteiro
  const refsContra = useRef({})                  // foco: Enter pula para a próxima linha

  const nomeBanco = cod => planoMap[String(cod)]?.nome || (cod ? `Conta ${cod}` : '—')
  // Centro de custo (só clientes que usam). Obrigatório APENAS na contrapartida de
  // RESULTADO (classificação começa em 3, 4 ou 5). O CC vem da planilha do mês; se veio
  // vazio, o usuário preenche à mão. `ccPendente` = falta preencher onde é obrigatório.
  const ehResultadoContra = contra => ['3', '4', '5'].includes(String(planoMap[String(contra)]?.classif || '')[0])
  const ccPendente = l => usaCC && l.contra && ehResultadoContra(l.contra) && !String(l.centro_custo || '').trim()
  const bancosEst = est?.bancos || {}
  // Banco concluído (validado): trava edição/inclusão/exclusão até reabrir.
  const concluido = !!(raw?.banco && bancosEst[raw.banco]?.concluido === true)
  // Contas de adiantamento (nome contém "adiant") — usadas para a regra: com nota não é adiantamento.
  const adiantContas = new Set(Object.entries(planoMap).filter(([, pl]) => /adiant/i.test(pl?.nome || '')).map(([cod]) => cod))

  // A FINANCEIRA só fica VERDE (validado) quando TODAS as contas bancárias cadastradas
  // estiverem CONCLUÍDAS (concluido) ou marcadas como SEM MOVIMENTO. Mantém est.estado
  // como fonte única (Status, badge e farol da tela leem daqui).
  function statusFinanceira(bancos) {
    const bm = bancos || {}
    if (!contas.length) return est?.estado === 'sem_movimento' ? 'sem_movimento' : null
    const todas = contas.every(c => { const s = bm[String(c.conta_contabil).trim()]; return s && (s.concluido === true || s.estado === 'sem_movimento') })
    return todas ? 'validado' : null
  }
  useEffect(() => {
    if (carregReg) return
    const novo = statusFinanceira(est?.bancos || {})
    if ((est?.estado || null) !== (novo || null)) onEstado({ ...est, estado: novo })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contas, est?.bancos, carregReg])

  useEffect(() => {
    setCarregReg(true); setRaw(null); setLinhas([]); setErro(''); setMsg('')
    Promise.all([
      supabase.from('cargas_cadastro').select('dados, obs').eq('cliente_id', empresaId).eq('tipo', 'contas_bancarias').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('cargas_cadastro').select('dados, obs').eq('cliente_id', empresaId).eq('tipo', 'memoria_financeira').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('cargas_cadastro').select('dados').eq('cliente_id', empresaId).eq('tipo', 'centro_custo').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ]).then(([bc, mem, cc]) => {
      // Lista de centros de custo (código, nome, responsável) — para o F4 do campo C. Custo.
      const kBy = (o, re) => { const k = Object.keys(o || {}).find(k => re.test(String(k).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''))); return k ? String(o[k] ?? '').trim() : '' }
      setCentros((Array.isArray(cc.data?.dados) ? cc.data.dados : []).map(r => ({ cod: kBy(r, /cod/), nome: kBy(r, /nome|descri/), resp: kBy(r, /respons/) })).filter(c => c.cod || c.nome))
      setContas(Array.isArray(bc.data?.dados) ? bc.data.dados : [])
      let perf = null, perfMap = {}
      try {
        const o = JSON.parse(bc.data?.obs || '')
        if (o && typeof o === 'object') {
          if (o.perfil) perf = o.perfil
          if (o.perfis && typeof o.perfis === 'object') perfMap = o.perfis
        }
      } catch { /* obs antigo em texto */ }
      setPerfil(perf); setPerfis(perfMap); setCfg(null)
      setMemoria(Array.isArray(mem.data?.dados) ? mem.data.dados : [])
      let meta = { nomeArquivo: '', semCarga: false }
      try { const m = JSON.parse(mem.data?.obs || ''); if (m && typeof m === 'object') meta = { nomeArquivo: m.nomeArquivo || '', semCarga: !!m.semCarga } } catch { /* obs antigo em texto */ }
      setMemMeta(meta)
      setCarregReg(false)
    })
  }, [empresaId])

  // Reabrir sozinho o banco após um reload (ex.: botão "Atualizar" da nova versão): guarda
  // em sessionStorage qual banco (e se o cruzamento) estava aberto e restaura ao voltar,
  // para não ter que refazer todo o caminho. Chave por cliente+competência.
  const restauradoRef = useRef(null)
  const chaveAberto = () => `integ_aberto_${empresaId}_${competencia}`
  // Restaura (uma vez por contexto), assim que o cadastro terminou de carregar.
  useEffect(() => {
    if (carregReg) return
    const chave = chaveAberto()
    if (restauradoRef.current === chave) return
    restauradoRef.current = chave
    if (raw?.banco) return // já tem um banco aberto (import em andamento) — não mexe
    let alvo = null
    try { alvo = JSON.parse(sessionStorage.getItem(chave) || 'null') } catch { alvo = null }
    const s = alvo?.banco ? (est?.bancos || {})[alvo.banco] : null
    if (s?.draft) {
      continuarRascunho(alvo.banco)
      if (alvo.cruzaOpen && s.cruza) setCruzaOpen(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carregReg, empresaId, competencia])
  // Guarda o banco aberto (e se o cruzamento está aberto) a cada mudança — só depois de restaurar.
  useEffect(() => {
    if (carregReg || restauradoRef.current !== chaveAberto()) return
    try {
      if (raw?.banco) sessionStorage.setItem(chaveAberto(), JSON.stringify({ banco: raw.banco, cruzaOpen }))
      else sessionStorage.removeItem(chaveAberto())
    } catch { /* sessionStorage indisponível */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw?.banco, cruzaOpen, carregReg])

  // Cadastro de bancos e memória valem para todas as competências (o cliente
  // cadastra uma vez). Por isso é lido sempre pelo registro mais recente, sem
  // filtro de mês, e persiste para os próximos meses.
  async function salvarCarga(tipo, arr, obs) {
    await supabase.from('cargas_cadastro').delete().eq('cliente_id', empresaId).eq('tipo', tipo)
    const { error } = await supabase.from('cargas_cadastro').insert({ cliente_id: empresaId, tipo, vigencia: competencia, dados: arr, usuario: user?.email || null, obs })
    if (error) setErro('Não consegui gravar: ' + error.message)
    return error
  }
  // O perfil de leitura do extrato vive no obs da carga de contas bancárias.
  // Cada BANCO (conta_contabil) tem seu próprio perfil — clientes com mais de um
  // banco exportam layouts diferentes (ex.: Itaú/Sisloc × Bradesco). O campo `perfil`
  // (legado, um só) é mantido só para retrocompatibilidade com cadastros antigos.
  function obsContas(perfMap = perfis, legado = perfil) { return JSON.stringify({ perfil: legado || null, perfis: perfMap || {} }) }
  // Resolve o perfil de um banco: primeiro o específico do banco, senão o legado.
  function perfilDeBanco(banco) { return perfis[String(banco)] || perfil || null }
  // Um perfil "serve" para este arquivo se a linha de início cabe e a coluna de valor
  // existe e tem números. Evita aplicar o perfil de OUTRO banco (colunas/linhas que nem
  // existem neste extrato → prévia vazia). Nesse caso o palpite vem do próprio arquivo.
  function perfilServe(p, arr) {
    if (!p || !Array.isArray(arr) || !arr.length) return false
    const nc = arr.reduce((m, r) => Math.max(m, (r || []).length), 0)
    if (p.linhaInicio == null || p.linhaInicio >= arr.length) return false
    if (p.colValor == null || p.colValor < 0 || p.colValor >= nc) return false
    return arr.slice(p.linhaInicio, p.linhaInicio + 60).some(r => { const v = parseValor(r?.[p.colValor]); return v && Math.abs(v) >= 1 })
  }
  // Palpite inicial ao abrir "Ajustar leitura": perfil salvo do banco se couber, senão
  // o legado se couber, senão auto-detecta do próprio arquivo.
  function perfilInicial(banco, arr) {
    const esp = perfis[String(banco)]
    if (perfilServe(esp, arr)) return esp
    if (!esp && perfilServe(perfil, arr)) return perfil
    return perfilPadrao(arr)
  }
  async function salvarContas(arr) { setContas(arr); await salvarCarga('contas_bancarias', arr, obsContas()) }
  async function salvarPerfil(perf, banco) {
    const chave = String(banco ?? '').trim()
    const novoMap = chave ? { ...perfis, [chave]: perf || null } : perfis
    // Perfil por banco → grava no mapa e preserva o legado (fallback dos demais bancos).
    // Sem banco (fluxo antigo) → grava no legado.
    const novoLegado = chave ? perfil : perf
    setPerfis(novoMap); setPerfil(novoLegado)
    await salvarCarga('contas_bancarias', contas, obsContas(novoMap, novoLegado))
  }
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
  function salvarBancoDraft(conta, estadoB, doc, draftLinhas, concluidoFlag, cruzaOverride) {
    const bancos = { ...(est?.bancos || {}) }
    const prev = bancos[conta] || {}
    // Guarda o ARQUIVO BRUTO (arr + mesclas) junto do rascunho: assim dá para "Ajustar
    // leitura" no arquivo JÁ IMPORTADO, sem reimportar. Vem do `raw` atual (import desta
    // sessão) ou preserva o que já estava salvo.
    const temRaw = raw?.banco === conta && Array.isArray(raw?.arr)
    // `concluido` (trava de edição) é um flag PRÓPRIO — não se confunde com `estado`
    // ('validado' também é setado no import). Só o botão Concluir liga; Reabrir desliga.
    bancos[conta] = { estado: estadoB, doc: doc || null, usuario: user?.email || null, draft: draftLinhas || null, saldoExtrato: saldoExtrato || null, cruza: cruzaOverride !== undefined ? cruzaOverride : (cruza || null), concluido: concluidoFlag ?? prev.concluido ?? false, arr: temRaw ? raw.arr : (prev.arr ?? null), catByRow: temRaw ? (raw.catByRow ?? null) : (prev.catByRow ?? null) }
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
      const cas = casarHistoricoNivel(historico, memX, banco ? new Set([String(banco)]) : null)
      return { banco, historico, valor: Math.abs(valor), entrada: valor >= 0, contra: cas.conta, contra_nivel: cas.nivel, data }
    // "SALDO ANTERIOR/INICIAL" não é lançamento (só valida o saldo) — fora da lista.
    }).filter(l => !/saldo\s+(anterior|inicial)/i.test(String(l.historico).normalize('NFD').replace(/[̀-ͯ]/g, '')))
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
    let colValor = -1, colData = -1, best = 0
    for (let j = 0; j < nc; j++) {
      const nums = rows.filter(r => { const v = parseValor(r?.[j]); return v && Math.abs(v) >= 1 }).length
      if (nums > best) { best = nums; colValor = j }
      if (colData < 0 && rows.filter(r => dataISO(r?.[j])).length > rows.length / 3) colData = j
    }
    // Histórico = coluna de TEXTO (descrição), excluindo valor, data e colunas que SÃO
    // datas (Date vira "Mon Jun 01…", que tem letras e enganava a detecção antiga).
    const pareceData = j => rows.filter(r => (r?.[j] instanceof Date) || dataISO(r?.[j])).length > rows.length / 3
    let colHist = -1, bestLen = 0
    for (let j = 0; j < nc; j++) {
      if (j === colValor || j === colData || pareceData(j)) continue
      const avg = rows.reduce((s, r) => { const t = (r?.[j] instanceof Date) ? '' : String(r?.[j] ?? ''); return s + (/[A-Za-zÀ-ú]{3,}/.test(t) ? t.length : 0) }, 0) / (rows.length || 1)
      if (avg > bestLen) { bestLen = avg; colHist = j }
    }
    // Coluna de NATUREZA (D/C): células curtas só com D ou C. No extrato, C = Entrada e
    // D = Saída. Se existir e o valor vier sempre positivo, usa a natureza; senão, o sinal.
    let colDC = -1
    for (let j = 0; j < nc; j++) {
      if (j === colValor || j === colData || j === colHist) continue
      const dc = rows.filter(r => /^[dc]$/i.test(String(r?.[j] ?? '').trim())).length
      if (dc > rows.length / 2) { colDC = j; break }
    }
    const temNegativo = rows.some(r => parseValor(r?.[colValor]) < 0)
    const es = (colDC >= 0 && !temNegativo)
      ? { modo: 'natureza', col: colDC, entrada: [] }
      : { modo: 'sinal', col: -1, entrada: [] }
    return { linhaInicio: ini, colValor, colData, colHist, colCredor: -1, colDoc: -1, colCategoria: -1, histCols: [], es, filtro: { col: -1, pularVazio: false } }
  }

  // Aplica o perfil já salvo a um extrato por banco e segue (marca o banco).
  function aplicarEProsseguir(arr, nome, bancoFixo, perf, catByRow, modoImp) {
    // A contrapartida NUNCA pode ser a própria conta do banco (o banco já é um lado da
    // partida). Se a memória/perfil devolver o próprio banco, limpa para classificar à mão.
    const norm = aplicarPerfil(arr, perf, memoria, catByRow, adiantContas, new Set([String(bancoFixo)]), centros)
      .map(l => ({ ...l, banco: bancoFixo, contra: String(l.contra || '') === String(bancoFixo) ? '' : l.contra }))
    // "Que já existe" deste banco: os lançamentos na tela (se o painel dele está aberto) OU
    // o rascunho salvo (quando se reimporta direto pelo slot, sem abrir com "Continuar").
    const prevBanco0 = (est?.bancos || {})[bancoFixo]
    const draftPrev = Array.isArray(prevBanco0?.draft) ? prevBanco0.draft : []
    const baseAtual = (raw?.banco === bancoFixo && linhas.length) ? linhas : draftPrev
    const bancoConcluido = prevBanco0?.estado === 'validado' || prevBanco0?.concluido
    // Já existe importação em andamento → pergunta substituir ou complementar (subir um 2º
    // arquivo somando ao que já está, para finalizar o fechamento).
    if (!modoImp && baseAtual.length && !bancoConcluido) {
      setImportPend({ arr, nome, bancoFixo, perf, catByRow, qtd: norm.length, atual: baseAtual.length })
      return
    }
    const modo = modoImp || 'substituir'
    // Reimport do mesmo arquivo (substituir): preserva as contrapartidas já preenchidas no
    // rascunho (mesmo arquivo → mesma ordem), atualizando histórico/valor/data.
    let mantidas = 0
    if (modo === 'substituir' && draftPrev.length === norm.length) {
      norm.forEach((l, i) => {
        if (draftPrev[i]?.contra) { l.contra = draftPrev[i].contra; l.contra_nivel = draftPrev[i].contra_nivel || 'manual'; mantidas++ }
        // Centro de custo preenchido à mão (planilha veio vazia) — preserva no reimport do mesmo arquivo.
        if (!l.centro_custo && draftPrev[i]?.centro_custo) l.centro_custo = draftPrev[i].centro_custo
      })
    }
    // Complementar: adiciona os novos lançamentos aos que já existem (tela ou rascunho salvo).
    const finalLinhas = modo === 'complementar' ? [...baseAtual, ...norm] : norm
    const prevBanco = (est?.bancos || {})[bancoFixo]
    if (prevBanco?.saldoExtrato) setSaldoExtrato(prevBanco.saldoExtrato)
    setCruza(prevBanco?.cruza || null); setCruzaOpen(false); setColPicker(null); setCruzaArr(null)
    setRaw({ nome, banco: bancoFixo, viaPerfil: true, arr, catByRow })
    setLinhas(finalLinhas); setSel(new Set())
    if (!finalLinhas.length) { setErro('O perfil de leitura não encontrou lançamentos. Clique em “Ajustar leitura” e revise o mapeamento.'); return }
    const erroComp = validarCompetencia(finalLinhas, { data: (perf.colData != null && perf.colData >= 0) ? 0 : -1 }, competencia)
    if (erroComp) { setErro(erroComp); return }
    const casadas = finalLinhas.filter(l => l.contra).length
    setMsg(`${finalLinhas.length} linha(s) · ${casadas} classificada(s)${modo === 'complementar' ? ` · ${norm.length} complementada(s)` : mantidas ? ` · ${mantidas} do rascunho preservada(s)` : ' pela memória'}. Rascunho salvo — conclua quando tudo estiver contabilizado.`)
    // Salva como rascunho (em andamento); só vira "concluído" ao clicar Concluir.
    salvarBancoDraft(bancoFixo, 'rascunho', nome, finalLinhas)
  }

  // Salva o progresso atual (rascunho) sem concluir.
  function salvarRascunho() {
    if (!raw?.banco) return
    salvarBancoDraft(raw.banco, 'rascunho', raw.nome, linhas)
    setMsg('Rascunho salvo — você pode fechar e continuar depois.')
  }
  // Conclui o banco (marca como contabilizado) — some do pendente no Status.
  async function concluirBanco() {
    if (!raw?.banco) return
    // Concluir exige o saldo do extrato INFORMADO e SEM diferença.
    if (!temExtrato) { setErro('Informe o saldo do extrato para concluir o banco.'); return }
    if (Math.abs(difSaldo) >= 0.005) { setErro(`Não dá para concluir: o saldo do extrato não confere (diferença ${money(difSaldo)}). Zere a diferença antes de concluir.`); return }
    const semData = linhas.filter(l => !l.data).length
    if (semData && !window.confirm(`Atenção: ${semData} lançamento(s) SEM DATA. O Domínio precisa da data. Concluir assim mesmo?`)) return
    const faltam = linhas.filter(l => !l.contra).length
    if (faltam && !window.confirm(`Ainda há ${faltam} linha(s) sem contrapartida. Concluir assim mesmo?`)) return
    // Centro de custo é OBRIGATÓRIO na contrapartida de resultado (3/4/5) — trava a conclusão.
    const semCC = usaCC ? linhas.filter(ccPendente).length : 0
    if (semCC) { setErro(`${semCC} lançamento(s) de resultado (grupos 3, 4 e 5) sem centro de custo. Preencha a coluna “C. Custo” antes de concluir.`); return }
    if (!window.confirm('Concluir o banco? Ele fica travado para edição — para alterar depois, use Reabrir banco.')) return
    // Ao concluir, JÁ APRENDE (não depende de lembrar de "Aprender e salvar"): grava
    // histórico → contrapartida de todas as linhas classificadas na memória do cliente.
    let aprendidas = 0
    const novas = linhas.filter(l => l.contra && l.historico).map(l => ({ historico: l.historico, conta: l.contra }))
    if (novas.length) {
      try { await salvarMemoria(aprender(memoria, novas), { nomeArquivo: memMeta.nomeArquivo, semCarga: false }); aprendidas = novas.length } catch { /* não bloqueia a conclusão */ }
    }
    salvarBancoDraft(raw.banco, 'validado', raw.nome, linhas, true)
    setMsg(`Banco concluído${aprendidas ? ` — ${aprendidas} classificação(ões) aprendidas na memória` : ''}. Travado para edição; para alterar, use Reabrir banco.`)
  }
  // Reabre o banco concluído: volta a rascunho e libera edição/inclusão/exclusão.
  function reabrirBanco() {
    if (!raw?.banco) return
    if (!window.confirm('Reabrir este banco? Ele volta a "em andamento" e você poderá editar, incluir e excluir lançamentos.')) return
    salvarBancoDraft(raw.banco, 'rascunho', raw.nome, linhas, false)
    setMsg('Banco reaberto — edição liberada.')
  }
  // Continua um rascunho salvo (carrega as linhas para a tela).
  function continuarRascunho(conta) {
    const s = (est?.bancos || {})[conta]
    if (!s?.draft) return
    // Recupera o arquivo bruto salvo (se houver) para permitir "Ajustar leitura" sem reimportar.
    setRaw({ nome: s.doc || 'Rascunho', banco: conta, viaPerfil: true, resumo: true, arr: Array.isArray(s.arr) ? s.arr : undefined, catByRow: s.catByRow ?? null })
    setLinhas(s.draft); setSel(new Set()); setErro(''); setSaldoExtrato(s.saldoExtrato || ''); setCruza(s.cruza || null); setCruzaOpen(false); setColPicker(null); setCruzaArr(null)
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

  async function importar(file, bancoFixo, modoForcado) {
    if (!file) return
    setErro(''); setMsg('')
    try {
      if (modo === 'combinado' && !contas.length) { setErro('Cadastre as contas bancárias antes de importar uma planilha combinada.'); return }
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
      const catByRow = catByRowDeMerges(ws['!merges'], arr)
      // Preenche células mescladas (Data/Documento/Natureza) — sem isso as linhas "de baixo"
      // da mescla sobem sem data. Feito DEPOIS do catByRow (que usa as mesclas originais).
      expandirMerges(arr, ws['!merges'])
      // Extrato por banco: cada cliente exporta diferente → usa o perfil salvo;
      // se ainda não houver, abre o mapeamento (uma vez por cliente).
      if (modo === 'porBanco' && bancoFixo) {
        // SEMPRE abre a tela de configuração para o usuário CONFERIR se o sistema entendeu
        // as colunas (parte do perfil salvo, quando houver — é só conferir e confirmar).
        // Ao confirmar, importa (aplicarEProsseguir no onSalvar da tela).
        setCfg({ arr, catByRow, nome: file.name, banco: bancoFixo, perfil: perfilInicial(bancoFixo, arr), modo: modoForcado || null })
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
  // Ao definir a contrapartida na mão, o nível vira 'manual' (100% do usuário).
  const setLinha = (i, patch) => { if (concluido) return; setLinhas(ls => ls.map((l, j) => j === i ? { ...l, ...patch, ...('contra' in patch ? { contra_nivel: patch.contra ? 'manual' : '' } : {}) } : l)) }

  // Recalcula o cruzamento SÓ pelo lado importado (as linhas): o lado do extrato — saldos e
  // movimentos por dia — não muda quando você edita/exclui um lançamento. Por isso reaproveita
  // o `cruza` que já está na tela (não precisa do extrato cru), e funciona mesmo depois de
  // reabrir o banco (quando o arquivo cru do extrato não está mais carregado).
  function recomputarComLinhas(c, novas) {
    const extratoDia = new Map(), extMovDia = {}
    for (const d of c.dias) {
      if (d.ext != null) extratoDia.set(d.data, d.ext)
      if (d.extMov != null) extMovDia[d.data] = d.extMov
    }
    const movDia = {}
    for (const l of novas) { if (!l.data) continue; movDia[l.data] = (movDia[l.data] || 0) + (l.entrada ? l.valor : -l.valor) }
    const dias = [...new Set([...extratoDia.keys(), ...Object.keys(movDia)])].sort()
    let corrente = saldoAnterior || 0, prevDif = null, primeiroDiv = null
    const out = []
    for (const d of dias) {
      corrente += (movDia[d] || 0)
      const ext = extratoDia.has(d) ? extratoDia.get(d) : null
      const extMov = (d in extMovDia) ? extMovDia[d] : null
      const dif = ext == null ? null : Math.round((corrente - ext) * 100) / 100
      const delta = (dif == null || prevDif == null) ? null : Math.round((dif - prevDif) * 100) / 100
      if (delta != null && Math.abs(delta) >= 0.005 && !primeiroDiv) primeiroDiv = d
      out.push({ data: d, mov: movDia[d] || 0, calc: corrente, ext, extMov, dif, delta })
      if (dif != null) prevDif = dif
    }
    const difTotal = out.filter(d => d.dif != null).slice(-1)[0]?.dif ?? null
    return { dias: out, primeiroDiv, difTotal, temValor: c.temValor, extRowsDia: c.extRowsDia }
  }
  // Se há um cruzamento na tela, recalcula com as linhas novas — assim editar/excluir/corrigir
  // um lançamento atualiza o confronto Importado × Extrato na hora e o dia some quando zera.
  // Salva as linhas no rascunho do banco (mantém estado/doc atuais) e ressincroniza o
  // cruzamento — atualiza a tela E o rascunho salvo (para reabrir já consistente).
  function persistirLinhas(novas) {
    const novaCruza = cruza ? recomputarComLinhas(cruza, novas) : (cruza || null)
    if (novaCruza !== cruza) setCruza(novaCruza)
    if (raw?.banco) salvarBancoDraft(raw.banco, bancosEst[raw.banco]?.estado || 'rascunho', raw.nome, novas, undefined, novaCruza)
  }
  // Ações do cruzamento por REFERÊNCIA da linha (o modal tem o objeto, não o índice).
  function excluirLinhaRef(l) { const i = linhas.indexOf(l); if (i >= 0) excluirLinha(i) }
  function editarLinhaRef(l) { const i = linhas.indexOf(l); if (i >= 0) setEditLanc({ i, linha: l }) }
  function corrigirDataRef(l, data) { if (concluido) return; const i = linhas.indexOf(l); if (i < 0) return; const novas = linhas.map((x, j) => j === i ? { ...x, data } : x); setLinhas(novas); persistirLinhas(novas); setMsg('Data do lançamento corrigida.') }
  // Exclui um lançamento (com confirmação) — para corrigir direto antes de gerar.
  function excluirLinha(i) {
    if (concluido) return
    if (!window.confirm('Tem certeza que deseja excluir este lançamento?')) return
    const novas = linhas.filter((_, j) => j !== i)
    setLinhas(novas); setSel(new Set()); persistirLinhas(novas)
    setMsg('Lançamento excluído.')
  }
  // Inclui um lançamento manual (confirmado no modal) — ex.: um que faltou.
  // Salva a edição de um lançamento inteiro (data/histórico/valor/E-S/contrapartida).
  function salvarEdicaoLanc(i, patch) {
    if (concluido) return
    const novas = linhas.map((l, j) => j === i ? { ...l, ...patch } : l)
    setLinhas(novas); persistirLinhas(novas); setEditLanc(null)
    setMsg('Lançamento atualizado.')
  }
  function adicionarLinha(nova) {
    if (concluido) return
    const novas = [...linhas, nova]
    setLinhas(novas); persistirLinhas(novas); setNovoLanc(false)
    setMsg('Lançamento incluído.')
  }

  // Filtros da tabela de classificação + preenchimento em lote.
  const dataBR = iso => iso ? iso.split('-').reverse().join('/') : ''
  const normTxt = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  // Nível de confiança da classificação (cor + rótulo).
  const nivelCor = n => n === 'alta' ? theme.green : n === 'media' ? theme.yellow : n === 'manual' ? theme.accent : theme.sub
  const nivelLabel = n => n === 'alta' ? 'Confiança alta (memória)' : n === 'media' ? 'Confiança média — confira' : n === 'manual' ? 'Definido manualmente' : 'Sem classificação'
  function linhaVisivel(l) {
    if (fSem && l.contra) return false
    if (fNivel === 'sem') { if (l.contra) return false }
    else if (fNivel) { if (!l.contra || (l.contra_nivel || 'manual') !== fNivel) return false }
    if (fHist) {
      const h = normTxt(l.historico), q = normTxt(fHist)
      if (fMode === 'exato' ? h !== q : !h.includes(q)) return false
    }
    if (fSemData && l.data) return false
    if (fData && !dataBR(l.data).includes(fData.trim())) return false
    if (fES && (fES === 'entrada') !== !!l.entrada) return false
    if (fConta && String(l.contra || '').trim() !== String(fConta).trim()) return false
    if (fNome.trim()) {
      const nomeConta = normTxt(planoMap[String(l.contra || '').trim()]?.nome || '')
      const has = nomeConta.includes(normTxt(fNome.trim()))
      if (fNomeMode === 'naocontem' ? has : !has) return false
    }
    return true
  }
  const toggleUm = i => setSel(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n })
  // Saldo de abertura do banco para conferir o extrato — o MESMO da conciliação
  // (montarBalancete faz o arrasto do mês anterior), não a tabela crua (saldo_inicial 0).
  async function carregarSaldoAnterior(banco) {
    const [mes, ano] = (competencia || '').split('/').map(Number)
    const { data: comp } = await supabase.from('competencias').select('id').eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
    if (!comp) { setSaldoAnterior(null); return }
    const { linhas } = await montarBalancete(empresaId, comp.id, 0, { comLancamentos: true })
    const l = (linhas || []).find(x => String(x.reduzido) === String(banco))
    setSaldoAnterior(l ? Number(l.saldo_inicial) : null)
  }
  useEffect(() => { setColPicker(null); setCruzaArr(null); if (raw?.banco) carregarSaldoAnterior(raw.banco); else { setSaldoAnterior(null); setSaldoExtrato(''); setCruza(null); setCruzaOpen(false) } }, [raw?.banco, competencia]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cruza os lançamentos classificados com o extrato do banco (saldos diários) para
  // achar o dia onde começa a diferença. O sinal é a MUDANÇA da diferença de um dia
  // para o outro (independe do saldo de abertura estar alinhado).
  // Monta o cruzamento por dia a partir das linhas cruas do extrato + o mapa de colunas.
  // Guarda também as linhas do extrato por dia (extRowsDia) para o confronto por lançamento.
  function computarCruza(arr, mapa, linhasArg = linhas) {
    const rows = arr.slice(mapa.linhaInicio).filter(r => r.some(c => c !== '' && c != null))
    const temCol = mapa.colValor != null && mapa.colValor >= 0
    const extratoDia = new Map(), extMovDia = {}, extRowsDia = {}
    // Sem coluna de Valor, o movimento de cada linha é DERIVADO da variação do saldo
    // (saldo desta linha − saldo da anterior). Assim o confronto por lançamento funciona
    // mesmo em extratos que só têm a coluna de Saldo.
    let prevSaldo = saldoAnterior != null ? saldoAnterior : null, algumValor = false
    for (const r of rows) {
      const d = dataISO(r[mapa.colData]); if (!d) continue
      const sld = parseValor(r[mapa.colSaldo])
      extratoDia.set(d, sld) // saldo de fim de dia = último por data
      const val = temCol ? parseValor(r[mapa.colValor]) : (prevSaldo != null ? Math.round((sld - prevSaldo) * 100) / 100 : null)
      prevSaldo = sld
      if (val != null) { algumValor = true; extMovDia[d] = (extMovDia[d] || 0) + val }
      ;(extRowsDia[d] = extRowsDia[d] || []).push({ saldo: sld, valor: val })
    }
    const temValor = temCol || algumValor
    // movimento por dia a partir da classificação (o que foi importado)
    const movDia = {}
    for (const l of linhasArg) { if (!l.data) continue; movDia[l.data] = (movDia[l.data] || 0) + (l.entrada ? l.valor : -l.valor) }
    const dias = [...new Set([...extratoDia.keys(), ...Object.keys(movDia)])].sort()
    let corrente = saldoAnterior || 0, prevDif = null, primeiroDiv = null
    const out = []
    for (const d of dias) {
      corrente += (movDia[d] || 0)
      const ext = extratoDia.has(d) ? extratoDia.get(d) : null
      const extMov = temValor && (d in extMovDia) ? extMovDia[d] : null
      const dif = ext == null ? null : Math.round((corrente - ext) * 100) / 100
      const delta = (dif == null || prevDif == null) ? null : Math.round((dif - prevDif) * 100) / 100
      if (delta != null && Math.abs(delta) >= 0.005 && !primeiroDiv) primeiroDiv = d
      out.push({ data: d, mov: movDia[d] || 0, calc: corrente, ext, extMov, dif, delta })
      if (dif != null) prevDif = dif
    }
    const difTotal = out.filter(d => d.dif != null).slice(-1)[0]?.dif ?? null
    return { dias: out, primeiroDiv, difTotal, temValor, extRowsDia }
  }

  // Sobe o extrato: resolve as colunas (mapa salvo do banco → auto → "Ajustar colunas") e
  // cruza. `mapaForcado` vem do modal de ajuste de colunas.
  async function cruzarSaldos(file, mapaForcado) {
    if (!file) return
    setErro('')
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
      setCruzaArr(arr)
      const saved = perfilDeBanco(raw?.banco)?.cruza
      const mapa = mapaForcado || (mapaExtratoValido(saved, arr) ? saved : null) || autoMapaExtrato(arr)
      if (!mapa) { setColPicker({ arr }); return } // não achou Data/Saldo → deixa o usuário mapear
      setCruza(computarCruza(arr, mapa)); setCruzaOpen(true); setColPicker(null)
      // aprende o mapa de colunas do extrato no perfil do banco → mês que vem lê sozinho
      if (raw?.banco) { const p = perfilDeBanco(raw.banco) || {}; salvarPerfil({ ...p, cruza: mapa }, raw.banco) }
    } catch (e) { setErro('Não consegui ler o extrato: ' + e.message) }
  }
  // Aplica o mapa escolhido no "Ajustar colunas" (sem reler o arquivo — usa o arr já lido).
  function aplicarColunasExtrato(mapa) {
    const arr = cruzaArr || colPicker?.arr
    if (!arr) { setColPicker(null); return }
    setCruza(computarCruza(arr, mapa)); setCruzaOpen(true); setColPicker(null)
    if (raw?.banco) { const p = perfilDeBanco(raw.banco) || {}; salvarPerfil({ ...p, cruza: mapa }, raw.banco) }
  }
  // Divide um lançamento em vários (ex.: 1 DARF → 3 lançamentos contábeis).
  function confirmarQuebra(i, partes) {
    if (concluido) return
    const base = linhas[i]
    const novas = partes.map(p => ({ ...base, valor: Math.abs(Number(p.valor) || 0), contra: String(p.contra || '').trim(), contra_nivel: String(p.contra || '').trim() ? 'manual' : '' }))
    setLinhas(ls => [...ls.slice(0, i), ...novas, ...ls.slice(i + 1)])
    setSel(new Set()); setQuebra(null)
    setMsg(`Lançamento dividido em ${novas.length}.`)
  }
  function aplicarLote() {
    if (concluido) return
    const cod = String(lote || '').trim()
    if (!cod) { setMsg('Informe a conta para aplicar em lote.'); return }
    if (!sel.size) { setMsg('Selecione as linhas (caixas à esquerda) para aplicar a conta.'); return }
    const n = sel.size
    setLinhas(ls => ls.map((l, j) => sel.has(j) ? { ...l, contra: cod, contra_nivel: 'manual' } : l))
    // Volta ao estado original para a próxima aplicação: limpa filtro, seleção e conta.
    setSel(new Set()); setLote(''); setFSem(false); setFHist(''); setFData(''); setFES(''); setFConta('')
    setMsg(`Conta ${cod} aplicada em ${n} linha(s). Pronto para a próxima seleção.`)
  }
  // Exclui em lote os lançamentos selecionados desta importação (ex.: linhas que não
  // devem ir para a contabilização). Some do rascunho; não afeta o extrato original.
  function excluirLote() {
    if (concluido) return
    if (!sel.size) { setMsg('Selecione as linhas (caixas à esquerda) para excluir.'); return }
    const n = sel.size
    if (!window.confirm(`Excluir ${n} lançamento(s) selecionado(s) desta importação? Eles não vão para a contabilização.`)) return
    setLinhas(ls => ls.filter((_, j) => !sel.has(j)))
    setSel(new Set())
    setMsg(`${n} lançamento(s) excluído(s) da importação.`)
  }

  // Aprende: guarda HISTÓRICO → contrapartida das linhas classificadas (o histórico já
  // traz a descrição/entidade). Antes usava `credor || historico`, e um credor mal
  // mapeado (ex.: coluna C/D = "D") fazia aprender o termo "D" — que é rejeitado, então
  // nada era salvo. Aprende tanto as que a memória trouxe quanto as que você preencheu.
  async function aprenderSalvar() {
    const novas = linhas.filter(l => l.contra && l.historico).map(l => ({ historico: l.historico, conta: l.contra }))
    if (!novas.length) { setMsg('Classifique ao menos uma linha (contrapartida) antes de salvar.'); return }
    const mem = aprender(memoria, novas)
    await salvarMemoria(mem, { nomeArquivo: memMeta.nomeArquivo, semCarga: false })
    // Com o novo aprendizado, tenta classificar as linhas que ainda estão SEM contrapartida.
    // Não aplica na hora — mostra para o usuário confirmar (pode não estar de acordo).
    const achados = []
    linhas.forEach((l, i) => {
      if (l.contra) return
      const cod = casarHistorico(l.historico, mem)
      if (cod) achados.push({ i, historico: l.historico, valor: l.valor, entrada: l.entrada, data: l.data, contra: cod })
    })
    if (achados.length && !concluido) {
      setSugAprend({ itens: achados, aprendidas: novas.length })
      setMsg(`Memória atualizada (${novas.length} aprendida(s)). Encontrei ${achados.length} lançamento(s) que este aprendizado também classifica — confirme abaixo.`)
    } else {
      setMsg(`Memória atualizada — ${novas.length} classificação(ões) aprendida(s).`)
    }
  }
  // Aplica as sugestões que o usuário confirmou (após "Aprender e salvar").
  function aplicarSugestoes(itensConfirmados) {
    if (concluido || !itensConfirmados?.length) { setSugAprend(null); return }
    const mapa = {}; for (const it of itensConfirmados) mapa[it.i] = it.contra
    const novas = linhas.map((l, j) => mapa[j] != null ? { ...l, contra: mapa[j], contra_nivel: 'manual' } : l)
    setLinhas(novas); persistirLinhas(novas); setSugAprend(null)
    setMsg(`${Object.keys(mapa).length} lançamento(s) classificado(s) pelo aprendizado.`)
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
      // Reconhece tanto o layout Domínio ("Complemento Histórico" + "Cód. Conta Débito/
      // Crédito") quanto a base simples ("DATA;DEBITO;CREDITO;VALOR;HIST").
      const iHist = achaColuna(header, /complement|hist|descri|memo/)
      const iDeb = achaColuna(header, /debito/)
      const iCred = achaColuna(header, /credito/)
      const iVal = achaColuna(header, /valor|montante/)
      const novas = []
      if (iHist >= 0 && iDeb >= 0 && iCred >= 0) {
        const rows = arr.slice(1).filter(r => r.some(c => c !== '' && c != null))
        // Banco = contas cadastradas E TAMBÉM o código mais frequente nas colunas D/C: numa
        // base bancária o banco é sempre um dos lados, então aparece em quase toda linha.
        // A contrapartida é o lado que NÃO é o banco (regra robusta — o sinal do VALOR nesta
        // base é inconsistente: o mesmo pagamento aparece + num mês e − no outro).
        // Entrada: banco no débito → contrapartida é o CRÉDITO (col C).
        // Saída:   banco no crédito → contrapartida é o DÉBITO (col B).
        const bancos = new Set(contas.map(c => String(c.conta_contabil).trim()).filter(Boolean))
        const freq = {}
        for (const r of rows) for (const i of [iDeb, iCred]) { const v = String(r[i] ?? '').trim(); if (v) freq[v] = (freq[v] || 0) + 1 }
        const top = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]
        if (top && top[1] >= rows.length * 0.4) bancos.add(top[0]) // aparece em ≥40% das linhas → é o banco
        for (const r of rows) {
          const h = String(r[iHist] ?? '').trim()
          const d = String(r[iDeb] ?? '').trim(), c = String(r[iCred] ?? '').trim()
          if (!h) continue
          const contra = bancos.has(d) ? c : bancos.has(c) ? d : ''
          const ent = extrairEntidade(h)
          const catBase = String(h).split(/\s-\s/)[0]
          // Nunca aprende o BANCO como contrapartida; pula adiantamento (contextual).
          if (contra && !bancos.has(contra) && ent && !adiantContas.has(String(contra)) && !/adiant/i.test(catBase)) novas.push({ historico: ent, conta: contra })
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
      ...(usaCC ? [{ nome: 'Centro de Custo', largura: 16 }] : []),
    ]
    const rows = linhas.map(l => [
      l.data ? l.data.split('-').reverse().join('/') : '', `${l.banco || ''} ${nomeBanco(l.banco)}`.trim(),
      l.historico || '', Number(l.valor) || 0, l.entrada ? 'Entrada' : 'Saída',
      l.contra || '', planoMap[String(l.contra)]?.nome || (l.contra ? '(fora do plano)' : ''),
      ...(usaCC ? [l.centro_custo || ''] : []),
    ])
    await gerarExcelTimbrado({
      titulo: `Financeiro classificado · ${competencia}`, sub: `${linhas.length} lançamento(s)`,
      colunas: cols, linhas: rows, totais: null, arquivo: `financeiro_classificado_${competencia.replace('/', '-')}.xlsx`, aba: 'Lançamentos',
    })
  }

  // Gera a partida completa para o Domínio (banco + contrapartida, por entrada/saída).
  function gerar() {
    if (!concluido) { setErro('Conclua o banco antes de gerar o arquivo do Domínio.'); return }
    const prontasL = linhas.filter(l => l.banco && l.contra && l.valor > 0)
    if (!prontasL.length) { setErro('Nenhuma linha com banco e contrapartida para gerar.'); return }
    const semData = prontasL.filter(l => !l.data).length
    if (semData && !window.confirm(`Atenção: ${semData} lançamento(s) SEM DATA vão sair sem data no arquivo do Domínio. Gerar assim mesmo? (recomendo entrar no lançamento e informar a data antes)`)) return
    // Centro de custo obrigatório na contrapartida de resultado — avisa antes de gerar.
    const semCC = usaCC ? prontasL.filter(ccPendente).length : 0
    if (semCC && !window.confirm(`Atenção: ${semCC} lançamento(s) de RESULTADO sem centro de custo. Gerar assim mesmo? (o Domínio vai receber sem CC nesses)`)) return
    const lanc = prontasL.map(l => ({
      data: l.data || null,
      conta_debito: l.entrada ? l.banco : l.contra,   // entrada: D banco; saída: D contrapartida
      conta_credito: l.entrada ? l.contra : l.banco,
      valor: l.valor,
      historico: l.historico,
      // CC vai no lado da contrapartida (débito na saída, crédito na entrada).
      cc_debito: (usaCC && !l.entrada) ? (l.centro_custo || '') : '',
      cc_credito: (usaCC && l.entrada) ? (l.centro_custo || '') : '',
    }))
    gerarDominioCSV(lanc, `financeiro_dominio_${competencia.replace('/', '-')}.csv`)
  }

  // Gera UM único arquivo do Domínio com TODOS os bancos (drafts salvos de cada banco),
  // para importar de uma vez só. Usa o que já foi classificado em cada banco.
  function gerarTodos() {
    const bancosSt = est?.bancos || {}
    const lanc = []
    for (const [, s] of Object.entries(bancosSt)) {
      // Só entram bancos CONCLUÍDOS (para gerar, o banco tem que estar concluído).
      if (!s?.concluido || !Array.isArray(s?.draft)) continue
      for (const l of s.draft) {
        if (!(l.banco && l.contra && Number(l.valor) > 0)) continue
        lanc.push({
          data: l.data || null,
          conta_debito: l.entrada ? l.banco : l.contra,
          conta_credito: l.entrada ? l.contra : l.banco,
          valor: l.valor, historico: l.historico,
          cc_debito: (usaCC && !l.entrada) ? (l.centro_custo || '') : '',
          cc_credito: (usaCC && l.entrada) ? (l.centro_custo || '') : '',
        })
      }
    }
    if (!lanc.length) { setErro('Nenhum banco CONCLUÍDO para gerar. Conclua os bancos antes.'); return }
    const semData = lanc.filter(l => !l.data).length
    if (semData && !window.confirm(`Atenção: ${semData} lançamento(s) SEM DATA vão sair sem data. Gerar assim mesmo?`)) return
    gerarDominioCSV(lanc, `financeiro_dominio_TODOS_${competencia.replace('/', '-')}.csv`)
    setErro(''); setMsg(`Arquivo do Domínio gerado com ${lanc.length} lançamento(s) de todos os bancos.`)
  }
  // Total de lançamentos prontos somando todos os bancos (para o botão "todos").
  const prontasTodos = Object.values(est?.bancos || {}).reduce((n, s) => n + (s?.concluido && Array.isArray(s?.draft) ? s.draft.filter(l => l.banco && l.contra && Number(l.valor) > 0).length : 0), 0)

  const prontas = linhas.filter(l => l.banco && l.contra && l.valor > 0).length
  const semContra = linhas.filter(l => !l.contra).length
  const nAlta = linhas.filter(l => l.contra && (l.contra_nivel || 'manual') === 'alta').length
  const nMedia = linhas.filter(l => l.contra && l.contra_nivel === 'media').length
  const totEnt = linhas.filter(l => l.entrada).reduce((s, l) => s + (l.valor || 0), 0)
  const totSai = linhas.filter(l => !l.entrada).reduce((s, l) => s + (l.valor || 0), 0)
  const saldoFinal = (saldoAnterior || 0) + totEnt - totSai
  const temExtrato = String(saldoExtrato).trim() !== ''
  const difSaldo = Math.round((saldoFinal - parseValor(saldoExtrato)) * 100) / 100
  const visiveis = linhas.map((l, i) => ({ l, i })).filter(({ l }) => linhaVisivel(l))
  // Totalizador do que está filtrado (útil ao filtrar por dia): quanto de + e de −.
  const filtroAtivo = fSem || fSemData || !!fHist || !!fData || !!fES || !!fConta || !!fNivel || !!fNome.trim()
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
            <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 12, marginBottom: 14 }}>
              {contas.map(c => {
                const s = bancosEst[c.conta_contabil]
                const quem = s?.usuario ? ` · por ${String(s.usuario).split('@')[0]}` : ''
                const done = s?.concluido === true, semMov = s?.estado === 'sem_movimento'
                const andamento = !done && !semMov && (s?.estado === 'rascunho' || s?.estado === 'validado' || !!s?.draft)
                const cor = done ? theme.green : semMov ? theme.sub : andamento ? theme.yellow : theme.red
                const txt = done ? `Concluído${s.doc ? ` · ${s.doc}` : ''}` : semMov ? 'Sem movimento no mês' : andamento ? `Em andamento${quem}${s.draft ? ` · ${s.draft.length} lançto(s)` : ''}` : 'Pendente'
                const icon = done ? 'ti-circle-check' : semMov ? 'ti-circle-minus' : andamento ? 'ti-progress' : 'ti-alert-triangle'
                return (
                  <div key={c.conta_contabil} style={{ background: theme.card, border: `1px solid ${semMov ? theme.cb : cor}`, borderRadius: 12, padding: 14 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <i className="ti ti-building-bank" style={{ color: theme.accent }} />
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{c.conta_contabil} · {nomeBanco(c.conta_contabil)}</span>
                    </div>
                    <p style={{ fontSize: 12, color: cor, margin: '0 0 10px', fontWeight: 500 }}><i className={`ti ${icon}`} /> {txt}</p>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {s?.draft && <button className="btn" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => continuarRascunho(c.conta_contabil)}><i className="ti ti-player-play" /> Continuar</button>}
                      {(() => { const temLanc = (s?.draft?.length || 0) > 0 || s?.estado === 'validado'; return (
                      <label className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', cursor: 'pointer' }} title={temLanc ? 'Trocar por outro extrato (substitui os lançamentos atuais)' : 'Importar o extrato deste banco'}>
                        <i className="ti ti-cloud-upload" /> {temLanc ? 'Substituir arquivo' : 'Importar extrato'}
                        <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importar(f, c.conta_contabil, temLanc ? 'substituir' : null) }} />
                      </label>
                      ) })()}
                      {(s?.draft?.length || 0) > 0 && !done && (
                        <label className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', cursor: 'pointer', color: theme.green, borderColor: theme.green }} title="Somar os lançamentos de OUTRO arquivo aos que já estão neste banco (ex.: 2º extrato do mês). Não apaga nada.">
                          <i className="ti ti-plus" /> Importar complemento
                          <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importar(f, c.conta_contabil, 'complementar') }} />
                        </label>
                      )}
                      <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => marcarBanco(c.conta_contabil, 'sem_movimento')}><i className="ti ti-circle-minus" /> Sem movimento</button>
                      {s?.estado && <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: theme.sub }} onClick={() => marcarBanco(c.conta_contabil, null)}>limpar</button>}
                      {isAdmin && <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: theme.red, borderColor: theme.red }} onClick={() => excluirBanco(c)}><i className="ti ti-trash" /> Excluir banco</button>}
                    </div>
                  </div>
                )
              })}
            </div>
            {prontasTodos > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14, padding: '10px 12px', background: theme.input, borderRadius: 8 }}>
                <i className="ti ti-files" style={{ color: theme.accent }} />
                <span style={{ fontSize: 12.5, color: theme.sub, flex: 1, minWidth: 200 }}>Gere <b style={{ color: theme.text }}>um único arquivo</b> do Domínio com os <b style={{ color: theme.text }}>bancos concluídos</b> ({prontasTodos} lançamento(s)) para importar de uma vez.</span>
                <button className="btn" style={{ fontSize: 12.5 }} onClick={gerarTodos}><i className="ti ti-file-export" /> Gerar Domínio — bancos concluídos</button>
              </div>
            )}
            </>
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
              {Array.isArray(raw.arr)
                ? <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => setCfg({ arr: raw.arr, catByRow: raw.catByRow, nome: raw.nome, banco: raw.banco, perfil: perfilInicial(raw.banco, raw.arr), modo: 'substituir' })}><i className="ti ti-adjustments" /> Ajustar leitura</button>
                : <label className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', cursor: 'pointer' }} title="Rascunho aberto sem o arquivo — reimporte o extrato para ajustar a leitura">
                    <i className="ti ti-adjustments" /> Ajustar leitura (reimportar)
                    <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => raw.banco && importar(e.target.files?.[0], raw.banco)} />
                  </label>}
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
            <button className={fSemData ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 12, padding: '5px 10px', ...(fSemData ? { background: theme.yellow, borderColor: theme.yellow } : { color: theme.yellow, borderColor: theme.yellow }) }} onClick={() => setFSemData(v => !v)} title="Mostrar só as linhas sem data (ex.: linhas de total do relatório)"><i className="ti ti-calendar-off" /> Sem data</button>
            <select className="input" style={{ maxWidth: 120, fontSize: 12, padding: '6px 8px' }} value={fES} onChange={e => setFES(e.target.value)}>
              <option value="">Entrada/Saída</option><option value="entrada">Só entradas</option><option value="saida">Só saídas</option>
            </select>
            <select className="input" style={{ maxWidth: 150, fontSize: 12, padding: '6px 8px' }} value={fNivel} onChange={e => setFNivel(e.target.value)} title="Filtrar por nível de confiança da classificação">
              <option value="">Confiança</option>
              <option value="alta">● Alta</option>
              <option value="media">● Média (confira)</option>
              <option value="manual">● Manual</option>
              <option value="sem">Sem contrapartida</option>
            </select>
            <CampoConta value={fConta} onChange={setFConta} placeholder="Filtrar conta (F4)" style={{ width: 170 }} />
            <input className="input" style={{ maxWidth: 170, fontSize: 12, padding: '6px 10px' }} placeholder="Nome da conta…" value={fNome} onChange={e => setFNome(e.target.value)} title="Filtra pelo nome da conta de contrapartida (do plano)" />
            <select className="input" style={{ maxWidth: 130, fontSize: 12, padding: '6px 8px' }} value={fNomeMode} onChange={e => setFNomeMode(e.target.value)} title="Contém / Não contém — pelo nome da conta">
              <option value="contem">Contém</option><option value="naocontem">Não contém</option>
            </select>
            {filtroAtivo && <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: theme.sub }} onClick={() => { setFSem(false); setFSemData(false); setFHist(''); setFData(''); setFES(''); setFConta(''); setFNivel(''); setFNome('') }}>limpar filtros</button>}
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 12, color: theme.sub }}>Aplicar às selecionadas:</span>
            <CampoConta value={lote} onChange={setLote} onEnter={aplicarLote} placeholder="Conta (F4)" style={{ width: 190 }} />
            {lote.trim() && <span style={{ fontSize: 11.5, maxWidth: 220, color: planoMap[String(lote).trim()]?.nome ? theme.green : theme.red }}>{planoMap[String(lote).trim()]?.nome || 'conta não encontrada'}</span>}
            <button className="btn" style={{ fontSize: 12, padding: '5px 10px' }} disabled={!sel.size || concluido} onClick={aplicarLote}><i className="ti ti-wand" /> Aplicar ({sel.size})</button>
            <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: theme.red, borderColor: theme.red }} disabled={!sel.size || concluido} onClick={excluirLote} title="Excluir as linhas selecionadas desta importação (não vão para a contabilização)"><i className="ti ti-trash" /> Excluir ({sel.size})</button>
          </div>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12.5, margin: '0 0 6px' }}>
            <span style={{ color: theme.green }}><b>{prontas}</b> pronta(s) p/ contabilizar</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: theme.sub }} title="Classificadas pela memória com confiança alta"><span style={{ width: 8, height: 8, borderRadius: '50%', background: theme.green }} /><b style={{ color: theme.text }}>{nAlta}</b> alta</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: theme.sub }} title="Confiança média — vale conferir"><span style={{ width: 8, height: 8, borderRadius: '50%', background: theme.yellow }} /><b style={{ color: theme.text }}>{nMedia}</b> confira</span>
            <span style={{ color: theme.yellow }}><b>{semContra}</b> sem contrapartida</span>
            <span style={{ color: theme.sub }}>mostrando <b>{visiveis.length}</b> de {linhas.length}{sel.size ? ` · ${sel.size} selecionada(s)` : ''}</span>
            {filtroAtivo && <span style={{ color: theme.sub }}>{fData ? `dia ${fData}: ` : 'filtro: '}<b style={{ color: theme.green }}>+{money(totVisEnt)}</b> · <b style={{ color: theme.red }}>−{money(totVisSai)}</b> · líquido <b style={{ color: theme.text }}>{money(totVisEnt - totVisSai)}</b></span>}
            {sel.size > 0 && <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: '3px 8px', color: theme.sub }} onClick={() => setSel(new Set())}>limpar seleção</button>}
            <span style={{ flex: 1 }} />
            <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: '3px 9px' }} disabled={concluido} onClick={() => setNovoLanc(true)}><i className="ti ti-plus" /> Incluir lançamento</button>
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
            {cruzaArr && <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: '4px 9px' }} onClick={() => setColPicker({ arr: cruzaArr })} title="Escolher manualmente quais colunas do extrato são Data, Saldo e Valor"><i className="ti ti-columns" /> Ajustar colunas</button>}
          </div>
          {saldoAnterior == null && <p style={{ color: theme.yellow, fontSize: 11.5, margin: '-4px 0 10px' }}>Saldo anterior indisponível (balancete da competência não importado) — o saldo final considera abertura zero.</p>}

          {concluido && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(48,164,108,0.10)', border: `1px solid ${theme.green}`, borderRadius: 10, padding: '10px 14px', margin: '0 0 10px' }}>
              <i className="ti ti-lock" style={{ color: theme.green, fontSize: 18 }} />
              <span style={{ fontSize: 12.5, color: theme.text, flex: 1 }}><b>Banco concluído.</b> Não é possível alterar, incluir ou excluir lançamentos. Clique em <b>Reabrir banco</b> para editar.</span>
              <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: '4px 10px', color: theme.yellow, borderColor: theme.yellow }} onClick={reabrirBanco}><i className="ti ti-lock-open" /> Reabrir banco</button>
            </div>
          )}

          {/* Tabela de classificação */}
          <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto', maxHeight: 460 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820 }}>
              <thead>
                <tr style={{ background: theme.input, position: 'sticky', top: 0 }}>
                  <th style={{ ...fth, width: 34, textAlign: 'center' }}><input type="checkbox" checked={todosSel} onChange={toggleTodos} title="Selecionar os visíveis" /></th>
                  <th style={fth}>Data</th><th style={fth}>Banco</th><th style={fth}>Histórico</th><th style={{ ...fth, textAlign: 'right' }}>Valor</th><th style={fth}>E/S</th><th style={fth}>Contrapartida</th><th style={fth}>Conta (nome)</th>{usaCC && <th style={fth}>C. Custo</th>}
                </tr>
              </thead>
              <tbody>
                {visiveis.map(({ l, i }, pos) => (
                  <tr key={i} style={{ borderTop: `1px solid ${theme.border}`, background: sel.has(i) ? 'rgba(74,124,255,0.10)' : !l.banco ? 'rgba(245,166,35,0.06)' : 'transparent' }}>
                    <td style={{ ...ftd, textAlign: 'center' }}><input type="checkbox" checked={sel.has(i)} onChange={() => toggleUm(i)} /></td>
                    <td style={{ ...ftd, fontSize: 11.5, whiteSpace: 'nowrap', color: theme.sub }}>{dataBR(l.data) || '—'}</td>
                    <td style={{ ...ftd, fontSize: 11.5 }}>{l.banco ? `${l.banco} · ${nomeBanco(l.banco)}` : <span style={{ color: theme.yellow }}>sem banco</span>}</td>
                    <td style={{ ...ftd, minWidth: 420 }}>
                      <input className="input" style={{ fontSize: 11.5, padding: '4px 7px', width: '100%', minWidth: 400 }} value={l.historico || ''} disabled={concluido} onChange={e => setLinha(i, { historico: e.target.value })} title={l.historico || 'Editar histórico'} />
                    </td>
                    <td style={{ ...ftd, textAlign: 'right', whiteSpace: 'nowrap' }}>{money(l.valor)}</td>
                    <td style={{ ...ftd }}>
                      <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px', color: l.entrada ? theme.green : theme.red, borderColor: l.entrada ? theme.green : theme.red }} disabled={concluido}
                        onClick={() => { if (window.confirm(`Trocar para ${l.entrada ? 'Saída' : 'Entrada'}? Isso inverte a contrapartida (D/C) deste lançamento.`)) setLinha(i, { entrada: !l.entrada }) }}>{l.entrada ? 'Entrada' : 'Saída'}</button>
                    </td>
                    <td style={{ ...ftd, minWidth: 180 }}>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        {l.contra && <span title={nivelLabel(l.contra_nivel)} style={{ width: 9, height: 9, borderRadius: '50%', background: nivelCor(l.contra_nivel), flexShrink: 0 }} />}
                        <div style={{ flex: 1 }}><ContraCell value={l.contra} disabled={concluido} onCommit={v => setLinha(i, { contra: v })}
                          inputRef={el => { refsContra.current[pos] = el }} onEnter={() => refsContra.current[pos + 1]?.focus()} /></div>
                        {!concluido && <i className="ti ti-pencil" title="Editar o lançamento (data, histórico, valor…)" onClick={() => setEditLanc({ i, linha: l })} style={{ color: theme.accent, cursor: 'pointer', fontSize: 15, flexShrink: 0 }} />}
                        {!concluido && <i className="ti ti-arrows-split-2" title="Dividir em vários lançamentos" onClick={() => setQuebra({ i, linha: l })} style={{ color: theme.sub, cursor: 'pointer', fontSize: 16, flexShrink: 0 }} />}
                        {!concluido && <i className="ti ti-trash" title="Excluir lançamento" onClick={() => excluirLinha(i)} style={{ color: theme.red, cursor: 'pointer', fontSize: 15, flexShrink: 0 }} />}
                        {!l.data && <i className="ti ti-calendar-exclamation" title="Sem data — clique no lápis para informar antes de gerar o Domínio" style={{ color: theme.yellow, fontSize: 15, flexShrink: 0 }} />}
                      </div>
                    </td>
                    <td style={{ ...ftd, fontSize: 11.5, maxWidth: 220 }}>
                      {!l.contra ? <span style={{ color: theme.sub }}>—</span>
                        : planoMap[String(l.contra)]?.nome
                          ? <span style={{ color: theme.green }}>{planoMap[String(l.contra)].nome}</span>
                          : <span style={{ color: theme.red }}><i className="ti ti-alert-triangle" /> conta não encontrada no plano</span>}
                    </td>
                    {usaCC && (
                      <td style={{ ...ftd, minWidth: 116 }}>
                        <CampoCentroCusto value={l.centro_custo} centros={centros} disabled={concluido}
                          placeholder={ehResultadoContra(l.contra) ? 'obrigatório (F4)' : 'C.Custo (F4)'}
                          style={ccPendente(l) ? { outline: `1px solid ${theme.red}`, borderRadius: 6 } : undefined}
                          onChange={v => setLinha(i, { centro_custo: v })} />
                      </td>
                    )}
                  </tr>
                ))}
                {!visiveis.length && <tr><td colSpan={usaCC ? 9 : 8} style={{ ...ftd, color: theme.sub, fontSize: 12 }}>Nenhuma linha com os filtros atuais.</td></tr>}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            {raw.banco && <button className="btn btn-ghost" onClick={salvarRascunho}><i className="ti ti-device-floppy" /> Salvar e continuar depois</button>}
            {raw.banco && !concluido && (
              <label className="btn btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: theme.accent, borderColor: theme.accent }} title={linhas.length ? 'Trocar por outro arquivo deste banco (substitui os lançamentos atuais)' : 'Importar o extrato deste banco'}>
                <i className="ti ti-cloud-upload" /> {linhas.length ? 'Substituir arquivo' : 'Importar arquivo'}
                <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importar(f, raw.banco, linhas.length ? 'substituir' : null) }} />
              </label>
            )}
            {raw.banco && !concluido && linhas.length > 0 && (
              <label className="btn btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: theme.green, borderColor: theme.green }} title="Somar os lançamentos de OUTRO arquivo aos que já estão aqui (ex.: 2º extrato para fechar o mês). Não apaga nada.">
                <i className="ti ti-plus" /> Importar complemento
                <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importar(f, raw.banco, 'complementar') }} />
              </label>
            )}
            <button className="btn" onClick={aprenderSalvar}><i className="ti ti-brain" /> Aprender e salvar</button>
            {raw.banco && (concluido
              ? <button className="btn btn-ghost" style={{ color: theme.yellow, borderColor: theme.yellow }} onClick={reabrirBanco}><i className="ti ti-lock-open" /> Reabrir banco</button>
              : <button className="btn btn-ghost" style={{ color: theme.green, borderColor: theme.green }} disabled={!temExtrato || Math.abs(difSaldo) >= 0.005}
                  title={!temExtrato ? 'Informe o saldo do extrato para concluir.' : (Math.abs(difSaldo) >= 0.005 ? 'O saldo do extrato não confere — zere a diferença antes de concluir.' : '')}
                  onClick={concluirBanco}><i className="ti ti-circle-check" /> Concluir banco</button>)}
            <button className="btn btn-ghost" onClick={exportarExcel}><i className="ti ti-file-spreadsheet" /> Exportar Excel</button>
            <button className="btn btn-ghost" disabled={!concluido || !prontas || (temExtrato && Math.abs(difSaldo) >= 0.005)}
              title={!concluido ? 'Conclua o banco antes de gerar o arquivo do Domínio.' : (temExtrato && Math.abs(difSaldo) >= 0.005 ? 'O saldo do extrato ainda não confere — zere a diferença antes de gerar.' : '')}
              onClick={gerar}><i className="ti ti-file-export" /> Gerar arquivo do Domínio ({prontas})</button>
          </div>
          <p style={{ color: theme.sub, fontSize: 11.5, margin: '10px 0 0' }}>Preencha a contrapartida das linhas que faltam e clique em <b style={{ color: theme.text }}>Aprender e salvar</b> — no próximo mês elas já vêm classificadas. Entrada = D banco / C contrapartida; Saída = D contrapartida / C banco.</p>
        </>
      )}

      {quebra && (
        <ModalQuebra linha={quebra.linha} nomeBanco={nomeBanco} planoMap={planoMap}
          onClose={() => setQuebra(null)} onConfirmar={partes => confirmarQuebra(quebra.i, partes)} />
      )}

      {cruzaOpen && cruza && <ModalCruzaSaldo cruza={cruza} linhas={linhas} planoMap={planoMap} competencia={competencia} titulo={raw?.banco ? `${raw.banco} ${nomeBanco(raw.banco)}` : ''} onClose={() => setCruzaOpen(false)}
        onAjustarColunas={cruzaArr ? () => { setCruzaOpen(false); setColPicker({ arr: cruzaArr }) } : null}
        onCorrigirData={concluido ? null : corrigirDataRef} onExcluir={concluido ? null : excluirLinhaRef} onEditar={concluido ? null : editarLinhaRef}
        onVerDia={iso => { const p = String(iso).split('-'); setFData(`${p[2]}/${p[1]}`); setCruzaOpen(false) }} />}

      {colPicker && <ModalColunasExtrato arr={colPicker.arr} inicial={perfilDeBanco(raw?.banco)?.cruza || autoMapaExtrato(colPicker.arr)}
        onClose={() => setColPicker(null)} onAplicar={aplicarColunasExtrato} />}

      {novoLanc && <ModalNovoLancamento banco={raw?.banco} nomeBanco={nomeBanco} competencia={competencia} planoMap={planoMap}
        onClose={() => setNovoLanc(false)} onConfirmar={adicionarLinha} />}

      {sugAprend && <ModalSugestoes itens={sugAprend.itens} planoMap={planoMap}
        onClose={() => setSugAprend(null)} onConfirmar={aplicarSugestoes} />}

      {editLanc && <ModalEditarLanc linha={editLanc.linha} banco={raw?.banco} nomeBanco={nomeBanco} competencia={competencia} planoMap={planoMap}
        onClose={() => setEditLanc(null)} onSalvar={patch => salvarEdicaoLanc(editLanc.i, patch)} />}

      {cfg && (
        <PerfilExtratoCfg
          arr={cfg.arr} catByRow={cfg.catByRow} adiantContas={adiantContas} nome={cfg.nome} bancoNome={nomeBanco(cfg.banco)} bancoCod={cfg.banco} perfilInicial={cfg.perfil} memoria={memoria} usaCC={usaCC} centros={centros}
          onCancelar={() => setCfg(null)}
          onSalvar={async (perf) => { const m = cfg.modo; await salvarPerfil(perf, cfg.banco); setCfg(null); aplicarEProsseguir(cfg.arr, cfg.nome, cfg.banco, perf, cfg.catByRow, m) }}
        />
      )}

      {importPend && (
        <div onClick={() => setImportPend(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 70 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(480px,96vw)', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
            <h2 style={{ fontSize: 17, margin: '0 0 6px' }}>Já existe uma importação deste banco</h2>
            <p style={{ color: theme.sub, fontSize: 13, margin: '0 0 4px' }}>Este banco já tem <b style={{ color: theme.text }}>{importPend.atual}</b> lançamento(s). O novo arquivo tem <b style={{ color: theme.text }}>{importPend.qtd}</b>.</p>
            <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 16px' }}><b style={{ color: theme.text }}>Complementar</b> soma os novos aos que já estão (ex.: 2º arquivo para fechar o mês). <b style={{ color: theme.text }}>Substituir</b> troca tudo pelos do novo arquivo.</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-ghost" onClick={() => setImportPend(null)}>Cancelar</button>
              <button className="btn btn-ghost" style={{ color: theme.red, borderColor: theme.red }}
                onClick={() => { const p = importPend; setImportPend(null); aplicarEProsseguir(p.arr, p.nome, p.bancoFixo, p.perf, p.catByRow, 'substituir') }}>
                <i className="ti ti-refresh" /> Substituir
              </button>
              <button className="btn" onClick={() => { const p = importPend; setImportPend(null); aplicarEProsseguir(p.arr, p.nome, p.bancoFixo, p.perf, p.catByRow, 'complementar') }}>
                <i className="ti ti-plus" /> Complementar
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// Resultado do cruzamento do saldo diário calculado vs o saldo do extrato do banco.
// Além de apontar os dias que não bateram, tenta ser ASSERTIVO sobre o erro:
// casa a diferença do dia com um lançamento (valor exato ou E/S trocada) e
// detecta lançamento com data trocada (dois dias com diferença oposta e igual).
// "Ajustar colunas" do extrato do cruzamento: o usuário escolhe qual coluna é Data,
// Saldo e (opcional) Valor/movimento. Fica salvo por banco (perfil.cruza).
function ModalColunasExtrato({ arr, inicial, onAplicar, onClose }) {
  const nc = (arr || []).reduce((m, r) => Math.max(m, (r || []).length), 0)
  const [linhaInicio, setLinhaInicio] = useState(inicial?.linhaInicio ?? 1)
  const [colData, setColData] = useState(inicial?.colData ?? -1)
  const [colSaldo, setColSaldo] = useState(inicial?.colSaldo ?? -1)
  const [colValor, setColValor] = useState(inicial?.colValor ?? -1)
  const letra = i => { let s = '', n = Number(i); while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1 } return s }
  const header = arr[Math.max(0, linhaInicio - 1)] || []
  const amostra = c => { for (let i = linhaInicio; i < Math.min(arr.length, linhaInicio + 8); i++) { const v = arr[i]?.[c]; if (v !== '' && v != null) return String(v).slice(0, 20) } return '' }
  const opts = Array.from({ length: nc }, (_, i) => i)
  const rotulo = i => `${letra(i)}${header[i] ? ' · ' + String(header[i]).slice(0, 18) : ''}${amostra(i) ? '  (' + amostra(i) + ')' : ''}`
  const pode = colData >= 0 && colSaldo >= 0 && colData !== colSaldo
  const corCol = i => i === colData ? 'rgba(74,124,255,0.20)' : i === colSaldo ? 'rgba(48,164,108,0.18)' : i === colValor ? 'rgba(245,166,35,0.18)' : 'transparent'
  const preview = arr.slice(Math.max(0, linhaInicio - 1), linhaInicio + 6)
  const sel = (label, val, set, cor, comVazio) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: theme.sub, flex: 1, minWidth: 150 }}>
      <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: cor, marginRight: 5 }} />{label}</span>
      <select className="input" style={{ fontSize: 12, padding: '6px 8px' }} value={val} onChange={e => set(Number(e.target.value))}>
        <option value={-1}>{comVazio ? '— nenhuma —' : '— escolher —'}</option>
        {opts.map(i => <option key={i} value={i}>{rotulo(i)}</option>)}
      </select>
    </label>
  )
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 16, zIndex: 70 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(760px,96vw)', maxHeight: '90vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h2 style={{ fontSize: 16, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><i className="ti ti-columns" style={{ color: theme.accent }} /> Ajustar colunas do extrato</h2>
          <span onClick={onClose} style={{ cursor: 'pointer', color: theme.sub, fontSize: 20 }}><i className="ti ti-x" /></span>
        </div>
        <p style={{ fontSize: 12.5, color: theme.sub, margin: '0 0 14px' }}>Escolha qual coluna do extrato é a <b style={{ color: theme.text }}>Data</b>, o <b style={{ color: theme.text }}>Saldo</b> e (opcional) o <b style={{ color: theme.text }}>Valor/movimento</b>. Fica salvo por banco — no próximo mês já lê sozinho.</p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: theme.sub, width: 120 }}>
            <span>Dados começam na linha</span>
            <input className="input" type="number" min={1} style={{ fontSize: 12, padding: '6px 8px' }} value={linhaInicio} onChange={e => setLinhaInicio(Math.max(1, Number(e.target.value) || 1))} />
          </label>
          {sel('Data', colData, setColData, theme.accent, false)}
          {sel('Saldo', colSaldo, setColSaldo, theme.green, false)}
          {sel('Valor / movimento (opcional)', colValor, setColValor, theme.yellow, true)}
        </div>
        <div style={{ border: `0.5px solid ${theme.cb}`, borderRadius: 10, overflow: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 11.5 }}>
            <tbody>
              {preview.map((r, ri) => (
                <tr key={ri} style={{ borderTop: ri ? `1px solid ${theme.border}` : 'none' }}>
                  <td style={{ padding: '5px 8px', color: theme.sub, background: theme.input, position: 'sticky', left: 0, whiteSpace: 'nowrap' }}>{ri === 0 ? 'cabeçalho' : `linha ${linhaInicio + ri}`}</td>
                  {opts.map(ci => (
                    <td key={ci} style={{ padding: '5px 9px', whiteSpace: 'nowrap', background: corCol(ci), color: ri === 0 ? theme.text : theme.sub, fontWeight: ri === 0 ? 600 : 400, borderLeft: `1px solid ${theme.border}` }}>
                      {String(r[ci] ?? '').slice(0, 22) || '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!pode && <p style={{ color: theme.yellow, fontSize: 12, margin: '10px 0 0' }}><i className="ti ti-alert-triangle" /> Escolha as colunas de <b>Data</b> e <b>Saldo</b> (precisam ser diferentes) para continuar.</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn" disabled={!pode} onClick={() => onAplicar({ linhaInicio, colData, colSaldo, colValor: colValor >= 0 ? colValor : null })}><i className="ti ti-check" /> Aplicar e cruzar</button>
        </div>
      </div>
    </div>
  )
}

// Pareia os movimentos de um dia: Importado (imps=[{v,l}]) × Extrato (exts=[{v,saldo}]).
// exato 1:1 → soma (vários de um lado = 1 do outro) → quase-igual (centavos) → anula
// (+X/−X internos, sem extrato) → sobra (o que resta = diferença real). Retorna os grupos.
function pareardia(imps, exts) {
  const r2 = v => Math.round((v || 0) * 100) / 100
  const I = imps.map(x => ({ ...x, used: false }))
  const E = exts.map(x => ({ ...x, used: false }))
  const eqv = (a, b) => Math.abs(a - b) < 0.005
  const grupos = []
  for (const i of I) { if (i.used) continue; const e = E.find(e => !e.used && eqv(e.v, i.v)); if (e) { i.used = e.used = true; grupos.push({ imp: [i], ext: [e], dif: 0, tipo: 'exato' }) } }
  const subset = (pool, alvo) => { const livres = pool.filter(x => !x.used); let achou = null; const dfs = (st, sm, esc) => { if (achou) return; if (esc.length >= 2 && Math.abs(sm - alvo) < 0.005) { achou = esc.slice(); return } if (esc.length >= 4) return; for (let j = st; j < livres.length; j++) { esc.push(livres[j]); dfs(j + 1, sm + livres[j].v, esc); esc.pop(); if (achou) return } }; dfs(0, 0, []); return achou }
  for (const e of E) { if (e.used) continue; const s = subset(I, e.v); if (s) { e.used = true; s.forEach(x => x.used = true); grupos.push({ imp: s, ext: [e], dif: 0, tipo: 'soma' }) } }
  for (const i of I) { if (i.used) continue; const s = subset(E, i.v); if (s) { i.used = true; s.forEach(x => x.used = true); grupos.push({ imp: [i], ext: s, dif: 0, tipo: 'soma' }) } }
  for (const i of I) { if (i.used) continue; const c = E.filter(e => !e.used && Math.sign(e.v) === Math.sign(i.v)).map(e => ({ e, d: Math.abs(e.v - i.v) })).sort((a, b) => a.d - b.d)[0]; if (c && c.d <= 2) { i.used = c.e.used = true; grupos.push({ imp: [i], ext: [c.e], dif: r2(i.v - c.e.v), tipo: 'quase' }) } }
  const anular = (arr, lado) => { for (const p of arr) { if (p.used || p.v <= 0) continue; const q = arr.find(n => !n.used && n.v < 0 && Math.abs(n.v + p.v) < 0.005); if (q) { p.used = q.used = true; grupos.push({ imp: lado === 'i' ? [p, q] : [], ext: lado === 'e' ? [p, q] : [], dif: 0, tipo: 'anula' }) } } }
  anular(I, 'i'); anular(E, 'e')
  for (const i of I) if (!i.used) grupos.push({ imp: [i], ext: [], dif: i.v, tipo: 'sobra' })
  for (const e of E) if (!e.used) grupos.push({ imp: [], ext: [e], dif: -e.v, tipo: 'sobra' })
  return grupos
}

function ModalCruzaSaldo({ cruza, linhas, planoMap, competencia, titulo, onClose, onVerDia, onAjustarColunas, onCorrigirData, onExcluir, onEditar }) {
  const brd = iso => iso ? iso.split('-').reverse().join('/') : '—'
  const eps = v => Math.abs(v) < 0.005
  const r2 = v => Math.round((v || 0) * 100) / 100
  const divergentes = cruza.dias.filter(d => d.delta != null && Math.abs(d.delta) >= 0.005)
  const [soDif, setSoDif] = useState(divergentes.length > 0)
  // Abertura por dia: null | 'todos' (todos os lançamentos) | 'estrela' (só o suspeito).
  const [aberto, setAberto] = useState(() => (divergentes.length === 1 ? { [divergentes[0].data]: 'todos' } : {}))
  const abrir = (data, modo) => setAberto(p => ({ ...p, [data]: p[data] === modo ? null : modo }))

  // Pareamento Importado × Extrato por dia + detecção de DATA TROCADA entre dias: uma sobra
  // do extrato no dia X e uma sobra do importado no dia Y (mesmo valor) → o lançamento
  // provavelmente foi lançado na data errada (o banco registrou noutro dia).
  const analise = useMemo(() => {
    const porDia = {}, sobrasImp = [], sobrasExt = []
    for (const d of cruza.dias) {
      const doDia = linhas.filter(l => l.data === d.data)
      const impItems = doDia.map(l => ({ v: r2(l.entrada ? l.valor : -l.valor), l }))
      const extItems = (cruza.extRowsDia?.[d.data] || []).filter(x => x.valor != null && Math.abs(x.valor) >= 0.005).map(x => ({ v: r2(x.valor), saldo: x.saldo }))
      const grupos = cruza.temValor ? pareardia(impItems, extItems) : null
      porDia[d.data] = { grupos, impItems, extItems, doDia }
      if (grupos) for (const g of grupos) if (g.tipo === 'sobra') {
        if (g.imp.length) sobrasImp.push({ data: d.data, v: g.imp[0].v, l: g.imp[0].l })
        if (g.ext.length) sobrasExt.push({ data: d.data, v: g.ext[0].v })
      }
    }
    const trocas = [], usI = new Set()
    for (const se of sobrasExt) {
      const k = sobrasImp.findIndex((si, idx) => !usI.has(idx) && si.data !== se.data && Math.abs(si.v - se.v) < 0.005)
      if (k >= 0) { usI.add(k); trocas.push({ v: se.v, diaExtrato: se.data, diaImportado: sobrasImp[k].data, l: sobrasImp[k].l }) }
    }
    return { porDia, trocas }
  }, [cruza, linhas]) // eslint-disable-line react-hooks/exhaustive-deps

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

  // Exporta o cruzamento para um Excel APRESENTÁVEL (papel timbrado), no mesmo formato
  // da tela: Importado × Extrato lado a lado, com a coluna Diferença e a situação de cada
  // par. Uma seção por dia com diferença (+ possíveis datas trocadas), pronto para enviar
  // ao cliente.
  async function exportar() {
    const situacao = g => g.tipo === 'exato' ? 'Bate' : g.tipo === 'soma' ? 'Soma bate' : g.tipo === 'quase' ? `Diferença de ${money(Math.abs(g.dif))} (centavos)` : g.tipo === 'anula' ? 'Anulado (lançamento + estorno, efeito zero)' : g.imp.length ? 'SEM PAR no extrato' : 'SEM PAR no importado'
    const contaNome = c => c ? `${c}${planoMap[String(c)]?.nome ? ' · ' + planoMap[String(c)].nome : ''}` : ''
    const secoes = []

    // Uma seção por dia com diferença: confronto Importado × Extrato como na tela.
    for (const d of divergentes) {
      const pd = analise.porDia[d.data] || {}
      const linhasSec = []
      linhasSec.push([`⚠ ${analisarDia(d).dica}`, '', '', '', ''])
      if (pd.grupos) {
        for (const g of pd.grupos) {
          const n = Math.max(g.imp.length, g.ext.length, 1)
          for (let k = 0; k < n; k++) {
            linhasSec.push([
              g.imp[k] ? g.imp[k].l.historico : '',
              g.imp[k] ? contaNome(g.imp[k].l.contra) : '',
              g.imp[k] ? r2(g.imp[k].v) : '',
              g.ext[k] ? r2(g.ext[k].v) : '',
              k === 0 ? (Math.abs(g.dif) < 0.005 ? situacao(g) : `${money(Math.abs(g.dif))} — ${situacao(g)}`) : '',
            ])
          }
        }
      } else {
        // Cruzamento antigo (sem valores do extrato por linha) — lista só o importado.
        for (const l of (pd.doDia || [])) linhasSec.push([l.historico, contaNome(l.contra), r2(l.entrada ? l.valor : -l.valor), '', ''])
        if (!(pd.doDia || []).length) linhasSec.push(['(nenhum lançamento classificado neste dia)', '', '', '', ''])
      }
      const totImp = r2((pd.impItems || []).reduce((s, x) => s + x.v, 0))
      const totExt = r2((pd.extItems || []).reduce((s, x) => s + x.v, 0))
      secoes.push({
        titulo: `${brd(d.data)}  —  diferença do dia ${money(d.delta)}`,
        linhas: linhasSec,
        totais: ['TOTAL DO DIA', '', totImp, totExt, `Diferença ${money(r2(totImp - totExt))}`],
      })
    }

    // Possíveis datas trocadas (o banco registrou noutro dia).
    if (analise.trocas.length) {
      secoes.push({
        titulo: 'Possíveis datas trocadas (lançado num dia, no extrato noutro)',
        linhas: analise.trocas.map(t => [t.l.historico, contaNome(t.l.contra), r2(t.v), '', `No extrato em ${brd(t.diaExtrato)} · lançado em ${brd(t.diaImportado)} → mover para ${brd(t.diaExtrato)}`]),
      })
    }

    if (!secoes.length) secoes.push({ titulo: 'Sem diferenças de movimento', linhas: [['Todos os dias bateram com o extrato.', '', '', '', '']] })

    const compBR = competencia ? String(competencia).split('-').reverse().join('/') : ''
    const slug = String(titulo || 'banco').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '')
    await gerarExcelTimbrado({
      titulo: `Cruzamento Importado × Extrato — ${titulo || 'Banco'}`,
      sub: `${compBR ? 'Competência ' + compBR + ' · ' : ''}Diferença total ${cruza.difTotal == null ? '—' : money(cruza.difTotal)} em ${divergentes.length} dia(s) · Importado = o que classificamos · Extrato = o arquivo do banco`,
      colunas: [
        { nome: 'Importado (histórico)', largura: 44, wrap: true },
        { nome: 'Contrapartida', largura: 26, wrap: true },
        { nome: 'Valor importado', alinhar: 'right', moeda: true, largura: 16 },
        { nome: 'Valor extrato', alinhar: 'right', moeda: true, largura: 16 },
        { nome: 'Diferença / situação', largura: 34, wrap: true },
      ],
      secoes,
      arquivo: `cruzamento_${slug}${compBR ? '_' + compBR.replace(/\//g, '-') : ''}.xlsx`,
      aba: 'Cruzamento',
    })
  }

  const linhasTabela = soDif ? divergentes : cruza.dias
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 16, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(720px,96vw)', maxHeight: '90vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 10 }}>
          <h2 style={{ fontSize: 16, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><i className="ti ti-file-search" style={{ color: theme.accent }} /> Importado × Extrato — por dia</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            {onAjustarColunas && <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: '4px 9px' }} onClick={onAjustarColunas} title="Escolher quais colunas do extrato são Data, Saldo e Valor"><i className="ti ti-columns" /> Ajustar colunas</button>}
            <span onClick={onClose} style={{ cursor: 'pointer', color: theme.sub, fontSize: 20 }}><i className="ti ti-x" /></span>
          </div>
        </div>
        <p style={{ fontSize: 13, margin: '0 0 12px', color: divergentes.length ? theme.red : theme.green }}>
          {divergentes.length
            ? <><i className="ti ti-alert-triangle" /> Diferença total <b>{cruza.difTotal == null ? '—' : money(cruza.difTotal)}</b> em <b>{divergentes.length}</b> dia(s). Os dias que bateram não aparecem — foque nos de baixo.</>
            : <><i className="ti ti-circle-check" /> Nenhuma divergência de movimento entre os dias. Se ainda há diferença, é no saldo de abertura.</>}
        </p>
        {divergentes.length > 0 && (
          (onEditar || onExcluir)
            ? <p style={{ fontSize: 11.5, margin: '-4px 0 12px', color: theme.sub, display: 'flex', alignItems: 'center', gap: 6 }}><i className="ti ti-info-circle" style={{ color: theme.accent }} /> Abra um dia em <b>confronto</b> e use os botões <i className="ti ti-pencil" style={{ color: theme.accent }} /> <b>editar</b> / <i className="ti ti-trash" style={{ color: theme.red }} /> <b>excluir</b> na coluna <b>Importado</b> para corrigir o lançamento na hora.</p>
            : <p style={{ fontSize: 11.5, margin: '-4px 0 12px', color: theme.yellow, display: 'flex', alignItems: 'center', gap: 6 }}><i className="ti ti-lock" /> Banco <b>concluído</b> — para editar ou excluir lançamentos aqui, feche e clique em <b>Reabrir banco</b> antes.</p>
        )}

        {/* Possível DATA TROCADA: o valor está no extrato num dia e foi classificado noutro.
            Oferece corrigir a data do lançamento para o dia em que o banco registrou. */}
        {analise.trocas.length > 0 && (
          <div style={{ marginBottom: 12, borderRadius: 10, background: 'rgba(245,166,35,0.08)', border: `0.5px solid rgba(245,166,35,0.35)`, padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: theme.text, marginBottom: 6 }}>
              <i className="ti ti-calendar-exclamation" style={{ color: theme.yellow }} /> <b>Provável data trocada</b> — o banco registrou noutro dia
            </div>
            {analise.trocas.map((t, ti) => (
              <div key={ti} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderTop: ti ? `1px solid ${theme.border}` : 'none', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, fontSize: 12, color: theme.sub, minWidth: 200 }}>
                  <b style={{ color: theme.text }}>{money(Math.abs(t.v))}</b> — no extrato em <b style={{ color: theme.green }}>{brd(t.diaExtrato)}</b>, mas o lançamento "{t.l.historico}" está em <b style={{ color: theme.red }}>{brd(t.diaImportado)}</b>.
                </div>
                {onCorrigirData && <button className="btn" style={{ fontSize: 11.5, padding: '4px 10px', whiteSpace: 'nowrap', flexShrink: 0 }} onClick={() => onCorrigirData(t.l, t.diaExtrato)} title={`Mudar a data do lançamento para ${brd(t.diaExtrato)}`}><i className="ti ti-calendar-check" /> Corrigir data → {brd(t.diaExtrato)}</button>}
              </div>
            ))}
          </div>
        )}

        {/* Análise por dia que não bateu: sugestão + confronto Importado × Extrato (expandível) */}
        {divergentes.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            {divergentes.map((d, i) => {
              const { dica } = analisarDia(d)
              const pd = analise.porDia[d.data] || {}
              const doDia = pd.doDia || []
              const modo = aberto[d.data]
              const contaNome = c => c ? `${c}${planoMap[String(c)]?.nome ? ' · ' + planoMap[String(c)].nome : ''}` : 'sem contrapartida'
              // Botões por lançamento na tela de revisão: editar (data/valor/E-S…) ou excluir.
              // Ficam num "chip" com borda para serem visíveis (antes eram ícones soltos que o
              // texto longo do histórico escondia).
              const acoesLanc = l => (onEditar || onExcluir) ? (
                <span style={{ display: 'inline-flex', gap: 2, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                  {onEditar && <button type="button" title="Editar o lançamento (data, valor, E/S, histórico…)" onClick={() => onEditar(l)} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 6, border: `1px solid ${theme.border}`, background: theme.input, color: theme.accent, cursor: 'pointer', fontSize: 14, padding: 0 }}><i className="ti ti-pencil" /></button>}
                  {onExcluir && <button type="button" title="Excluir este lançamento" onClick={() => onExcluir(l)} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 6, border: `1px solid ${theme.border}`, background: theme.input, color: theme.red, cursor: 'pointer', fontSize: 14, padding: 0 }}><i className="ti ti-trash" /></button>}
                </span>
              ) : null
              // Célula "Importado" com o histórico truncado à esquerda e os botões SEMPRE
              // visíveis à direita (fora do trecho que corta o texto).
              const celImportado = l => (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.historico}</span>
                  {acoesLanc(l)}
                </div>
              )
              const linhaLanc = l => (
                <tr key={l.historico + l.valor + l.entrada} style={{ borderTop: `1px solid ${theme.border}` }}>
                  <td style={{ ...ftd, fontSize: 11 }}>{celImportado(l)}</td>
                  <td style={{ ...ftd, fontSize: 11, textAlign: 'right', whiteSpace: 'nowrap', color: l.entrada ? theme.green : theme.red }}>{l.entrada ? '+' : '−'}{money(l.valor)}</td>
                  <td style={{ ...ftd, fontSize: 11, whiteSpace: 'nowrap', color: theme.sub }}>{contaNome(l.contra)}</td>
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
                      <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px', whiteSpace: 'nowrap' }} onClick={() => abrir(d.data, 'todos')}><i className={`ti ${modo ? 'ti-chevron-up' : 'ti-chevron-down'}`} /> confronto</button>
                      {onVerDia && <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px', whiteSpace: 'nowrap' }} onClick={() => onVerDia(d.data)} title="Filtrar a tabela por este dia"><i className="ti ti-filter" /> na tabela</button>}
                    </div>
                  </div>
                  {modo && (() => {
                    // Confronto lançamento a lançamento: usa o pareamento já calculado em `analise`
                    // (exato/soma/quase, estornos anulados). O que casa fica verde; o que sobra de
                    // cada lado fica vermelho (é a diferença real).
                    const extDia = pd.extItems || []
                    const impItems = pd.impItems || []
                    const totImp = r2(impItems.reduce((s, x) => s + x.v, 0))
                    const totExt = r2(extDia.reduce((s, x) => s + x.v, 0))
                    const difTot = r2(totImp - totExt)
                    // Cruzamento calculado numa versão antiga (sem os dados do extrato por
                    // linha) → orienta a recruzar para ver o confronto Importado × Extrato.
                    if (!cruza.temValor || !pd.grupos) {
                      return (
                        <div style={{ borderTop: `0.5px solid rgba(229,72,77,0.25)`, background: theme.card }}>
                          {!cruza.extRowsDia && <p style={{ color: theme.yellow, fontSize: 11.5, margin: 0, padding: '8px 11px', display: 'flex', gap: 6, alignItems: 'center' }}><i className="ti ti-refresh" /> Este cruzamento é de uma versão anterior. Clique em <b>Trocar extrato</b> e suba o extrato de novo para ver o confronto <b>Importado × Extrato</b> lado a lado.</p>}
                          {doDia.length === 0
                            ? <p style={{ color: theme.sub, fontSize: 11.5, margin: 0, padding: '8px 11px' }}>Nenhum lançamento classificado neste dia — provável lançamento faltando de {money(Math.abs(d.delta))}.</p>
                            : <table style={{ width: '100%', borderCollapse: 'collapse' }}><tbody>{doDia.map(linhaLanc)}</tbody></table>}
                        </div>
                      )
                    }
                    const gruposReais = pd.grupos.filter(g => g.tipo !== 'anula')
                    const anulaItens = pd.grupos.filter(g => g.tipo === 'anula').reduce((s, g) => s + g.imp.length + g.ext.length, 0)
                    const tintG = t => t === 'sobra' ? 'rgba(229,72,77,0.10)' : t === 'quase' ? 'rgba(245,166,35,0.12)' : 'rgba(48,164,108,0.09)'
                    const vlr = v => `${v >= 0 ? '+' : '−'}${money(Math.abs(v))}`
                    const corV = v => v >= 0 ? theme.green : theme.red
                    return (
                      <div style={{ borderTop: `0.5px solid rgba(229,72,77,0.25)`, background: theme.card }}>
                        {/* Totais do dia */}
                        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', padding: '8px 11px', fontSize: 11.5, borderBottom: `1px solid ${theme.border}`, background: theme.input }}>
                          <span style={{ color: theme.sub }}><i className="ti ti-file-import" style={{ color: theme.accent }} /> Importado <b style={{ color: theme.text }}>{money(totImp)}</b> ({impItems.length})</span>
                          <span style={{ color: theme.sub }}><i className="ti ti-file-dollar" style={{ color: theme.green }} /> Extrato <b style={{ color: theme.text }}>{money(totExt)}</b> ({extDia.length})</span>
                          <span style={{ marginLeft: 'auto', color: Math.abs(difTot) >= 0.005 ? theme.red : theme.green, fontWeight: 700 }}>{Math.abs(difTot) >= 0.005 ? <><i className="ti ti-alert-triangle" /> Diferença {money(difTot)}</> : <><i className="ti ti-circle-check" /> Bate</>}</span>
                        </div>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <thead><tr style={{ background: theme.card }}>
                            <th style={{ ...ftd, fontSize: 10, color: theme.accent, textTransform: 'uppercase', letterSpacing: .4, fontWeight: 700 }}>Importado</th>
                            <th style={{ ...ftd, fontSize: 10, textAlign: 'right', color: theme.accent }} />
                            <th style={{ ...ftd, fontSize: 10, color: theme.green, textTransform: 'uppercase', letterSpacing: .4, fontWeight: 700, borderLeft: `1px solid ${theme.border}` }}>Extrato</th>
                            <th style={{ ...ftd, width: 92, textAlign: 'right', fontSize: 10, textTransform: 'uppercase', letterSpacing: .4, fontWeight: 700, color: theme.sub, borderLeft: `1px solid ${theme.border}` }}>Diferença</th>
                          </tr></thead>
                          <tbody>
                            {gruposReais.map((g, gi) => {
                              const n = Math.max(g.imp.length, g.ext.length, 1)
                              return Array.from({ length: n }).map((_, k) => (
                                <tr key={gi + '-' + k} style={{ borderTop: k === 0 ? `1px solid ${theme.border}` : 'none', background: tintG(g.tipo) }}>
                                  <td style={{ ...ftd, fontSize: 11, color: g.imp[k] ? theme.text : theme.sub, maxWidth: 260 }} title={g.imp[k] ? `${g.imp[k].l.historico} · ${contaNome(g.imp[k].l.contra)}` : ''}>{g.imp[k] ? celImportado(g.imp[k].l) : ''}</td>
                                  <td style={{ ...ftd, fontSize: 11, textAlign: 'right', whiteSpace: 'nowrap', color: g.imp[k] ? corV(g.imp[k].v) : theme.sub }}>{g.imp[k] ? vlr(g.imp[k].v) : ''}</td>
                                  <td style={{ ...ftd, fontSize: 11, textAlign: 'right', whiteSpace: 'nowrap', color: g.ext[k] ? corV(g.ext[k].v) : theme.sub, borderLeft: `1px solid ${theme.border}` }}>{g.ext[k] ? vlr(g.ext[k].v) : ''}</td>
                                  {k === 0 && <td rowSpan={n} style={{ ...ftd, textAlign: 'right', verticalAlign: 'middle', whiteSpace: 'nowrap', borderLeft: `1px solid ${theme.border}`, color: g.tipo === 'sobra' ? theme.red : g.tipo === 'quase' ? theme.yellow : theme.green, fontWeight: 700 }} title={g.tipo === 'soma' ? 'A soma dos lançamentos bate com o movimento do extrato' : g.tipo === 'quase' ? `Diferença de ${money(Math.abs(g.dif))}` : g.tipo === 'sobra' ? 'Sem par — este valor compõe a diferença' : 'Bate exatamente'}>
                                    {Math.abs(g.dif) < 0.005
                                      ? <><i className="ti ti-check" />{g.tipo === 'soma' ? <span style={{ fontSize: 9.5 }}> soma</span> : ''}</>
                                      : <>{g.tipo === 'sobra' ? <i className="ti ti-alert-triangle" style={{ marginRight: 3 }} /> : null}{money(Math.abs(g.dif))}</>}
                                  </td>}
                                </tr>
                              ))
                            })}
                            {!gruposReais.length && <tr><td colSpan={4} style={{ ...ftd, fontSize: 11.5, color: theme.sub }}>{anulaItens ? 'Só lançamentos que se anulam neste dia (veja abaixo).' : 'Nada para confrontar neste dia.'}</td></tr>}
                          </tbody>
                        </table>
                        {anulaItens > 0 && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 11px', borderTop: `1px solid ${theme.border}`, fontSize: 11.5, color: theme.sub }}>
                            <i className="ti ti-arrows-exchange" style={{ color: theme.sub }} />
                            <span><b style={{ color: theme.text }}>{anulaItens}</b> lançamento(s) se <b>anulam entre si</b> (+ e −, sem correspondência no extrato) — provável lançamento errado + estorno. <b>Efeito zero</b>, não entram na diferença.</span>
                          </div>
                        )}
                      </div>
                    )
                  })()}
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
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: cruza.temValor ? 640 : 560 }}>
            <thead>
              <tr style={{ background: theme.input }}>
                <th style={fth}></th>
                <th style={{ ...fth, textAlign: 'center', color: theme.accent, borderLeft: `1px solid ${theme.border}` }} colSpan={cruza.temValor ? 2 : 1}><i className="ti ti-file-import" /> Importado</th>
                <th style={{ ...fth, textAlign: 'center', color: theme.green, borderLeft: `1px solid ${theme.border}` }} colSpan={cruza.temValor ? 2 : 1}><i className="ti ti-file-dollar" /> Extrato</th>
                <th style={{ ...fth, textAlign: 'right', borderLeft: `1px solid ${theme.border}` }}></th>
              </tr>
              <tr style={{ background: theme.input }}>
                <th style={fth}>Data</th>
                {cruza.temValor && <th style={{ ...fth, textAlign: 'right', borderLeft: `1px solid ${theme.border}` }}>Movimento</th>}
                <th style={{ ...fth, textAlign: 'right', borderLeft: cruza.temValor ? 'none' : `1px solid ${theme.border}` }}>Saldo</th>
                {cruza.temValor && <th style={{ ...fth, textAlign: 'right', borderLeft: `1px solid ${theme.border}` }}>Movimento</th>}
                <th style={{ ...fth, textAlign: 'right', borderLeft: cruza.temValor ? 'none' : `1px solid ${theme.border}` }}>Saldo</th>
                <th style={{ ...fth, textAlign: 'right', borderLeft: `1px solid ${theme.border}` }}>Diferença</th>
              </tr>
            </thead>
            <tbody>
              {linhasTabela.map((d, i) => {
                const marca = d.delta != null && Math.abs(d.delta) >= 0.005
                const difMov = (cruza.temValor && d.extMov != null) ? r2(d.mov - d.extMov) : null
                return (
                  <tr key={i} onClick={() => onVerDia && onVerDia(d.data)} style={{ borderTop: `1px solid ${theme.border}`, background: marca ? 'rgba(229,72,77,0.10)' : 'transparent', cursor: onVerDia ? 'pointer' : 'default' }} title={onVerDia ? 'Filtrar os lançamentos deste dia' : ''}>
                    <td style={{ ...ftd, fontSize: 11.5, whiteSpace: 'nowrap' }}>{brd(d.data)}</td>
                    {cruza.temValor && <td style={{ ...ftd, textAlign: 'right', fontSize: 11.5, whiteSpace: 'nowrap', color: theme.sub, borderLeft: `1px solid ${theme.border}` }}>{money(d.mov)}</td>}
                    <td style={{ ...ftd, textAlign: 'right', whiteSpace: 'nowrap', borderLeft: cruza.temValor ? 'none' : `1px solid ${theme.border}` }}>{money(d.calc)}</td>
                    {cruza.temValor && <td style={{ ...ftd, textAlign: 'right', fontSize: 11.5, whiteSpace: 'nowrap', color: difMov != null && Math.abs(difMov) >= 0.005 ? theme.red : theme.sub, borderLeft: `1px solid ${theme.border}` }}>{d.extMov == null ? '—' : money(d.extMov)}</td>}
                    <td style={{ ...ftd, textAlign: 'right', whiteSpace: 'nowrap', borderLeft: cruza.temValor ? 'none' : `1px solid ${theme.border}` }}>{d.ext == null ? '—' : money(d.ext)}</td>
                    <td style={{ ...ftd, textAlign: 'right', whiteSpace: 'nowrap', fontWeight: marca ? 700 : 400, color: marca ? theme.red : theme.sub, borderLeft: `1px solid ${theme.border}` }}>{d.delta == null ? '—' : money(d.delta)}</td>
                  </tr>
                )
              })}
              {!linhasTabela.length && <tr><td colSpan={cruza.temValor ? 6 : 4} style={{ ...ftd, color: theme.sub, fontSize: 12 }}>Sem dias para mostrar.</td></tr>}
            </tbody>
          </table>
        </div>
        <p style={{ color: theme.sub, fontSize: 11, margin: '10px 0 0' }}>Colunas <b style={{ color: theme.accent }}>Importado</b> (o que você classificou) × <b style={{ color: theme.green }}>Extrato</b> (o arquivo do banco). "Diferença" é a mudança do dia — o valor que sobra/falta ali. Abra um dia (<b>confronto</b>) para ver <b>lançamento a lançamento</b>; ali dá para <b><i className="ti ti-pencil" /> editar</b> ou <b><i className="ti ti-trash" /> excluir</b> um lançamento na hora. Se o extrato não tiver coluna de movimento, use <b>Ajustar colunas</b>. Clique num dia para filtrar a tabela.</p>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 14 }}>
          <button className="btn btn-ghost" onClick={exportar} title="Excel no papel timbrado, Importado × Extrato lado a lado — pronto para enviar ao cliente"><i className="ti ti-file-spreadsheet" /> Exportar cruzamento (Excel p/ cliente)</button>
          <button className="btn" onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
  )
}

// Campo da contrapartida na tabela: só confirma (grava na linha) ao apertar Enter,
// sair do campo ou escolher pelo F4 — enquanto digita não é interpretado como lançado.
function ContraCell({ value, onCommit, onEnter, inputRef, disabled }) {
  const [v, setV] = useState(value ?? '')
  useEffect(() => { setV(value ?? '') }, [value])
  const commit = val => { const s = String(val ?? '').trim(); if (s !== String(value ?? '')) onCommit(s) }
  if (disabled) return <input className="input" value={value ?? ''} disabled readOnly style={{ fontSize: 11.5, padding: '4px 7px', width: '100%' }} />
  return (
    <CampoConta value={v} onChange={setV} inputRef={inputRef}
      onPick={p => { setV(p.cod); onCommit(p.cod) }}
      onEnter={() => { commit(v); onEnter && onEnter() }}
      onBlur={() => commit(v)} />
  )
}

// Inclui um lançamento manual na classificação (ex.: um que faltou, identificado
// no cruzamento). Confirma antes de subir. Data precisa estar na competência.
// Após "Aprender e salvar": lista os lançamentos que o novo aprendizado também classifica
// (estavam sem contrapartida). O usuário marca os que estão de acordo e confirma.
function ModalSugestoes({ itens, planoMap, onClose, onConfirmar }) {
  const [marcados, setMarcados] = useState(() => new Set(itens.map((_, i) => i)))
  const toggle = i => setMarcados(s => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n })
  const todos = marcados.size === itens.length
  const selecionados = itens.filter((_, i) => marcados.has(i))
  const fmtData = iso => iso ? String(iso).split('-').reverse().join('/') : '—'
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, zIndex: 70 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, width: 'min(780px, 96vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: `0.5px solid ${theme.cb}` }}>
          <h3 style={{ fontSize: 15, margin: 0 }}><i className="ti ti-brain" style={{ color: theme.accent, marginRight: 6 }} />Este aprendizado classifica mais {itens.length} lançamento(s)</h3>
          <p style={{ color: theme.sub, fontSize: 12.5, margin: '6px 0 0' }}>Confira e marque os que estiverem de acordo — só os selecionados recebem a contrapartida.</p>
        </div>
        <div style={{ overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
            <thead>
              <tr style={{ background: theme.input, position: 'sticky', top: 0 }}>
                <th style={{ ...fth, width: 34, textAlign: 'center' }}><input type="checkbox" checked={todos} onChange={() => setMarcados(todos ? new Set() : new Set(itens.map((_, i) => i)))} /></th>
                <th style={fth}>Data</th><th style={fth}>Histórico</th><th style={{ ...fth, textAlign: 'right' }}>Valor</th><th style={fth}>E/S</th><th style={fth}>Contrapartida</th>
              </tr>
            </thead>
            <tbody>
              {itens.map((it, i) => (
                <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                  <td style={{ ...ftd, textAlign: 'center' }}><input type="checkbox" checked={marcados.has(i)} onChange={() => toggle(i)} /></td>
                  <td style={{ ...ftd, fontSize: 11.5, whiteSpace: 'nowrap', color: theme.sub }}>{fmtData(it.data)}</td>
                  <td style={{ ...ftd, maxWidth: 320 }}>{it.historico || ''}</td>
                  <td style={{ ...ftd, textAlign: 'right', whiteSpace: 'nowrap' }}>{money(it.valor)}</td>
                  <td style={{ ...ftd, color: it.entrada ? theme.green : theme.red }}>{it.entrada ? 'Entrada' : 'Saída'}</td>
                  <td style={{ ...ftd, fontSize: 11.5 }}>{it.contra} · {planoMap[String(it.contra)]?.nome || <span style={{ color: theme.red }}>conta não encontrada</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding: '12px 20px', borderTop: `0.5px solid ${theme.cb}`, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Agora não</button>
          <button className="btn" disabled={!selecionados.length} onClick={() => onConfirmar(selecionados)}><i className="ti ti-check" /> Classificar {selecionados.length} selecionado(s)</button>
        </div>
      </div>
    </div>
  )
}

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

// Editar um lançamento inteiro antes de gravar/gerar: data, histórico, valor, E/S e
// contrapartida. Permite informar a DATA que faltou. Só grava ao clicar em Salvar.
function ModalEditarLanc({ linha, banco, nomeBanco, competencia, planoMap, onClose, onSalvar }) {
  const [mes, ano] = (competencia || '').split('/').map(Number)
  const [data, setData] = useState(linha.data || '')
  const [valor, setValor] = useState(linha.valor != null ? String(linha.valor) : '')
  const [entrada, setEntrada] = useState(!!linha.entrada)
  const [historico, setHistorico] = useState(linha.historico || '')
  const [contra, setContra] = useState(linha.contra || '')
  const [erro, setErro] = useState('')
  const v = parseValor(valor)
  const nomeC = planoMap[String(contra).trim()]?.nome || ''
  function salvar() {
    if (!(v > 0)) { setErro('Informe um valor maior que zero.'); return }
    if (data) {
      const [dy, dm] = data.split('-').map(Number)
      if (mes && ano && (dm !== mes || dy !== ano)) { setErro(`A data deve estar na competência ${competencia}.`); return }
    }
    if (!historico.trim()) { setErro('Informe o histórico.'); return }
    onSalvar({ data: data || null, historico: historico.trim(), valor: Math.abs(v), entrada, contra: String(contra).trim() })
  }
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 16, zIndex: 80 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(560px,96vw)', maxHeight: '90vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h2 style={{ fontSize: 16, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><i className="ti ti-pencil" style={{ color: theme.accent }} /> Editar lançamento</h2>
          <span onClick={onClose} style={{ cursor: 'pointer', color: theme.sub, fontSize: 20 }}><i className="ti ti-x" /></span>
        </div>
        <p style={{ color: theme.sub, fontSize: 12, margin: '0 0 12px' }}>{banco ? `${banco} · ${nomeBanco(banco)}` : 'Banco'} · competência {competencia}</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={{ fontSize: 12, color: theme.sub }}>Data</label>
            <input className="input" type="date" value={data} onChange={e => setData(e.target.value)} />
            {!data && <p style={{ color: theme.yellow, fontSize: 11, margin: '4px 0 0' }}><i className="ti ti-alert-triangle" /> Sem data — o Domínio precisa da data.</p>}
          </div>
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
          <button className="btn" onClick={salvar}><i className="ti ti-device-floppy" /> Salvar alterações</button>
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
function PerfilExtratoCfg({ arr, catByRow, adiantContas, nome, bancoNome, bancoCod, perfilInicial, memoria, usaCC, centros = [], onCancelar, onSalvar }) {
  const [p, setP] = useState(perfilInicial)
  const set = patch => setP(x => ({ ...x, ...patch }))
  const nc = (arr || []).reduce((m, r) => Math.max(m, (r || []).length), 0)
  const ini = Number.isInteger(p.linhaInicio) ? p.linhaInicio : 1
  const fmtVal = v => {
    if (v == null || v === '') return ''
    if (v instanceof Date) return v.toLocaleDateString('pt-BR')
    return String(v).trim()
  }
  const amostra = (j) => { for (const r of (arr || []).slice(ini, ini + 60)) { const v = fmtVal(r?.[j]); if (v) return v } return '' }
  const cols = Array.from({ length: nc }, (_, j) => ({ j, label: `Col ${j + 1} · ${amostra(j).slice(0, 24) || '(vazia)'}` }))
  // Papel de cada coluna (para marcar na prévia) — mostra o que o sistema entendeu.
  const roles = {}
  const setRole = (j, txt) => { if (j != null && j >= 0) roles[j] = txt }
  setRole(p.colData, 'Data'); setRole(p.colHist, 'Histórico'); setRole(p.colValor, 'Valor')
  setRole(p.colCredor, 'Credor/Devedor'); setRole(p.colDoc, 'Documento'); setRole(p.colCategoria, 'Categoria')
  if (usaCC) setRole(p.colCC, 'Centro de Custo')
  if (p.es?.modo === 'coluna' || p.es?.modo === 'natureza') setRole(p.es?.col, p.es.modo === 'natureza' ? 'Natureza (D/C)' : 'Entrada/Saída')
  const amostras = (arr || []).slice(ini, ini + 3)
  const Sel = ({ val, on, vazio = '—' }) => (
    <select className="input" style={{ padding: '7px 9px', fontSize: 12 }} value={val ?? -1} onChange={e => on(Number(e.target.value))}>
      <option value={-1}>{vazio}</option>
      {cols.map(c => <option key={c.j} value={c.j}>{c.label}</option>)}
    </select>
  )
  const todas = aplicarPerfil(arr, p, memoria, catByRow, adiantContas, bancoCod ? new Set([String(bancoCod)]) : null, centros)
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
        <p style={{ color: theme.sub, fontSize: 12, margin: '0 0 10px' }}>Diga como ler <b style={{ color: theme.text }}>{nome}</b>. Salvo no cliente — nos próximos meses o extrato entra sozinho, no layout do Domínio.</p>

        {/* Prévia das colunas do arquivo — veja o que tem em cada uma e confira, abaixo,
            o papel que o sistema deu a ela (selo azul). Assim o mapeamento fica claro. */}
        <p style={{ color: theme.sub, fontSize: 11.5, margin: '0 0 6px' }}><i className="ti ti-table" style={{ color: theme.accent }} /> Prévia do arquivo — confira o que tem em cada coluna. O selo azul mostra o que o sistema entendeu (ajuste nos campos abaixo).</p>
        <div style={{ margin: '0 0 14px', border: `0.5px solid ${theme.cb}`, borderRadius: 10, overflow: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr style={{ background: theme.input }}>
                {cols.map(c => (
                  <th key={c.j} style={{ ...fth, borderLeft: `1px solid ${theme.border}`, textAlign: 'left' }}>
                    Col {c.j + 1}
                    {roles[c.j] && <div style={{ marginTop: 3, color: theme.accent, fontWeight: 700, fontSize: 10, textTransform: 'none', letterSpacing: 0 }}><i className="ti ti-arrow-down-circle" /> {roles[c.j]}</div>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {amostras.map((r, ri) => (
                <tr key={ri} style={{ borderTop: `1px solid ${theme.border}` }}>
                  {cols.map(c => (
                    <td key={c.j} style={{ ...ftd, fontSize: 11, color: roles[c.j] ? theme.text : theme.sub, borderLeft: `1px solid ${theme.border}`, whiteSpace: 'nowrap', maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis', background: roles[c.j] ? 'rgba(74,124,255,0.05)' : undefined }}>
                      {fmtVal(r?.[c.j]) || '—'}
                    </td>
                  ))}
                </tr>
              ))}
              {!amostras.length && <tr><td style={{ ...ftd, color: theme.yellow, fontSize: 12 }}>Sem linhas para prever — ajuste a linha de início.</td></tr>}
            </tbody>
          </table>
        </div>

        <p style={{ color: theme.sub, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .4, margin: '0 0 6px' }}>Diga qual coluna é qual — o essencial é <span style={{ color: theme.text }}>Data</span>, <span style={{ color: theme.text }}>Histórico</span> e <span style={{ color: theme.text }}>Valor</span></p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 10 }}>
          <div><label>Data <span style={{ color: theme.red }}>*</span></label><Sel val={p.colData} on={v => set({ colData: v })} /><small style={dicaS}>a data do lançamento</small></div>
          <div><label>Histórico <span style={{ color: theme.red }}>*</span></label><Sel val={p.colHist} on={v => set({ colHist: v })} /><small style={dicaS}>a descrição do lançamento — vira o histórico e ajuda a achar a conta na memória</small></div>
          <div><label>Valor <span style={{ color: theme.red }}>*</span></label><Sel val={p.colValor} on={v => set({ colValor: v })} /><small style={dicaS}>o valor do lançamento (R$)</small></div>
          <div><label>Documento (opc.)</label><Sel val={p.colDoc} on={v => set({ colDoc: v })} /><small style={dicaS}>nº da NF/documento — só é juntado ao histórico se ele ainda não o tiver</small></div>
          <div><label>Credor/Devedor (opc.)</label><Sel val={p.colCredor} on={v => set({ colCredor: v })} /><small style={dicaS}>coluna separada com o nome do cliente/fornecedor, se houver</small></div>
          <div><label>Categoria (mesclada, opc.)</label><Sel val={p.colCategoria} on={v => set({ colCategoria: v })} /><small style={dicaS}>grupo/histórico do extrato, se houver</small></div>
          {usaCC && <div><label>Centro de Custo (opc.)</label><Sel val={p.colCC} on={v => set({ colCC: v })} /><small style={dicaS}>coluna do centro de custo na planilha do mês — se vier vazia, preenche à mão na grade. Não entra na memória.</small></div>}
        </div>
        <div style={{ marginTop: 10 }}>
          <label>Linha de início (onde começam os lançamentos)</label>
          <input className="input" type="number" min="1" style={{ fontSize: 12, maxWidth: 160 }} value={ini + 1} onChange={e => set({ linhaInicio: Math.max(0, (Number(e.target.value) || 1) - 1) })} />
          <small style={dicaS}>número da 1ª linha de dados — pula o cabeçalho/títulos. Ex.: cabeçalho na linha 1 → comece em <b>2</b>.</small>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 10, marginTop: 12, alignItems: 'end' }}>
          <div>
            <label>Entrada × Saída (financeiro)</label>
            <select className="input" style={{ fontSize: 12 }} value={p.es?.modo || 'sinal'} onChange={e => set({ es: { ...(p.es || {}), modo: e.target.value } })}>
              <option value="sinal">Pelo sinal do valor (− saída, + entrada)</option>
              <option value="natureza">Pela natureza D/C (C = entrada, D = saída)</option>
              <option value="coluna">Por uma coluna (valores de entrada)</option>
            </select>
            <small style={dicaS}>No extrato, <b>C = entrada</b> e <b>D = saída</b> — é o inverso da contabilidade.</small>
          </div>
          {(p.es?.modo === 'coluna' || p.es?.modo === 'natureza') && <div><label>Coluna do indicador {p.es?.modo === 'natureza' ? '(D/C)' : ''}</label><Sel val={p.es?.col} on={v => set({ es: { ...(p.es || {}), col: v } })} /></div>}
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
            <thead><tr style={{ background: theme.input }}><th style={fth}>E/S</th><th style={{ ...fth, textAlign: 'right' }}>Valor</th><th style={fth}>Data</th><th style={{ ...fth, minWidth: 380 }}>Histórico montado</th><th style={fth}>Contrap.</th>{usaCC && <th style={fth}>C. Custo</th>}</tr></thead>
            <tbody>
              {prev.map((l, i) => (
                <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                  <td style={{ ...ftd, fontSize: 11, color: l.entrada ? theme.green : theme.red }}>{l.entrada ? 'Entrada' : 'Saída'}</td>
                  <td style={{ ...ftd, textAlign: 'right', whiteSpace: 'nowrap' }}>{money(l.valor)}</td>
                  <td style={{ ...ftd, fontSize: 11, color: theme.sub, whiteSpace: 'nowrap' }}>{l.data ? l.data.split('-').reverse().join('/') : '—'}</td>
                  <td style={{ ...ftd, fontSize: 11, color: theme.text, minWidth: 380, whiteSpace: 'normal', lineHeight: 1.35 }}>{l.historico || '—'}</td>
                  <td style={{ ...ftd, fontSize: 11.5 }}>{l.contra || '—'}</td>
                  {usaCC && <td style={{ ...ftd, fontSize: 11.5, color: theme.sub }}>{l.centro_custo || '—'}</td>}
                </tr>
              ))}
              {!prev.length && <tr><td colSpan={usaCC ? 6 : 5} style={{ ...ftd, color: theme.yellow, fontSize: 12 }}>Nenhum lançamento com este mapeamento. Ajuste a linha de início e a coluna de valor.</td></tr>}
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
const dicaS = { display: 'block', color: theme.sub, fontSize: 10, marginTop: 3, lineHeight: 1.3 }

// Documento "virtual" que marca uma conta como validada pela integração de patrimônio.
const DOC_PATRIMONIO = 'Resumo da Depreciação Fiscal · Patrimônio'
// Contas ANALÍTICAS sob as contas cadastradas (se sintética, pega os filhos; se analítica,
// ela mesma) — são as que somando batem com a sintética e serão validadas na conciliação.
function analiticasSob(codes, linhas) {
  const dig = s => String(s).replace(/\D/g, '')
  const out = new Map()
  for (const c of codes) {
    const l = linhas.find(x => String(x.reduzido) === c || String(x.classif) === c || (dig(x.classif) && dig(x.classif) === dig(c)) || (dig(x.reduzido) && dig(x.reduzido) === dig(c)))
    if (!l) continue
    if (!l.sintetica) { out.set(String(l.reduzido), l); continue }
    const pref = String(l.classif || '') // mascarado, ex.: "1.2.3" — casa filhas com "1.2.3."
    for (const x of linhas) { if (x.sintetica) continue; if (pref && String(x.classif || '').startsWith(pref + '.')) out.set(String(x.reduzido), x) }
  }
  return [...out.values()]
}

// Integração PATRIMÔNIO: cadastra a conta SINTÉTICA (imobilizado − depreciação) e importa o
// "Resumo da Depreciação Fiscal" (PDF). O saldo da sintética deve bater com o "Saldo a
// depreciar" (imobilizado líquido) do documento. Bateu → verde.
function Patrimonio({ empresaId, competencia, planoMap = {}, est, onEstado, onSemMov }) {
  const contas = est?.contas || (est?.conta ? [est.conta] : []) // migra do formato antigo (1 conta)
  const valorDoc = est?.valorDoc
  const semMov = est?.estado === 'sem_movimento'
  const [novo, setNovo] = useState('')
  const [linhas, setLinhas] = useState(null) // linhas do balancete montado
  const [busy, setBusy] = useState(false)
  const [erro, setErro] = useState('')

  useEffect(() => {
    if (!empresaId) { setLinhas(null); return }
    let ativo = true
    ;(async () => {
      const [mes, ano] = (competencia || '').split('/').map(Number)
      const { data: comp } = await supabase.from('competencias').select('id').eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
      if (!comp) { if (ativo) setLinhas([]); return }
      const { linhas: L } = await montarBalancete(empresaId, comp.id, 0, { comLancamentos: true })
      if (ativo) setLinhas(L)
    })()
    return () => { ativo = false }
  }, [empresaId, competencia])

  const dig = s => String(s).replace(/\D/g, '')
  const saldoDe = c => {
    if (!linhas) return null
    const l = linhas.find(x => String(x.reduzido) === c || String(x.classif) === c || (dig(x.classif) && dig(x.classif) === dig(c)) || (dig(x.reduzido) && dig(x.reduzido) === dig(c)))
    return l ? (Number(l.saldo_final) || 0) : null
  }
  const saldoTotal = (linhas && contas.length) ? contas.reduce((s, c) => { const v = saldoDe(c); return s + (v == null ? 0 : v) }, 0) : null

  function persistContas(cs) { const e = { ...(est || {}), contas: cs }; delete e.conta; onEstado(e) }
  const addConta = () => { const c = novo.trim(); if (!c || contas.includes(c)) { setNovo(''); return } persistContas([...contas, c]); setNovo('') }
  const removeConta = i => persistContas(contas.filter((_, j) => j !== i))

  async function importarPdf(file) {
    if (!file) return
    setErro(''); setBusy(true)
    try {
      if (!/\.pdf$/i.test(file.name)) { setErro('Envie o "Resumo da Depreciação Fiscal" em PDF (com texto).'); setBusy(false); return }
      const { extrairTextoPdf } = await import('../lib/pdfText')
      const valor = valorDepreciacaoPdf(await extrairTextoPdf(file))
      if (valor == null) { setErro('Não identifiquei o total "Saldo a depreciar" no PDF (confira se tem texto, não é imagem).'); setBusy(false); return }
      let path = est?.path || ''
      const [mes, ano] = (competencia || '').split('/').map(Number)
      const { data: comp } = await supabase.from('competencias').select('id').eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
      if (comp) { path = `integracao/${comp.id}/patrimonio.pdf`; try { await supabase.storage.from('extratos').upload(path, file, { upsert: true, contentType: 'application/pdf' }) } catch { path = '' } }
      onEstado({ ...(est || {}), contas, valorDoc: valor, doc: file.name, path, estado: null })
    } catch (e) { setErro('Não consegui ler: ' + e.message) }
    setBusy(false)
  }
  async function extrair() {
    if (!est?.path) return
    const { data, error } = await supabase.storage.from('extratos').createSignedUrl(est.path, 300, { download: est.doc || 'depreciacao.pdf' })
    if (error) { setErro(error.message); return }
    const a = document.createElement('a'); a.href = data.signedUrl; a.download = est.doc || 'depreciacao.pdf'; document.body.appendChild(a); a.click(); a.remove()
  }

  const dif = (saldoTotal != null && valorDoc != null) ? Math.round((Math.abs(saldoTotal) - Math.abs(valorDoc)) * 100) / 100 : null
  const bate = dif != null && Math.abs(dif) < 0.05

  // Marca (ou desmarca) as contas analíticas do imobilizado como VERDES na conciliação,
  // usando o próprio Resumo da Depreciação como documento validador.
  async function validarConciliacao(marcar) {
    if (!linhas) return
    const [mes, ano] = (competencia || '').split('/').map(Number)
    const { data: comp } = await supabase.from('competencias').select('id').eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
    if (!comp) return
    for (const l of analiticasSob(contas, linhas)) {
      const conta = String(l.reduzido)
      const { data: ex } = await supabase.from('conciliacao_conta').select('id, documento, documento_path').eq('competencia_id', comp.id).eq('conta', conta).maybeSingle()
      if (marcar) {
        // não sobrescreve um extrato real já anexado
        if (ex?.documento_path && !String(ex.documento || '').startsWith('Resumo da Depreciação')) continue
        const campos = { competencia_id: comp.id, conta, documento: DOC_PATRIMONIO, documento_path: est?.path || null, saldo_documento: Number(l.saldo_final) || 0 }
        if (ex) await supabase.from('conciliacao_conta').update(campos).eq('id', ex.id)
        else await supabase.from('conciliacao_conta').insert(campos)
      } else if (ex && String(ex.documento || '').startsWith('Resumo da Depreciação')) {
        await supabase.from('conciliacao_conta').update({ documento: null, documento_path: null, saldo_documento: null }).eq('id', ex.id)
      }
    }
  }

  useEffect(() => {
    if (semMov) return
    const desired = bate ? 'validado' : null
    if ((est?.estado || null) !== desired && contas.length && valorDoc != null && saldoTotal != null) onEstado({ ...(est || {}), estado: desired })
  }, [bate, saldoTotal, valorDoc]) // eslint-disable-line react-hooks/exhaustive-deps

  // Marca/desmarca as analíticas na conciliação SEMPRE que estiver batendo (não só na
  // transição) — cobre o caso do patrimônio já validado de antes. Idempotente por assinatura.
  const marcadoRef = useRef('')
  useEffect(() => {
    if (!linhas || semMov) return
    const sig = (bate && contas.length) ? `${contas.join(',')}|${valorDoc}|${est?.path || ''}` : ''
    if (sig && marcadoRef.current !== sig) { marcadoRef.current = sig; validarConciliacao(true) }
    else if (!sig && marcadoRef.current) { marcadoRef.current = ''; validarConciliacao(false) }
  }, [linhas, bate, valorDoc]) // eslint-disable-line react-hooks/exhaustive-deps

  if (semMov) return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: theme.sub, background: theme.card, border: `1px solid ${theme.cb}`, borderRadius: 20, padding: '5px 12px' }}><i className="ti ti-circle-minus" /> Patrimônio — sem movimento no período</span>
      <button className="btn btn-ghost" style={{ fontSize: 12.5 }} onClick={() => onEstado({})}><i className="ti ti-rotate" /> Tem movimento</button>
    </div>
  )

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={{ background: theme.card, border: `0.5px solid ${bate ? theme.green : theme.cb}`, borderRadius: 12, padding: 18, marginBottom: 14 }}>
        <p style={{ fontSize: 14, fontWeight: 600, margin: '0 0 4px' }}>Conta(s) do imobilizado líquido {bate && <i className="ti ti-circle-check" style={{ color: theme.green }} />}</p>
        <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 10px', lineHeight: 1.5 }}>Cadastre a <b style={{ color: theme.text }}>conta sintética</b> (imobilizado − depreciação) ou <b style={{ color: theme.text }}>várias contas</b> cuja <b style={{ color: theme.text }}>soma</b> dê o imobilizado líquido. A soma tem que bater com o "Saldo a depreciar" do Resumo da Depreciação. <span style={{ color: theme.accent }}>F4</span> abre o plano.</p>
        <div style={{ display: 'flex', gap: 8, maxWidth: 440 }}>
          <CampoConta value={novo} onChange={setNovo} onEnter={addConta} onPick={p => setNovo(p.cod)} style={{ flex: 1 }} />
          <button className="btn" style={{ fontSize: 12.5 }} onClick={addConta}><i className="ti ti-plus" /> Incluir</button>
        </div>
        {novo && planoMap[novo] && <p style={{ fontSize: 12, color: theme.accent, margin: '6px 0 0' }}><i className="ti ti-corner-down-right" /> {planoMap[novo].nome}</p>}
        {contas.length > 0 && <div style={{ marginTop: 10 }}>
          {contas.map((c, i) => { const v = saldoDe(c); return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '5px 0', borderTop: i ? `1px solid ${theme.border}` : 'none' }}>
              <span style={{ color: theme.text }}>{c}{planoMap[c] ? ` · ${planoMap[c].nome}` : ''}</span>
              <span style={{ marginLeft: 'auto', color: linhas && v == null ? theme.yellow : theme.sub, fontSize: 12.5 }}>{linhas == null ? '…' : v == null ? 'não achei no razão' : moneyDC(v)}</span>
              <i className="ti ti-trash" onClick={() => removeConta(i)} style={{ color: theme.sub, cursor: 'pointer' }} />
            </div>
          ) })}
          {contas.length > 1 && saldoTotal != null && <p style={{ textAlign: 'right', fontSize: 12.5, color: theme.text, margin: '6px 0 0' }}>Soma: <b>{money(Math.abs(saldoTotal))}</b></p>}
        </div>}
      </div>

      <ImpCard titulo="Importar Resumo da Depreciação Fiscal (Domínio)"
        desc={'PDF (com texto) do "Resumo da Depreciação Fiscal por Conta Patrimonial". Leio o total "Saldo a depreciar" (imobilizado líquido).'}
        onImport={importarPdf} nome={est?.doc} qtd={valorDoc != null ? 1 : undefined} />
      <div style={{ display: 'flex', gap: 12, margin: '10px 0 0', flexWrap: 'wrap' }}>
        {est?.path && <button className="btn btn-ghost" style={{ fontSize: 12.5 }} onClick={extrair}><i className="ti ti-download" /> Extrair arquivo</button>}
        {!est?.doc && valorDoc == null && <button className="btn btn-ghost" style={{ fontSize: 12.5 }} onClick={onSemMov}><i className="ti ti-circle-minus" /> Marcar sem movimento</button>}
        {busy && <span style={{ color: theme.sub, fontSize: 12.5 }}><i className="ti ti-loader" /> Lendo o PDF…</span>}
      </div>

      {(contas.length > 0 || valorDoc != null) && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(190px,1fr))', gap: 12, margin: '16px 0 0' }}>
        <Metric label="Saldo no razão (soma)" valor={saldoTotal != null ? money(Math.abs(saldoTotal)) : (contas.length ? '—' : 'cadastre a conta')} icon="ti-report-money" cor={contas.length && saldoTotal == null ? theme.yellow : theme.text} />
        <Metric label="Documento (saldo a depreciar)" valor={valorDoc != null ? money(valorDoc) : 'importe o PDF'} icon="ti-file-invoice" cor={valorDoc == null ? theme.yellow : theme.text} />
        <Metric label="Diferença" valor={dif != null ? money(dif) : '—'} icon="ti-arrows-diff" cor={dif == null ? theme.sub : bate ? theme.green : theme.red} sub={dif == null ? '' : bate ? 'bateu' : 'não bateu — verifique'} />
      </div>}
      {erro && <p style={{ color: theme.red, fontSize: 13, margin: '12px 0 0' }}>{erro}</p>}
    </div>
  )
}

// Cliente sem integração por Excel (via sistema): cadastra AQUI as contas bancárias e o
// sistema verifica na conciliação se cada uma bateu com o extrato (verde). Se todas
// baterem, fica verde automático — sem precisar confirmar na mão.
function FinanceiraViaSistema({ integ, sistema, empresaId, competencia, planoMap = {}, est, onEstado }) {
  const usaSistema = integ === 'Sistema' || (integ !== 'Excel' && sistema)
  const contas = est?.contas || []
  const [red, setRed] = useState(null) // Set das contas ainda em aberto na conciliação
  const [novo, setNovo] = useState('')

  useEffect(() => {
    if (!usaSistema || !empresaId) { setRed(null); return }
    let ativo = true
    ;(async () => {
      const [mes, ano] = (competencia || '').split('/').map(Number)
      const { data: comp } = await supabase.from('competencias').select('id')
        .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
      const abertas = comp ? await contasConciliacaoAbertas(empresaId, comp.id) : []
      const dig = s => String(s).replace(/\D/g, '')
      const set = new Set(); for (const c of abertas) { set.add(String(c.conta)); set.add(dig(c.conta)) }
      if (ativo) setRed(set)
    })()
    return () => { ativo = false }
  }, [usaSistema, empresaId, competencia])

  const dig = s => String(s).replace(/\D/g, '')
  const conciliada = c => red && !red.has(String(c)) && !red.has(dig(c))
  const estadoDe = cs => (cs.length > 0 && red && cs.every(conciliada)) ? 'validado' : null

  // Persiste as contas (e o estado calculado). Também reavalia quando a conciliação carrega.
  const persist = cs => onEstado({ ...(est || {}), via: 'sistema', contas: cs, estado: estadoDe(cs) })
  useEffect(() => {
    if (!red) return
    const desired = estadoDe(contas)
    if ((est?.estado || null) !== desired) onEstado({ ...(est || {}), via: 'sistema', contas, estado: desired })
  }, [red]) // eslint-disable-line react-hooks/exhaustive-deps

  const addConta = () => { const c = novo.trim(); if (!c || contas.includes(c)) { setNovo(''); return } persist([...contas, c]); setNovo('') }
  const removeConta = i => persist(contas.filter((_, j) => j !== i))
  const tudoOk = estadoDe(contas) === 'validado'

  return (
    <div style={{ background: theme.card, border: `0.5px solid ${tudoOk ? theme.green : theme.cb}`, borderRadius: 12, padding: '24px', maxWidth: 720 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
        <span style={{ background: 'rgba(74,124,255,0.15)', borderRadius: 12, width: 48, height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <i className={`ti ${usaSistema ? 'ti-plug-connected' : 'ti-plug-off'}`} style={{ color: theme.accent, fontSize: 24 }} />
        </span>
        <div style={{ flex: 1, minWidth: 220 }}>
          {usaSistema ? (
            <>
              <p style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Financeiro via sistema {tudoOk && <i className="ti ti-circle-check" style={{ color: theme.green }} />}</p>
              <p style={{ color: theme.sub, fontSize: 13.5, margin: '6px 0 14px', lineHeight: 1.5 }}>
                Cliente usa <b style={{ color: theme.text }}>{sistema || 'sistema'}</b> (não importa por Excel). Cadastre as <b style={{ color: theme.text }}>contas bancárias</b> abaixo — quando <b style={{ color: theme.text }}>todas</b> estiverem conciliadas (verdes na Conciliação), o financeiro fica verde sozinho.
              </p>
              <label style={{ fontSize: 12, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3 }}>Contas bancárias (código reduzido · F4 = plano)</label>
              <div style={{ display: 'flex', gap: 8, margin: '6px 0 4px', maxWidth: 420 }}>
                <CampoConta value={novo} onChange={setNovo} onEnter={addConta} onPick={p => setNovo(p.cod)} style={{ flex: 1 }} />
                <button className="btn" style={{ fontSize: 12.5 }} onClick={addConta}><i className="ti ti-plus" /> Adicionar</button>
              </div>
              {novo && planoMap[novo] && <p style={{ fontSize: 12, color: theme.accent, margin: '0 0 10px' }}><i className="ti ti-corner-down-right" /> {planoMap[novo].nome}</p>}
              {contas.length === 0
                ? <p style={{ color: theme.yellow, fontSize: 12.5, margin: 0 }}>Nenhuma conta cadastrada ainda.</p>
                : <div>
                  {contas.map((c, i) => {
                    const ok = conciliada(c)
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '5px 0', borderTop: i ? `1px solid ${theme.border}` : 'none' }}>
                        <i className={`ti ${red == null ? 'ti-loader' : ok ? 'ti-circle-check' : 'ti-alert-triangle'}`} style={{ color: red == null ? theme.sub : ok ? theme.green : theme.yellow }} />
                        <span style={{ color: theme.text }}>Conta {c}{planoMap[c] ? ` · ${planoMap[c].nome}` : ''}</span>
                        <span style={{ color: theme.sub, fontSize: 12 }}>— {red == null ? 'verificando…' : ok ? 'conciliada (bateu com o extrato)' : 'ainda não conciliada'}</span>
                        <i className="ti ti-trash" onClick={() => removeConta(i)} style={{ color: theme.sub, cursor: 'pointer', marginLeft: 'auto' }} />
                      </div>
                    )
                  })}
                  <p style={{ fontSize: 12.5, margin: '10px 0 0', color: tudoOk ? theme.green : theme.sub }}>
                    <i className={`ti ${tudoOk ? 'ti-circle-check' : 'ti-info-circle'}`} /> {tudoOk ? 'Todas conciliadas — financeiro OK (verde no Status).' : 'O financeiro fica verde quando todas as contas estiverem conciliadas.'}
                  </p>
                </div>}
              {!sistema && <p style={{ color: theme.yellow, fontSize: 12, margin: '10px 0 0' }}>Informe o sistema no cadastro do cliente (campo “Sistema financeiro”).</p>}
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
