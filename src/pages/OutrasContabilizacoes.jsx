import { useEffect, useState } from 'react'
import { theme, money } from '../lib/theme'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import { listar, inserir, remover, gerarLancamento, enviarSaldoInicialContrato } from '../lib/outras'
import ObservacoesConciliacao from '../components/ObservacoesConciliacao'
import LeitorIA from '../components/LeitorIA'

const ACC = { seguro: '#4A7CFF', despesa: '#33B4C6', importacao: '#2FB6A8', emprestimo: '#9A7CF0', parcelamento: '#E8923B', equivalencia: '#E06C9F', outros: '#7C89A6' }
const BLOCOS = [
  { key: 'seguro', label: 'Seguro', icon: 'ti-shield-half', sub: 'Apólices & apropriação' },
  { key: 'despesa', label: 'Despesa a Apropriar', icon: 'ti-calendar-repeat', sub: 'IPVA, IPTU, etc.' },
  { key: 'importacao', label: 'Importação', icon: 'ti-ship', sub: 'Processos de mercadoria' },
  { key: 'emprestimo', label: 'Empréstimo', icon: 'ti-building-bank', sub: 'Contratos & conferência' },
  { key: 'parcelamento', label: 'Parc. Impostos', icon: 'ti-receipt', sub: 'Só juros & multa' },
  { key: 'equivalencia', label: 'Equiv. Patrimonial', icon: 'ti-scale', sub: 'Participações (MEP)' },
  { key: 'outros', label: 'Outros Lançamentos', icon: 'ti-pencil-plus', sub: 'Manual' },
]

function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})` }
const th = { textAlign: 'left', padding: '9px 12px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3, whiteSpace: 'nowrap', borderBottom: `1px solid ${theme.border}` }
const td = { padding: '10px 12px', fontSize: 13, color: theme.text, borderBottom: `1px solid ${theme.border}`, verticalAlign: 'top' }
function Card({ children, style }) { return <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 12, padding: 18, ...style }}>{children}</div> }
function SecTitle({ children }) { return <p style={{ fontSize: 15, fontWeight: 700, margin: '0 0 2px', display: 'flex', alignItems: 'center', gap: 8 }}>{children}</p> }
function SecSub({ children }) { return <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 14px' }}>{children}</p> }
function Field({ label, children, col }) { return <div style={{ gridColumn: col ? `span ${col}` : 'auto' }}><label>{label}</label>{children}</div> }
function num(v) { return Number(String(v).replace(/\./g, '').replace(',', '.')) || 0 }

// Data do último dia da competência (MM/AAAA) em ISO.
function dataComp(competencia) {
  const [m, a] = (competencia || '').split('/').map(Number)
  if (!m || !a) return ''
  const d = new Date(a, m, 0).getDate()
  return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

// ---- form genérico (controlado) ----
function useForm(init) {
  const [f, setF] = useState(init)
  return [f, k => e => setF(x => ({ ...x, [k]: e.target.value })), () => setF(init), setF]
}

// Mescla no formulário só os campos que a IA de fato extraiu (não vazios/zerados)
// e que existem no formulário — preserva o que já estava preenchido.
function aplicarIA(setF, dados) {
  setF(x => {
    const merge = { ...x }
    for (const [k, v] of Object.entries(dados || {})) {
      if (!(k in x)) continue
      if (v === '' || v === null || v === undefined || v === 0) continue
      merge[k] = String(v)
    }
    return merge
  })
}

export default function OutrasContabilizacoes() {
  const { empresaId, empresaNome, competencia, getCompetenciaId } = useAppData()
  const { user } = useAuth()
  const [tab, setTab] = useState('seguro')
  const [gerar, setGerar] = useState(null) // {campos, titulo}
  const [msg, setMsg] = useState('')

  function abrirGerar(prefill, titulo) { setGerar({ ...prefill, _titulo: titulo }) }

  async function confirmarGerar(g) {
    try {
      const competencia_id = await getCompetenciaId()
      if (!competencia_id) { setMsg('Selecione uma empresa e abra um fechamento.'); return }
      await gerarLancamento({ competencia_id, ...g, usuario: user?.email })
      setGerar(null); setMsg('Lançamento gerado e enviado ao Status → Domínio.')
      setTimeout(() => setMsg(''), 4000)
    } catch (e) { setMsg('Erro: ' + e.message) }
  }

  // Envia o saldo de abertura de um contrato (seguro/despesa a apropriar) para a
  // carga inicial — o que falta apropriar na abertura vira composição da conta.
  async function enviarSaldoInicial(origem, contrato) {
    try {
      const restante = await enviarSaldoInicialContrato({ clienteId: empresaId, origem, contrato, usuario: user?.email })
      setMsg(restante > 0.005
        ? `Saldo de abertura enviado à carga inicial: ${money(restante)} a apropriar (Base de Informações → carga inicial).`
        : 'Sem saldo a apropriar na abertura — o contrato já estaria encerrado nessa data.')
      setTimeout(() => setMsg(''), 6000)
    } catch (e) { setMsg('Erro: ' + e.message) }
  }

  if (!empresaId) return <Aviso texto="Selecione uma empresa no menu lateral." />

  const props = { clienteId: empresaId, user, competencia, abrirGerar, enviarSaldoInicial }
  const Pane = { seguro: PaneSeguro, despesa: PaneDespesaApropriar, importacao: PaneImportacao, emprestimo: PaneEmprestimo, parcelamento: PaneParcelamento, equivalencia: PaneEquivalencia, outros: PaneOutros }[tab]

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Outras Contabilizações</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 16, maxWidth: 820 }}>
        Cadastre os contratos/processos e gere os lançamentos do mês — tudo que você <b style={{ color: theme.text }}>gera</b> entra em <b style={{ color: theme.text }}>Lançamentos</b> e alimenta o Status → Domínio.
        {empresaNome && <> · <b style={{ color: theme.text }}>{empresaNome}</b> · {competencia}</>}
      </p>

      {msg && <div style={{ background: theme.card, border: `1px solid ${theme.accent}`, borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 14, color: theme.text }}><i className="ti ti-info-circle" style={{ color: theme.accent }} /> {msg}</div>}

      <ObservacoesConciliacao clienteId={empresaId} competencia={competencia} user={user} irPara={setTab} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(168px,1fr))', gap: 12, marginBottom: 18 }}>
        {BLOCOS.map(b => {
          const on = tab === b.key
          return (
            <div key={b.key} onClick={() => setTab(b.key)} style={{ background: theme.card, border: `1px solid ${on ? ACC[b.key] : theme.border}`, borderRadius: 12, padding: 16, cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: ACC[b.key] }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 38, height: 38, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19, background: hexA(ACC[b.key], 0.16), color: ACC[b.key] }}><i className={`ti ${b.icon}`} /></div>
                <div><div style={{ fontSize: 14, fontWeight: 700 }}>{b.label}</div><div style={{ fontSize: 11.5, color: theme.sub }}>{b.sub}</div></div>
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${theme.border}`, marginBottom: 20, flexWrap: 'wrap' }}>
        {BLOCOS.map(b => (
          <button key={b.key} onClick={() => setTab(b.key)} style={{ background: 'none', border: 'none', padding: '10px 14px', fontSize: 13.5, fontWeight: 600, color: tab === b.key ? theme.text : theme.sub, borderBottom: `2px solid ${tab === b.key ? theme.accent : 'transparent'}`, marginBottom: -1, cursor: 'pointer' }}>
            <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', marginRight: 7, background: ACC[b.key] }} />{b.label}
          </button>
        ))}
      </div>

      <Pane {...props} />
      {gerar && <GerarModal cfg={gerar} onClose={() => setGerar(null)} onConfirm={confirmarGerar} />}
    </div>
  )
}

