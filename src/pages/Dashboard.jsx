import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { theme, applyThemeMode, getThemeMode } from '../lib/theme'
import { normalizaCompetencia } from '../lib/balancete'
import { fechaSozinho } from '../lib/clientes'

const MES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']
const MES_C = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
const TEMPO = 10000 // 10s por tela
const N = 8

const fmtH = s => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return `${h}h${String(m).padStart(2, '0')}` }

// Meses ANTERIORES à competência-alvo que o cliente já deveria ter fechado: do início
// (competencia_inicio) até o mês imediatamente anterior ao alvo (o alvo é o fechamento
// corrente — esse fica no placar, não no atraso).
function mesesEsperados(inicio, alvoAno, alvoMes) {
  const m = normalizaCompetencia(inicio).match(/^(\d{2})\/(\d{4})$/)
  if (!m) return []
  let mes = +m[1], ano = +m[2]
  const out = []
  let guard = 0
  while ((ano < alvoAno || (ano === alvoAno && mes < alvoMes)) && guard++ < 240) {
    out.push({ ano, mes }); mes++; if (mes > 12) { mes = 1; ano++ }
  }
  return out
}

// Donut (gráfico de pizza). segs: [{ v, c }]. Mostra um rótulo central.
function Donut({ size = 150, segs, label, sub, labelColor }) {
  const total = segs.reduce((a, s) => a + s.v, 0) || 1
  let acc = 0
  return (
    <div style={{ position: 'relative', width: size, height: size, alignSelf: 'center' }}>
      <svg width={size} height={size} viewBox="0 0 42 42">
        <circle cx="21" cy="21" r="15.9155" fill="none" stroke={theme.cb} strokeWidth="5" />
        {segs.filter(s => s.v > 0).map((s, i) => {
          const p = (s.v / total) * 100, off = 25 - acc; acc += p
          return <circle key={i} cx="21" cy="21" r="15.9155" fill="none" stroke={s.c} strokeWidth="5" strokeDasharray={`${p} ${100 - p}`} strokeDashoffset={off} />
        })}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <b style={{ fontSize: Math.round(size * 0.2), fontWeight: 800, lineHeight: 1, color: labelColor || theme.text }}>{label}</b>
        {sub && <small style={{ color: theme.sub, fontSize: 11 }}>{sub}</small>}
      </div>
    </div>
  )
}

