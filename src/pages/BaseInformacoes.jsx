import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import DropZone from '../components/DropZone'
import CampoConta from '../components/CampoConta'
import { theme, money } from '../lib/theme'
import { parsePlano, applyMask, normalizaCompetencia } from '../lib/balancete'

const hoje = () => new Date().toLocaleDateString('pt-BR')

// Lê a 1ª planilha detectando a linha de cabeçalho (a 1ª com >=3 células de texto não vazias).
// Necessário p/ exports do Domínio (ex.: plano de contas com cabeçalho na 5ª linha).
function lerPlanilha(XLSX, ws) {
  const matriz = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
  let hdr = 0
  for (let i = 0; i < Math.min(matriz.length, 30); i++) {
    const txt = (matriz[i] || []).filter(c => String(c ?? '').trim().length > 0)
    if (txt.length >= 3) { hdr = i; break }
  }
  return XLSX.utils.sheet_to_json(ws, { range: hdr, defval: '' })
}

const CARGAS = [
  { tipo: 'plano', icon: 'ti-list-numbers', title: 'Plano de contas', sub: 'Com tipo de conciliação' },
  { tipo: 'depara', icon: 'ti-arrows-transfer-down', title: 'De/Para integrações', sub: 'Acumulador → conta' },
  { tipo: 'apelidos', icon: 'ti-book', title: 'Apelidos', sub: 'Leitura de histórico' },
  { tipo: 'financeiro', icon: 'ti-history', title: 'Histórico de lançamentos financeiros', sub: 'Carga inicial · atualiza a cada mês' },
  { tipo: 'bancoresult', icon: 'ti-cash', title: 'Amarração banco × resultado', sub: 'Contas banco e resultados liberados' },
]

// Modelo de planilha de cada carga (colunas + exemplos). Serve para baixar o template
// e para montar o cadastro manual (uma linha por conta).
const MODELOS = {
  plano: {
    cols: ['Código', 'Classificação', 'Nome', 'Tipo', 'Grau'],
    ex: [['1', '1', 'ATIVO', 'S', '1'], ['5', '1110010001', 'CAIXA', 'A', '5']],
    dica: 'Código (reduzido), Classificação (hierárquica), Nome, Tipo (S sintética / A analítica), Grau.',
  },
  depara: {
    cols: ['Acumulador', 'Conta', 'Nome'],
    ex: [['5949', '3.1.1.01', 'Receita de vendas'], ['1102', '4.1.1.01', 'Despesas bancárias']],
    dica: 'Acumulador da integração → conta contábil de destino.',
  },
  apelidos: {
    cols: ['Termo no histórico', 'Cliente/Fornecedor'],
    ex: [['PAGSEG', 'PAGSEGURO INTERNET'], ['CPFL', 'CPFL ENERGIAS RENOVÁVEIS']],
    dica: 'Termo como aparece no histórico → nome real do cliente/fornecedor.',
  },
  financeiro: {
    cols: ['Data', 'Conta', 'Cliente/NF', 'Valor'],
    ex: [['01/01/2026', '1.1.2.01', 'PAGSEGURO NF 3256', '24275.92']],
    dica: 'Saldo de abertura/composição inicial: data, conta, cliente/NF e valor.',
  },
  bancoresult: {
    cols: ['Tipo', 'Código', 'Nome'],
    ex: [['Banco', '1.1.1.01', 'Banco Itaú c/c'], ['Banco', '1.1.1.02', 'Banco Bradesco c/c'], ['Resultado liberado', '4.1.1.01', 'Despesas bancárias / tarifas'], ['Resultado liberado', '3.2.1.01', 'Receita financeira (rendimento)']],
    dica: 'Tipo = "Banco" (conta de banco) ou "Resultado liberado" (resultado que pode receber lançamento direto do banco).',
  },
}

// Modelos da carga inicial — separados por TIPO de conta (Saldo × Composição).
// Conta de Saldo: basta o saldo de abertura. Conta de Composição: sobe os títulos em
// aberto (por cliente/NF) e o sistema confere se a soma bate com o saldo da conta.
const MODELO_SALDOS = {
  cols: ['Código', 'Nome', 'Saldo', 'D/C'],
  ex: [['12', 'Banco Itaú c/c', '15230.45', 'D'], ['340', 'Impostos a recolher', '3120.00', 'C']],
  dica: 'Contas de saldo (banco, aplicação, impostos a recolher…). Uma linha por conta: código da conta (o mesmo do razão/plano), nome, saldo e D/C.',
}
const MODELO_COMP = {
  cols: ['Conta', 'Cliente/Fornecedor', 'NF', 'Valor', 'D/C'],
  ex: [['118', 'PAGSEGURO INTERNET', '3256', '24275.92', 'D'], ['205', 'CPFL ENERGIAS', '8842', '1200.00', 'C']],
  dica: 'Contas de composição (clientes, fornecedores, contas a pagar, adiantamentos). Um título em aberto por linha: código da conta, cliente/fornecedor, NF, valor e D/C.',
}

// Lê valor em formato brasileiro ("1.234,56") ou americano ("1234.56").
function numBR(v) {
  if (typeof v === 'number') return v
  let s = String(v ?? '').trim().replace(/[R$\s]/g, '')
  if (!s) return 0
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
  const n = parseFloat(s)
  return isNaN(n) ? 0 : n
}
// Saldo com sinal: D (devedor) positivo, C (credor) negativo. Usa a coluna D/C;
// na falta dela, respeita o sinal do próprio número.
function saldoComSinal(valor, dc) {
  const n = numBR(valor)
  const s = String(dc ?? '').trim()
  if (/c/i.test(s)) return -Math.abs(n)
  if (/d/i.test(s)) return Math.abs(n)
  return n
}

// Extrai { codigo, nome, tipo, classif } de uma linha salva (qualquer formato de coluna).
const normK = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
// Acha o valor de uma coluna por regex no nome (normalizado).
function campoPor(obj, re) {
  const k = Object.keys(obj || {}).find(k => re.test(normK(k)))
  return k ? obj[k] : ''
}
// Chave de conta p/ casar saldo × composição (dígitos da classificação/código).
const chaveConta = v => String(v ?? '').replace(/\D/g, '')
function extrairConta(obj) {
  const keys = Object.keys(obj || {})
  const acha = re => keys.find(k => re.test(normK(k)))
  const kCod = keys.find(k => /(codigo|conta)/.test(normK(k)) && !/classif/.test(normK(k))) || acha(/^cod/)
  return {
    codigo: String(obj[kCod] ?? '').trim(),
    nome: String(obj[acha(/nome|descri/)] ?? '').trim(),
    tipo: String(obj[acha(/tipo/)] ?? '').trim(),
    classif: String(obj[acha(/classific/)] ?? '').trim(),
  }
}