// ---- Modal: confirmar/editar a partida antes de gerar o lançamento ----
function GerarModal({ cfg, onClose, onConfirm }) {
  const [f, on] = useForm({ data: cfg.data || '', conta_debito: cfg.conta_debito || '', conta_credito: cfg.conta_credito || '', valor: cfg.valor || '', historico: cfg.historico || '', origem: cfg.origem, documento: cfg.documento })
  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose() }} style={{ position: 'fixed', inset: 0, background: 'rgba(8,11,18,0.64)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 14, maxWidth: 560, width: '100%', padding: '22px 24px' }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px' }}>Gerar lançamento</h3>
        <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 16px' }}>{cfg._titulo} — confira a partida e confirme.</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Data"><input className="input" type="date" value={f.data} onChange={on('data')} /></Field>
          <Field label="Valor"><input className="input" type="number" step="0.01" value={f.valor} onChange={on('valor')} /></Field>
          <Field label="Conta débito"><input className="input" value={f.conta_debito} onChange={on('conta_debito')} /></Field>
          <Field label="Conta crédito"><input className="input" value={f.conta_credito} onChange={on('conta_credito')} /></Field>
          <Field label="Histórico" col={2}><input className="input" value={f.historico} onChange={on('historico')} /></Field>
        </div>
        <p style={{ color: theme.sub, fontSize: 12, marginTop: 12 }}><i className="ti ti-sparkles" style={{ color: theme.accent }} /> Só gera no Domínio com débito e crédito. Atualiza a conciliação.</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn" onClick={() => onConfirm(f)}>Confirmar e gerar</button>
        </div>
      </div>
    </div>
  )
}

// ---- helper: lista + exclusão comum ----
function useLista(tabela, clienteId) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState('')
  async function recarregar() {
    setLoading(true); setErro('')
    try { setRows(await listar(tabela, clienteId)) } catch (e) { setErro(e.message) } finally { setLoading(false) }
  }
  useEffect(() => { recarregar() }, [tabela, clienteId]) // eslint-disable-line
  async function excluir(id) { if (!confirm('Excluir este registro?')) return; try { await remover(tabela, id); recarregar() } catch (e) { setErro(e.message) } }
  return { rows, loading, erro, recarregar, excluir }
}