export default function Dashboard() {
  const nav = useNavigate()
  const box = useRef(null)
  const [d, setD] = useState(null)
  const [idx, setIdx] = useState(0)
  const [paused, setPaused] = useState(false)
  const [mode, setMode] = useState(getThemeMode())
  const [agora, setAgora] = useState(new Date())
  const [drill, setDrill] = useState(null) // { titulo, itens:[nomes] } — quem compõe um número
  const [erroPainel, setErroPainel] = useState(null)

  // Competência do painel = mês ANTERIOR ao calendário (a contabilidade fecha um mês depois).
  const hoje = new Date()
  const alvo = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1)
  const targAno = alvo.getFullYear(), targMes = alvo.getMonth() + 1

  useEffect(() => {
    const iv = setInterval(() => setAgora(new Date()), 30000)
    return () => clearInterval(iv)
  }, [])

  useEffect(() => {
    (async () => {
     try {
      const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString()
      const [{ data: cli }, { data: comps }, { data: ts }] = await Promise.all([
        supabase.from('clientes').select('*'),
        supabase.from('competencias').select('cliente_id, ano, mes, status, razao_importado, created_at'),
        supabase.from('timesheet').select('cliente_id, cliente_nome, segundos, created_at').gte('created_at', inicioMes),
      ])
      // Carteira inteira (matriz + filiais) — usada no painel de regime.
      const todos = cli || []
      // Só quem fecha sozinho entra nos demais painéis: matriz e filial individualizada.
      // Filial consolidada é representada pela matriz (não conta em placar/atraso/prazo).
      const clientes = todos.filter(fechaSozinho), cps = comps || [], tss = ts || []
      const nomeCli = Object.fromEntries(clientes.map(c => [c.id, c.razao_social]))

      // Status da competência-alvo por cliente. Uma competência só é "em andamento"
      // depois que o razão é importado; sem competência ou sem razão → "pendente".
      const compAlvo = {}
      for (const cp of cps) if (cp.ano === targAno && cp.mes === targMes) compAlvo[cp.cliente_id] = cp
      const statusEfetivo = cp => cp?.status === 'fechado' ? 'fechado' : (cp && cp.razao_importado) ? 'andamento' : 'pendente'
      const contaStatus = lista => {
        const b = { fechado: [], andamento: [], pendente: [] }
        for (const c of lista) b[statusEfetivo(compAlvo[c.id])].push(c.razao_social)
        return {
          total: lista.length, fechadas: b.fechado.length, andamento: b.andamento.length, pendentes: b.pendente.length,
          fechadasL: b.fechado, andamentoL: b.andamento, pendentesL: b.pendente, totalL: lista.map(c => c.razao_social),
        }
      }

      // 1 · Placar — só a competência-alvo (o fechamento atual). Atrasos ficam nos outros painéis.
      const placar = contaStatus(clientes)
      const recentes = cps.filter(c => c.ano === targAno && c.mes === targMes)
        .slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 6)
        .map(c => ({ nome: nomeCli[c.cliente_id] || '—', mes: c.mes, ano: c.ano, status: statusEfetivo(c) }))

      // 2 · Atraso: meses esperados (desde o início) não fechados, até a competência-alvo.
      const fechadoSet = new Set(cps.filter(c => c.status === 'fechado').map(c => `${c.cliente_id}|${c.ano}|${c.mes}`))
      const atrasoLista = []
      let atrasoTotal = 0
      for (const c of clientes) {
        const mm = mesesEsperados(c.competencia_inicio, targAno, targMes)
        let n = 0, oldest = null
        for (const { ano, mes } of mm) if (!fechadoSet.has(`${c.id}|${ano}|${mes}`)) { n++; if (!oldest) oldest = { ano, mes } }
        if (n > 0) { atrasoTotal += n; atrasoLista.push({ nome: c.razao_social, regime: c.regime_tributario, analista: c.analista, meses: n, oldest }) }
      }
      atrasoLista.sort((a, b) => b.meses - a.meses)

      // 3 · Regime — carteira INTEIRA (matriz + filiais), somando os dois.
      const regMap = {}
      for (const c of todos) { const r = (c.regime_tributario || '').trim() || 'Sem regime'; regMap[r] = (regMap[r] || 0) + 1 }
      const regime = Object.entries(regMap).map(([nome, n]) => ({ nome, n })).sort((a, b) => b.n - a.n)
      const matrizes = todos.filter(c => c.tipo !== 'Filial').length
      const filiais = todos.filter(c => c.tipo === 'Filial').length

      // 4 · Por usuário (analista)
      const porAnalista = {}
      for (const c of clientes) { const a = (c.analista || '').trim() || 'Sem analista'; (porAnalista[a] = porAnalista[a] || []).push(c) }
      const analistas = Object.entries(porAnalista).map(([nome, lista]) => ({ nome, ...contaStatus(lista) }))
        .sort((a, b) => b.total - a.total)

      // 5 · Timesheet do mês corrente por cliente
      const tsMap = {}
      for (const t of tss) { const k = t.cliente_nome || nomeCli[t.cliente_id] || '—'; tsMap[k] = (tsMap[k] || 0) + (Number(t.segundos) || 0) }
      const tsLista = Object.entries(tsMap).map(([nome, s]) => ({ nome, s })).sort((a, b) => b.s - a.s).slice(0, 8)
      const tsTotal = Object.values(tsMap).reduce((a, b) => a + b, 0)

      // 6 · Prazo de entrega (dia do mês). Livre: os dias vêm do que está cadastrado.
      const dias = [...new Set(clientes.map(c => Number(c.prazo_entrega)).filter(p => p >= 1 && p <= 31))].sort((a, b) => a - b)
      const diaCli = {}
      for (const dia of dias) diaCli[dia] = []
      const semPrazo = []
      for (const c of clientes) {
        const p = Number(c.prazo_entrega)
        if (p >= 1 && p <= 31) diaCli[p].push(c); else semPrazo.push(c)
      }
      const prazos = dias.map(dia => {
        const lista = diaCli[dia]
        const entregues = lista.filter(c => compAlvo[c.id]?.status === 'fechado').length
        const faltam = lista.length - entregues
        const vencido = hoje.getDate() > dia && faltam > 0
        const prox = !vencido && faltam > 0 && hoje.getDate() <= dia && (dias.filter(x => x >= hoje.getDate())[0] === dia)
        return { dia, total: lista.length, entregues, faltam, vencido, prox }
      })

      // 7 · Matriz prazo × usuário
      const nomesAnal = analistas.map(a => a.nome)
      const matriz = dias.map(dia => {
        const row = { dia, cels: {}, total: 0 }
        for (const a of nomesAnal) {
          const n = (diaCli[dia] || []).filter(c => ((c.analista || '').trim() || 'Sem analista') === a).length
          row.cels[a] = n; row.total += n
        }
        return row
      })
      const matrizTot = {}
      for (const a of nomesAnal) matrizTot[a] = matriz.reduce((s, r) => s + r.cels[a], 0)

      // 8 · Sistemas financeiros usados pelos clientes (coluna M). Vazio e
      // variações de "Sem Sistema" caem no mesmo balde.
      const sisMap = {}
      for (const c of clientes) {
        let s = (c.sistema_financeiro || '').trim()
        if (!s || /^sem\s*sistema$/i.test(s)) s = 'Sem sistema'
        sisMap[s] = (sisMap[s] || 0) + 1
      }
      const sistemas = Object.entries(sisMap).map(([nome, n]) => ({ nome, n })).sort((a, b) => b.n - a.n)

      setD({ placar, recentes, atrasoLista, atrasoTotal, regime, matrizes, filiais, analistas, tsLista, tsTotal, prazos, dias, semPrazo: semPrazo.length, nomesAnal, matriz, matrizTot, totalClientes: clientes.length, sistemas })
     } catch (e) { console.error('Dashboard:', e); setErroPainel(String(e?.message || e)) }
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Rotação automática (pausa no mouse).
  useEffect(() => {
    if (paused) return
    const t = setTimeout(() => setIdx(i => (i + 1) % N), TEMPO)
    return () => clearTimeout(t)
  }, [idx, paused, d])

  const irPara = i => setIdx((i + N) % N)
  const flipTema = () => setMode(applyThemeMode(mode === 'light' ? 'dark' : 'light'))
  const telaCheia = () => {
    if (!document.fullscreenElement) box.current?.requestFullscreen?.()
    else document.exitFullscreen?.()
  }

  const nomeComp = `${MES[targMes - 1]} / ${targAno}`

  if (erroPainel) return <div style={{ color: theme.red, fontSize: 13 }}><i className="ti ti-alert-triangle" /> Não consegui carregar o painel: {erroPainel}</div>
  if (!d) return <div style={{ color: theme.sub, fontSize: 13 }}>Carregando painel…</div>

  return (
    <div ref={box} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      style={{ background: theme.contentBg, display: 'flex', flexDirection: 'column', gap: 14, minHeight: 'calc(100vh - 160px)' }}>

      {/* topo */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Painel do escritório <span style={{ color: theme.sub, fontWeight: 400, fontSize: 14 }}>· visão global</span></h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: theme.sub, fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{agora.toLocaleDateString('pt-BR')} · {agora.toLocaleTimeString('pt-BR').slice(0, 5)}</span>
          <div style={{ background: theme.card, border: `1px solid ${theme.cb}`, borderRadius: 12, padding: '6px 14px', lineHeight: 1.15 }}>
            <small style={{ color: theme.sub, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: .6, display: 'block' }}>Fechamento</small>
            <b style={{ fontSize: 16 }}>{nomeComp}</b>
          </div>
          <button className="iconbtn-dash" onClick={flipTema} title="Tema claro/escuro" style={iconBtn}><i className={`ti ${mode === 'light' ? 'ti-moon' : 'ti-sun'}`} /></button>
          <button onClick={telaCheia} title="Tela cheia" style={iconBtn}><i className="ti ti-maximize" /></button>
        </div>
      </div>

      {/* barra de rotação */}
      <div style={{ height: 4, background: theme.cb, borderRadius: 20, overflow: 'hidden' }}>
        <div key={idx + (paused ? 'p' : '')} style={{ height: '100%', background: theme.accent, borderRadius: 20, animation: paused ? 'none' : `painelGrow ${TEMPO}ms linear forwards`, width: paused ? '100%' : 0 }} />
      </div>

      {/* palco */}
      <div key={idx} style={{ flex: 1, display: 'flex', flexDirection: 'column', animation: 'painelFade .45s ease' }}>
        {idx === 0 && <PainelVisao d={d} nomeComp={nomeComp} nav={nav} onDrill={setDrill} />}
        {idx === 1 && <PainelAtraso d={d} onDrill={setDrill} />}
        {idx === 2 && <PainelRegime d={d} />}
        {idx === 3 && <PainelUsuario d={d} onDrill={setDrill} />}
        {idx === 4 && <PainelTimesheet d={d} />}
        {idx === 5 && <PainelPrazo d={d} />}
        {idx === 6 && <PainelMatriz d={d} />}
        {idx === 7 && <PainelSistemas d={d} />}
      </div>

      {/* navegação */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <button onClick={() => irPara(idx - 1)} style={arrow}><i className="ti ti-chevron-left" /></button>
        <div style={{ display: 'flex', gap: 8 }}>
          {Array.from({ length: N }).map((_, i) => (
            <span key={i} onClick={() => irPara(i)} style={{ width: i === idx ? 26 : 9, height: 9, borderRadius: 20, background: i === idx ? theme.accent : theme.cb, cursor: 'pointer', transition: '.2s' }} />
          ))}
        </div>
        <button onClick={() => irPara(idx + 1)} style={arrow}><i className="ti ti-chevron-right" /></button>
      </div>

      {drill && <DrillModal titulo={drill.titulo} itens={drill.itens} onClose={() => setDrill(null)} />}
    </div>
  )
}

// Mostra QUEM compõe um número clicado no painel (ex.: os clientes pendentes).
function DrillModal({ titulo, itens, onClose }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 80 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(520px,96vw)', maxHeight: '82vh', overflow: 'auto', background: theme.card, border: `1px solid ${theme.cb}`, borderRadius: 16, padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h2 style={{ fontSize: 17, margin: 0 }}>{titulo} <span style={{ color: theme.sub, fontWeight: 400 }}>· {itens.length}</span></h2>
          <span onClick={onClose} style={{ cursor: 'pointer', color: theme.sub, fontSize: 20, lineHeight: 1 }}><i className="ti ti-x" /></span>
        </div>
        {itens.length === 0
          ? <p style={{ color: theme.sub, fontSize: 13.5, margin: '10px 0 0' }}>Nenhuma empresa nesta categoria.</p>
          : <div style={{ marginTop: 8 }}>
              {itens.slice().sort((a, b) => String(a).localeCompare(String(b), 'pt-BR')).map((nome, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 2px', borderTop: i ? `1px solid ${theme.border}` : 'none', fontSize: 14 }}>
                  <span style={{ color: theme.sub, fontSize: 12, minWidth: 22, textAlign: 'right' }}>{i + 1}</span>
                  <i className="ti ti-building" style={{ color: theme.accent, fontSize: 15 }} />
                  <span>{nome}</span>
                </div>
              ))}
            </div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
  )
}

/* ---------- Painéis ---------- */
function Titulo({ h2, sub }) {
  return <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 14 }}>
    <h2 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>{h2}</h2><span style={{ color: theme.sub, fontSize: 13 }}>{sub}</span>
  </div>
}

function PainelVisao({ d, nomeComp, nav, onDrill }) {
  const p = d.placar
  const cor = { fechado: theme.green, andamento: theme.yellow, pendente: theme.red }
  return (
    <>
      <Titulo h2="Visão geral" sub={`Competência ${nomeComp} (mês anterior — a contabilidade fecha um mês depois)`} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 16 }}>
        <Metric label="Clientes" v={p.total} icon="ti-building" onClick={() => onDrill({ titulo: `Clientes · ${nomeComp}`, itens: p.totalL })} />
        <Metric label="Fechados" v={p.fechadas} icon="ti-circle-check" cor={theme.green} onClick={() => onDrill({ titulo: `Fechados · ${nomeComp}`, itens: p.fechadasL })} />
        <Metric label="Em andamento" v={p.andamento} icon="ti-progress" cor={theme.yellow} onClick={() => onDrill({ titulo: `Em andamento · ${nomeComp}`, itens: p.andamentoL })} />
        <Metric label="Pendentes" v={p.pendentes} icon="ti-alert-triangle" cor={theme.red} onClick={() => onDrill({ titulo: `Pendentes · ${nomeComp}`, itens: p.pendentesL })} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.7fr) minmax(0,1fr)', gap: 16, flex: 1 }}>
        <div style={card}>
          <p style={{ fontSize: 16, fontWeight: 600, margin: '0 0 8px' }}>Fechamentos de {nomeComp}</p>
          {d.recentes.length === 0 ? <p style={{ color: theme.sub, fontSize: 13 }}>Nenhum fechamento de {nomeComp} ainda.</p>
            : d.recentes.map((r, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderTop: `1px solid ${theme.border}`, fontSize: 14 }}>
                <span>{r.nome} <span style={{ color: theme.sub }}>· {MES_C[r.mes - 1]}/{r.ano}</span></span>
                <span style={{ color: cor[r.status] || theme.sub, fontSize: 13 }}>{r.status}</span>
              </div>
            ))}
        </div>
        <div style={card}>
          <p style={{ fontSize: 16, fontWeight: 600, margin: '0 0 8px' }}>Ações rápidas</p>
          {[['ti-calendar-check', 'Ver fechamentos', '/fechamentos'], ['ti-file-import', 'Importar razão', '/razao'], ['ti-file-check', 'Documentos recebidos', '/documentos'], ['ti-info-circle', 'Base de Informações', '/base']].map(([ic, txt, to]) => (
            <div key={to} onClick={() => nav(to)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', cursor: 'pointer', fontSize: 14 }}><i className={`ti ${ic}`} style={{ color: theme.accent }} /> {txt}</div>
          ))}
        </div>
      </div>
    </>
  )
}

