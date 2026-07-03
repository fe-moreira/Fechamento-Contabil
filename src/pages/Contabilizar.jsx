import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import { theme, money } from '../lib/theme'
import CampoConta from '../components/CampoConta'
import { gerarExcelTimbrado } from '../lib/excel'

const vazio = { data: '', conta_debito: '', conta_credito: '', valor: '', historico: '', documento: '' }
const MODULOS_SUGESTAO = ['Conciliação', 'Comparativo', 'Status']
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

export default function Contabilizar() {
  const { empresaId, empresaNome, competencia, getCompetenciaId } = useAppData()
  const { user } = useAuth()
  const [lista, setLista] = useState([])
  const [plano, setPlano] = useState([])      // [{cod, nome}]
  const [status, setStatus] = useState(null)  // status da competência
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState('')
  const [form, setForm] = useState(vazio)
  const [modo, setModo] = useState('escrever') // 'escrever' | 'reclassificar' | 'documento'
  const [rec, setRec] = useState({ errada: '', certa: '', lado: 'debito' }) // reclassificação de conta
  const [salvando, setSalvando] = useState(false)
  const [aberto, setAberto] = useState(false)

  const [sugestoes, setSugestoes] = useState([])
  const [tratadas, setTratadas] = useState(() => new Set())
  const [sugConfirmando, setSugConfirmando] = useState(null)

  const ro = status === 'fechado' // somente leitura quando fechado
  const planoMap = useMemo(() => Object.fromEntries(plano.map(p => [p.cod, p.nome])), [plano])

  async function competenciaInfo() {
    if (!empresaId) return null
    const [mes, ano] = competencia.split('/').map(Number)
    const { data } = await supabase.from('competencias').select('id, status')
      .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()
    return data || null
  }

  async function carregarPlano() {
    const { data } = await supabase.from('cargas_cadastro').select('dados')
      .eq('cliente_id', empresaId).eq('tipo', 'plano').order('created_at', { ascending: false }).limit(1).maybeSingle()
    const rows = Array.isArray(data?.dados) ? data.dados : []
    if (!rows.length) { setPlano([]); return }
    const keys = Object.keys(rows[0])
    const kCod = keys.find(k => /cod|reduz/.test(norm(k))) || keys.find(k => /conta/.test(norm(k))) || keys[0]
    const kNome = keys.find(k => /nome|descri/.test(norm(k))) || keys.find(k => k !== kCod) || keys[0]
    setPlano(rows.map(r => ({ cod: String(r[kCod] ?? '').trim(), nome: String(r[kNome] ?? '').trim() })).filter(o => o.cod))
  }

  async function carregar() {
    setLoading(true); setErro('')
    const comp = await competenciaInfo()
    setStatus(comp?.status || null)
    await carregarPlano()
    if (!comp) { setLista([]); setSugestoes([]); setLoading(false); return }
    const { data } = await supabase.from('lancamentos').select('*').eq('competencia_id', comp.id).order('data', { ascending: true })
    setLista(data || [])
    const { data: aud } = await supabase.from('auditoria').select('id, modulo, item, tipo, detalhe')
      .eq('competencia_id', comp.id).eq('tipo', 'Correção').in('modulo', MODULOS_SUGESTAO).order('id', { ascending: false })
    // Correções que já viraram lançamento de acerto (casadas pela NF) não reaparecem como sugestão.
    const soNF = s => String(s ?? '').replace(/\D/g, '')
    const docsCorrecao = new Set((data || []).filter(l => l.origem === 'correcao' && l.documento).map(l => soNF(l.documento)).filter(Boolean))
    const nfDoItem = it => soNF((String(it || '').match(/NF\s*([\w]+)/i) || [])[1] || '')
    // Ajuste de leitura (NF/nome/histórico) resolve-se na Conciliação e só vai para o
    // relatório de correções — não entra como sugestão de lançamento.
    const ehAjusteLeitura = s => /^ajuste de leitura/i.test(String(s.detalhe || ''))
    setSugestoes((aud || []).filter(s => {
      if (ehAjusteLeitura(s)) return false
      const nf = nfDoItem(s.item); return !(nf && docsCorrecao.has(nf))
    }))
    setLoading(false)
  }

  useEffect(() => {
    setTratadas(new Set())
    if (!empresaId) { setLista([]); setSugestoes([]); setLoading(false); return }
    carregar() // eslint-disable-line react-hooks/exhaustive-deps
  }, [empresaId, competencia])

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }))
  function abrirNovo() { setForm(vazio); setModo('escrever'); setRec({ errada: '', certa: '', lado: 'debito' }); setSugConfirmando(null); setAberto(true) }
  function confirmarSugestao(s) {
    setForm({ ...vazio, historico: s.detalhe || `${s.modulo} · ${s.item}` })
    setModo('escrever'); setSugConfirmando(s.id); setAberto(true)
  }
  function descartarSugestao(s) { setTratadas(prev => new Set(prev).add(s.id)) }

  async function salvar(e) {
    e.preventDefault(); setSalvando(true); setErro('')
    try {
      const competencia_id = await getCompetenciaId()
      if (!competencia_id) { setErro('Selecione uma empresa.'); return }

      let deb = form.conta_debito.trim() || null
      let cred = form.conta_credito.trim() || null
      let historico = form.historico.trim() || null
      let origem = sugConfirmando ? 'sugestao' : (modo === 'documento' ? 'documento' : 'manual')

      // Reclassificação: monta a partida de estorno mantendo o lado (natureza) original.
      // Errada no débito → D certa / C errada. Errada no crédito → D errada / C certa.
      if (modo === 'reclassificar') {
        const errada = rec.errada.trim(), certa = rec.certa.trim()
        if (!errada || !certa) { setErro('Informe a conta lançada (errada) e a conta correta.'); setSalvando(false); return }
        if (errada === certa) { setErro('A conta correta precisa ser diferente da conta lançada.'); setSalvando(false); return }
        if (rec.lado === 'debito') { deb = certa; cred = errada } else { deb = errada; cred = certa }
        historico = historico || `Reclassificação: ${errada} → ${certa}`
        origem = 'correcao'
      }

      const { error } = await supabase.from('lancamentos').insert({
        competencia_id,
        data: form.data || null,
        conta_debito: deb,
        conta_credito: cred,
        valor: Number(form.valor) || 0,
        historico,
        documento: form.documento.trim() || null,
        origem,
        usuario: user?.email || null,
      })
      if (error) throw error
      if (sugConfirmando) setTratadas(prev => new Set(prev).add(sugConfirmando))
      setAberto(false); setSugConfirmando(null); carregar()
    } catch (err) { setErro(err.message) } finally { setSalvando(false) }
  }

  async function excluir(l) {
    if (!confirm('Excluir este lançamento?')) return
    const { error } = await supabase.from('lancamentos').delete().eq('id', l.id)
    if (error) setErro(error.message); else carregar()
  }

  function gerarDominio() {
    if (!lista.length) { alert('Não há lançamentos para gerar o arquivo.'); return }
    const hdr = ['Data', 'Cód. Conta Debito', 'Cód. Conta Credito', 'Valor', 'Cód. Histórico', 'Complemento Histórico', 'Inicia Lote', 'Código Matriz/Filial', 'Centro de Custo Débito', 'Centro de Custo Crédito']
    const linhas = [hdr.join(';')]
    lista.forEach((l, i) => {
      const v = (Number(l.valor) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      const data = l.data ? l.data.split('-').reverse().join('/') : ''
      linhas.push([data, l.conta_debito || '', l.conta_credito || '', v, '', l.historico || '', i === 0 ? '1' : '', '9999', '', ''].join(';'))
    })
    baixar('﻿' + linhas.join('\r\n'), 'lanctos_dominio.csv')
  }

  function relatorioLancamentos() {
    gerarExcelTimbrado({
      titulo: 'Relatório de lançamentos',
      sub: `${empresaNome} · competência ${competencia}`,
      colunas: [
        { nome: 'Data', largura: 14 },
        { nome: 'Conta débito', largura: 18 },
        { nome: 'Conta crédito', largura: 18 },
        { nome: 'Valor', alinhar: 'right', moeda: true },
        { nome: 'Histórico', largura: 50, wrap: true },
        { nome: 'Origem', largura: 18 },
      ],
      linhas: lista.map(l => [
        l.data ? l.data.split('-').reverse().join('/') : '', l.conta_debito || '', l.conta_credito || '',
        Number(l.valor) || 0, l.historico || '', l.origem || '',
      ]),
      totais: ['', '', 'TOTAL', lista.reduce((s, l) => s + (Number(l.valor) || 0), 0), '', ''],
      arquivo: `lancamentos_${competencia.replace('/', '-')}.xlsx`,
      aba: 'Lançamentos',
    })
  }

  if (!empresaId) {
    return <Wrapper><Aviso texto="Selecione uma empresa no menu lateral." /></Wrapper>
  }

  const total = lista.reduce((s, l) => s + (Number(l.valor) || 0), 0)
  const sugestoesAtivas = sugestoes.filter(s => !tratadas.has(s.id))

  return (
    <Wrapper>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 16 }}>
        <b style={{ color: theme.text }}>{empresaNome}</b> · competência <b style={{ color: theme.text }}>{competencia}</b>
        {ro && <span style={{ marginLeft: 10, color: theme.red, fontWeight: 600 }}><i className="ti ti-lock" /> Fechado · somente leitura</span>}
      </p>

      {erro && <p style={{ color: theme.red, fontSize: 13, marginBottom: 14 }}>Erro: {erro}</p>}

      {/* Botões */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
        {!ro && <button className="btn" onClick={abrirNovo}><i className="ti ti-pencil-plus" /> Novo lançamento</button>}
        <button className="btn btn-ghost" onClick={relatorioLancamentos} disabled={!lista.length}><i className="ti ti-report" /> Relatório de lançamentos</button>
        {!ro && <button className="btn btn-ghost" onClick={gerarDominio} disabled={!lista.length}><i className="ti ti-file-export" /> Gerar arquivo Domínio</button>}
      </div>

      {/* Sugestões da plataforma */}
      {!loading && !ro && sugestoesAtivas.length > 0 && (
        <section style={{ marginBottom: 22 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: '#8FB0FF', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            <i className="ti ti-robot" /> Sugestões da plataforma
          </h2>
          <div style={{ display: 'grid', gap: 10 }}>
            {sugestoesAtivas.map(s => (
              <div key={s.id} style={{ background: theme.card, border: `0.5px solid #4A7CFF`, borderLeft: '3px solid #4A7CFF', borderRadius: '0 12px 12px 0', padding: '14px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{s.item || s.modulo}</p>
                    <span style={{ background: 'rgba(74,124,255,0.14)', color: '#8FB0FF', fontSize: 11, padding: '3px 9px', borderRadius: 20 }}>{s.modulo}</span>
                  </div>
                </div>
                <p style={{ color: theme.sub, fontSize: 13, margin: '0 0 12px', lineHeight: 1.5 }}>{s.detalhe || '(sem detalhe)'}</p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn" style={{ fontSize: 13 }} onClick={() => confirmarSugestao(s)}><i className="ti ti-check" /> Confirmar lançamento</button>
                  <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => descartarSugestao(s)}><i className="ti ti-x" /> Descartar</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Lançamentos do fechamento */}
      <p style={{ color: theme.sub, fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: .6, margin: '4px 0 10px' }}>
        Lançamentos do fechamento ({lista.length})
      </p>
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
          <thead>
            <tr style={{ background: theme.input }}>
              {['Data', 'Débito', 'Crédito', 'Valor', 'Histórico', 'Origem', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} style={{ padding: 20, color: theme.sub }}>Carregando…</td></tr>
            ) : lista.length === 0 ? (
              <tr><td colSpan={7} style={{ padding: 20, color: theme.sub }}>Nenhum lançamento nesta competência.{!ro && ' Clique em “Novo lançamento”.'}</td></tr>
            ) : lista.map(l => (
              <tr key={l.id} style={{ borderTop: `1px solid ${theme.border}` }}>
                <td style={{ ...td, color: theme.sub, whiteSpace: 'nowrap' }}>{l.data ? l.data.split('-').reverse().join('/') : ''}</td>
                <td style={td}><ContaCell cod={l.conta_debito} nome={planoMap[l.conta_debito]} /></td>
                <td style={td}><ContaCell cod={l.conta_credito} nome={planoMap[l.conta_credito]} /></td>
                <td style={{ ...td, whiteSpace: 'nowrap', fontWeight: 600 }}>{money(l.valor)}</td>
                <td style={{ ...td, maxWidth: 280 }}>{l.historico || ''}</td>
                <td style={{ ...td, color: theme.sub }}>{l.origem || ''}</td>
                <td style={{ padding: '9px 14px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {!ro && <button className="btn btn-ghost" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => excluir(l)}>excluir</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Arquivo de importação do Domínio */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 18, marginTop: 16, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <i className="ti ti-file-export" style={{ color: theme.accent, fontSize: 22 }} />
        <div style={{ flex: 1, minWidth: 200 }}>
          <p style={{ color: theme.text, fontSize: 14, fontWeight: 600, margin: 0 }}>Arquivo de importação do Domínio</p>
          <p style={{ color: theme.sub, fontSize: 12.5, margin: '2px 0 0' }}>{lista.length} lançamento(s) · layout Partidas Simples/Múltiplas, gera o lanctos_dominio.csv.</p>
        </div>
        {!ro && <button className="btn" onClick={gerarDominio} disabled={!lista.length}><i className="ti ti-download" /> Gerar</button>}
      </div>

      {/* Modal Novo lançamento */}
      {aberto && (
        <div onClick={() => setAberto(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 50 }}>
          <form onClick={e => e.stopPropagation()} onSubmit={salvar} style={{ width: 'min(580px,96vw)', maxHeight: '90vh', overflow: 'auto', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
            <h2 style={{ fontSize: 17, marginBottom: 4 }}>{sugConfirmando ? 'Confirmar lançamento' : 'Novo lançamento'}</h2>
            <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 14 }}>Escreva a partida, reclassifique uma conta ou suba o documento.</p>

            {!sugConfirmando && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                <button type="button" className={modo === 'escrever' ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 13 }} onClick={() => setModo('escrever')}><i className="ti ti-pencil" /> Escrever a partida</button>
                <button type="button" className={modo === 'reclassificar' ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 13 }} onClick={() => setModo('reclassificar')}><i className="ti ti-arrows-exchange" /> Reclassificar conta</button>
                <button type="button" className={modo === 'documento' ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 13 }} onClick={() => setModo('documento')}><i className="ti ti-cloud-upload" /> Subir documento</button>
              </div>
            )}

            {modo === 'documento' && (
              <div style={{ marginBottom: 12 }}>
                <label>Documento</label>
                <input type="file" onChange={e => setForm(f => ({ ...f, documento: e.target.files?.[0]?.name || '' }))} style={{ fontSize: 13, color: theme.sub }} />
                {form.documento && <p style={{ color: theme.sub, fontSize: 12, marginTop: 6 }}><i className="ti ti-file" /> {form.documento}</p>}
              </div>
            )}

            {modo === 'reclassificar' ? (
              <>
                <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 12 }}>
                  Informe a conta que <b style={{ color: theme.text }}>foi lançada errada</b>, de que lado ela entrou e a <b style={{ color: theme.text }}>conta correta</b>. A plataforma monta o lançamento de estorno para o Domínio (a outra conta original — ex.: o banco — não é tocada).
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Campo label="Conta lançada (errada)"><CampoConta value={rec.errada} onChange={v => setRec(r => ({ ...r, errada: v }))} /></Campo>
                  <Campo label="Lançada no">
                    <div style={{ display: 'flex', gap: 8 }}>
                      {[['debito', 'Débito'], ['credito', 'Crédito']].map(([v, l]) => (
                        <button key={v} type="button" className={rec.lado === v ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 13, flex: 1 }} onClick={() => setRec(r => ({ ...r, lado: v }))}>{l}</button>
                      ))}
                    </div>
                  </Campo>
                  <Campo label="Conta correta"><CampoConta value={rec.certa} onChange={v => setRec(r => ({ ...r, certa: v }))} /></Campo>
                  <Campo label="Valor"><input className="input" type="number" step="0.01" value={form.valor} onChange={set('valor')} required /></Campo>
                  <Campo label="Data"><input className="input" type="date" value={form.data} onChange={set('data')} required /></Campo>
                  <Campo label="Histórico (opcional)"><input className="input" value={form.historico} onChange={set('historico')} placeholder={rec.errada && rec.certa ? `Reclassificação: ${rec.errada} → ${rec.certa}` : 'Reclassificação…'} /></Campo>
                </div>
                {rec.errada && rec.certa && (
                  <div style={{ background: theme.input, borderRadius: 10, padding: '10px 12px', marginTop: 12, fontSize: 12.5 }}>
                    <span style={{ color: theme.sub }}>Lançamento gerado: </span>
                    <b>D {rec.lado === 'debito' ? rec.certa : rec.errada}</b> <span style={{ color: theme.sub }}>/</span> <b>C {rec.lado === 'debito' ? rec.errada : rec.certa}</b>
                    {Number(form.valor) > 0 && <span style={{ color: theme.sub }}> · {money(form.valor)}</span>}
                  </div>
                )}
              </>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Campo label="Data"><input className="input" type="date" value={form.data} onChange={set('data')} required /></Campo>
                <Campo label="Valor"><input className="input" type="number" step="0.01" value={form.valor} onChange={set('valor')} required /></Campo>
                <Campo label="Conta débito"><CampoConta value={form.conta_debito} onChange={v => setForm(f => ({ ...f, conta_debito: v }))} /></Campo>
                <Campo label="Conta crédito"><CampoConta value={form.conta_credito} onChange={v => setForm(f => ({ ...f, conta_credito: v }))} /></Campo>
                <Campo label="Histórico" full><textarea className="input" rows={2} value={form.historico} onChange={set('historico')} /></Campo>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button type="button" className="btn btn-ghost" onClick={() => setAberto(false)}>Cancelar</button>
              <button className="btn" disabled={salvando}>{salvando ? 'Salvando…' : 'Salvar'}</button>
            </div>
          </form>
        </div>
      )}
    </Wrapper>
  )
}

function ContaCell({ cod, nome }) {
  if (!cod) return ''
  return (<><span style={{ fontWeight: 600 }}>{cod}</span>{nome && <p style={{ color: theme.sub, fontSize: 11.5, margin: '2px 0 0' }}>{nome}</p>}</>)
}
function ContaInput({ value, onChange, plano }) {
  if (plano.length) return (
    <select className="input" value={value} onChange={onChange}>
      <option value="">— selecione a conta —</option>
      {plano.map(p => <option key={p.cod} value={p.cod}>{p.cod} · {p.nome}</option>)}
    </select>
  )
  return <input className="input" value={value} onChange={onChange} placeholder="Código da conta" />
}

const csv = v => `"${String(v ?? '').replace(/"/g, '""')}"`
function baixar(conteudo, nome) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([conteudo], { type: 'text/csv;charset=utf-8;' }))
  a.download = nome; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(a.href)
}

const th = { textAlign: 'left', padding: '11px 14px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3, whiteSpace: 'nowrap' }
const td = { padding: '11px 14px', fontSize: 13, color: theme.text, verticalAlign: 'top' }

function Wrapper({ children }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Ajuda a Contabilizar</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 18, maxWidth: 760 }}>
        Tem dúvida em como lançar algo? Escreva a partida com as contas do plano ou suba o documento. A plataforma também sugere lançamentos e, no fim, gera o arquivo de importação do Domínio.
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
function Campo({ label, children, full }) {
  return <div style={{ gridColumn: full ? '1 / -1' : 'auto' }}><label>{label}</label>{children}</div>
}