function GerarBtn({ onClick, children = 'Gerar lançamento' }) { return <button className="btn" style={{ fontSize: 12, padding: '5px 10px' }} onClick={onClick}><i className="ti ti-file-plus" /> {children}</button> }
function SaldoIniBtn({ onClick }) { return <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={onClick} title="Calcula o que falta apropriar na abertura e envia à carga inicial"><i className="ti ti-arrow-bar-to-up" /> Saldo inicial</button> }
function DelBtn({ onClick }) { return <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={onClick}>excluir</button> }
function Vazio({ colSpan, texto }) { return <tr><td colSpan={colSpan} style={{ padding: 18, color: theme.sub, fontSize: 13 }}>{texto}</td></tr> }

// ================= SEGURO =================
function PaneSeguro({ clienteId, user, competencia, abrirGerar, enviarSaldoInicial }) {
  const { rows, loading, erro, recarregar, excluir } = useLista('seguros', clienteId)
  const [f, on, reset, setF] = useForm({ seguradora: '', apolice: '', ramo: '', vigencia_inicio: '', vigencia_fim: '', premio_total: '', num_parcelas: '12', valor_parcela: '', conta_despesa: '4.1.2.18', conta_apropriar: '1.1.3.02', conta_pagar: '2.1.1.05' })
  const [sav, setSav] = useState(false)
  async function salvar(e) { e.preventDefault(); setSav(true); try { await inserir('seguros', { cliente_id: clienteId, seguradora: f.seguradora, apolice: f.apolice, ramo: f.ramo, vigencia_inicio: f.vigencia_inicio || null, vigencia_fim: f.vigencia_fim || null, premio_total: num(f.premio_total), num_parcelas: Number(f.num_parcelas) || null, valor_parcela: num(f.valor_parcela), conta_despesa: f.conta_despesa, conta_apropriar: f.conta_apropriar, conta_pagar: f.conta_pagar, usuario: user?.email }); reset(); recarregar() } catch (er) { alert(er.message) } finally { setSav(false) } }
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Card>
        <SecTitle><i className="ti ti-shield-half" style={{ color: ACC.seguro }} /> Novo contrato de seguro</SecTitle>
        <SecSub>Cadastre a apólice — depois gere a apropriação do mês, que vira lançamento.</SecSub>
        <LeitorIA tipo="seguro" acento={ACC.seguro} onExtraido={d => aplicarIA(setF, d)} />
        <form onSubmit={salvar} style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
          <Field label="Seguradora"><input className="input" value={f.seguradora} onChange={on('seguradora')} required /></Field>
          <Field label="Apólice"><input className="input" value={f.apolice} onChange={on('apolice')} /></Field>
          <Field label="Ramo"><input className="input" value={f.ramo} onChange={on('ramo')} /></Field>
          <Field label="Prêmio total"><input className="input" value={f.premio_total} onChange={on('premio_total')} placeholder="0,00" /></Field>
          <Field label="Vigência início"><input className="input" type="date" value={f.vigencia_inicio} onChange={on('vigencia_inicio')} /></Field>
          <Field label="Vigência fim"><input className="input" type="date" value={f.vigencia_fim} onChange={on('vigencia_fim')} /></Field>
          <Field label="Nº parcelas"><input className="input" value={f.num_parcelas} onChange={on('num_parcelas')} /></Field>
          <Field label="Valor parcela"><input className="input" value={f.valor_parcela} onChange={on('valor_parcela')} placeholder="0,00" /></Field>
          <Field label="Conta despesa (D)"><input className="input" value={f.conta_despesa} onChange={on('conta_despesa')} /></Field>
          <Field label="Conta a apropriar (C)"><input className="input" value={f.conta_apropriar} onChange={on('conta_apropriar')} /></Field>
          <div style={{ gridColumn: 'span 2', display: 'flex', alignItems: 'flex-end' }}><button className="btn" disabled={sav}>{sav ? 'Salvando…' : '＋ Salvar contrato'}</button></div>
        </form>
      </Card>
      <Card>
        <SecTitle>Contratos de seguro ({rows.length})</SecTitle>
        {erro && <p style={{ color: theme.red, fontSize: 13 }}>{erro}</p>}
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}><thead><tr>{['Seguradora', 'Apólice', 'Ramo', 'Prêmio', 'Parcela', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead><tbody>
          {loading ? <Vazio colSpan={6} texto="Carregando…" /> : rows.length === 0 ? <Vazio colSpan={6} texto="Nenhum contrato cadastrado ainda." /> : rows.map(r => (
            <tr key={r.id}>
              <td style={td}><b>{r.seguradora}</b></td><td style={td}>{r.apolice}</td><td style={td}>{r.ramo}</td>
              <td style={{ ...td, textAlign: 'right' }}>{money(r.premio_total)}</td><td style={{ ...td, textAlign: 'right' }}>{money(r.valor_parcela)}</td>
              <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                <GerarBtn onClick={() => abrirGerar({ data: dataComp(competencia), conta_debito: r.conta_despesa, conta_credito: r.conta_apropriar, valor: r.valor_parcela, historico: `Apropriação seguro ${r.seguradora} ${r.apolice || ''}`.trim(), origem: 'seguro', documento: r.apolice }, `Apropriação — ${r.seguradora}`)}>Apropriação do mês</GerarBtn>{' '}
                <SaldoIniBtn onClick={() => enviarSaldoInicial('seguro', r)} />{' '}
                <DelBtn onClick={() => excluir(r.id)} />
              </td>
            </tr>
          ))}
        </tbody></table></div>
      </Card>
    </div>
  )
}