function PainelAtraso({ d, onDrill }) {
  const nClientes = d.atrasoLista.length
  const abrir = () => onDrill && onDrill({ titulo: 'Clientes em atraso', itens: d.atrasoLista.map(a => `${a.nome} · ${a.meses} ${a.meses === 1 ? 'mês' : 'meses'}${a.oldest ? ` (desde ${MES_C[a.oldest.mes - 1]}/${a.oldest.ano})` : ''}`) })
  return (
    <>
      <Titulo h2="Balancetes em atraso" sub="Competências de meses anteriores ainda não fechadas" />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,.8fr) minmax(0,1.4fr)', gap: 16, flex: 1, minHeight: 0 }}>
        <div onClick={nClientes ? abrir : undefined} title={nClientes ? 'Ver quais clientes' : undefined} style={{ ...card, display: 'flex', alignItems: 'center', gap: 22, cursor: nClientes ? 'pointer' : 'default' }}>
          <div style={{ fontSize: 92, fontWeight: 800, lineHeight: .9, color: d.atrasoTotal ? theme.red : theme.green }}>{d.atrasoTotal}</div>
          <div style={{ fontSize: 16, color: theme.sub, lineHeight: 1.4 }}>balancete(s) em atraso<br />em <b style={{ color: theme.text }}>{nClientes} cliente(s)</b></div>
        </div>
        <div style={{ ...card, overflow: 'auto' }}>
          {nClientes === 0 ? <p style={{ color: theme.sub, fontSize: 14 }}><i className="ti ti-circle-check" style={{ color: theme.green }} /> Nada em atraso. 🎉</p>
            : d.atrasoLista.slice(0, 7).map((a, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '28px 1fr auto', alignItems: 'center', gap: 12, padding: '11px 0', borderTop: i ? `1px solid ${theme.border}` : 'none' }}>
                <span style={{ color: theme.sub, fontWeight: 700, textAlign: 'center' }}>{i + 1}</span>
                <div><div style={{ fontSize: 15, fontWeight: 600 }}>{a.nome}</div>
                  <div style={{ fontSize: 12, color: theme.sub }}>{a.oldest ? `desde ${MES_C[a.oldest.mes - 1]}/${a.oldest.ano}` : ''}{a.regime ? ` · ${a.regime}` : ''}{a.analista ? ` · ${a.analista}` : ''}</div></div>
                <span style={{ fontSize: 16, fontWeight: 700, color: a.meses >= 3 ? theme.red : theme.yellow }}>{a.meses} {a.meses === 1 ? 'mês' : 'meses'}</span>
              </div>
            ))}
        </div>
      </div>
    </>
  )
}

