import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { useAuth } from '../components/AuthProvider'
import { fechaSozinho } from '../lib/clientes'
import { normalizaCompetencia } from '../lib/balancete'
import { calcularProgresso } from '../lib/progresso'
import { theme } from '../lib/theme'
import InfoTela from '../components/InfoTela'

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']
const MESES_CURTO = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']

const ST = {
  fechado: { txt: 'Encerrado', cor: theme.green, bg: 'rgba(48,164,108,0.15)', icon: 'ti-lock-check', sub: () => 'Encerrado (somente leitura)' },
  // 100% dos gates OK, ainda não encerrado formalmente. Verde (conta como Fechado no resumo).
  pronto: { txt: 'Concluído', cor: theme.green, bg: 'rgba(48,164,108,0.15)', icon: 'ti-circle-check', sub: () => 'Pronto para encerrar · 100%' },
  andamento: { txt: 'Em andamento', cor: theme.yellow, bg: 'rgba(245,166,35,0.15)', icon: 'ti-progress', sub: c => `Progresso ${c.pct || 0}%` },
  pendente: { txt: 'Pendente', cor: theme.red, bg: 'rgba(229,72,77,0.15)', icon: 'ti-alert-triangle', sub: () => 'Aguardando importação do razão' },
}

export default function Fechamentos() {
  const { empresas, empresaId, empresaNome, competencia, setCompetencia, abrirFechamento, isAdmin, recalcularPendencias, refreshStatusCompetencia } = useAppData()
  const { user } = useAuth()
  const nav = useNavigate()
  const cli = empresas.find(e => e.id === empresaId)
  const podeFechar = cli ? fechaSozinho(cli) : true // filial consolidada fecha na matriz
  const matriz = cli && cli.tipo === 'Filial' ? empresas.find(e => e.codigo_dominio === cli.codigo_matriz) : null
  const [lista, setLista] = useState([])
  const [loading, setLoading] = useState(true)
  const [fAno, setFAno] = useState('todos')
  const [fMes, setFMes] = useState('todos')
  const [excluirAlvo, setExcluirAlvo] = useState(null) // { comp, motivo } (modal excluir c/ motivo)
  const [salvandoAcao, setSalvandoAcao] = useState(false)
  const [novo, setNovo] = useState(null)

  const [selMes, selAno] = competencia.split('/').map(Number)

  async function carregar() {
    setLoading(true)
    const { data } = await supabase.from('competencias').select('id, ano, mes, status, razao_importado, pct, documentos')
      .eq('cliente_id', empresaId).order('ano', { ascending: false }).order('mes', { ascending: false })
    const rows = data || []
    setLista(rows); setLoading(false)
    // Progresso AO VIVO (não depende de abrir o Status de cada cliente): recalcula o % das
    // competências em andamento e atualiza o card + grava em competencias.pct (aquece o
    // Dashboard, que lê o pct salvo). Só as "em andamento" (com razão, não fechadas) —
    // fechadas já são 100% e sem razão ficam como estão.
    const alvo = rows.filter(c => c.status !== 'fechado' && c.razao_importado)
    if (!alvo.length) return
    const pcts = await Promise.all(alvo.map(c => calcularProgresso(empresaId, `${String(c.mes).padStart(2, '0')}/${c.ano}`)))
    const mapPct = {}
    alvo.forEach((c, i) => { mapPct[c.id] = pcts[i] })
    setLista(prev => prev.map(c => (c.id in mapPct ? { ...c, pct: mapPct[c.id] } : c)))
    for (const c of alvo) {
      if ((mapPct[c.id] || 0) !== (c.pct || 0)) await supabase.from('competencias').update({ pct: mapPct[c.id] }).eq('id', c.id)
    }
  }
  useEffect(() => { if (empresaId) carregar(); else { setLista([]); setLoading(false) } }, [empresaId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!empresaId) {
    return <Wrapper><Aviso texto="Selecione uma empresa no menu lateral para ver os fechamentos." /></Wrapper>
  }

  // Meses ANTERIORES ao início do cliente não são fechamentos — foram importados só
  // para alimentar o Comparativo de Movimento. Ficam guardados (mantêm razão/balancete
  // do comparativo), mas não aparecem na lista de fechamentos nem contam nos resumos.
  const iniM = String(normalizaCompetencia(cli?.competencia_inicio) || '').match(/^(\d{2})\/(\d{4})$/)
  const iniMes = iniM ? +iniM[1] : null
  const iniAno = iniM ? +iniM[2] : null
  const anteriorAoInicio = c => iniAno != null && (c.ano < iniAno || (c.ano === iniAno && c.mes < iniMes))

  const filtrada = lista.filter(c => !anteriorAoInicio(c) && (fAno === 'todos' || c.ano === +fAno) && (fMes === 'todos' || c.mes === +fMes))
  // Só é "em andamento" depois de importar o razão; sem razão (e não fechado) → "pendente".
  // 100% dos gates (pct) → "pronto" (verde), mesmo antes de encerrar formalmente.
  const efet = c => c.status === 'fechado' ? 'fechado' : (c.razao_importado ? ((c.pct || 0) >= 100 ? 'pronto' : 'andamento') : 'pendente')
  const cont = { fechado: 0, andamento: 0, pendente: 0 }
  // "pronto" (100%) conta junto com "fechado" no resumo verde.
  filtrada.forEach(c => { const e = efet(c); const b = e === 'pronto' ? 'fechado' : e; cont[b] = (cont[b] || 0) + 1 })

  // Clicar no card abre a competência (a encerrada abre em SOMENTE LEITURA — a faixa de
  // leitura aparece na plataforma). Reabrir é feito pelo botão dedicado (com confirmação).
  function abrir(c) {
    abrirFechamento(c.mes, c.ano) // marca o fechamento como ativo (libera as funções)
    nav('/status')
  }
  // Encerrar DIRETO no card: pergunta se tem certeza e marca a competência como ENCERRADA
  // (somente leitura). Só aparece a 100% (pronto).
  async function encerrarDireto(c) {
    if (!window.confirm(`Encerrar o fechamento de ${MESES[c.mes - 1]}/${c.ano}? Ele fica ENCERRADO (somente leitura) — para editar depois é preciso Reabrir (admin).\n\nTem certeza?`)) return
    setSalvandoAcao(true)
    const { error } = await supabase.from('competencias').update({ status: 'fechado' }).eq('id', c.id)
    setSalvandoAcao(false)
    if (error) { alert('Não consegui encerrar: ' + error.message); return }
    refreshStatusCompetencia?.()
    await carregar()
  }
  // Reabrir DIRETO no card (só administrador): pergunta se tem certeza e volta a ABERTO.
  async function reabrirDireto(c) {
    if (!isAdmin) { alert('Apenas um administrador pode reabrir um fechamento.'); return }
    if (!window.confirm(`Reabrir o fechamento de ${MESES[c.mes - 1]}/${c.ano}? Ele volta a ficar ABERTO para edição.\n\nTem certeza?`)) return
    setSalvandoAcao(true)
    const { error } = await supabase.from('competencias').update({ status: 'andamento' }).eq('id', c.id)
    setSalvandoAcao(false)
    if (error) { alert('Não consegui reabrir: ' + error.message); return }
    refreshStatusCompetencia?.()
    await carregar()
  }
  async function criar() {
    if (!podeFechar) { setNovo(null); return }
    const { ano, mes } = novo
    const existe = lista.find(c => c.ano === +ano && c.mes === +mes)
    if (existe) { setNovo(null); abrir(existe); return }
    const { data, error } = await supabase.from('competencias')
      .insert({ cliente_id: empresaId, ano: +ano, mes: +mes, status: 'andamento' }).select('id, ano, mes, status, pct, documentos').single()
    setNovo(null)
    if (!error && data) { await carregar(); abrir(data) }
  }

  // Excluir: só administrador, e SEMPRE exige o motivo escrito (modal). Abre o modal.
  function excluir(c, e) {
    e.stopPropagation()
    if (!isAdmin) { alert('Apenas um administrador pode excluir um fechamento.'); return }
    setExcluirAlvo({ comp: c, motivo: '' })
  }
  async function excluirConfirmar() {
    const c = excluirAlvo?.comp
    const motivo = (excluirAlvo?.motivo || '').trim()
    if (!c) return
    if (motivo.length < 3) { alert('Escreva o motivo da exclusão.'); return }
    setSalvandoAcao(true)
    try {
      // Registra o motivo (com usuário e data) num log que SOBREVIVE à exclusão da competência.
      await supabase.from('cargas_cadastro').insert({
        cliente_id: empresaId, tipo: 'exclusao_fechamento', vigencia: `${String(c.mes).padStart(2, '0')}/${c.ano}`,
        dados: { mes: c.mes, ano: c.ano, status: c.status, motivo }, usuario: user?.email || null,
      })
      // Se estiver fechada, reabre antes (o bloqueio do banco impede apagar dados de fechada).
      if (c.status === 'fechado') await supabase.from('competencias').update({ status: 'andamento' }).eq('id', c.id)
      for (const t of ['razao', 'balancete', 'lancamentos', 'auditoria', 'ajuste_leitura', 'conciliacao_conta', 'observacoes']) {
        await supabase.from(t).delete().eq('competencia_id', c.id)
      }
      await supabase.from('competencias').delete().eq('id', c.id)
      setExcluirAlvo(null)
      await carregar(); recalcularPendencias?.()
    } catch (err) {
      alert('Não consegui excluir: ' + (err.message || err))
    } finally { setSalvandoAcao(false) }
  }

  return (
    <Wrapper>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <p style={{ color: theme.sub, fontSize: 13.5 }}><b style={{ color: theme.text }}>{empresaNome}</b> — escolha uma competência ou abra um novo fechamento.</p>
        {podeFechar && (
          <button className="btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setNovo({ ano: 2026, mes: 6 })}>
            <i className="ti ti-plus" /> Novo fechamento
          </button>
        )}
      </div>

      {!podeFechar && (
        <div style={{ background: 'rgba(74,124,255,0.12)', border: `1px solid ${theme.accent}`, borderRadius: 12, padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
          <i className="ti ti-git-merge" style={{ fontSize: 22, color: theme.accent, flexShrink: 0 }} />
          <p style={{ fontSize: 13.5, color: theme.text, margin: 0, lineHeight: 1.5 }}>
            Esta filial tem fechamento <b>consolidado na matriz</b>{matriz ? <> — <b>{matriz.razao_social}</b> (código {matriz.codigo_dominio})</> : cli?.codigo_matriz ? <> (código da matriz {cli.codigo_matriz})</> : ''}. Faça o fechamento pela matriz.
            {' '}Para dar fechamento próprio a esta filial, altere o <b>Tipo de fechamento</b> para <b>Individualizado</b> no cadastro.
          </p>
        </div>
      )}

      {/* Filtro */}
      <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <span style={{ color: theme.sub, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}><i className="ti ti-calendar-event" style={{ color: theme.accent }} /> Filtrar período</span>
        <select className="input" style={selS} value={fAno} onChange={e => setFAno(e.target.value)}>
          <option value="todos">Todos os anos</option><option value="2026">2026</option><option value="2025">2025</option>
        </select>
        <select className="input" style={selS} value={fMes} onChange={e => setFMes(e.target.value)}>
          <option value="todos">Todos os meses</option>
          {MESES_CURTO.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
        </select>
      </div>

      {/* Cards de resumo */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14, marginBottom: 16 }}>
        <ResumoCard label="Fechados" valor={cont.fechado} icon="ti-circle-check" cor={theme.green} />
        <ResumoCard label="Em andamento" valor={cont.andamento} icon="ti-progress" cor={theme.yellow} />
        <ResumoCard label="Pendentes" valor={cont.pendente} icon="ti-alert-triangle" cor={theme.red} />
      </div>

      {/* Lista de fechamentos (linhas) */}
      {loading ? (
        <p style={{ color: theme.sub, fontSize: 13 }}>Carregando…</p>
      ) : filtrada.length === 0 ? (
        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: '26px 22px', color: theme.sub, fontSize: 13.5 }}>
          Nenhum fechamento para este filtro. Clique em <b style={{ color: theme.text }}>Novo fechamento</b> para abrir uma competência.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {filtrada.map(c => {
            const s = ST[efet(c)] || ST.pendente
            const aberto = c.mes === selMes && c.ano === selAno
            return (
              <div key={c.id} onClick={() => abrir(c)} style={{
                background: theme.card, borderRadius: 12, padding: '16px 18px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 16,
                border: aberto ? `1px solid ${theme.accent}` : `0.5px solid ${theme.cb}`,
              }}>
                <div style={{ width: 48, height: 48, borderRadius: 12, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: s.bg }}>
                  <i className={`ti ${s.icon}`} style={{ fontSize: 24, color: s.cor }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
                    {MESES[c.mes - 1]} {c.ano}
                    {aberto && <span style={{ color: theme.accent, fontSize: 13, fontWeight: 500 }}> · aberto</span>}
                  </p>
                  <p style={{ color: theme.sub, fontSize: 13, margin: '2px 0 0' }}>{s.sub(c)}</p>
                </div>
                <span style={{ background: s.bg, color: s.cor, fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 20, display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                  <i className={`ti ${s.icon}`} /> {s.txt}
                </span>
                {efet(c) === 'fechado' && (
                  <button className="btn btn-ghost" disabled={salvandoAcao} onClick={e => { e.stopPropagation(); reabrirDireto(c) }}
                    style={{ fontSize: 12.5, padding: '5px 12px', color: theme.yellow, borderColor: theme.yellow, flexShrink: 0, whiteSpace: 'nowrap' }} title="Reabrir este fechamento (somente administrador)">
                    <i className="ti ti-lock-open" /> Reabrir
                  </button>
                )}
                {efet(c) === 'pronto' && (
                  <button className="btn" disabled={salvandoAcao} onClick={e => { e.stopPropagation(); encerrarDireto(c) }}
                    style={{ fontSize: 12.5, padding: '5px 12px', background: theme.green, borderColor: theme.green, flexShrink: 0, whiteSpace: 'nowrap' }} title="Encerrar o fechamento (fica somente leitura)">
                    <i className="ti ti-lock-check" /> Encerrar
                  </button>
                )}
                <i className="ti ti-trash" title="Excluir fechamento" onClick={e => excluir(c, e)}
                  style={{ color: theme.sub, fontSize: 17, flexShrink: 0, cursor: 'pointer' }} />
                <i className="ti ti-chevron-right" style={{ color: theme.sub, fontSize: 20, flexShrink: 0 }} />
              </div>
            )
          })}
        </div>
      )}

      {/* Modal novo fechamento */}
      {novo && (
        <div onClick={() => setNovo(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 60 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(420px, 96vw)', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
            <h2 style={{ fontSize: 17, marginBottom: 16 }}>Novo fechamento</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div><label>Mês</label>
                <select className="input" value={novo.mes} onChange={e => setNovo(n => ({ ...n, mes: +e.target.value }))}>
                  {MESES_CURTO.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                </select>
              </div>
              <div><label>Ano</label>
                <select className="input" value={novo.ano} onChange={e => setNovo(n => ({ ...n, ano: +e.target.value }))}>
                  <option value={2026}>2026</option><option value={2025}>2025</option>
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button className="btn btn-ghost" onClick={() => setNovo(null)}>Cancelar</button>
              <button className="btn" onClick={criar}>Abrir fechamento</button>
            </div>
          </div>
        </div>
      )}


      {/* Modal: EXCLUIR fechamento — exige motivo escrito */}
      {excluirAlvo && (
        <div onClick={() => !salvandoAcao && setExcluirAlvo(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 60 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(480px, 96vw)', background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 16, padding: 24 }}>
            <h2 style={{ fontSize: 17, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8, color: theme.red }}><i className="ti ti-alert-triangle" /> Excluir fechamento</h2>
            <p style={{ color: theme.sub, fontSize: 13.5, margin: '0 0 14px', lineHeight: 1.55 }}>
              Vai apagar <b style={{ color: theme.text }}>{MESES[excluirAlvo.comp.mes - 1]}/{excluirAlvo.comp.ano}</b> e todos os dados dela (razão, balancete, lançamentos, auditoria, conciliação). <b>Escreva o motivo</b> — fica registrado com seu usuário e a data.
            </p>
            <textarea className="input" rows={3} autoFocus placeholder="Motivo da exclusão (obrigatório)"
              value={excluirAlvo.motivo} onChange={e => setExcluirAlvo(a => ({ ...a, motivo: e.target.value }))}
              style={{ width: '100%', resize: 'vertical' }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button className="btn btn-ghost" onClick={() => setExcluirAlvo(null)} disabled={salvandoAcao}>Cancelar</button>
              <button className="btn" style={{ background: theme.red, opacity: excluirAlvo.motivo.trim().length < 3 ? 0.5 : 1 }}
                onClick={excluirConfirmar} disabled={salvandoAcao || excluirAlvo.motivo.trim().length < 3}>
                <i className="ti ti-trash" /> {salvandoAcao ? 'Excluindo…' : 'Excluir definitivamente'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Wrapper>
  )
}

const selS = { width: 'auto', padding: '8px 12px' }

function ResumoCard({ label, valor, icon, cor }) {
  return (
    <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12, padding: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: theme.sub, fontSize: 11, textTransform: 'uppercase', letterSpacing: .5 }}>{label}</span>
        <span style={{ background: 'rgba(74,124,255,0.15)', borderRadius: 8, width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <i className={`ti ${icon}`} style={{ color: cor, fontSize: 16 }} />
        </span>
      </div>
      <p style={{ fontSize: 30, fontWeight: 700, margin: '8px 0 2px' }}>{valor}</p>
      <p style={{ color: theme.sub, fontSize: 12, margin: 0 }}>no período</p>
    </div>
  )
}

function Wrapper({ children }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <h1 style={{ fontSize: 22, fontWeight: 500, margin: 0 }}>Fechamento Contábil</h1>
        <InfoTela titulo="Fechamento Contábil">Abre e acompanha a competência de fechamento de cada cliente. É o <b>contexto</b> (mês/ano) em que as demais telas de fechamento operam.</InfoTela>
      </div>
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
