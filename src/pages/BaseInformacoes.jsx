import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import { theme } from '../lib/theme'

const hoje = () => new Date().toLocaleDateString('pt-BR')

// Cards de carga: tipo permitido em cargas_cadastro (plano|depara|apelidos|financeiro|bancoresult).
const CARGAS = [
  { tipo: 'plano', icon: 'ti-list-numbers', title: 'Plano de contas', sub: 'Com tipo de conciliação' },
  { tipo: 'depara', icon: 'ti-arrows-transfer-down', title: 'De/Para integrações', sub: 'Acumulador → conta' },
  { tipo: 'apelidos', icon: 'ti-book', title: 'Apelidos', sub: 'Leitura de histórico' },
  { tipo: 'financeiro', icon: 'ti-history', title: 'Histórico de lançamentos financeiros', sub: 'Carga inicial · atualiza a cada mês' },
  { tipo: 'bancoresult', icon: 'ti-cash', title: 'Amarração banco × resultado', sub: 'Contas banco e resultados liberados' },
]

export default function BaseInformacoes() {
  const { empresaId, empresaNome } = useAppData()
  const { user } = useAuth()

  const [particularidades, setParticularidades] = useState([])
  const [contatos, setContatos] = useState([])
  const [cargas, setCargas] = useState({})
  const [modal, setModal] = useState(null)

  async function carregarCargas() {
    const { data } = await supabase.from('cargas_cadastro')
      .select('id, tipo, vigencia, dados, obs, usuario, created_at')
      .eq('cliente_id', empresaId).order('created_at', { ascending: true })
    const grp = {}
    for (const c of (data || [])) (grp[c.tipo] ||= []).push(c)
    setCargas(grp)
  }
  useEffect(() => {
    setParticularidades([]); setContatos([]); setCargas({})
    if (!empresaId) return
    carregarCargas()
    supabase.from('clientes').select('particularidades, contatos').eq('id', empresaId).single()
      .then(({ data }) => { setParticularidades(data?.particularidades || []); setContatos(data?.contatos || []) })
  }, [empresaId])

  function persistir(campo, valor) {
    supabase.from('clientes').update({ [campo]: valor }).eq('id', empresaId).then(() => {})
  }

  if (!empresaId) {
    return (
      <Wrapper>
        <Aviso texto="Selecione uma empresa no menu lateral para ver a Base de Informações." />
      </Wrapper>
    )
  }

  function salvarPartic(texto, idx) {
    const item = { t: texto, u: user?.email || 'você', d: hoje() }
    const novo = idx == null ? [...particularidades, item] : particularidades.map((x, i) => i === idx ? item : x)
    setParticularidades(novo); persistir('particularidades', novo)
  }
  function removerPartic(idx) {
    const novo = particularidades.filter((_, j) => j !== idx)
    setParticularidades(novo); persistir('particularidades', novo)
  }
  function salvarContato(c, idx) {
    const item = { ...c, u: user?.email || 'você', d: hoje() }
    const novo = idx == null ? [...contatos, item] : contatos.map((x, i) => i === idx ? item : x)
    setContatos(novo); persistir('contatos', novo)
  }
  function removerContato(idx) {
    const novo = contatos.filter((_, j) => j !== idx)
    setContatos(novo); persistir('contatos', novo)
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
        <SimplesCard icon="ti-file-description" title="Modelos de relatório" sub="Balancete, DRE, DFC" badge={{ txt: 'em breve', cor: theme.sub }} />
        <SimplesCard icon="ti-calendar-event" title="Período de início" sub="Trava o passado"
          onClick={() => setModal({ tipo: 'simples', titulo: 'Período de início', texto: 'O período de início (competência que trava o passado) é definido no Cadastro de Clientes, no campo “Competência de início”.' })} />
        <CargaCard {...CARGAS[3]} ultima={cargas.financeiro?.at(-1)} onClick={() => setModal({ tipo: 'carga', carga: CARGAS[3] })} />
        <CargaCard {...CARGAS[4]} ultima={cargas.bancoresult?.at(-1)} onClick={() => setModal({ tipo: 'carga', carga: CARGAS[4] })} />
        <SimplesCard icon="ti-users" title="Distribuição de lucros" sub="Limite, alíquota e sócios (IRRF 2026)" badge={{ txt: 'em breve', cor: theme.sub }}
          onClick={() => setModal({ tipo: 'simples', titulo: 'Distribuição de lucros · IRRF 2026', texto: 'Configuração de limite (R$ 50.000), alíquota (10%), contas observadas e sócios. A apuração por sócio entra junto com o gate de Status.' })} />
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
      {modal?.tipo === 'simples' && (
        <ModalSimples titulo={modal.titulo} texto={modal.texto} onClose={() => setModal(null)} />
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
        : <span style={badge('rgba(255,255,255,0.06)', theme.sub)}>importar</span>}
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
      {b && <span style={badge('rgba(255,255,255,0.06)', b.cor)}>{b.txt}</span>}
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
  const [vigencia, setVigencia] = useState('')
  const [preview, setPreview] = useState(null)
  const [erro, setErro] = useState('')
  const [salvando, setSalvando] = useState(false)

  async function aoEscolher(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setErro('')
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const dados = XLSX.utils.sheet_to_json(ws, { defval: '' })
      if (!dados.length) { setErro('Planilha vazia.'); return }
      setPreview({ nome: file.name, dados })
    } catch (err) { setErro('Não consegui ler: ' + err.message) }
  }

  async function importar() {
    if (!/^\d{2}\/\d{4}$/.test(vigencia)) { setErro('Informe a vigência no formato MM/AAAA.'); return }
    if (!preview) { setErro('Escolha um arquivo.'); return }
    setSalvando(true); setErro('')
    const { error } = await supabase.from('cargas_cadastro').insert({
      cliente_id: empresaId, tipo: carga.tipo, vigencia, dados: preview.dados, usuario, obs: preview.nome,
    })
    setSalvando(false)
    if (error) { setErro(error.message); return }
    onImportado(); onClose()
  }

  return (
    <Modal titulo={carga.title} sub={carga.sub} onClose={onClose} largura={620}>
      <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 14 }}>Cada carga cria uma <b style={{ color: theme.text }}>vigência</b> e preserva o histórico (nada é sobrescrito).</p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
        <div><label>Vigência (MM/AAAA)</label><input className="input" value={vigencia} onChange={e => setVigencia(e.target.value)} placeholder="01/2026" /></div>
        <div><label>Arquivo (.xlsx, .xls, .csv)</label><input type="file" accept=".xlsx,.xls,.csv" onChange={aoEscolher} style={{ fontSize: 13, color: theme.sub, marginTop: 6 }} /></div>
      </div>
      {preview && <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 12 }}><i className="ti ti-file-spreadsheet" /> {preview.nome} — {preview.dados.length} linha(s)</p>}
      {erro && <p style={{ color: theme.red, fontSize: 13, marginBottom: 12 }}>{erro}</p>}

      <button className="btn" disabled={salvando} onClick={importar}><i className="ti ti-cloud-upload" /> {salvando ? 'Importando…' : 'Importar carga'}</button>

      <p style={{ color: theme.sub, fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .6, margin: '22px 0 10px' }}>Histórico de vigências</p>
      {historico.length === 0
        ? <p style={{ color: theme.sub, fontSize: 12.5 }}>Nenhuma carga ainda.</p>
        : historico.slice().reverse().map(c => (
          <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '9px 0', borderTop: `1px solid ${theme.border}`, fontSize: 12.5 }}>
            <span style={{ color: theme.text }}><b>{c.vigencia || '—'}</b> · {Array.isArray(c.dados) ? c.dados.length : 0} linha(s)</span>
            <span style={{ color: theme.sub }}>{c.obs || ''}</span>
          </div>
        ))}
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

function ModalSimples({ titulo, texto, onClose }) {
  return (
    <Modal titulo={titulo} onClose={onClose}>
      <p style={{ color: theme.text, fontSize: 13.5, lineHeight: 1.6 }}>{texto}</p>
      <Rodape onClose={onClose} fechar />
    </Modal>
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