function PainelRegime({ d }) {
  const max = Math.max(1, ...d.regime.map(r => r.n))
  const cores = [theme.green, theme.accent, theme.yellow, '#7C5CFF', '#E5894D', '#22B8CF']
  return (
    <>
      <Titulo h2="Clientes por regime tributário" sub="Composição da carteira" />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,.7fr)', gap: 16, flex: 1 }}>
        <div style={{ ...card, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 18 }}>
          {d.regime.length === 0 ? <p style={{ color: theme.sub }}>Sem clientes cadastrados.</p>
            : d.regime.map((r, i) => (
              <div key={r.nome}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, marginBottom: 6 }}><span>{r.nome}</span><b>{r.n}</b></div>
                <div style={{ height: 24, background: theme.input, borderRadius: 8, overflow: 'hidden' }}>
                  <div style={{ width: `${(r.n / max) * 100}%`, height: '100%', background: cores[i % cores.length], borderRadius: 8, minWidth: 6 }} />
                </div>
              </div>
            ))}
        </div>
        <div style={{ ...card, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 16 }}>
          <div style={{ textAlign: 'center' }}>
            <small style={{ color: theme.sub, textTransform: 'uppercase', letterSpacing: .6, fontSize: 12 }}>Matrizes</small>
            <b style={{ fontSize: 52, fontWeight: 800, display: 'block', lineHeight: 1 }}>{d.matrizes}</b>
          </div>
          <div style={{ textAlign: 'center' }}>
            <small style={{ color: theme.sub, textTransform: 'uppercase', letterSpacing: .6, fontSize: 12 }}>Filiais</small>
            <b style={{ fontSize: 52, fontWeight: 800, display: 'block', lineHeight: 1 }}>{d.filiais}</b>
          </div>
          <div style={{ textAlign: 'center', borderTop: `1px solid ${theme.border}`, paddingTop: 12 }}>
            <small style={{ color: theme.sub, textTransform: 'uppercase', letterSpacing: .6, fontSize: 12 }}>Total da carteira</small>
            <b style={{ fontSize: 30, fontWeight: 800, display: 'block' }}>{d.matrizes + d.filiais}</b>
          </div>
        </div>
      </div>
    </>
  )
}