// ================= DESPESA A APROPRIAR =================
// Funciona como o seguro, mas genérico: IPVA, IPTU, aluguel antecipado, etc.
function PaneDespesaApropriar({ clienteId, user, competencia, abrirGerar, enviarSaldoInicial }) {
  const { rows, loading, erro, recarregar, excluir } = useLista('despesas_apropriar', clienteId)
  const [f, on, reset] = useForm({ tipo: '', descricao: '', documento: '', valor_total: '', vigencia_inicio: '', vigencia_fim: '', num_parcelas: '12', valor_parcela: '', conta_despesa: '', conta_apropriar: '' })
  const [sav, setSav] = useState(false)
  async function salvar(e) {
    e.preventDefault(); setSav(true)
    try {
      await inserir('despesas_apropriar', { cliente_id: clienteId, tipo: f.tipo, descricao: f.descricao, documento: f.documento, valor_total: num(f.valor_total), vigencia_inicio: f.vigencia_inicio || null, vigencia_fim: f.vigencia_fim || null, num_parcelas: Number(f.num_parcelas) || null, valor_parcela: num(f.valor_parcela), conta_despesa: f.conta_despesa, conta_apropriar: f.conta_apropriar, usuario: user?.email })
      reset(); recarregar()
    } catch (er) { alert(er.message) } finally { setSav(false) }
  }
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Card>
        <SecTitle><i className="ti ti-calendar-repeat" style={{ color: ACC.despesa }} /> Nova despesa a apropriar</SecTitle>
        <SecSub>IPVA, IPTU, aluguel antecipado, licenças… Cadastre uma vez e gere a apropriação do mês. O saldo que falta apropriar pode ir direto ao saldo inicial.</SecSub>
        <form onSubmit={salvar} style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
          <Field label="Tipo (IPVA, IPTU…)"><input className="input" value={f.tipo} onChange={on('tipo')} placeholder="IPVA" required /></Field>
          <Field label="Descrição"><input className="input" value={f.descricao} onChange={on('descricao')} placeholder="Placa ABC1D23 / imóvel matriz" /></Field>
          <Field label="Documento"><input className="input" value={f.documento} onChange={on('documento')} /></Field>
          <Field label="Valor total"><input className="input" value={f.valor_total} onChange={on('valor_total')} placeholder="0,00" /></Field>
          <Field label="Vigência início"><input className="input" type="date" value={f.vigencia_inicio} onChange={on('vigencia_inicio')} /></Field>
          <Field label="Vigência fim"><input className="input" type="date" value={f.vigencia_fim} onChange={on('vigencia_fim')} /></Field>
          <Field label="Nº parcelas"><input className="input" value={f.num_parcelas} onChange={on('num_parcelas')} /></Field>
          <Field label="Valor parcela"><input className="input" value={f.valor_parcela} onChange={on('valor_parcela')} placeholder="0,00" /></Field>
          <Field label="Conta despesa (D)"><input className="input" value={f.conta_despesa} onChange={on('conta_despesa')} placeholder="4.x…" /></Field>
          <Field label="Conta a apropriar (C)"><input className="input" value={f.conta_apropriar} onChange={on('conta_apropriar')} placeholder="1.1.3…" /></Field>
          <div style={{ gridColumn: 'span 2', display: 'flex', alignItems: 'flex-end' }}><button className="btn" disabled={sav}>{sav ? 'Salvando…' : '＋ Salvar despesa'}</button></div>
        </form>
      </Card>
      <Card>
        <SecTitle>Despesas a apropriar ({rows.length})</SecTitle>
        {erro && <p style={{ color: theme.red, fontSize: 13 }}>{erro}</p>}
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}><thead><tr>{['Tipo', 'Descrição', 'Total', 'Parcela', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead><tbody>
          {loading ? <Vazio colSpan={5} texto="Carregando…" /> : rows.length === 0 ? <Vazio colSpan={5} texto="Nenhuma despesa cadastrada ainda." /> : rows.map(r => (
            <tr key={r.id}>
              <td style={td}><b>{r.tipo}</b></td><td style={td}>{r.descricao}</td>
              <td style={{ ...td, textAlign: 'right' }}>{money(r.valor_total)}</td><td style={{ ...td, textAlign: 'right' }}>{money(r.valor_parcela)}</td>
              <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                <GerarBtn onClick={() => abrirGerar({ data: dataComp(competencia), conta_debito: r.conta_despesa, conta_credito: r.conta_apropriar, valor: r.valor_parcela, historico: `Apropriação ${r.tipo} ${r.descricao || ''}`.trim(), origem: 'despesa', documento: r.documento }, `Apropriação — ${r.tipo}`)}>Apropriação do mês</GerarBtn>{' '}
                <SaldoIniBtn onClick={() => enviarSaldoInicial('despesa', r)} />{' '}
                <DelBtn onClick={() => excluir(r.id)} />
              </td>
            </tr>
          ))}
        </tbody></table></div>
      </Card>
    </div>
  )
}

