import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import { gerarSugestoesDoRazao } from '../lib/sugestoesRazao'
import { gerarSugestoesConciliacao } from '../lib/sugestoesConciliacao'
import { checarArquivoEmpresa } from '../lib/validarArquivoEmpresa'
import DropZone from '../components/DropZone'
import { theme } from '../lib/theme'
import InfoTela from '../components/InfoTela'
import { money } from '../lib/theme'

const ALVOS = [
  { key: 'data', label: 'Data', dicas: ['data', 'datalan'] },
  { key: 'conta', label: 'Conta', dicas: ['conta', 'clasc', 'cód conta', 'codigo conta', 'reduzido'] },
  { key: 'nome', label: 'Nome da conta', dicas: ['nomec', 'nome da conta', 'nome conta'] },
  { key: 'contrapartida', label: 'Contrapartida', dicas: ['contrapartida', 'contra partida', 'c.partida', 'cont. partida', 'contrap'] },
  { key: 'historico', label: 'Histórico', dicas: ['histor', 'complemento'] },
  { key: 'debito', label: 'Débito', dicas: ['débito', 'debito', 'valdeb', 'valor débito', 'vlr deb'] },
  { key: 'credito', label: 'Crédito', dicas: ['crédito', 'credito', 'valcre', 'valor crédito', 'vlr cred'] },
  { key: 'centro_custo', label: 'Centro de custo (opcional)', dicas: ['centro de custo', 'centro custo', 'codi_ccu', 'ccu', 'cencus', 'c.custo', 'cto custo'] },
]

// Aplica a máscara do Domínio (ex.: "9.9.9.999.9999") a um código sem pontos.
function applyMask(code, mask) {
  const c = String(code ?? '').replace(/\D/g, '')
  if (!c) return ''
  if (!mask) return c
  const lens = String(mask).split('.').map(s => s.length)
  let i = 0; const out = []
  for (const L of lens) { out.push(c.slice(i, i + L)); i += L }
  return out.filter(Boolean).join('.')
}

// Contrapartida: trata "0"/"0,00"/vazio como ausente (no Domínio, lançamentos com
// contrapartida múltipla saem zerados — nesses casos a plataforma infere pela partida).
function limpaContra(v) {
  const s = String(v ?? '').trim()
  if (!s || /^0+([.,]0+)?$/.test(s.replace(/\./g, ''))) return null
  return s
}

// Converte valor pt-BR ("1.234,56") ou número para float.
function num(v) {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return v
  let s = String(v).trim()
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
  const n = parseFloat(s.replace(/[^\d.-]/g, ''))
  return isNaN(n) ? 0 : n
}