export default function BaseInformacoes() {
  const { empresaId, empresaNome, recalcularPendencias } = useAppData()
  const { user } = useAuth()

  const [particularidades, setParticularidades] = useState([])
  const [contatos, setContatos] = useState([])
  const [cargas, setCargas] = useState({})
  const [periodo, setPeriodo] = useState('')
  const [cargaSaldos, setCargaSaldos] = useState(false)   // empresa tem saldo inicial (não é nova)
  const [cargaFeita, setCargaFeita] = useState(false)     // carga inicial já lançada
  const [dist, setDist] = useState(null)   // linha de dist_lucros_config
  const [modal, setModal] = useState(null)

  async function carregarCargas() {
    const { data } = await supabase.from('cargas_cadastro')
      .select('id, tipo, vigencia, dados, obs, usuario, created_at')
      .eq('cliente_id', empresaId).order('created_at', { ascending: true })
    const grp = {}
    for (const c of (data || [])) (grp[c.tipo] ||= []).push(c)
    setCargas(grp)
  }
  async function carregarDist() {
    const { data } = await supabase.from('dist_lucros_config').select('*')
      .eq('cliente_id', empresaId).order('created_at', { ascending: false }).limit(1).maybeSingle()
    setDist(data || null)
  }
  useEffect(() => {
    setParticularidades([]); setContatos([]); setCargas({}); setPeriodo(''); setDist(null); setCargaSaldos(false); setCargaFeita(false)
    if (!empresaId) return
    carregarCargas(); carregarDist()
    supabase.from('clientes').select('particularidades, contatos, competencia_inicio, carga_saldos, carga_inicial_feita').eq('id', empresaId).single()
      .then(({ data }) => {
        setParticularidades(data?.particularidades || [])
        setContatos(data?.contatos || [])
        setPeriodo(data?.competencia_inicio || '')
        setCargaSaldos(!!data?.carga_saldos)
        setCargaFeita(!!data?.carga_inicial_feita)
      })
  }, [empresaId])

  function persistirCliente(campo, valor) {
    supabase.from('clientes').update({ [campo]: valor }).eq('id', empresaId).then(() => {})
  }

  if (!empresaId) {
    return <Wrapper><Aviso texto="Selecione uma empresa no menu lateral para ver a Base de Informações." /></Wrapper>
  }

  function salvarPartic(texto, idx) {
    const item = { t: texto, u: user?.email || 'você', d: hoje() }
    const novo = idx == null ? [...particularidades, item] : particularidades.map((x, i) => i === idx ? item : x)
    setParticularidades(novo); persistirCliente('particularidades', novo)
  }
  function removerPartic(idx) {
    const novo = particularidades.filter((_, j) => j !== idx)
    setParticularidades(novo); persistirCliente('particularidades', novo)
  }
  function salvarContato(c, idx) {
    const item = { ...c, u: user?.email || 'você', d: hoje() }
    const novo = idx == null ? [...contatos, item] : contatos.map((x, i) => i === idx ? item : x)
    setContatos(novo); persistirCliente('contatos', novo)
  }
  function removerContato(idx) {
    const novo = contatos.filter((_, j) => j !== idx)
    setContatos(novo); persistirCliente('contatos', novo)
  }
  function salvarPeriodo(v, nova) {
    setPeriodo(v); setCargaSaldos(!nova)
    supabase.from('clientes').update({ competencia_inicio: v, carga_saldos: !nova }).eq('id', empresaId).then(() => recalcularPendencias?.())
    setModal(null)
  }
  function abrirCargaInicial(v) {
    setPeriodo(v); setCargaSaldos(true)
    supabase.from('clientes').update({ competencia_inicio: v, carga_saldos: true }).eq('id', empresaId).then(() => {})
    setModal({ tipo: 'cargaInicial', vigencia: v })
  }
  async function concluirCargaInicial(vigencia, payload, obs) {
    await supabase.from('cargas_cadastro').insert({ cliente_id: empresaId, tipo: 'financeiro', vigencia, dados: payload, usuario: user?.email, obs: 'Carga inicial · ' + obs })
    await supabase.from('clientes').update({ carga_inicial_feita: true }).eq('id', empresaId)
    setCargaFeita(true); carregarCargas(); recalcularPendencias?.(); setModal(null)
  }
  async function salvarDist(cfg) {
    if (dist) await supabase.from('dist_lucros_config').update(cfg).eq('id', dist.id)
    else await supabase.from('dist_lucros_config').insert({ cliente_id: empresaId, usuario: user?.email, ...cfg })
    await carregarDist(); setModal(null)
  }

  return (
    <Wrapper nome={empresaNome}>
      {/* Particularidades */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderLeft: '3px solid #F5A623', borderRadius: '0 12px 12px 0', padding: 20, marginBottom: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 10 }}>
          <p style={{ color: theme.text, fontSize: 15, fontWeight: 600, margin: 0 }}>
            <i className="ti ti-alert-hexagon" style={{ color: '#F5A623', marginRight: 6 }} />Particularidades do cliente
          </p>
          <button className="btn" style={btnMini} onClick={() => setModal({ tipo: 'partic' })}><i className="ti ti-plus" /> Incluir</button>
        </div>
        {particularidades.length === 0
          ? <p style={{ color: theme.sub, fontSize: 12.5 }}>Nenhuma particularidade registrada.</p>
          : particularidades.map((x, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '7px 0', borderBottom: `1px solid ${theme.border}` }}>
              <span style={{ color: theme.text, fontSize: 13, flex: 1 }}>{x.t} <span style={{ color: theme.sub, fontSize: 11 }}>— atualizado por {x.u} · {x.d}</span></span>
              <Acoes onEdit={() => setModal({ tipo: 'partic', idx: i, valor: x.t })} onDel={() => removerPartic(i)} />
            </div>
          ))}
      </div>

      {/* Contatos */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '20px 0 8px', gap: 10 }}>
        <p style={{ color: theme.sub, margin: 0, fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .8 }}>Contatos</p>
        <button className="btn" style={btnMini} onClick={() => setModal({ tipo: 'contato' })}><i className="ti ti-plus" /> Incluir</button>
      </div>
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 20, marginBottom: 22 }}>
        {contatos.length === 0
          ? <p style={{ color: theme.sub, fontSize: 12.5 }}>Nenhum contato cadastrado.</p>
          : contatos.map((x, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: `1px solid ${theme.border}` }}>
              <div>
                <p style={{ color: theme.text, margin: 0, fontSize: 13.5 }}>{x.nome}</p>
                <p style={{ color: theme.sub, fontSize: 11.5, margin: '2px 0 0' }}>{x.tel}{x.email ? ' · ' + x.email : ''}</p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ color: theme.sub, fontSize: 11, whiteSpace: 'nowrap' }}>{x.u} · {x.d}</span>
                <Acoes onEdit={() => setModal({ tipo: 'contato', idx: i, valor: x })} onDel={() => removerContato(i)} />
              </div>
            </div>
          ))}
      </div>

      {/* Parâmetros do fechamento */}
      <p style={{ color: theme.sub, fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .8, margin: '4px 0 12px' }}>Parâmetros do fechamento</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
        <CargaCard {...CARGAS[0]} ultima={cargas.plano?.at(-1)} onClick={() => setModal({ tipo: 'carga', carga: CARGAS[0] })} />
        <CargaCard {...CARGAS[1]} ultima={cargas.depara?.at(-1)} onClick={() => setModal({ tipo: 'carga', carga: CARGAS[1] })} />
        <CargaCard {...CARGAS[2]} ultima={cargas.apelidos?.at(-1)} onClick={() => setModal({ tipo: 'carga', carga: CARGAS[2] })} />
        <SimplesCard icon="ti-file-description" title="Modelos de relatório" sub="Balancete, DRE, DFC" onClick={() => setModal({ tipo: 'modelos' })} />
        <SimplesCard icon="ti-calendar-event" title="Período de início" sub={periodo ? `${periodo} · trava o passado` : 'Trava o passado'}
          badge={!periodo
            ? { txt: 'definir', cor: theme.yellow, bg: 'rgba(245,166,35,0.15)' }
            : (cargaSaldos && !cargaFeita)
              ? { txt: 'carga pendente', cor: theme.yellow, bg: 'rgba(245,166,35,0.15)' }
              : { txt: `início ${periodo}`, cor: theme.green, bg: 'rgba(48,164,108,0.15)' }}
          onClick={() => setModal({ tipo: 'periodo' })} />
        <CargaCard {...CARGAS[3]} ultima={cargas.financeiro?.at(-1)} onClick={() => setModal({ tipo: 'carga', carga: CARGAS[3] })} />
        <CargaCard {...CARGAS[4]} ultima={cargas.bancoresult?.at(-1)} onClick={() => setModal({ tipo: 'carga', carga: CARGAS[4] })} />
        <SimplesCard icon="ti-users" title="Distribuição de lucros" sub="Limite, alíquota e sócios (IRRF 2026)"
          badge={dist ? { txt: 'configurado', cor: theme.green, bg: 'rgba(48,164,108,0.15)' } : null}
          onClick={() => setModal({ tipo: 'dist' })} />
      </div>

      {/* Modais */}
      {modal?.tipo === 'carga' && (
        <ModalCarga carga={modal.carga} historico={cargas[modal.carga.tipo] || []} empresaId={empresaId} usuario={user?.email}
          onClose={() => setModal(null)} onImportado={carregarCargas} />
      )}
      {modal?.tipo === 'partic' && (
        <ModalTexto titulo={modal.idx == null ? 'Nova particularidade' : 'Editar particularidade'} valorInicial={modal.valor || ''}
          label="Particularidade" onClose={() => setModal(null)} onSalvar={v => { salvarPartic(v, modal.idx); setModal(null) }} />
      )}
      {modal?.tipo === 'contato' && (
        <ModalContato valorInicial={modal.valor} onClose={() => setModal(null)} onSalvar={c => { salvarContato(c, modal.idx); setModal(null) }} />
      )}
      {modal?.tipo === 'periodo' && (
        <ModalPeriodo valorInicial={periodo} cargaSaldos={cargaSaldos} cargaFeita={cargaFeita}
          onClose={() => setModal(null)} onSalvar={salvarPeriodo} onFazerCarga={abrirCargaInicial} />
      )}
      {modal?.tipo === 'cargaInicial' && (
        <ModalCargaInicial vigencia={modal.vigencia} empresaId={empresaId} onClose={() => setModal(null)} onConcluir={concluirCargaInicial} />
      )}
      {modal?.tipo === 'dist' && (
        <ModalDist inicial={dist} onClose={() => setModal(null)} onSalvar={salvarDist} />
      )}
      {modal?.tipo === 'modelos' && (
        <ModalSimples titulo="Modelos de relatório" texto="Os modelos do escritório (Balancete, DRE, DFC, Balanço) já são gerados na tela de Relatórios a partir do balancete da competência, com exportação para Excel (.xlsx) no papel timbrado da Attentive. A personalização de modelos por cliente entra em breve." onClose={() => setModal(null)} />
      )}
    </Wrapper>
  )
}