function PainelUsuario({ d, onDrill }) {
  return (
    <>
      <Titulo h2="Fechamento por usuário" sub="Progresso de cada analista no mês" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, flex: 1 }}>
        {d.analistas.length === 0 ? <p style={{ color: theme.sub }}>Sem analistas atribuídos.</p>
          : d.analistas.map((a, i) => {
            const pct = a.total ? Math.round((a.fechadas / a.total) * 100) : 0
            const ini = (a.nome[0] || '?').toUpperCase()
            const cor = ['#4A7CFF', '#7C5CFF', '#E5894D', '#22B8CF', '#30A46C', '#E54D8A'][i % 6]
            return (
              <div key={a.nome} style={{ ...card, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ width: 46, height: 46, borderRadius: '50%', background: cor, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 18 }}>{ini}</span>
                  <div><b style={{ fontSize: 18 }}>{a.nome}</b><br /><small style={{ color: theme.sub }}>{a.total} empresa(s)</small></div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
                  <MiniN n={a.fechadas} t="fechadas" c={theme.green} onClick={() => onDrill && onDrill({ titulo: `${a.nome} · fechadas`, itens: a.fechadasL || [] })} />
                  <MiniN n={a.andamento} t="andamento" c={theme.yellow} onClick={() => onDrill && onDrill({ titulo: `${a.nome} · em andamento`, itens: a.andamentoL || [] })} />
                  <MiniN n={a.pendentes} t="pendente" c={theme.red} onClick={() => onDrill && onDrill({ titulo: `${a.nome} · pendentes`, itens: a.pendentesL || [] })} />
                </div>
                <Donut size={180} label={`${pct}%`} segs={[{ v: a.fechadas, c: theme.green }, { v: a.andamento, c: theme.yellow }, { v: a.pendentes, c: theme.red }]} />
              </div>
            )
          })}
      </div>
    </>
  )
}