// ================= IMPORTAÇÃO =================
function PaneImportacao({ clienteId, user, competencia, abrirGerar }) {
  const proc = useLista('importacoes', clienteId)
  const adiant = useLista('adiantamentos_importacao', clienteId)
  const [f, on, reset, setF] = useForm({ numero: '', di: '', fornecedor: '', mercadoria: '', invoice_moeda: 'USD', invoice_valor: '', cambio: '', custo_total: '' })
  const [fa, ona, resetA] = useForm({ fornecedor: '', data: '', valor: '' })
  async function salvarProc(e) { e.preventDefault(); try { await inserir('importacoes', { cliente_id: clienteId, numero: f.numero, di: f.di, fornecedor: f.fornecedor, mercadoria: f.mercadoria, invoice_moeda: f.invoice_moeda, invoice_valor: num(f.invoice_valor), cambio: num(f.cambio), custo_total: num(f.custo_total), usuario: user?.email }); reset(); proc.recarregar() } catch (er) { alert(er.message) } }
  async function salvarAdiant(e) { e.preventDefault(); try { await inserir('adiantamentos_importacao', { cliente_id: clienteId, fornecedor: fa.fornecedor, data: fa.data || null, valor: num(fa.valor), usuario: user?.email }); resetA(); adiant.recarregar() } catch (er) { alert(er.message) } }
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Card>
        <SecTitle><i className="ti ti-cash" style={{ color: ACC.importacao }} /> Adiantamento de importação</SecTitle>
        <SecSub>Registre o adiantamento ao fornecedor do exterior. Fica em controle até o processo chegar.</SecSub>
        <form onSubmit={salvarAdiant} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: 10, alignItems: 'flex-end' }}>
          <Field label="Fornecedor (exterior)"><input className="input" value={fa.fornecedor} onChange={ona('fornecedor')} required /></Field>
          <Field label="Data"><input className="input" type="date" value={fa.data} onChange={ona('data')} /></Field>
          <Field label="Valor"><input className="input" value={fa.valor} onChange={ona('valor')} placeholder="0,00" /></Field>
          <button className="btn">＋ Adiantamento</button>
        </form>
        <div style={{ overflowX: 'auto', marginTop: 12 }}><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr>{['Fornecedor', 'Data', 'Valor', 'Situação', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead><tbody>
          {adiant.rows.length === 0 ? <Vazio colSpan={5} texto="Nenhum adiantamento." /> : adiant.rows.map(r => (
            <tr key={r.id}><td style={td}><b>{r.fornecedor}</b></td><td style={td}>{r.data || ''}</td><td style={{ ...td, textAlign: 'right' }}>{money(r.valor)}</td><td style={td}>{r.processo_id ? 'vinculado' : 'aguardando processo'}</td><td style={{ ...td, textAlign: 'right' }}><DelBtn onClick={() => adiant.excluir(r.id)} /></td></tr>
          ))}
        </tbody></table></div>
      </Card>
      <Card>
        <SecTitle><i className="ti ti-ship" style={{ color: ACC.importacao }} /> Novo processo de importação</SecTitle>
        <LeitorIA tipo="importacao" acento={ACC.importacao} onExtraido={d => aplicarIA(setF, d)} />
        <form onSubmit={salvarProc} style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
          <Field label="Nº processo"><input className="input" value={f.numero} onChange={on('numero')} required /></Field>
          <Field label="DI / DUIMP"><input className="input" value={f.di} onChange={on('di')} /></Field>
          <Field label="Fornecedor"><input className="input" value={f.fornecedor} onChange={on('fornecedor')} /></Field>
          <Field label="Mercadoria"><input className="input" value={f.mercadoria} onChange={on('mercadoria')} /></Field>
          <Field label="Moeda"><input className="input" value={f.invoice_moeda} onChange={on('invoice_moeda')} /></Field>
          <Field label="Invoice"><input className="input" value={f.invoice_valor} onChange={on('invoice_valor')} placeholder="0,00" /></Field>
          <Field label="Câmbio"><input className="input" value={f.cambio} onChange={on('cambio')} placeholder="0,0000" /></Field>
          <Field label="Custo total (R$)"><input className="input" value={f.custo_total} onChange={on('custo_total')} placeholder="0,00" /></Field>
          <div style={{ gridColumn: 'span 4' }}><button className="btn">＋ Salvar processo</button></div>
        </form>
      </Card>
      <Card>
        <SecTitle>Processos armazenados ({proc.rows.length})</SecTitle>
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}><thead><tr>{['Processo', 'Fornecedor', 'Custo', 'Status', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead><tbody>
          {proc.rows.length === 0 ? <Vazio colSpan={5} texto="Nenhum processo." /> : proc.rows.map(r => (
            <tr key={r.id}><td style={td}><b>{r.numero}</b></td><td style={td}>{r.fornecedor}</td><td style={{ ...td, textAlign: 'right' }}>{money(r.custo_total)}</td><td style={td}>{r.status}</td>
              <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                <GerarBtn onClick={() => abrirGerar({ data: dataComp(competencia), conta_debito: '1.1.4.09', conta_credito: '2.1.1.11', valor: r.custo_total, historico: `Importação ${r.numero} — ${r.fornecedor || ''}`.trim(), origem: 'importacao', documento: r.numero }, `Custo — ${r.numero}`)}>Lançar custo</GerarBtn>{' '}
                <DelBtn onClick={() => proc.excluir(r.id)} />
              </td></tr>
          ))}
        </tbody></table></div>
      </Card>
    </div>
  )
}

// ================= EMPRÉSTIMO =================
function PaneEmprestimo({ clienteId, user }) {
  const { rows, recarregar, excluir } = useLista('emprestimos', clienteId)
  const [f, on, reset, setF] = useForm({ banco: '', contrato: '', modalidade: '', valor: '', prazo: '', taxa_mensal: '', valor_parcela: '', saldo_devedor: '' })
  async function salvar(e) { e.preventDefault(); try { await inserir('emprestimos', { cliente_id: clienteId, banco: f.banco, contrato: f.contrato, modalidade: f.modalidade, valor: num(f.valor), prazo: Number(f.prazo) || null, taxa_mensal: num(f.taxa_mensal), valor_parcela: num(f.valor_parcela), saldo_devedor: num(f.saldo_devedor), usuario: user?.email }); reset(); recarregar() } catch (er) { alert(er.message) } }
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Card>
        <SecTitle><i className="ti ti-building-bank" style={{ color: ACC.emprestimo }} /> Novo contrato de empréstimo</SecTitle>
        <SecSub>O empréstimo <b>não gera lançamento</b> — serve de referência para conferir com a Conciliação.</SecSub>
        <LeitorIA tipo="emprestimo" acento={ACC.emprestimo} onExtraido={d => aplicarIA(setF, d)} />
        <form onSubmit={salvar} style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
          <Field label="Banco"><input className="input" value={f.banco} onChange={on('banco')} required /></Field>
          <Field label="Contrato"><input className="input" value={f.contrato} onChange={on('contrato')} /></Field>
          <Field label="Modalidade"><input className="input" value={f.modalidade} onChange={on('modalidade')} /></Field>
          <Field label="Valor"><input className="input" value={f.valor} onChange={on('valor')} placeholder="0,00" /></Field>
          <Field label="Prazo (x)"><input className="input" value={f.prazo} onChange={on('prazo')} /></Field>
          <Field label="Taxa % a.m."><input className="input" value={f.taxa_mensal} onChange={on('taxa_mensal')} /></Field>
          <Field label="Parcela"><input className="input" value={f.valor_parcela} onChange={on('valor_parcela')} placeholder="0,00" /></Field>
          <Field label="Saldo devedor"><input className="input" value={f.saldo_devedor} onChange={on('saldo_devedor')} placeholder="0,00" /></Field>
          <div style={{ gridColumn: 'span 4' }}><button className="btn">＋ Salvar contrato</button></div>
        </form>
      </Card>
      <Card>
        <SecTitle>Contratos armazenados ({rows.length})</SecTitle>
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}><thead><tr>{['Banco', 'Contrato', 'Saldo devedor', 'Parcela', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead><tbody>
          {rows.length === 0 ? <Vazio colSpan={5} texto="Nenhum contrato." /> : rows.map(r => (
            <tr key={r.id}><td style={td}><b>{r.banco}</b></td><td style={td}>{r.contrato}</td><td style={{ ...td, textAlign: 'right' }}>{money(r.saldo_devedor)}</td><td style={{ ...td, textAlign: 'right' }}>{money(r.valor_parcela)}</td><td style={{ ...td, textAlign: 'right' }}><DelBtn onClick={() => excluir(r.id)} /></td></tr>
          ))}
        </tbody></table></div>
      </Card>
    </div>
  )
}

// ================= PARCELAMENTO =================
function PaneParcelamento({ clienteId, user, competencia, abrirGerar }) {
  const { rows, recarregar, excluir } = useLista('parcelamentos', clienteId)
  const [f, on, reset, setF] = useForm({ orgao: '', numero: '', tributo: '', consolidado: '', num_parcelas: '', valor_parcela: '', saldo_devedor: '', juros_multa_mes: '', conta_despesa: '4.3.1.05', conta_passivo: '2.1.2.20' })
  async function salvar(e) { e.preventDefault(); try { await inserir('parcelamentos', { cliente_id: clienteId, orgao: f.orgao, numero: f.numero, tributo: f.tributo, consolidado: num(f.consolidado), num_parcelas: Number(f.num_parcelas) || null, valor_parcela: num(f.valor_parcela), saldo_devedor: num(f.saldo_devedor), juros_multa_mes: num(f.juros_multa_mes), conta_despesa: f.conta_despesa, conta_passivo: f.conta_passivo, usuario: user?.email }); reset(); recarregar() } catch (er) { alert(er.message) } }
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Card>
        <SecTitle><i className="ti ti-receipt" style={{ color: ACC.parcelamento }} /> Novo parcelamento de impostos</SecTitle>
        <SecSub>A única contabilização é a <b>atualização de juros e multa</b>. A parcela (principal) vem do banco, na conciliação.</SecSub>
        <LeitorIA tipo="parcelamento" acento={ACC.parcelamento} onExtraido={d => aplicarIA(setF, d)} />
        <form onSubmit={salvar} style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
          <Field label="Órgão"><input className="input" value={f.orgao} onChange={on('orgao')} placeholder="PGFN / Sefaz…" required /></Field>
          <Field label="Nº parcelamento"><input className="input" value={f.numero} onChange={on('numero')} /></Field>
          <Field label="Tributo"><input className="input" value={f.tributo} onChange={on('tributo')} /></Field>
          <Field label="Consolidado"><input className="input" value={f.consolidado} onChange={on('consolidado')} placeholder="0,00" /></Field>
          <Field label="Nº parcelas"><input className="input" value={f.num_parcelas} onChange={on('num_parcelas')} /></Field>
          <Field label="Valor parcela"><input className="input" value={f.valor_parcela} onChange={on('valor_parcela')} placeholder="0,00" /></Field>
          <Field label="Saldo devedor"><input className="input" value={f.saldo_devedor} onChange={on('saldo_devedor')} placeholder="0,00" /></Field>
          <Field label="Juros/multa do mês"><input className="input" value={f.juros_multa_mes} onChange={on('juros_multa_mes')} placeholder="0,00" /></Field>
          <div style={{ gridColumn: 'span 4' }}><button className="btn">＋ Salvar parcelamento</button></div>
        </form>
      </Card>
      <Card>
        <SecTitle>Parcelamentos armazenados ({rows.length})</SecTitle>
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 680 }}><thead><tr>{['Órgão', 'Nº', 'Saldo', 'Juros/multa mês', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead><tbody>
          {rows.length === 0 ? <Vazio colSpan={5} texto="Nenhum parcelamento." /> : rows.map(r => (
            <tr key={r.id}><td style={td}><b>{r.orgao}</b></td><td style={td}>{r.numero}</td><td style={{ ...td, textAlign: 'right' }}>{money(r.saldo_devedor)}</td><td style={{ ...td, textAlign: 'right' }}>{money(r.juros_multa_mes)}</td>
              <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                <GerarBtn onClick={() => abrirGerar({ data: dataComp(competencia), conta_debito: r.conta_despesa, conta_credito: r.conta_passivo, valor: r.juros_multa_mes, historico: `Juros e multa parcelamento ${r.orgao} ${r.numero || ''}`.trim(), origem: 'parcelamento', documento: r.numero }, `Juros/multa — ${r.orgao}`)}>Juros/multa do mês</GerarBtn>{' '}
                <DelBtn onClick={() => excluir(r.id)} />
              </td></tr>
          ))}
        </tbody></table></div>
      </Card>
    </div>
  )
}