// Converte data (Date do Excel ou "dd/mm/aaaa") para ISO "aaaa-mm-dd".
function toISO(v) {
  if (!v) return null
  if (v instanceof Date) {
    const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, '0'), d = String(v.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  const m = String(v).trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/)
  if (m) {
    let [, d, mo, y] = m
    if (y.length === 2) y = '20' + y
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  return null
}

// Acha a linha de cabeçalho: a primeira com 3+ células de texto.
function acharCabecalho(linhas) {
  for (let i = 0; i < Math.min(linhas.length, 25); i++) {
    const textos = linhas[i].filter(c => typeof c === 'string' && c.trim().length > 1)
    if (textos.length >= 3) return i
  }
  return 0
}

function autoMapear(headers) {
  const map = {}
  for (const alvo of ALVOS) {
    const idx = headers.findIndex(h => {
      const hl = String(h || '').toLowerCase()
      if (alvo.key === 'conta') return hl === 'clasc' || (hl.includes('conta') && !hl.includes('contra') && !hl.includes('nome'))
      if (alvo.key === 'nome') return hl === 'nomec' || hl.includes('nome da conta') || hl.includes('nome conta')
      return alvo.dicas.some(d => hl.includes(d))
    })
    map[alvo.key] = idx >= 0 ? String(idx) : ''
  }
  return map
}

// Metadado dos arquivos do razão: guardado em competencias.integracoes.razao.arquivos
// (sem tocar no schema). O razão importado é a UNIÃO das linhas de todos os arquivos —
// reconstruída ao complementar/excluir. Cada arquivo guarda o original (extrair) e um
// JSON das linhas normalizadas (rebuild sem reprocessar a planilha).
const rowsPathDe = (compId, id) => `razao/${compId}/${id}.json`

export default function ImportarRazao() {
  const { empresas, empresaId, empresaNome, competencia, getCompetenciaId, recalcularPendencias } = useAppData()
  const cliente = empresas?.find(e => e.id === empresaId)
  const { user } = useAuth()
  const [headers, setHeaders] = useState([])
  const [linhas, setLinhas] = useState([])   // linhas de dados (arrays)
  const [map, setMap] = useState({})
  const [arquivo, setArquivo] = useState('')
  const [fileObj, setFileObj] = useState(null) // File original (p/ subir ao Storage)
  const [erro, setErro] = useState('')
  const [importando, setImportando] = useState(false)
  const [resultado, setResultado] = useState(null)
  const [mascaraIdx, setMascaraIdx] = useState(-1)
  const [compId, setCompId] = useState(null)
  const [arquivos, setArquivos] = useState([])   // [{ id, nome, path, linhas }]
  const [pend, setPend] = useState(null)          // { registros, file, nome } — pergunta substituir/complementar
  const [msg, setMsg] = useState('')

  // Carrega compId + a lista de arquivos do razão já importados na competência.
  useEffect(() => {
    setResultado(null); setCompId(null); setArquivos([]); setMsg('')
    if (!empresaId) return
    let vivo = true
    ;(async () => {
      const [mes, ano] = competencia.split('/').map(Number)
      const { data: comp } = await supabase.from('competencias').select('id, integracoes')
        .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
      if (!comp || !vivo) return
      setCompId(comp.id)
      const metaArq = comp.integracoes?.razao?.arquivos
      if (Array.isArray(metaArq) && metaArq.length) { setArquivos(metaArq); return }
      // Sem metadado (razão importado numa versão anterior): mostra um arquivo "legado".
      const { count } = await supabase.from('razao').select('id', { count: 'exact', head: true }).eq('competencia_id', comp.id)
      if (vivo && count) setArquivos([{ id: '__legado', nome: 'Razão importado (versão anterior)', path: '', linhas: count }])
    })()
    return () => { vivo = false }
  }, [empresaId, competencia])

  // Salva a lista de arquivos no metadado da competência (read-modify-write no integracoes).
  async function salvarMeta(cid, novoArquivos) {
    const { data } = await supabase.from('competencias').select('integracoes').eq('id', cid).maybeSingle()
    const integ = (data?.integracoes && typeof data.integracoes === 'object') ? data.integracoes : {}
    await supabase.from('competencias').update({ integracoes: { ...integ, razao: { arquivos: novoArquivos } } }).eq('id', cid)
  }

  async function aoEscolherArquivo(file) {
    if (!file) return
    const errCod = await checarArquivoEmpresa(file, cliente)
    if (errCod) { setErro(errCod); setArquivo(''); setFileObj(null); setHeaders([]); setLinhas([]); return }
    setErro(''); setResultado(''); setArquivo(file.name); setFileObj(file)
    const reader = new FileReader()
    reader.onload = async (ev) => {
      try {
        const XLSX = await import('xlsx')
        const wb = XLSX.read(ev.target.result, { type: 'array', cellDates: true })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const linhasBrutas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' })
        if (!linhasBrutas.length) { setErro('Planilha vazia.'); return }
        const hIdx = acharCabecalho(linhasBrutas)
        const hs = linhasBrutas[hIdx].map(c => String(c || '').trim())
        const dados = linhasBrutas.slice(hIdx + 1).filter(r => r.some(c => c !== '' && c != null))
        const mi = hs.findIndex(h => h.toLowerCase() === 'mascara')
        setHeaders(hs); setLinhas(dados); setMap(autoMapear(hs)); setMascaraIdx(mi); setResultado(null)
      } catch (err) {
        setErro('Não consegui ler o arquivo: ' + err.message)
      }
    }
    reader.readAsArrayBuffer(file)
  }

  function valorCol(linha, key) {
    const idx = map[key]
    return idx === '' || idx == null ? '' : linha[Number(idx)]
  }

  // Código da conta EXATAMENTE como vem no arquivo (o código reduzido do Domínio, sem
  // pontos). NÃO aplica máscara: várias contas analíticas dividem a mesma classificação
  // (ex.: todos os bancos), então o que identifica a conta é o código reduzido — e é ele
  // que casa com o plano e com o saldo inicial. Mascarar o reduzido gerava pontos e
  // desalinhava a conta (o banco "sumia").
  function contaDe(linha) {
    return String(valorCol(linha, 'conta') ?? '').trim()
  }

  // Lê os registros normalizados do arquivo atual (mapeamento) e valida o mês.
  function lerRegistros(competencia_id) {
    const registros = linhas.map(l => ({
      competencia_id,
      data: toISO(valorCol(l, 'data')),
      conta: contaDe(l) || null,
      contrapartida: limpaContra(valorCol(l, 'contrapartida')),
      historico: String(valorCol(l, 'historico') ?? '').trim() || null,
      debito: num(valorCol(l, 'debito')),
      credito: num(valorCol(l, 'credito')),
      centro_custo: String(valorCol(l, 'centro_custo') ?? '').trim() || null,
      nome: String(valorCol(l, 'nome') ?? '').trim() || null,   // só para o balancete
    })).filter(r => r.conta && (r.debito || r.credito))
    if (!registros.length) return { erro: 'Nenhuma linha válida (confira o mapeamento de Conta/Débito/Crédito).' }
    // Validação: o mês dos lançamentos tem que ser o da competência selecionada.
    const [cmes, cano] = competencia.split('/').map(Number)
    const cont = {}
    for (const r of registros) { if (!r.data) continue; const [y, m] = r.data.split('-').map(Number); cont[`${m}/${y}`] = (cont[`${m}/${y}`] || 0) + 1 }
    const chaves = Object.keys(cont)
    if (chaves.length) {
      const dominante = chaves.sort((a, b) => cont[b] - cont[a])[0]
      if (dominante !== `${cmes}/${cano}`) {
        const [dm, dy] = dominante.split('/')
        return { erro: `Os lançamentos são de ${String(dm).padStart(2, '0')}/${dy}, mas o fechamento selecionado é ${competencia}. Selecione a competência correta no topo antes de importar.` }
      }
    }
    return { registros }
  }

  async function importar() {
    setErro(''); setImportando(true); setResultado(null)
    try {
      const competencia_id = await getCompetenciaId()
      if (!competencia_id) { setErro('Selecione uma empresa no topo.'); setImportando(false); return }
      const { registros, erro } = lerRegistros(competencia_id)
      if (erro) { setErro(erro); setImportando(false); return }
      // Já tem arquivo? Pergunta substituir × complementar (matriz/filiais). Senão, aplica direto.
      if (arquivos.length) { setPend({ registros, file: fileObj, nome: arquivo }); setImportando(false); return }
      await aplicar({ registros, file: fileObj, nome: arquivo }, 'substituir', competencia_id)
    } catch (err) {
      setErro('Erro ao gravar: ' + err.message); setImportando(false)
    }
  }

  // Reconstrói o razão + balancete a partir da UNIÃO das linhas de todos os arquivos da lista.
  // cache: { [id]: registros } evita rebaixar do Storage o arquivo recém-lido.
  async function rebuildRazao(cid, novoArquivos, cache = {}) {
    // Carrega os registros de cada arquivo (do cache ou do JSON no Storage).
    const porArquivo = []
    for (const a of novoArquivos) {
      if (cache[a.id]) { porArquivo.push(cache[a.id]); continue }
      const jsonPath = rowsPathDe(cid, a.id)
      const { data, error } = await supabase.storage.from('extratos').download(jsonPath)
      if (error || !data) throw new Error(`Não consegui reler as linhas de "${a.nome}". Reimporte este arquivo.`)
      porArquivo.push(JSON.parse(await data.text()))
    }
    const todos = porArquivo.flat().map(r => ({ ...r, competencia_id: cid }))
    // Regrava o razão (sem a coluna nome, que é só do balancete).
    await supabase.from('razao').delete().eq('competencia_id', cid)
    const paraRazao = todos.map(({ nome, ...r }) => r)
    for (let i = 0; i < paraRazao.length; i += 500) {
      const { error } = await supabase.from('razao').insert(paraRazao.slice(i, i + 500))
      if (error) throw error
    }
    // Balancete derivado: agrupa por conta (soma matriz + filiais), com o nome lido do razão.
    const porConta = {}
    for (const r of todos) {
      const c = porConta[r.conta] || (porConta[r.conta] = { conta: r.conta, nome: r.nome || null, debito: 0, credito: 0 })
      if (!c.nome && r.nome) c.nome = r.nome
      c.debito += r.debito; c.credito += r.credito
    }
    const balancete = Object.values(porConta).map(c => ({
      competencia_id: cid, conta: c.conta, nome: c.nome || null,
      saldo_inicial: 0, debito: c.debito, credito: c.credito, saldo_final: c.debito - c.credito,
    }))
    await supabase.from('balancete').delete().eq('competencia_id', cid)
    for (let i = 0; i < balancete.length; i += 500) {
      const { error } = await supabase.from('balancete').insert(balancete.slice(i, i + 500))
      if (error) throw error
    }
    await supabase.from('competencias').update({ razao_importado: todos.length > 0 }).eq('id', cid)
    await salvarMeta(cid, novoArquivos)
    // Regenera as sugestões do mês a partir do razão resultante.
    if (todos.length) {
      try { await gerarSugestoesDoRazao(empresaId, cid, competencia, user?.email) } catch (e) { console.error('sugestões:', e) }
      try { await gerarSugestoesConciliacao(empresaId, cid, competencia, user?.email) } catch (e) { console.error('sugestões concil.:', e) }
    }
    return { balancete, todos }
  }

  // Aplica o arquivo lido: substituir (troca a lista) ou complementar (soma à lista, sem fundir).
  async function aplicar(pack, modo, cidArg) {
    setImportando(true); setErro('')
    try {
      const cid = cidArg || compId || await getCompetenciaId()
      if (!cid) { setErro('Selecione uma empresa no topo.'); setImportando(false); return }
      const id = Math.random().toString(36).slice(2, 10)
      // Sobe o original (extrair) e o JSON das linhas (rebuild).
      let path = ''
      if (pack.file) {
        const ext = (pack.nome.match(/\.[a-z0-9]+$/i) || ['.xlsx'])[0].toLowerCase()
        path = `razao/${cid}/${id}${ext}`
        await supabase.storage.from('extratos').upload(path, pack.file, { upsert: true, contentType: pack.file.type || undefined })
      }
      const jsonBlob = new Blob([JSON.stringify(pack.registros)], { type: 'application/json' })
      await supabase.storage.from('extratos').upload(rowsPathDe(cid, id), jsonBlob, { upsert: true, contentType: 'application/json' })
      const meta = { id, nome: pack.nome, path, linhas: pack.registros.length }
      const base = modo === 'complementar' ? arquivos.filter(a => a.id !== '__legado') : []
      const novoArquivos = [...base, meta]
      const { balancete, todos } = await rebuildRazao(cid, novoArquivos, { [id]: pack.registros })
      setArquivos(novoArquivos)
      const totDeb = todos.reduce((s, r) => s + r.debito, 0)
      const totCred = todos.reduce((s, r) => s + r.credito, 0)
      setResultado({ lancamentos: todos.length, contas: balancete.length, totDeb, totCred })
      recalcularPendencias()
      setHeaders([]); setLinhas([]); setArquivo(''); setFileObj(null); setPend(null)
    } catch (err) {
      setErro('Erro ao gravar: ' + err.message)
    } finally {
      setImportando(false)
    }
  }

  // Exclui UM arquivo da lista e reconstrói o razão com os que sobraram.
  async function excluirArquivo(a) {
    if (a.id === '__legado') {
      if (!window.confirm('Limpar o razão importado desta competência? Você poderá importar de novo.')) return
      setImportando(true)
      try { await rebuildRazao(compId, []); setArquivos([]); setResultado(null); recalcularPendencias(); setMsg('Razão limpo.') }
      catch (e) { setErro(e.message) } finally { setImportando(false) }
      return
    }
    if (!window.confirm(`Excluir o arquivo "${a.nome}"? As linhas dele saem do razão; os outros arquivos continuam.`)) return
    setImportando(true); setErro('')
    try {
      const novoArquivos = arquivos.filter(x => x.id !== a.id)
      await rebuildRazao(compId, novoArquivos)
      setArquivos(novoArquivos)
      setMsg(novoArquivos.length ? 'Arquivo excluído; razão reconstruído com os demais.' : 'Último arquivo excluído — razão vazio.')
    } catch (e) { setErro(e.message) } finally { setImportando(false) }
  }

  async function extrair(a) {
    if (!a.path) { setErro('Este arquivo foi importado numa versão anterior e o original não ficou salvo. Reimporte para poder extrair.'); return }
    const { data, error } = await supabase.storage.from('extratos').createSignedUrl(a.path, 300, { download: a.nome })
    if (error) { setErro('Não consegui abrir o arquivo: ' + error.message); return }
    const el = document.createElement('a'); el.href = data.signedUrl; el.download = a.nome
    document.body.appendChild(el); el.click(); el.remove()
  }

  const temArquivo = headers.length > 0

  if (!empresaId) {
    return (
      <Wrapper>
        <Aviso icon="ti-building" texto="Selecione uma empresa no seletor do menu lateral para importar o razão." />
      </Wrapper>
    )
  }

  return (
    <Wrapper>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 18 }}>
        <b style={{ color: theme.text }}>{empresaNome}</b> · competência <b style={{ color: theme.text }}>{competencia}</b>
      </p>

      {arquivos.length > 0 && (
        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 16, marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <i className="ti ti-files" style={{ color: theme.accent }} />
            <b style={{ fontSize: 13 }}>{arquivos.length} arquivo(s) de razão nesta competência</b>
            <span style={{ marginLeft: 'auto', fontSize: 12, color: theme.sub }}>{arquivos.reduce((s, a) => s + (a.linhas || 0), 0)} linha(s) no total</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {arquivos.map((a, i) => (
              <div key={(a.id || 'x') + i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, background: theme.input, border: `1px solid ${theme.border}`, borderRadius: 8, padding: '6px 10px' }}>
                <i className="ti ti-file-spreadsheet" style={{ color: theme.sub, flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.nome}>{a.nome}</span>
                <span style={{ color: theme.sub, flexShrink: 0 }}>{a.linhas} linha(s)</span>
                {a.path && <i className="ti ti-download" title="Extrair (baixar) este arquivo" onClick={() => extrair(a)} style={{ color: theme.sub, cursor: 'pointer', flexShrink: 0 }} />}
                <i className="ti ti-trash" title="Excluir só este arquivo (as linhas dele saem do razão)" onClick={() => excluirArquivo(a)} style={{ color: theme.red, cursor: 'pointer', flexShrink: 0 }} />
              </div>
            ))}
          </div>
          <p style={{ fontSize: 11.5, color: theme.sub, margin: '10px 2px 0' }}>Ao importar outro arquivo o sistema pergunta <b>Substituir</b> ou <b>Complementar</b> (soma sem apagar — para matriz + filiais). Cada arquivo pode ser baixado ou excluído individualmente.</p>
        </div>
      )}

      {msg && <p style={{ color: theme.green, fontSize: 13, marginBottom: 14 }}><i className="ti ti-circle-check" /> {msg}</p>}

      {/* Upload */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 22, marginBottom: 18 }}>
        <label style={{ fontSize: 13, color: theme.text, marginBottom: 10, display: 'block' }}>{arquivos.length ? 'Importar outro arquivo do razão' : 'Arquivo do razão'} (Excel do Domínio — .xlsx, .xls ou .csv)</label>
        <DropZone onArquivo={aoEscolherArquivo} hint="Arraste o razão aqui ou clique · .xlsx, .xls ou .csv" />
        {arquivo && <p style={{ fontSize: 12.5, color: theme.sub, marginTop: 10 }}><i className="ti ti-file-spreadsheet" /> {arquivo} — {linhas.length} linha(s) detectada(s)</p>}
      </div>

      {erro && <p style={{ color: theme.red, fontSize: 13, marginBottom: 14 }}>{erro}</p>}

      {pend && (
        <div onClick={() => setPend(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 70 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(470px,96vw)', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
            <h2 style={{ fontSize: 17, margin: '0 0 6px' }}>Já existe razão importado</h2>
            <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 16px' }}>
              Esta competência já tem <b>{arquivos.length}</b> arquivo(s) de razão. O arquivo <b style={{ color: theme.text }}>{pend.nome}</b> traz <b>{pend.registros.length}</b> linha(s). O que fazer? (Use <b>Complementar</b> para <b>somar</b> matriz + filial, sem apagar o que já subiu.)
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-ghost" onClick={() => setPend(null)}>Cancelar</button>
              <button className="btn btn-ghost" style={{ color: theme.red, borderColor: 'rgba(229,72,77,0.4)' }} onClick={() => aplicar(pend, 'substituir')} disabled={importando}><i className="ti ti-refresh" /> Substituir</button>
              <button className="btn" onClick={() => aplicar(pend, 'complementar')} disabled={importando}><i className="ti ti-plus" /> Complementar</button>
            </div>
          </div>
        </div>
      )}

      {/* Mapeamento + prévia */}
      {temArquivo && (
        <>
          <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 22, marginBottom: 18 }}>
            <h3 style={{ fontSize: 14, marginBottom: 4 }}>Mapeamento de colunas</h3>
            <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 16 }}>Confira a correspondência detectada automaticamente e ajuste se necessário.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 12 }}>
              {ALVOS.map(a => (
                <div key={a.key}>
                  <label>{a.label}</label>
                  <select className="input" value={map[a.key] ?? ''} onChange={e => setMap(m => ({ ...m, [a.key]: e.target.value }))}>
                    <option value="">— nenhuma —</option>
                    {headers.map((h, i) => <option key={i} value={i}>{h || `Coluna ${i + 1}`}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </div>

          <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'hidden', marginBottom: 18 }}>
            <p style={{ fontSize: 12.5, color: theme.sub, padding: '12px 16px' }}>Prévia (5 primeiras linhas)</p>
            <table>
              <thead>
                <tr style={{ background: theme.input }}>
                  {ALVOS.map(a => <th key={a.key} style={th}>{a.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {linhas.slice(0, 5).map((l, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                    {ALVOS.map(a => {
                      const v = valorCol(l, a.key)
                      const txt = a.key === 'conta' ? contaDe(l)
                        : (a.key === 'debito' || a.key === 'credito') ? (num(v) ? money(num(v)) : '')
                          : a.key === 'data' ? (toISO(v) || '')
                            : String(v ?? '')
                      return <td key={a.key} style={td}>{txt}</td>
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button className="btn" disabled={importando} onClick={importar} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <i className="ti ti-cloud-upload" /> {importando ? 'Importando…' : `Importar ${linhas.length} linha(s)`}
          </button>
        </>
      )}

      {/* Resultado */}
      {resultado && (
        <div style={{ background: 'rgba(48,164,108,0.1)', border: '0.5px solid rgba(48,164,108,0.4)', borderRadius: 12, padding: 22 }}>
          <h3 style={{ fontSize: 15, color: theme.green, marginBottom: 12 }}><i className="ti ti-circle-check" /> Importação concluída</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: 14 }}>
            <Stat label="Lançamentos" valor={resultado.lancamentos} />
            <Stat label="Contas (balancete)" valor={resultado.contas} />
            <Stat label="Total débito" valor={money(resultado.totDeb)} />
            <Stat label="Total crédito" valor={money(resultado.totCred)} />
          </div>
          <p style={{ color: theme.sub, fontSize: 12.5, marginTop: 14 }}>
            O balancete da competência foi gerado a partir deste razão (saldo final = débito − crédito por conta).
          </p>
        </div>
      )}
    </Wrapper>
  )
}

const th = { textAlign: 'left', padding: '10px 14px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3 }
const td = { padding: '9px 14px', fontSize: 12.5, color: theme.text, whiteSpace: 'nowrap', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }

function Wrapper({ children }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <h1 style={{ fontSize: 22, fontWeight: 500, margin: 0 }}>Importar Razão</h1>
        <InfoTela titulo="Importar Razão">Importa o razão do mês (arquivo do Domínio) — a base de todo o fechamento. Balancete, Conciliação e Comparativo leem daqui. Reimportar <b>substitui</b> o razão daquela competência.</InfoTela>
      </div>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 22 }}>Upload do razão do Domínio, gravação por competência e geração do balancete.</p>
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

function Stat({ label, valor }) {
  return (
    <div>
      <p style={{ color: theme.sub, fontSize: 12, marginBottom: 4 }}>{label}</p>
      <p style={{ fontSize: 20, fontWeight: 700 }}>{valor}</p>
    </div>
  )
}