function PainelTimesheet({ d }) {
  const max = Math.max(1, ...d.tsLista.map(t => t.s))
  return (
    <>
      <Titulo h2="Timesheet por cliente" sub="Horas no mês corrente" />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,.7fr)', gap: 16, flex: 1, minHeight: 0 }}>
        <div style={{ ...card, overflow: 'auto' }}>
          {d.tsLista.length === 0 ? <p style={{ color: theme.sub, fontSize: 14 }}>Sem tempo registrado neste mês.</p>
            : d.tsLista.map((t, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '28px 1fr auto', alignItems: 'center', gap: 12, padding: '11px 0', borderTop: i ? `1px solid ${theme.border}` : 'none' }}>
                <span style={{ color: theme.sub, fontWeight: 700, textAlign: 'center' }}>{i + 1}</span>
                <div style={{ width: '100%' }}><div style={{ fontSize: 15, fontWeight: 600 }}>{t.nome}</div>
                  <div style={{ height: 8, background: theme.cb, borderRadius: 20, marginTop: 6, overflow: 'hidden' }}><div style={{ width: `${(t.s / max) * 100}%`, height: '100%', background: theme.accent, borderRadius: 20 }} /></div></div>
                <span style={{ fontSize: 16, fontWeight: 700 }}>{fmtH(t.s)}</span>
              </div>
            ))}
        </div>
        <div style={{ ...card, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
          <small style={{ color: theme.sub, textTransform: 'uppercase', letterSpacing: .6, fontSize: 12 }}>Total da equipe</small>
          <b style={{ fontSize: 52, fontWeight: 800 }}>{fmtH(d.tsTotal)}</b>
          <small style={{ color: theme.sub }}>no mês</small>
        </div>
      </div>
    </>
  )
}