// ================= EQUIVALÊNCIA =================
function PaneEquivalencia({ clienteId, user, competencia, abrirGerar }) {
  const { rows, recarregar, excluir } = useLista('participacoes', clienteId)
  const [f, on, reset, setF] = useForm({ investida: '', vinculo: 'Coligada', participacao_pct: '', valor_investimento: '', conta_investimento: '1.2.1.03', conta_resultado: '4.3.2.01' })
  const [res, setRes] = useState({}) // id -> resultado do mês digitado
  async function salvar(e) { e.preventDefault(); try { await inserir('participacoes', { cliente_id: clienteId, investida: f.investida, vinculo: f.vinculo, participacao_pct: num(f.participacao_pct), valor_investimento: num(f.valor_investimento), conta_investimento: f.conta_investimento, conta_resultado: f.conta_resultado, usuario: user?.email }); reset(); recarregar() } catch (er) { alert(er.message) } }
  function gerarMEP(r) {
    const resultado = num(res[r.id] || 0)
    const mep = Math.round(resultado * (Number(r.participacao_pct) / 100) * 100) / 100
    if (!mep) { alert('Informe o resultado da investida no mês.'); return }
    const lucro = mep > 0
    abrirGerar({
      data: dataComp(competencia), valor: Math.abs(mep),
      conta_debito: lucro ? r.conta_investimento : r.conta_resultado,
      conta_credito: lucro ? r.conta_resultado : r.conta_investimento,
      historico: `Equivalência patrimonial ${r.investida} (${r.participacao_pct}%)`, origem: 'equivalencia', documento: r.investida,
    }, `MEP — ${r.investida}`)
  }
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Card>
        <SecTitle><i className="ti ti-scale" style={{ color: ACC.equivalencia }} /> Nova participação societária</SecTitle>
        <SecSub>Cadastre a investida. Para gerar a MEP, informe o <b>resultado da investida no mês</b> na tabela abaixo.</SecSub>
        <LeitorIA tipo="participacao" acento={ACC.equivalencia} onExtraido={d => aplicarIA(setF, d)} />
        <form onSubmit={salvar} style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
          <Field label="Investida"><input className="input" value={f.investida} onChange={on('investida')} required /></Field>
          <Field label="Vínculo"><select className="input" value={f.vinculo} onChange={on('vinculo')}><option>Coligada</option><option>Controlada</option></select></Field>
          <Field label="Participação %"><input className="input" value={f.participacao_pct} onChange={on('participacao_pct')} placeholder="30" /></Field>
          <Field label="Valor investimento"><input className="input" value={f.valor_investimento} onChange={on('valor_investimento')} placeholder="0,00" /></Field>
          <div style={{ gridColumn: 'span 4' }}><button className="btn">＋ Salvar participação</button></div>
        </form>
      </Card>
      <Card>
        <SecTitle>Participações ({rows.length})</SecTitle>
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}><thead><tr>{['Investida', 'Vínculo', '%', 'Resultado da investida (mês)', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead><tbody>
          {rows.length === 0 ? <Vazio colSpan={5} texto="Nenhuma participação." /> : rows.map(r => (
            <tr key={r.id}><td style={td}><b>{r.investida}</b></td><td style={td}>{r.vinculo}</td><td style={{ ...td, textAlign: 'right' }}>{r.participacao_pct}%</td>
              <td style={td}><input className="input" style={{ maxWidth: 160 }} value={res[r.id] || ''} onChange={e => setRes(s => ({ ...s, [r.id]: e.target.value }))} placeholder="lucro + / prejuízo -" /></td>
              <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}><GerarBtn onClick={() => gerarMEP(r)}>Gerar MEP</GerarBtn>{' '}<DelBtn onClick={() => excluir(r.id)} /></td></tr>
          ))}
        </tbody></table></div>
      </Card>
    </div>
  )
}