/* ---------- Cards ---------- */
function CargaCard({ icon, title, sub, ultima, onClick }) {
  return (
    <div onClick={onClick} style={cardBase}>
      <IconeBadge icon={icon} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ color: theme.text, fontSize: 14, fontWeight: 500, margin: 0 }}>{title}</p>
        <p style={{ color: theme.sub, fontSize: 12, margin: '2px 0 0' }}>{sub}</p>
      </div>
      {ultima
        ? <span style={badge('rgba(48,164,108,0.15)', theme.green)}>vigência {ultima.vigencia}</span>
        : <span style={badge('rgba(245,166,35,0.15)', theme.yellow)}>carga pendente</span>}
    </div>
  )
}
function SimplesCard({ icon, title, sub, onClick, badge: b }) {
  return (
    <div onClick={onClick} style={{ ...cardBase, cursor: onClick ? 'pointer' : 'default' }}>
      <IconeBadge icon={icon} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ color: theme.text, fontSize: 14, fontWeight: 500, margin: 0 }}>{title}</p>
        <p style={{ color: theme.sub, fontSize: 12, margin: '2px 0 0' }}>{sub}</p>
      </div>
      {b && <span style={badge(b.bg || 'rgba(255,255,255,0.06)', b.cor)}>{b.txt}</span>}
    </div>
  )
}
function IconeBadge({ icon }) {
  return (
    <span style={{ background: 'rgba(74,124,255,0.15)', borderRadius: 10, width: 42, height: 42, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <i className={`ti ${icon}`} style={{ color: theme.accent, fontSize: 20 }} />
    </span>
  )
}
function Acoes({ onEdit, onDel }) {
  return (
    <span style={{ display: 'flex', gap: 12, flexShrink: 0 }}>
      <i className="ti ti-pencil" style={{ color: theme.sub, cursor: 'pointer', fontSize: 14 }} onClick={onEdit} title="Editar" />
      <i className="ti ti-trash" style={{ color: theme.sub, cursor: 'pointer', fontSize: 14 }} onClick={onDel} title="Excluir" />
    </span>
  )
}

/* ---------- Modais ---------- */
function ModalCarga({ carga, historico, empresaId, usuario, onClose, onImportado }) {
  const modelo = MODELOS[carga.tipo] || { cols: ['Código', 'Nome'], ex: [], dica: '' }
  const linhaVazia = () => Object.fromEntries(modelo.cols.map(c => [c, '']))
  const [vigencia, setVigencia] = useState('')
  const [modo, setModo] = useState('arquivo') // 'arquivo' | 'manual'
  const [linhas, setLinhas] = useState([linhaVazia()])
  const [erro, setErro] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [planoIdx, setPlanoIdx] = useState(null) // { porRed, porNum, mascara } p/ puxar nome pelo código
  const [hist, setHist] = useState(historico || []) // cargas (vigências) já salvas — recarrega ao salvar
  const [msgOk, setMsgOk] = useState('')
  const vigOk = /^\d{2}\/\d{4}$/.test(vigencia)

  async function recarregar() {
    const { data } = await supabase.from('cargas_cadastro').select('id, vigencia, dados, usuario, obs, created_at')
      .eq('cliente_id', empresaId).eq('tipo', carga.tipo).order('created_at', { ascending: true })
    setHist(data || [])
  }

  // Carrega o plano de contas para autopreencher nome/classificação a partir do código.
  useEffect(() => {
    supabase.from('cargas_cadastro').select('dados').eq('cliente_id', empresaId).eq('tipo', 'plano')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
      .then(({ data }) => {
        const plano = parsePlano(data?.dados)
        const porRed = {}, porNum = {}
        for (const p of plano) {
          if (p.reduzido) porRed[p.reduzido] = p
          if (p.classif) porNum[p.classif.replace(/\D/g, '')] = p
        }
        setPlanoIdx({ porRed, porNum, mascara: plano.find(p => p.mascara)?.mascara || '9.9.9.999.9999' })
      })
  }, [empresaId])

  // Acha a conta no plano pelo código digitado (reduzido ou classificação, com/sem máscara).
  function buscaConta(v) {
    if (!planoIdx) return null
    const t = String(v || '').trim(); if (!t) return null
    if (planoIdx.porRed[t]) return planoIdx.porRed[t]
    return planoIdx.porNum[t.replace(/\D/g, '')] || null
  }

  // Colunas do modelo: qual é a de código, nome e classificação (para autopreencher).
  const colCod = modelo.cols.find(c => /(c[oó]digo|conta)/i.test(c) && !/classific/i.test(c))
  const colNome = modelo.cols.find(c => /nome/i.test(c))
  const colClassif = modelo.cols.find(c => /classific/i.test(c))

  async function baixarModelo() {
    const XLSX = await import('xlsx')
    const ws = XLSX.utils.aoa_to_sheet([modelo.cols, ...(modelo.ex || [])])
    ws['!cols'] = modelo.cols.map(c => ({ wch: Math.max(14, c.length + 4) }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Modelo')
    XLSX.writeFile(wb, `modelo_${carga.tipo}.xlsx`)
  }

  // Sobrepõe a carga da mesma vigência (se houver) antes de inserir a nova.
  async function sobreporSeMesma() {
    const mesma = (hist || []).filter(h => h.vigencia === vigencia)
    if (mesma.length) {
      if (!confirm(`Já existe carga para a vigência ${vigencia}. Deseja sobrepor (substituir)?`)) return false
      for (const m of mesma) await supabase.from('cargas_cadastro').delete().eq('id', m.id)
    }
    return true
  }

  // Escolher/arrastar o arquivo já importa na hora (a vigência precisa estar preenchida antes).
  async function importarArquivo(file) {
    if (!file) return
    if (!vigOk) { setErro('Informe a vigência (MM/AAAA) antes de escolher o arquivo.'); return }
    setErro(''); setSalvando(true)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const dados = lerPlanilha(XLSX, wb.Sheets[wb.SheetNames[0]])
      if (!dados.length) { setErro('Planilha vazia.'); setSalvando(false); return }
      if (!(await sobreporSeMesma())) { setSalvando(false); return }
      const { error } = await supabase.from('cargas_cadastro').insert({
        cliente_id: empresaId, tipo: carga.tipo, vigencia, dados, usuario, obs: file.name,
      })
      if (error) throw error
      await recarregar(); onImportado(); setSalvando(false); setMsgOk(`Importado · vigência ${vigencia}.`)
    } catch (err) { setErro('Erro ao importar: ' + err.message); setSalvando(false) }
  }

  async function salvarManual() {
    if (!vigOk) { setErro('Informe a vigência (MM/AAAA) antes de salvar.'); return }
    const dados = linhas.filter(l => Object.values(l).some(v => String(v).trim()))
    if (!dados.length) { setErro('Preencha ao menos uma linha.'); return }
    setErro(''); setSalvando(true)
    try {
      if (!(await sobreporSeMesma())) { setSalvando(false); return }
      const { error } = await supabase.from('cargas_cadastro').insert({
        cliente_id: empresaId, tipo: carga.tipo, vigencia, dados, usuario, obs: 'Cadastro manual',
      })
      if (error) throw error
      await recarregar(); onImportado(); setSalvando(false); setMsgOk(`Salvo · vigência ${vigencia} (${dados.length} conta(s)).`)
    } catch (err) { setErro('Erro ao salvar: ' + err.message); setSalvando(false) }
  }

  // Carrega as linhas de uma vigência no editor manual (para editar e salvar de novo).
  function editarVigencia(c) {
    setVigencia(c.vigencia || '')
    setModo('manual'); setMsgOk(''); setErro('')
    const colTipo = modelo.cols.find(k => /tipo/i.test(k))
    const ls = (Array.isArray(c.dados) ? c.dados : []).map(o => {
      const ec = extrairConta(o); const row = linhaVazia()
      if (colCod) row[colCod] = ec.codigo
      if (colNome) row[colNome] = ec.nome
      if (colTipo) row[colTipo] = ec.tipo
      if (colClassif) row[colClassif] = ec.classif
      return row
    })
    setLinhas(ls.length ? ls : [linhaVazia()])
  }
  function novaVigencia() { setVigencia(''); setLinhas([linhaVazia()]); setModo('manual'); setMsgOk(''); setErro('') }

  function setCelV(i, col, v) {
    setLinhas(ls => ls.map((l, j) => {
      if (j !== i) return l
      const nova = { ...l, [col]: v }
      // Ao informar o código, puxa nome e classificação do plano de contas.
      if (col === colCod) {
        const p = buscaConta(v)
        if (p) {
          if (colNome) nova[colNome] = p.nome
          if (colClassif && colClassif !== colCod) nova[colClassif] = applyMask(p.classif, planoIdx?.mascara)
        }
      }
      return nova
    }))
  }
  const setCel = (i, col) => e => setCelV(i, col, e.target.value)

  async function excluirVigencia(id) {
    if (!confirm('Excluir esta vigência da carga?')) return
    await supabase.from('cargas_cadastro').delete().eq('id', id)
    await recarregar(); onImportado()
  }

  // Carga mais recente → "Contas já cadastradas".
  const cargaRecente = hist.length ? hist[hist.length - 1] : null
  const contasCad = cargaRecente ? (Array.isArray(cargaRecente.dados) ? cargaRecente.dados : []).map(extrairConta).filter(c => c.codigo || c.nome) : []
  const ehBR = carga.tipo === 'bancoresult'
  const bancosCad = contasCad.filter(c => normK(c.tipo).includes('banco'))
  const resultCad = contasCad.filter(c => /result|liber/.test(normK(c.tipo)))
  const credito = cargaRecente ? `${(cargaRecente.usuario || '').split('@')[0] || '—'} · ${new Date(cargaRecente.created_at).toLocaleDateString('pt-BR')}` : ''
  const LinhaConta = ({ c }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: `1px solid ${theme.border}`, fontSize: 13 }}>
      <span style={{ color: theme.text }}><span style={{ color: theme.sub }}>{c.codigo}</span>{c.codigo && c.nome ? ' · ' : ''}{c.nome}</span>
      <span style={{ color: theme.sub, fontSize: 12, whiteSpace: 'nowrap' }}>{credito}</span>
    </div>
  )
  const SubTit = ({ children }) => <p style={{ color: theme.sub, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .4, margin: '14px 0 2px' }}>{children}</p>

  return (
    <Modal titulo={carga.title} sub={carga.sub} onClose={onClose} largura={680}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
        <p style={{ color: theme.sub, fontSize: 12.5, margin: 0, flex: 1 }}>{modelo.dica || 'Importe a planilha ou cadastre manualmente.'} Cada carga cria uma <b style={{ color: theme.text }}>vigência</b> e preserva o histórico.</p>
        <button className="btn btn-ghost" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }} onClick={baixarModelo}><i className="ti ti-download" /> Baixar modelo</button>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label>1. Vigência (MM/AAAA)</label>
        <input className="input" style={{ maxWidth: 220 }} value={vigencia} onChange={e => setVigencia(e.target.value)} placeholder="01/2026" autoFocus />
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button className={modo === 'arquivo' ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 13 }} onClick={() => setModo('arquivo')}><i className="ti ti-cloud-upload" /> Importar planilha</button>
        <button className={modo === 'manual' ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 13 }} onClick={() => setModo('manual')}><i className="ti ti-keyboard" /> Cadastrar manual</button>
      </div>

      {modo === 'arquivo' ? (
        <>
          <label>2. Arquivo</label>
          <DropZone onArquivo={importarArquivo} disabled={!vigOk || salvando}
            hint={vigOk ? 'Arraste ou clique · .xlsx, .xls ou .csv' : 'Informe a vigência primeiro'} />
          {salvando && <p style={{ color: theme.accent, fontSize: 12, marginTop: 8 }}><i className="ti ti-loader" /> Importando…</p>}
        </>
      ) : (
        <>
          <label>2. Linhas (uma conta por linha){colCod && colNome ? ' — digite o código que o nome é puxado do plano' : ''}</label>
          <div style={{ overflowX: 'auto', border: `0.5px solid ${theme.cb}`, borderRadius: 10 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 480 }}>
              <thead>
                <tr style={{ background: theme.input }}>
                  {modelo.cols.map(c => <th key={c} style={{ textAlign: 'left', padding: '8px 10px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3 }}>{c}</th>)}
                  <th style={{ width: 34 }} />
                </tr>
              </thead>
              <tbody>
                {linhas.map((l, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${theme.border}` }}>
                    {modelo.cols.map(c => (
                      <td key={c} style={{ padding: 4 }}>
                        {c === 'Tipo' && carga.tipo === 'bancoresult'
                          ? <select className="input" style={{ minWidth: 150 }} value={l[c]} onChange={setCel(i, c)}><option value="">—</option><option value="Banco">Banco</option><option value="Resultado liberado">Resultado liberado</option></select>
                          : c === colCod
                            ? <CampoConta value={l[c]} onChange={v => setCelV(i, c, v)} onPick={p => setCelV(i, c, p.cod)} placeholder={`${c} (F4)`} style={{ minWidth: 160 }} />
                            : <input className="input" value={l[c]} onChange={setCel(i, c)} placeholder={c} />}
                      </td>
                    ))}
                    <td style={{ textAlign: 'center' }}>
                      <i className="ti ti-trash" title="Remover linha" onClick={() => setLinhas(ls => ls.filter((_, j) => j !== i).length ? ls.filter((_, j) => j !== i) : [linhaVazia()])} style={{ color: theme.sub, cursor: 'pointer' }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
            <button className="btn btn-ghost" style={{ fontSize: 12.5 }} onClick={() => setLinhas(ls => [...ls, linhaVazia()])}><i className="ti ti-plus" /> Adicionar linha</button>
            <button className="btn" disabled={salvando} onClick={salvarManual}>{salvando ? 'Salvando…' : 'Salvar cadastro'}</button>
          </div>
        </>
      )}
      {erro && <p style={{ color: theme.red, fontSize: 13, margin: '10px 0 0' }}>{erro}</p>}
      {msgOk && <p style={{ color: theme.green, fontSize: 13, margin: '10px 0 0' }}><i className="ti ti-circle-check" /> {msgOk}</p>}

      {/* Histórico de vigências */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '22px 0 6px' }}>
        <p style={{ color: theme.sub, fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .6, margin: 0 }}>Histórico de vigências</p>
        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={novaVigencia}><i className="ti ti-plus" /> Nova vigência</button>
      </div>
      {hist.length === 0
        ? <p style={{ color: theme.sub, fontSize: 12.5 }}>Nenhuma carga ainda.</p>
        : hist.slice().reverse().map(c => (
          <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: `1px solid ${theme.border}`, fontSize: 12.5 }}>
            <span style={{ color: theme.text }}>Vigência <b>{c.vigencia || '—'}</b> · {Array.isArray(c.dados) ? c.dados.length : ((c.dados?.saldos?.length || 0) + (c.dados?.composicoes?.length || 0))} item(ns) <span style={{ color: theme.sub }}>· {c.obs || ''}</span></span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ color: theme.sub, whiteSpace: 'nowrap' }}>{(c.usuario || '').split('@')[0]} · {new Date(c.created_at).toLocaleDateString('pt-BR')}</span>
              <i className="ti ti-pencil" title="Editar esta vigência" onClick={() => editarVigencia(c)} style={{ color: theme.accent, cursor: 'pointer', flexShrink: 0 }} />
              <i className="ti ti-trash" title="Excluir esta vigência" onClick={() => excluirVigencia(c.id)} style={{ color: theme.sub, cursor: 'pointer', flexShrink: 0 }} />
            </span>
          </div>
        ))}

      {/* Contas já cadastradas (carga mais recente) */}
      {contasCad.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <p style={{ fontSize: 15, fontWeight: 600, margin: '0 0 4px' }}>Contas já cadastradas</p>
          {ehBR ? (
            <>
              <SubTit>Contas de banco</SubTit>
              {bancosCad.length ? bancosCad.map((c, i) => <LinhaConta key={'b' + i} c={c} />) : <p style={{ color: theme.sub, fontSize: 12.5 }}>—</p>}
              <SubTit>Resultados liberados (lançamento direto do banco)</SubTit>
              {resultCad.length ? resultCad.map((c, i) => <LinhaConta key={'r' + i} c={c} />) : <p style={{ color: theme.sub, fontSize: 12.5 }}>—</p>}
            </>
          ) : (
            contasCad.map((c, i) => <LinhaConta key={i} c={c} />)
          )}
        </div>
      )}
    </Modal>
  )
}

function ModalTexto({ titulo, label, valorInicial, onClose, onSalvar }) {
  const [v, setV] = useState(valorInicial)
  return (
    <Modal titulo={titulo} onClose={onClose}>
      <label>{label}</label>
      <textarea className="input" rows={3} value={v} onChange={e => setV(e.target.value)} autoFocus />
      <Rodape onClose={onClose} onSalvar={() => v.trim() && onSalvar(v.trim())} />
    </Modal>
  )
}

function ModalContato({ valorInicial, onClose, onSalvar }) {
  const [f, setF] = useState(valorInicial || { nome: '', tel: '', email: '' })
  const set = k => e => setF(s => ({ ...s, [k]: e.target.value }))
  return (
    <Modal titulo={valorInicial ? 'Editar contato' : 'Novo contato'} onClose={onClose}>
      <div style={{ display: 'grid', gap: 12 }}>
        <div><label>Nome</label><input className="input" value={f.nome} onChange={set('nome')} autoFocus /></div>
        <div><label>Telefone</label><input className="input" value={f.tel} onChange={set('tel')} /></div>
        <div><label>E-mail</label><input className="input" value={f.email} onChange={set('email')} /></div>
      </div>
      <Rodape onClose={onClose} onSalvar={() => f.nome.trim() && onSalvar(f)} />
    </Modal>
  )
}

function mesAnterior(p) {
  const m = String(p || '').match(/^(\d{2})\/(\d{4})$/)
  if (!m) return '—'
  let mes = +m[1], ano = +m[2]
  mes -= 1; if (mes === 0) { mes = 12; ano -= 1 }
  return `${String(mes).padStart(2, '0')}/${ano}`
}

function ModalPeriodo({ valorInicial, cargaSaldos, cargaFeita, onClose, onSalvar, onFazerCarga }) {
  const [v, setV] = useState(valorInicial || '')
  const [nova, setNova] = useState(valorInicial ? !cargaSaldos : false)
  const [erro, setErro] = useState('')
  const vNorm = normalizaCompetencia(v)            // aceita data/serial e normaliza p/ MM/AAAA
  const ok = /^\d{2}\/\d{4}$/.test(vNorm)
  const valida = () => ok ? true : (setErro('Use o formato MM/AAAA.'), false)

  return (
    <Modal titulo={`Período de início${ok ? ' — ' + vNorm : ''}`} onClose={onClose} largura={560}>
      <label>Competência de início (MM/AAAA)</label>
      <input className="input" value={v} onChange={e => setV(e.target.value)} placeholder="04/2026" autoFocus />
      <p style={{ color: theme.sub, fontSize: 12.5, margin: '10px 0 0', lineHeight: 1.55 }}>
        A partir desta competência o passado fica travado. O mês anterior ({mesAnterior(vNorm)}) é o saldo de abertura.
      </p>

      <label style={{ display: 'flex', alignItems: 'center', gap: 9, margin: '16px 0 0', cursor: 'pointer', color: theme.text, fontSize: 13 }}>
        <input type="checkbox" checked={nova} onChange={e => setNova(e.target.checked)} />
        Empresa nova — não tem saldo inicial
      </label>

      {!nova && (
        <div style={{ background: theme.input, border: `1px solid ${cargaFeita ? 'rgba(48,164,108,0.45)' : 'rgba(245,166,35,0.45)'}`, borderRadius: 10, padding: 16, marginTop: 14 }}>
          <p style={{ color: theme.text, fontSize: 14, fontWeight: 600, margin: 0 }}>Carga inicial de saldos e composições</p>
          <p style={{ color: theme.sub, fontSize: 12.5, margin: '6px 0 0', lineHeight: 1.55 }}>
            Lance o saldo de abertura de cada conta e, nas contas de composição, os itens iniciais (por cliente/NF).
            Pode fazer agora ou depois — mas o primeiro fechamento só encerra com a carga concluída.
          </p>
          <p style={{ color: cargaFeita ? theme.green : theme.yellow, fontSize: 13, fontWeight: 600, margin: '10px 0 0' }}>
            <i className={`ti ${cargaFeita ? 'ti-circle-check' : 'ti-alert-triangle'}`} /> {cargaFeita ? 'Carga inicial concluída.' : 'Carga inicial pendente.'}
          </p>
        </div>
      )}

      {erro && <p style={{ color: theme.red, fontSize: 12.5, marginTop: 8 }}>{erro}</p>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
        <button className="btn btn-ghost" onClick={() => valida() && onSalvar(vNorm, nova)}>{nova ? 'Salvar' : 'Depois'}</button>
        {!nova && <button className="btn" onClick={() => valida() && onFazerCarga(vNorm)}><i className="ti ti-cloud-upload" /> Fazer agora</button>}
      </div>
    </Modal>
  )
}

function ModalCargaInicial({ vigencia, empresaId, onClose, onConcluir }) {
  const [saldos, setSaldos] = useState(null)        // { nome, dados:[...] }
  const [comp, setComp] = useState(null)            // { nome, dados:[...] }
  const [erro, setErro] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [planoNomes, setPlanoNomes] = useState({})  // chaveConta → nome (fallback p/ conferência)

  // Nomes do plano p/ exibir na conferência quando a conta não veio no bloco de saldos.
  useEffect(() => {
    if (!empresaId) return
    supabase.from('cargas_cadastro').select('dados').eq('cliente_id', empresaId).eq('tipo', 'plano')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
      .then(({ data }) => {
        const m = {}
        for (const p of parsePlano(data?.dados)) {
          if (p.classif) m[chaveConta(p.classif)] = p.nome
          if (p.reduzido) m[chaveConta(p.reduzido)] = p.nome
        }
        setPlanoNomes(m)
      })
  }, [empresaId])

  async function lerArquivo(file, setter) {
    if (!file) return
    setErro('')
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const dados = lerPlanilha(XLSX, wb.Sheets[wb.SheetNames[0]])
      if (!dados.length) { setErro('Planilha vazia.'); return }
      setter({ nome: file.name, dados })
    } catch (err) { setErro('Não consegui ler: ' + err.message) }
  }

  async function baixarModelo(modelo, arquivo) {
    const XLSX = await import('xlsx')
    const ws = XLSX.utils.aoa_to_sheet([modelo.cols, ...(modelo.ex || [])])
    ws['!cols'] = modelo.cols.map(c => ({ wch: Math.max(16, c.length + 4) }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Modelo')
    XLSX.writeFile(wb, arquivo)
  }

  // Conferência: soma da composição por conta × saldo informado no bloco de saldos.
  const conferencia = (() => {
    const compRows = comp?.dados || []
    if (!compRows.length) return []
    // Saldo informado por conta (chave dígitos).
    const saldoPorConta = {}
    const nomePorConta = {}
    for (const r of (saldos?.dados || [])) {
      const cod = campoPor(r, /(codigo|conta)/) || campoPor(r, /^cod/)
      const k = chaveConta(cod); if (!k) continue
      saldoPorConta[k] = (saldoPorConta[k] || 0) + saldoComSinal(campoPor(r, /saldo|valor/), campoPor(r, /^d\/?c$|natureza/))
      nomePorConta[k] = campoPor(r, /nome|descri/) || nomePorConta[k]
    }
    // Soma da composição por conta.
    const compPorConta = {}
    for (const r of compRows) {
      const cod = campoPor(r, /^conta$|(codigo|conta)/) || campoPor(r, /^cod/)
      const k = chaveConta(cod); if (!k) continue
      compPorConta[k] = (compPorConta[k] || 0) + saldoComSinal(campoPor(r, /valor|saldo/), campoPor(r, /^d\/?c$|natureza/))
    }
    return Object.keys(compPorConta).map(k => {
      const somaComp = compPorConta[k]
      const saldo = saldoPorConta[k]
      const temSaldo = saldoPorConta[k] !== undefined
      const diff = temSaldo ? (saldo - somaComp) : null
      return {
        k, nome: nomePorConta[k] || planoNomes[k] || '',
        somaComp, saldo, temSaldo, diff,
        ok: temSaldo && Math.abs(diff) < 0.005,
      }
    }).sort((a, b) => a.k.localeCompare(b.k))
  })()

  const temAlgo = (saldos?.dados?.length || 0) + (comp?.dados?.length || 0) > 0
  const temDivergencia = conferencia.some(c => !c.ok)

  async function concluir() {
    setSalvando(true)
    const obsArq = [saldos?.nome, comp?.nome].filter(Boolean).join(' + ') || 'manual'
    await onConcluir(vigencia, { saldos: saldos?.dados || [], composicoes: comp?.dados || [] }, obsArq)
  }

  const Bloco = ({ icon, titulo, dica, modelo, arquivo, estado, setter }) => (
    <div style={{ background: theme.input, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 16, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
        <div style={{ flex: 1 }}>
          <p style={{ color: theme.text, fontSize: 14, fontWeight: 600, margin: 0 }}><i className={`ti ${icon}`} style={{ color: theme.accent, marginRight: 6 }} />{titulo}</p>
          <p style={{ color: theme.sub, fontSize: 12, margin: '4px 0 0', lineHeight: 1.5 }}>{dica}</p>
        </div>
        <button className="btn btn-ghost" style={{ fontSize: 12, whiteSpace: 'nowrap' }} onClick={() => baixarModelo(modelo, arquivo)}><i className="ti ti-download" /> Modelo</button>
      </div>
      <DropZone onArquivo={f => lerArquivo(f, setter)} hint="Arraste ou clique · .xlsx, .xls ou .csv" />
      {estado && (
        <p style={{ color: theme.green, fontSize: 12.5, marginTop: 8 }}>
          <i className="ti ti-circle-check" /> {estado.nome} — {estado.dados.length} linha(s)
          <i className="ti ti-x" title="Remover" onClick={() => setter(null)} style={{ color: theme.sub, cursor: 'pointer', marginLeft: 8 }} />
        </p>
      )}
    </div>
  )

  return (
    <Modal titulo="Carga inicial de saldos" sub={`Saldo de abertura — vigência ${vigencia}`} onClose={onClose} largura={640}>
      <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 14, lineHeight: 1.55 }}>
        São <b style={{ color: theme.text }}>dois tipos de conta</b>: as de <b style={{ color: theme.text }}>saldo</b> (basta o valor de abertura) e as de
        <b style={{ color: theme.text }}> composição</b> (clientes, fornecedores, contas a pagar…) que precisam dos títulos em aberto.
        O sistema confere se a composição bate com o saldo da conta.
      </p>

      {Bloco({ icon: 'ti-scale', titulo: '1. Saldos de abertura', dica: MODELO_SALDOS.dica,
        modelo: MODELO_SALDOS, arquivo: 'modelo_saldos_abertura.xlsx', estado: saldos, setter: setSaldos })}

      {Bloco({ icon: 'ti-list-details', titulo: '2. Composições de abertura', dica: MODELO_COMP.dica,
        modelo: MODELO_COMP, arquivo: 'modelo_composicoes_abertura.xlsx', estado: comp, setter: setComp })}

      {/* Conferência composição × saldo */}
      {conferencia.length > 0 && (
        <div style={{ marginTop: 4, marginBottom: 8 }}>
          <p style={{ color: theme.sub, fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .5, margin: '0 0 6px' }}>Conferência composição × saldo</p>
          {conferencia.map(c => (
            <div key={c.k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '7px 0', borderTop: `1px solid ${theme.border}`, fontSize: 12.5 }}>
              <span style={{ color: theme.text }}>
                <i className={`ti ${c.ok ? 'ti-circle-check' : 'ti-alert-triangle'}`} style={{ color: c.ok ? theme.green : theme.yellow, marginRight: 6 }} />
                {c.nome || c.k}
              </span>
              <span style={{ color: theme.sub, fontSize: 12, whiteSpace: 'nowrap', textAlign: 'right' }}>
                comp. {money(Math.abs(c.somaComp))} {c.somaComp < 0 ? 'C' : 'D'}
                {c.temSaldo
                  ? <> · saldo {money(Math.abs(c.saldo))} {c.saldo < 0 ? 'C' : 'D'}{c.ok ? '' : <b style={{ color: theme.yellow }}> · dif {money(Math.abs(c.diff))}</b>}</>
                  : <b style={{ color: theme.yellow }}> · sem saldo informado</b>}
              </span>
            </div>
          ))}
          {temDivergencia && <p style={{ color: theme.yellow, fontSize: 12, margin: '8px 0 0' }}><i className="ti ti-info-circle" /> Há contas em que a composição não fecha com o saldo. Você pode concluir mesmo assim e ajustar depois.</p>}
        </div>
      )}

      {erro && <p style={{ color: theme.red, fontSize: 13, marginTop: 10 }}>{erro}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn" disabled={!temAlgo || salvando} onClick={concluir}>
          <i className="ti ti-cloud-upload" /> {salvando ? 'Concluindo…' : 'Concluir carga inicial'}
        </button>
      </div>
    </Modal>
  )
}

function ModalDist({ inicial, onClose, onSalvar }) {
  const [limite, setLimite] = useState(inicial?.limite ?? 50000)
  const [aliquota, setAliquota] = useState(inicial?.aliquota ?? 10)
  const [contas, setContas] = useState(inicial?.contas?.length ? inicial.contas : [{ cod: '', nome: '' }])
  const [socios, setSocios] = useState(inicial?.socios?.length ? inicial.socios : [{ nome: '', ident: '' }])
  const [salvando, setSalvando] = useState(false)

  const upd = (set, i, k) => e => set(l => l.map((x, j) => j === i ? { ...x, [k]: e.target.value } : x))
  const rem = (set, i) => set(l => l.filter((_, j) => j !== i))

  async function salvar() {
    setSalvando(true)
    await onSalvar({
      limite: Number(limite) || 0, aliquota: Number(aliquota) || 0,
      contas: contas.filter(c => c.cod || c.nome), socios: socios.filter(s => s.nome || s.ident),
    })
    setSalvando(false)
  }

  return (
    <Modal titulo="Distribuição de lucros · IRRF 2026" sub="Lei 15.270/2025 — limite, alíquota, contas observadas e sócios." onClose={onClose} largura={640}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <div><label>Limite mensal por sócio (R$)</label><input className="input" type="number" value={limite} onChange={e => setLimite(e.target.value)} /></div>
        <div><label>Alíquota de IRRF (%)</label><input className="input" type="number" value={aliquota} onChange={e => setAliquota(e.target.value)} /></div>
      </div>

      <LinhaTitulo titulo="Contas de distribuição observadas" onAdd={() => setContas(l => [...l, { cod: '', nome: '' }])} />
      {contas.map((c, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input className="input" style={{ width: 130 }} placeholder="Código" value={c.cod} onChange={upd(setContas, i, 'cod')} />
          <input className="input" style={{ flex: 1 }} placeholder="Nome da conta" value={c.nome} onChange={upd(setContas, i, 'nome')} />
          <i className="ti ti-trash" onClick={() => rem(setContas, i)} style={{ color: theme.sub, cursor: 'pointer', alignSelf: 'center' }} />
        </div>
      ))}

      <LinhaTitulo titulo="Sócios" onAdd={() => setSocios(l => [...l, { nome: '', ident: '' }])} />
      {socios.map((s, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input className="input" style={{ flex: 1 }} placeholder="Nome do sócio" value={s.nome} onChange={upd(setSocios, i, 'nome')} />
          <input className="input" style={{ flex: 1 }} placeholder="Identificação no razão (CC/histórico)" value={s.ident} onChange={upd(setSocios, i, 'ident')} />
          <i className="ti ti-trash" onClick={() => rem(setSocios, i)} style={{ color: theme.sub, cursor: 'pointer', alignSelf: 'center' }} />
        </div>
      ))}

      <p style={{ color: theme.sub, fontSize: 11.5, margin: '12px 0 0' }}>Estimativa para revisão humana — o razão não distingue sozinho lucro de 2025 (isento) de lucro novo.</p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn" disabled={salvando} onClick={salvar}>{salvando ? 'Salvando…' : 'Salvar configuração'}</button>
      </div>
    </Modal>
  )
}

function ModalSimples({ titulo, texto, onClose }) {
  return (
    <Modal titulo={titulo} onClose={onClose}>
      <p style={{ color: theme.text, fontSize: 13.5, lineHeight: 1.6 }}>{texto}</p>
      <Rodape onClose={onClose} fechar />
    </Modal>
  )
}

function LinhaTitulo({ titulo, onAdd }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '14px 0 8px' }}>
      <span style={{ color: theme.sub, fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .4 }}>{titulo}</span>
      <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={onAdd}><i className="ti ti-plus" /> Adicionar</button>
    </div>
  )
}

function Modal({ titulo, sub, children, onClose, largura = 520 }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 60 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: `min(${largura}px, 96vw)`, maxHeight: '90vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <h2 style={{ fontSize: 17 }}>{titulo}</h2>
            {sub && <p style={{ color: theme.sub, fontSize: 12.5, marginTop: 2 }}>{sub}</p>}
          </div>
          <i className="ti ti-x" style={{ color: theme.sub, cursor: 'pointer', fontSize: 18 }} onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  )
}
function Rodape({ onClose, onSalvar, fechar }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
      <button className="btn btn-ghost" onClick={onClose}>{fechar ? 'Fechar' : 'Cancelar'}</button>
      {!fechar && <button className="btn" onClick={onSalvar}>Salvar</button>}
    </div>
  )
}

/* ---------- estilos ---------- */
const cardBase = { background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 20, display: 'flex', alignItems: 'center', gap: 14, cursor: 'pointer' }
const btnMini = { fontSize: 12, padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }
const badge = (bg, cor) => ({ background: bg, color: cor, fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 20, whiteSpace: 'nowrap', flexShrink: 0 })

function Wrapper({ children, nome }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Base de Informações</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 22 }}>
        Parâmetros do cliente{nome ? <> <b style={{ color: theme.text }}>{nome}</b></> : ''} — valem para todos os fechamentos.
      </p>
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