function PainelPrazo({ d }) {
  return (
    <>
      <Titulo h2="Empresas por prazo de entrega" sub={`Prazo do balancete · hoje é dia ${new Date().getDate()}${d.semPrazo ? ` · ${d.semPrazo} sem prazo definido` : ''}`} />
      {d.prazos.length === 0 ? (
        <div style={{ ...card, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.sub, fontSize: 15 }}>
          Nenhum prazo de entrega definido nos clientes. Preencha o dia no cadastro para ver este painel.
        </div>
      ) : (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gridAutoRows: '1fr', gap: 14, flex: 1, minHeight: 0 }}>
        {d.prazos.map(p => {
          const pct = p.total ? Math.round((p.entregues / p.total) * 100) : 0
          const corFalta = p.vencido ? theme.red : p.prox ? theme.accent : '#5A6785'
          const borda = p.vencido ? theme.red : p.prox ? theme.accent : 'transparent'
          const av = p.vencido ? theme.red : p.prox ? theme.accent : p.total && p.faltam === 0 ? theme.green : '#5A6785'
          const st = p.total === 0 ? 'sem empresas' : p.vencido ? `${p.faltam} vencida(s)` : p.prox ? 'próximo prazo' : p.faltam === 0 ? 'em dia' : 'aguardando'
          return (
            <div key={p.dia} style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 9, border: `2px solid ${borda}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ width: 44, height: 44, borderRadius: '50%', background: av, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 15 }}>{p.dia}</span>
                <div><b style={{ fontSize: 18 }}>Dia {p.dia}</b><br /><small style={{ color: p.vencido ? theme.red : theme.sub }}>{p.total} empresa(s) · {st}</small></div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <MiniN n={p.entregues} t="entregues" c={theme.green} sm /><MiniN n={p.faltam} t="faltam" c={p.vencido ? theme.red : theme.sub} sm />
              </div>
              <Donut size={120} label={`${pct}%`} labelColor={p.total ? theme.text : theme.sub} segs={[{ v: p.entregues, c: theme.green }, { v: p.faltam, c: corFalta }]} />
            </div>
          )
        })}
      </div>
      )}
    </>
  )
}

function PainelMatriz({ d }) {
  const intens = n => n ? `rgba(74,124,255,${Math.min(0.62, 0.16 + (n - 1) * 0.22)})` : theme.input
  return (
    <>
      <Titulo h2="Empresas por prazo e usuário" sub="Quantas empresas cada analista entrega em cada data" />
      <div style={{ ...card, flex: 1, display: 'flex', alignItems: 'center', overflow: 'auto' }}>
        {d.nomesAnal.length === 0 ? <p style={{ color: theme.sub }}>Sem analistas atribuídos.</p> : (
          <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 10 }}>
            <thead>
              <tr>
                <th style={{ ...mth, textAlign: 'left' }}>Prazo</th>
                {d.nomesAnal.map(a => <th key={a} style={mth}>{a}</th>)}
                <th style={mth}>Total</th>
              </tr>
            </thead>
            <tbody>
              {d.matriz.map(r => (
                <tr key={r.dia}>
                  <td style={{ ...mtd, background: 'transparent', textAlign: 'left', fontSize: 16, fontWeight: 700 }}>Dia {r.dia}</td>
                  {d.nomesAnal.map(a => <td key={a} style={{ ...mtd, background: intens(r.cels[a]), color: r.cels[a] ? theme.text : theme.sub }}>{r.cels[a]}</td>)}
                  <td style={{ ...mtd, background: 'transparent', color: theme.sub }}>{r.total}</td>
                </tr>
              ))}
              <tr>
                <td style={{ ...mtd, background: 'transparent', textAlign: 'left', fontSize: 16, fontWeight: 700, borderTop: `1px solid ${theme.border}` }}>Total</td>
                {d.nomesAnal.map(a => <td key={a} style={{ ...mtd, background: 'transparent', borderTop: `1px solid ${theme.border}` }}>{d.matrizTot[a]}</td>)}
                <td style={{ ...mtd, background: 'transparent', borderTop: `1px solid ${theme.border}`, color: theme.accent }}>{d.totalClientes - d.semPrazo}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

function PainelSistemas({ d }) {
  const sistemas = d.sistemas || []
  const max = Math.max(1, ...sistemas.map(s => s.n))
  const totalCli = sistemas.reduce((a, s) => a + s.n, 0)
  const comSistema = sistemas.filter(s => s.nome !== 'Sem sistema').reduce((a, s) => a + s.n, 0)
  const distintos = sistemas.filter(s => s.nome !== 'Sem sistema').length
  const cores = [theme.accent, theme.green, '#7C5CFF', '#E5894D', theme.yellow, '#22B8CF', '#E54D8A', '#30A46C']
  return (
    <>
      <Titulo h2="Sistemas usados pelos clientes" sub="Quantos clientes usam cada sistema financeiro" />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,.7fr)', gap: 16, flex: 1, minHeight: 0 }}>
        <div style={{ ...card, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 16, overflow: 'auto' }}>
          {sistemas.length === 0 ? <p style={{ color: theme.sub }}>Sem clientes cadastrados.</p>
            : sistemas.map((s, i) => {
              const pct = totalCli ? Math.round((s.n / totalCli) * 100) : 0
              const semSis = s.nome === 'Sem sistema'
              return (
                <div key={s.nome}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 15, marginBottom: 6 }}>
                    <span style={{ color: semSis ? theme.sub : theme.text }}>{s.nome}</span>
                    <span><b>{s.n}</b> <small style={{ color: theme.sub }}>· {pct}%</small></span>
                  </div>
                  <div style={{ height: 24, background: theme.input, borderRadius: 8, overflow: 'hidden' }}>
                    <div style={{ width: `${(s.n / max) * 100}%`, height: '100%', background: semSis ? '#5A6785' : cores[i % cores.length], borderRadius: 8, minWidth: 6 }} />
                  </div>
                </div>
              )
            })}
        </div>
        <div style={{ ...card, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
          <small style={{ color: theme.sub, textTransform: 'uppercase', letterSpacing: .6, fontSize: 12 }}>Sistemas diferentes</small>
          <b style={{ fontSize: 64, fontWeight: 800 }}>{distintos}</b>
          <small style={{ color: theme.sub }}>{comSistema} de {totalCli} clientes usam sistema</small>
        </div>
      </div>
    </>
  )
}

/* ---------- peças ---------- */
function Metric({ label, v, icon, cor, onClick }) {
  return (
    <div onClick={onClick} title={onClick ? 'Ver quais empresas' : undefined}
      style={{ background: theme.input, borderRadius: 12, padding: 16, cursor: onClick ? 'pointer' : 'default' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: theme.sub, fontSize: 11, textTransform: 'uppercase', letterSpacing: .5 }}>{label}</span>
        <span style={{ background: 'rgba(74,124,255,0.15)', borderRadius: 8, width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><i className={`ti ${icon}`} style={{ color: theme.accent, fontSize: 16 }} /></span>
      </div>
      <p style={{ fontSize: 34, fontWeight: 800, margin: '8px 0 0', color: cor || theme.text }}>{v}{onClick ? <i className="ti ti-chevron-right" style={{ fontSize: 15, color: theme.sub, marginLeft: 6, verticalAlign: 'middle' }} /> : null}</p>
    </div>
  )
}
function MiniN({ n, t, c, sm, onClick }) {
  return <div onClick={onClick} title={onClick ? 'Ver quais empresas' : undefined}
    style={{ background: theme.input, borderRadius: 10, padding: sm ? 8 : 10, textAlign: 'center', cursor: onClick ? 'pointer' : 'default' }}>
    <b style={{ display: 'block', fontSize: sm ? 20 : 24, fontWeight: 800, color: c }}>{n}</b><small style={{ fontSize: 11, color: theme.sub }}>{t}</small>
  </div>
}

const card = { background: theme.card, border: `1px solid ${theme.cb}`, borderRadius: 16, padding: 22 }
const iconBtn = { background: theme.card, border: `1px solid ${theme.cb}`, color: theme.text, borderRadius: 10, width: 40, height: 40, cursor: 'pointer', fontSize: 18, display: 'flex', alignItems: 'center', justifyContent: 'center' }
const arrow = { background: theme.card, border: `1px solid ${theme.cb}`, color: theme.text, width: 38, height: 38, borderRadius: '50%', cursor: 'pointer', fontSize: 18, display: 'flex', alignItems: 'center', justifyContent: 'center' }
const mth = { fontSize: 13, color: theme.sub, textTransform: 'uppercase', letterSpacing: .5, fontWeight: 600, padding: '6px 8px', textAlign: 'center' }
const mtd = { textAlign: 'center', borderRadius: 12, padding: 16, fontSize: 22, fontWeight: 800, color: theme.text }