// ================= OUTROS LANÇAMENTOS =================
function PaneOutros({ competencia, abrirGerar }) {
  const [f, on] = useForm({ data: dataComp(competencia), conta_debito: '', conta_credito: '', valor: '', historico: '' })
  return (
    <Card>
      <SecTitle><i className="ti ti-pencil-plus" style={{ color: ACC.outros }} /> Lançamento avulso</SecTitle>
      <SecSub>Escreva a partida. Ao gerar, entra em Lançamentos e alimenta o Status → Domínio.</SecSub>
      <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr 1fr 130px', gap: 10 }}>
        <Field label="Data"><input className="input" type="date" value={f.data} onChange={on('data')} /></Field>
        <Field label="Conta débito"><input className="input" value={f.conta_debito} onChange={on('conta_debito')} /></Field>
        <Field label="Conta crédito"><input className="input" value={f.conta_credito} onChange={on('conta_credito')} /></Field>
        <Field label="Valor"><input className="input" value={f.valor} onChange={on('valor')} placeholder="0,00" /></Field>
        <Field label="Histórico" col={4}><input className="input" value={f.historico} onChange={on('historico')} /></Field>
      </div>
      <div style={{ marginTop: 14 }}>
        <button className="btn" onClick={() => abrirGerar({ data: f.data, conta_debito: f.conta_debito, conta_credito: f.conta_credito, valor: num(f.valor), historico: f.historico, origem: 'manual', documento: '' }, 'Lançamento avulso')}><i className="ti ti-file-plus" /> Gerar lançamento</button>
      </div>
    </Card>
  )
}

function Aviso({ texto }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 12 }}>Outras Contabilizações</h1>
      <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 12, padding: '28px 24px', display: 'flex', alignItems: 'center', gap: 14, maxWidth: 560 }}>
        <i className="ti ti-building" style={{ fontSize: 24, color: theme.accent }} /><p style={{ fontSize: 14, color: theme.text }}>{texto}</p>
      </div>
    </div>
  )
}
