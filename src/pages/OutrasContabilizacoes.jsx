import { useState } from 'react'
import { theme, money } from '../lib/theme'
import { useAppData } from '../lib/appData'

// Acentos por bloco (mesma linguagem do protótipo aprovado).
const ACC = {
  seguro: '#4A7CFF', importacao: '#2FB6A8', emprestimo: '#9A7CF0',
  parcelamento: '#E8923B', equivalencia: '#E06C9F', outros: '#7C89A6',
}
const BLOCOS = [
  { key: 'seguro', label: 'Seguro', icon: 'ti-shield-half', sub: 'Apólices & apropriação', num: 4, foot: '+4 parcelas/mês' },
  { key: 'importacao', label: 'Importação', icon: 'ti-ship', sub: 'Processos de mercadoria', num: 2, foot: '1 a nacionalizar' },
  { key: 'emprestimo', label: 'Empréstimo', icon: 'ti-building-bank', sub: 'Contratos & conferência', num: 3, foot: 'confere × concil.' },
  { key: 'parcelamento', label: 'Parc. Impostos', icon: 'ti-receipt', sub: 'Só juros & multa', num: 2, foot: '+2 atualiz./mês' },
  { key: 'equivalencia', label: 'Equiv. Patrimonial', icon: 'ti-scale', sub: 'Participações (MEP)', num: 2, foot: '1 apontamento' },
  { key: 'outros', label: 'Outros Lançamentos', icon: 'ti-pencil-plus', sub: 'Manual ou por relatório', num: 5, foot: 'antigo Contabilizar' },
]

// ---------------------------------------------------------------- helpers UI
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}
const chipTone = {
  good: [theme.green], warn: [theme.yellow], info: [theme.accent],
  mut: [theme.sub], apont: [theme.red],
}
function Chip({ tone = 'mut', children }) {
  const c = (chipTone[tone] || chipTone.mut)[0]
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 600, padding: '3px 9px', borderRadius: 20, color: c, background: hexA(c.startsWith('#') ? c : '#888888', 0.16) }}>{children}</span>
}
function Card({ children, style }) {
  return <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 12, padding: 18, ...style }}>{children}</div>
}
function SecTitle({ children, style }) { return <p style={{ fontSize: 15, fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: 8, ...style }}>{children}</p> }
function SecSub({ children }) { return <p style={{ color: theme.sub, fontSize: 12.5, margin: '2px 0 14px' }}>{children}</p> }
function Note({ children, tone = 'accent' }) {
  const c = tone === 'accent' ? theme.accent : theme.green
  return <div style={{ display: 'flex', gap: 9, background: hexA('#4A7CFF', 0.07), border: `1px solid ${hexA('#4A7CFF', 0.2)}`, borderRadius: 10, padding: '11px 13px', fontSize: 12.5, color: theme.text, marginTop: 14 }}><i className="ti ti-sparkles" style={{ color: c }} /><span>{children}</span></div>
}
const th = { textAlign: 'left', padding: '9px 12px', fontSize: 11, color: theme.sub, textTransform: 'uppercase', letterSpacing: .3, whiteSpace: 'nowrap', borderBottom: `1px solid ${theme.border}` }
const td = { padding: '11px 12px', fontSize: 13, color: theme.text, borderBottom: `1px solid ${theme.border}`, verticalAlign: 'top' }
function Tabela({ head, children }) {
  return <div style={{ overflowX: 'auto' }}><table><thead><tr>{head.map((h, i) => <th key={i} style={{ ...th, textAlign: h.r ? 'right' : 'left' }}>{h.t ?? h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>
}

// Botão salvar/confirmar com "reabrir" (desfazer).
function SaveBtn({ label, doneLabel = 'confirmado', ghost, onDone }) {
  const [done, setDone] = useState(false)
  if (done) return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <span style={{ color: theme.green, fontWeight: 700, fontSize: 12.5 }}><i className="ti ti-check" /> {doneLabel}</span>
      <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: '4px 9px' }} onClick={() => setDone(false)}><i className="ti ti-rotate" /> reabrir</button>
    </span>
  )
  return <button className={ghost ? 'btn btn-ghost' : 'btn'} onClick={() => { setDone(true); onDone?.() }}>{label}</button>
}

// Linha "a confirmar": Confirmar / não contabilizar, com reabrir.
function ConfirmRow({ icon, color, title, why, partida, amount }) {
  const [st, setSt] = useState(null) // 'ok' | 'no'
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '36px 1fr auto', gap: 12, alignItems: 'center', padding: '12px 2px', borderTop: `1px solid ${theme.border}`, opacity: st ? 0.72 : 1 }}>
      <div style={{ width: 34, height: 34, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', background: hexA(color, 0.16), color }}><i className={`ti ${icon}`} /></div>
      <div style={{ minWidth: 0 }}>
        <b style={{ fontSize: 13.5 }}>{title}</b>
        {why && <div style={{ fontSize: 12, color: theme.sub, margin: '3px 0 5px' }}><i className="ti ti-calendar-event" style={{ color: theme.yellow }} /> {why}</div>}
        {partida && <span style={{ fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 12, color: theme.sub, background: theme.input, border: `1px solid ${theme.border}`, borderRadius: 6, padding: '4px 8px', display: 'inline-block' }}>{partida}</span>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 7 }}>
        {amount != null && <b style={{ fontVariantNumeric: 'tabular-nums', fontSize: 14 }}>{money(amount)}</b>}
        {!st ? (
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn" style={{ fontSize: 12, padding: '6px 12px' }} onClick={() => setSt('ok')}>Confirmar</button>
            <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 10px' }} title="Não contabilizar" onClick={() => setSt('no')}><i className="ti ti-x" /></button>
          </div>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: st === 'ok' ? theme.green : theme.red }}>{st === 'ok' ? '✓ confirmado' : '✕ não contabilizado'}</span>
            <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: '4px 9px' }} onClick={() => setSt(null)}><i className="ti ti-rotate" /> reabrir</button>
          </span>
        )}
      </div>
    </div>
  )
}

// Fluxo "jogar documento -> ler -> contabilização -> salvar".
function UploadFlow({ file, hint, dados, children, saveLabel, saveDone, btnLabel = 'Ler documento' }) {
  const [lido, setLido] = useState(false)
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <div style={{ border: `1.5px dashed ${theme.border}`, borderRadius: 12, padding: '24px 18px', textAlign: 'center' }}>
            <div style={{ width: 50, height: 50, borderRadius: 13, background: hexA('#4A7CFF', 0.14), color: '#8FB0FF', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, margin: '0 auto 12px' }}><i className="ti ti-cloud-upload" /></div>
            <b style={{ display: 'block', fontSize: 14 }}>Arraste o documento</b>
            <small style={{ color: theme.sub }}>{hint}</small>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 9, background: theme.input, border: `1px solid ${theme.border}`, borderRadius: 9, padding: '9px 13px', marginTop: 14, fontSize: 13 }}><i className="ti ti-file" /> {file} <i className="ti ti-check" style={{ color: theme.green }} /></div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
            <button className="btn" onClick={() => setLido(true)} disabled={lido}><i className="ti ti-settings" /> {lido ? 'Documento lido' : btnLabel}</button>
          </div>
        </div>
        <div style={{ background: theme.input, border: `1px solid ${theme.border}`, borderRadius: 12, padding: 16, opacity: lido ? 1 : 0.45, filter: lido ? 'none' : 'grayscale(.3)' }}>
          <SecTitle style={{ fontSize: 13.5, marginBottom: 10 }}>Dados lidos</SecTitle>
          {dados.map((d, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: i < dados.length - 1 ? `1px solid ${theme.border}` : 'none', fontSize: 13 }}>
              <span style={{ color: theme.sub }}>{d.k}</span><span style={{ fontWeight: 600 }}>{d.v}</span>
            </div>
          ))}
          <div style={{ marginTop: 10 }}><Chip tone="info">Confiança da leitura {dados._conf || '95%'}</Chip></div>
        </div>
      </div>
      {lido && (
        <div style={{ marginTop: 18 }}>
          <div style={{ height: 1, background: theme.border, margin: '4px 0 16px' }} />
          {children}
          <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
            {saveLabel && <SaveBtn label={saveLabel} doneLabel={saveDone || 'salvo'} />}
          </div>
        </div>
      )}
    </>
  )
}

// Partida contábil (D/C) só visual.
function Partida({ titulo, lote, linhas }) {
  return (
    <div style={{ background: theme.input, border: `1px solid ${theme.border}`, borderRadius: 10, overflow: 'hidden', marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 13px', background: hexA('#ffffff', 0.03), fontSize: 12, fontWeight: 600, borderBottom: `1px solid ${theme.border}` }}>{titulo}{lote && <span style={{ marginLeft: 'auto', color: theme.sub, fontWeight: 500 }}>{lote}</span>}</div>
      {linhas.map((l, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '24px 1fr auto', gap: 10, padding: l.c ? '8px 13px 8px 37px' : '8px 13px', alignItems: 'baseline', borderBottom: i < linhas.length - 1 ? `1px solid ${theme.border}` : 'none', fontSize: 12.5 }}>
          <span style={{ fontWeight: 800, fontSize: 11, textAlign: 'center', borderRadius: 4, padding: '1px 0', color: l.c ? theme.yellow : '#8FB0FF', background: hexA(l.c ? '#F5A623' : '#4A7CFF', 0.18) }}>{l.c ? 'C' : 'D'}</span>
          <span><b style={{ fontWeight: 600 }}>{l.conta}</b>{l.desc && <small style={{ display: 'block', color: theme.sub, fontSize: 11 }}>{l.desc}</small>}</span>
          <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{l.valor}</span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- OBSERVAÇÕES
const OBS0 = [
  { id: 'o1', icon: 'ti-shield-half', color: ACC.seguro, tipo: 'doc', bloco: 'seguro', t: 'Seguro detectado sem apólice', w: 'Conta 1.1.3.02 “Prêmios a apropriar” tem saldo, mas nenhuma apólice foi cadastrada em julho.' },
  { id: 'o2', icon: 'ti-ship', color: ACC.importacao, tipo: 'doc', bloco: 'importacao', t: 'Importação detectada sem processo', w: '“Fornecedor exterior” movimentou no razão e não há processo de importação cadastrado.' },
  { id: 'o3', icon: 'ti-building-bank', color: ACC.emprestimo, tipo: 'doc', bloco: 'emprestimo', t: 'Empréstimo detectado sem contrato conferido', w: 'Conta 2.1.2 “Empréstimos a pagar” teve movimento e nenhum contrato foi conferido contra a conciliação.' },
  { id: 'o4', icon: 'ti-clock-exclamation', color: theme.red, tipo: 'atraso', bloco: 'parcelamento', t: 'Imposto ou parcela de parcelamento em atraso', w: 'ICMS/PIS vencidos sem baixa, ou parcela não paga. Confirmar o atraso não gera lançamento — vai para o relatório do cliente.' },
  { id: 'o5', icon: 'ti-receipt', color: ACC.parcelamento, tipo: 'doc', bloco: 'parcelamento', t: 'Conta de parcelamento com saldo sem parcelamento cadastrado', w: 'Conta 2.1.2.20 “Parcelamentos a pagar” tem saldo, mas nenhum termo foi cadastrado no bloco.' },
]

function Observacoes({ irPara, abrirModal }) {
  const [aberto, setAberto] = useState(true)
  const [estado, setEstado] = useState({}) // id -> {status, texto}
  const set = (id, v) => setEstado(e => ({ ...e, [id]: v }))
  const pend = OBS0.filter(o => !estado[o.id]).length
  return (
    <Card style={{ border: `1px solid ${hexA('#F5A623', 0.4)}`, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, cursor: 'pointer' }} onClick={() => setAberto(a => !a)}>
        <div>
          <SecTitle><i className="ti ti-alert-triangle" style={{ color: theme.yellow }} /> Observações da conciliação</SecTitle>
          {aberto && <SecSub>A observação só aparece quando a conciliação mostra que <b>houve lançamento/movimento</b> na conta e ainda <b>não há documento/processo registrado</b>. Confirme e suba o processo, corrija (se foi lançamento errado) ou justifique.</SecSub>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <Chip tone="warn">{pend} observaç{pend === 1 ? 'ão' : 'ões'}</Chip>
          <button className="btn btn-ghost" style={{ padding: '4px 9px', fontSize: 13 }} onClick={e => { e.stopPropagation(); setAberto(a => !a) }}><i className={`ti ti-chevron-${aberto ? 'down' : 'left'}`} /></button>
        </div>
      </div>
      {aberto && OBS0.map(o => {
        const st = estado[o.id]
        return (
          <div key={o.id} style={{ display: 'grid', gridTemplateColumns: '36px 1fr auto', gap: 12, alignItems: 'center', padding: '12px 2px', borderTop: `1px solid ${theme.border}`, opacity: st ? 0.72 : 1 }}>
            <div style={{ width: 34, height: 34, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', background: hexA(o.color, 0.16), color: o.color }}><i className={`ti ${o.icon}`} /></div>
            <div style={{ minWidth: 0 }}>
              <b style={{ fontSize: 13.5 }}>{o.t}</b>
              <div style={{ fontSize: 12, color: theme.sub, marginTop: 3 }}><i className="ti ti-search" style={{ color: theme.yellow }} /> {o.w}</div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              {!st ? (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {o.tipo === 'atraso'
                    ? <button className="btn" style={{ fontSize: 12, padding: '6px 12px' }} onClick={() => set(o.id, { status: 'atraso' })}>Confirmar atraso</button>
                    : <button className="btn" style={{ fontSize: 12, padding: '6px 12px' }} onClick={() => set(o.id, { status: 'confirmado', bloco: o.bloco })}>Confirmar e subir</button>}
                  <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 10px' }} onClick={() => abrirModal({ kind: 'corrigir', title: o.t, done: () => set(o.id, { status: 'corrigido' }) })}>Corrigir</button>
                  <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 10px' }} onClick={() => abrirModal({ kind: 'justificar', title: o.t, done: (txt) => set(o.id, { status: 'justificado', texto: txt }) })}>Justificar</button>
                </div>
              ) : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {st.status === 'confirmado' && <><span style={{ fontSize: 12, fontWeight: 700, color: theme.green }}>✓ confirmado</span><button className="btn" style={{ fontSize: 11.5, padding: '4px 9px' }} onClick={() => irPara(st.bloco)}>Subir processo</button></>}
                  {st.status === 'atraso' && <span style={{ fontSize: 12, fontWeight: 700, color: theme.red }}>⏰ em atraso · no relatório do cliente</span>}
                  {st.status === 'corrigido' && <span style={{ fontSize: 12, fontWeight: 700, color: '#8FB0FF' }}>✓ corrigido · vira lançamento e atualiza a Conciliação</span>}
                  {st.status === 'justificado' && <span style={{ fontSize: 12, fontWeight: 700, color: theme.sub }}>✓ justificado{st.texto ? ` · “${st.texto.slice(0, 32)}${st.texto.length > 32 ? '…' : ''}”` : ''}</span>}
                  <button className="btn btn-ghost" style={{ fontSize: 11.5, padding: '4px 9px' }} onClick={() => set(o.id, null)}><i className="ti ti-rotate" /> reabrir</button>
                </span>
              )}
            </div>
          </div>
        )
      })}
    </Card>
  )
}

// ---------------------------------------------------------------- MODAL
function Modal({ cfg, onClose }) {
  const [txt, setTxt] = useState('')
  const [err, setErr] = useState(false)
  if (!cfg) return null
  const justificar = cfg.kind === 'justificar'
  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose() }} style={{ position: 'fixed', inset: 0, background: 'rgba(8,11,18,0.64)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 14, maxWidth: 540, width: '100%', padding: '22px 24px' }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px' }}>{justificar ? 'Justificar observação' : 'Corrigir lançamento'}</h3>
        <p style={{ color: theme.sub, fontSize: 12.5, margin: '0 0 16px' }}>{cfg.title}{justificar ? '' : ' — abra a partida e ajuste.'}</p>
        {justificar ? (
          <div>
            <label>Justificativa (obrigatória)</label>
            <textarea className="input" rows={4} value={txt} onChange={e => { setTxt(e.target.value); setErr(false) }} placeholder="Escreva a justificativa desta observação…" style={err ? { borderColor: theme.red } : undefined} />
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div><label>Data</label><input className="input" defaultValue="31/07/2026" /></div>
              <div><label>Valor</label><input className="input" defaultValue="4.700,00" style={{ textAlign: 'right' }} /></div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div><label>Conta débito</label><input className="input" defaultValue="1.1.1.02 Banco Itaú" /></div>
              <div><label>Conta crédito</label><input className="input" defaultValue="3.1.1.08 Receita reclassificada" /></div>
            </div>
            <div><label>Histórico</label><input className="input" defaultValue="Reclassificação — correção de lançamento" /></div>
            <Note>A correção vira lançamento e <b>atualiza a Conciliação</b>.</Note>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn" onClick={() => { if (justificar && !txt.trim()) { setErr(true); return } cfg.done(txt.trim()); onClose() }}>{justificar ? 'Salvar justificativa' : 'Salvar correção'}</button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- PANES
function PaneSeguro() {
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
          <div><SecTitle>Apropriações de Julho / 2026 — a confirmar</SecTitle><SecSub>Virou o mês → a apropriação de cada apólice fica aqui. Confirme e vira lançamento; nada é postado sozinho.</SecSub></div>
        </div>
        <ConfirmRow icon="ti-shield-half" color={ACC.seguro} title="Porto Seguro — apólice 1188-4477" why="Parcela 1/12 · patrimonial" partida="D 4.1.2.18 · C 1.1.3.02" amount={1000} />
        <ConfirmRow icon="ti-shield-half" color={ACC.seguro} title="Bradesco Seguros — apólice 55-9021" why="Parcela 5/12 · frota" partida="D 4.1.2.18 · C 1.1.3.02" amount={800} />
        <ConfirmRow icon="ti-shield-half" color={ACC.seguro} title="Allianz — apólice A-33120" why="Parcela 7/12 · resp. civil" partida="D 4.1.2.18 · C 1.1.3.02" amount={500} />
        <Note>O que você confirmar aqui vira lançamento, <b>atualiza a Conciliação</b> e alimenta o Status → Domínio.</Note>
      </Card>
      <Card>
        <SecTitle><i className="ti ti-shield-half" style={{ color: ACC.seguro }} /> Novo contrato de seguro</SecTitle>
        <SecSub>Jogue a apólice — a plataforma extrai os dados e monta a contabilização.</SecSub>
        <UploadFlow file="apolice_porto_1188.pdf" hint="PDF, XML ou imagem" btnLabel="Ler documento e contabilizar" saveLabel="Salvar contrato e programar parcelas" saveDone="contrato salvo"
          dados={[{ k: 'Seguradora', v: 'Porto Seguro' }, { k: 'Apólice', v: '1188-4477' }, { k: 'Vigência', v: '07/26 → 06/27' }, { k: 'Prêmio total', v: 'R$ 12.000,00' }, { k: 'Parcelamento', v: '12× R$ 1.000' }]}>
          <SecTitle style={{ fontSize: 14 }}>Contabilização gerada automaticamente</SecTitle>
          <Partida titulo="① Contratação — 01/07/2026" lote="origem: Seguro" linhas={[{ conta: '1.1.3.02 Prêmios a apropriar', desc: 'Despesa antecipada', valor: '12.000,00' }, { c: true, conta: '2.1.1.05 Porto Seguro a pagar', valor: '12.000,00' }]} />
          <Partida titulo="② Apropriação mensal (12×)" lote="gerado a cada fechamento" linhas={[{ conta: '4.1.2.18 Despesas com seguros', desc: 'Resultado — dedutível', valor: '1.000,00' }, { c: true, conta: '1.1.3.02 Prêmios a apropriar', valor: '1.000,00' }]} />
        </UploadFlow>
      </Card>
      <Card>
        <SecTitle>Contratos de seguro armazenados</SecTitle><SecSub>Cada apólice mantém seu cronograma e contabilização.</SecSub>
        <Tabela head={['Seguradora', 'Ramo', 'Vigência', { t: 'Prêmio', r: 1 }, { t: 'Parcela', r: 1 }, 'Status']}>
          {[['Porto Seguro', 'Patrimonial', '07/26–06/27', 12000, 1000], ['Bradesco', 'Frota', '03/26–02/27', 9600, 800], ['Allianz', 'Resp. civil', '01/26–12/26', 6000, 500], ['Tokio Marine', 'Vida', '05/26–04/27', 8400, 700]].map((r, i) => (
            <tr key={i}><td style={td}><b>{r[0]}</b></td><td style={td}>{r[1]}</td><td style={{ ...td, fontFamily: 'monospace' }}>{r[2]}</td><td style={{ ...td, textAlign: 'right' }}>{money(r[3])}</td><td style={{ ...td, textAlign: 'right' }}>{money(r[4])}</td><td style={td}><Chip tone="good"><i className="ti ti-check" /> ativo</Chip></td></tr>
          ))}
        </Tabela>
      </Card>
    </div>
  )
}

function PaneImportacao() {
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Card>
        <SecTitle>Adiantamentos de importação — controle automático</SecTitle>
        <SecSub>Quando a plataforma identifica um <b>adiantamento a fornecedor do exterior</b>, ele entra aqui. Ao subir o processo, é <b>vinculado</b> automaticamente.</SecSub>
        <Tabela head={['Fornecedor (exterior)', 'Data', { t: 'Adiantamento', r: 1 }, 'Vínculo', 'Situação']}>
          <tr><td style={td}><b>Brembo S.p.A.</b> — Itália</td><td style={{ ...td, fontFamily: 'monospace' }}>15/07/2026</td><td style={{ ...td, textAlign: 'right' }}>{money(20000)}</td><td style={td}><Chip tone="mut">sem processo</Chip></td><td style={td}><Chip tone="warn"><i className="ti ti-clock" /> aguardando processo</Chip></td></tr>
          <tr><td style={td}><b>Sachs GmbH</b> — Alemanha</td><td style={{ ...td, fontFamily: 'monospace' }}>02/07/2026</td><td style={{ ...td, textAlign: 'right' }}>{money(40000)}</td><td style={td}><Chip tone="info"><i className="ti ti-link" /> IMP-2026-009</Chip></td><td style={td}><Chip tone="good"><i className="ti ti-check" /> vinculado</Chip></td></tr>
        </Tabela>
        <Note>O adiantamento fica em <b>1.1.5.09 Adiantamentos de importação</b> até o processo chegar. Ao vincular, entra na composição de custo — sem duplicar o lançamento.</Note>
      </Card>
      <Card>
        <SecTitle><i className="ti ti-ship" style={{ color: ACC.importacao }} /> Novo processo de importação</SecTitle>
        <SecSub>Jogue o processo (DI, invoice, notas) — a plataforma acumula os custos.</SecSub>
        <UploadFlow file="processo_IMP-2026-014.zip" hint="DI / DUIMP · Invoice · frete · despachante" btnLabel="Ler processo e contabilizar" saveLabel="Confirmar lançamento" saveDone="lançamento confirmado"
          dados={[{ k: 'Processo / DI', v: 'IMP-2026-014' }, { k: 'Fornecedor', v: 'Brembo S.p.A.' }, { k: 'Invoice', v: 'USD 10.000 · 5,40' }, { k: 'Adiant. vinculado', v: '🔗 R$ 20.000 · Brembo' }]}>
          <SecTitle style={{ fontSize: 14 }}>Composição do custo — contabilização gerada</SecTitle>
          <Partida titulo="Formação de custo — IMP-2026-014" lote="origem: Importação" linhas={[{ conta: '1.1.4.09 Importação em andamento', valor: '78.240,00' }, { c: true, conta: '2.1.1.11 Fornecedor exterior — Brembo', valor: '54.000,00' }, { c: true, conta: '1.1.2.31 Impostos a recuperar/recolher', valor: '19.140,00' }, { c: true, conta: '2.1.1.14 Despachante & frete', valor: '5.100,00' }]} />
          <Note>Adiantamento vinculado: R$ 20.000 (Brembo) entra na composição, sem duplicar. Ao nacionalizar, transfere para <b>Estoque de mercadorias</b>.</Note>
        </UploadFlow>
      </Card>
      <Card>
        <SecTitle>Processos de importação armazenados</SecTitle>
        <Tabela head={['Processo / DI', 'Fornecedor', { t: 'Custo acumulado', r: 1 }, 'Etapa', 'Status']}>
          <tr><td style={td}><b>IMP-2026-014</b></td><td style={td}>Brembo S.p.A.</td><td style={{ ...td, textAlign: 'right' }}>{money(78240)}</td><td style={td}><Chip tone="warn">em curso</Chip></td><td style={td}><Chip tone="info">a nacionalizar</Chip></td></tr>
          <tr><td style={td}><b>IMP-2026-009</b></td><td style={td}>Sachs GmbH</td><td style={{ ...td, textAlign: 'right' }}>{money(146900)}</td><td style={td}><Chip tone="good">nacionalizado</Chip></td><td style={td}><Chip tone="good"><i className="ti ti-check" /> em estoque</Chip></td></tr>
        </Tabela>
      </Card>
    </div>
  )
}

function PaneEmprestimo() {
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Card>
        <SecTitle><i className="ti ti-building-bank" style={{ color: ACC.emprestimo }} /> Novo contrato de empréstimo</SecTitle>
        <SecSub>Jogue o contrato — a plataforma sugere os lançamentos e <b>confere com a Conciliação</b>. Não gera lançamento.</SecSub>
        <UploadFlow file="ccb_itau_capital_giro.pdf" hint="Cédula de crédito bancário · tabela de parcelas" btnLabel="Ler contrato e sugerir lançamentos" saveLabel="Salvar contrato (arquivar)" saveDone="contrato arquivado"
          dados={[{ k: 'Banco', v: 'Itaú Unibanco' }, { k: 'Modalidade', v: 'Capital de giro' }, { k: 'Valor liberado', v: 'R$ 100.000,00' }, { k: 'Prazo / taxa', v: '24× · 1,45% a.m.' }, { k: 'Parcela', v: 'R$ 4.980,00' }]}>
          <SecTitle style={{ fontSize: 14 }}>Lançamentos sugeridos pelo contrato — para conferência</SecTitle>
          <SecSub>O empréstimo <b>não gera lançamento</b> aqui: a baixa real vem do banco. Serve para cruzar com a conciliação.</SecSub>
          <Partida titulo="Parcela mensal esperada" lote="referência — não vai ao Domínio" linhas={[{ conta: '2.1.2.07 Empréstimos a pagar', desc: 'Amortização', valor: '3.530,00' }, { conta: '4.3.1.01 Juros sobre empréstimos', desc: 'Despesa financeira', valor: '1.450,00' }, { c: true, conta: '1.1.1.02 Banco Itaú', valor: '4.980,00' }]} />
          <SecTitle style={{ fontSize: 13.5, marginTop: 18 }}>Conferência com a conciliação — Julho / 2026</SecTitle>
          <div style={{ marginTop: 8 }}>
            <Tabela head={['Item', { t: 'Esperado (contrato)', r: 1 }, { t: 'Na conciliação', r: 1 }, 'Situação']}>
              <tr><td style={td}>Amortização do principal</td><td style={{ ...td, textAlign: 'right' }}>{money(3530)}</td><td style={{ ...td, textAlign: 'right' }}>{money(3530)}</td><td style={td}><Chip tone="good"><i className="ti ti-check" /> bate</Chip></td></tr>
              <tr><td style={td}>Juros do mês</td><td style={{ ...td, textAlign: 'right' }}>{money(1450)}</td><td style={{ ...td, textAlign: 'right' }}>{money(1640)}</td><td style={td}><Chip tone="warn">✗ diverge R$ 190</Chip></td></tr>
            </Tabela>
          </div>
          <Note>Divergência? A correção é feita <b>na Conciliação</b> — não aqui. O contrato só aponta o valor esperado.</Note>
        </UploadFlow>
      </Card>
      <Card>
        <SecTitle>Contratos de empréstimo armazenados</SecTitle>
        <SecSub>Todos guardados aqui. A plataforma confere a parcela do mês contra a conciliação — não gera lançamento.</SecSub>
        <Tabela head={['Banco / contrato', 'Modalidade', { t: 'Saldo devedor', r: 1 }, { t: 'Parcela', r: 1 }, 'Conferência Jul', 'Arquivo']}>
          <tr><td style={td}><b>Itaú</b> CCB-8841</td><td style={td}>Capital de giro</td><td style={{ ...td, textAlign: 'right' }}>{money(100000)}</td><td style={{ ...td, textAlign: 'right' }}>{money(4980)}</td><td style={td}><Chip tone="warn">✗ corrigir na concil.</Chip></td><td style={td}><Chip tone="mut"><i className="ti ti-paperclip" /> armazenado</Chip></td></tr>
          <tr><td style={td}><b>Santander</b> FIN-2207</td><td style={td}>Financ. máquina</td><td style={{ ...td, textAlign: 'right' }}>{money(64200)}</td><td style={{ ...td, textAlign: 'right' }}>{money(3010)}</td><td style={td}><Chip tone="good"><i className="ti ti-check" /> bate</Chip></td><td style={td}><Chip tone="mut"><i className="ti ti-paperclip" /> armazenado</Chip></td></tr>
          <tr><td style={td}><b>BNDES</b> 33.401-9</td><td style={td}>Finame</td><td style={{ ...td, textAlign: 'right' }}>{money(210000)}</td><td style={{ ...td, textAlign: 'right' }}>{money(5120)}</td><td style={td}><Chip tone="good"><i className="ti ti-check" /> bate</Chip></td><td style={td}><Chip tone="mut"><i className="ti ti-paperclip" /> armazenado</Chip></td></tr>
        </Tabela>
      </Card>
    </div>
  )
}

function PaneParcelamento() {
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Card>
        <SecTitle>Atualização de juros e multa — Julho / 2026 — a confirmar</SecTitle>
        <SecSub>A <b>única contabilização</b> do parcelamento é a atualização de juros e multa sobre o saldo. A parcela paga é baixada pelo banco, na conciliação.</SecSub>
        <ConfirmRow icon="ti-receipt" color={ACC.parcelamento} title="PGFN — parcelamento 19.884-0" why="Selic + multa sobre saldo de R$ 132.000" partida="D 4.3.1.05 · C 2.1.2.20" amount={1320} />
        <ConfirmRow icon="ti-receipt" color={ACC.parcelamento} title="ICMS-SP — parcelamento 7742/2025" why="Juros e multa sobre saldo de R$ 61.000" partida="D 4.3.1.05 · C 2.1.2.20" amount={610} />
        <Note>Só a atualização de juros e multa é contabilizada aqui. O pagamento da parcela entra pelo banco, na Conciliação.</Note>
      </Card>
      <Card>
        <SecTitle><i className="ti ti-receipt" style={{ color: ACC.parcelamento }} /> Novo parcelamento de impostos</SecTitle>
        <SecSub>Jogue o termo — a plataforma passa a sugerir a atualização de juros e multa todo mês.</SecSub>
        <UploadFlow file="parcelamento_pgfn_19884.pdf" hint="PGFN / Receita / Sefaz · termo, DAS ou guias" btnLabel="Ler parcelamento" saveLabel="Salvar parcelamento" saveDone="parcelamento salvo"
          dados={[{ k: 'Órgão', v: 'PGFN — União' }, { k: 'Nº / tributo', v: '19.884-0 · IRPJ/CSLL' }, { k: 'Consolidado', v: 'R$ 180.000' }, { k: 'Parcelas', v: '60×' }, { k: 'Saldo devedor', v: 'R$ 132.000' }]}>
          <SecTitle style={{ fontSize: 14 }}>Contabilização gerada — só juros e multa</SecTitle>
          <Partida titulo="Atualização mensal de juros e multa" lote="origem: Parcelamento" linhas={[{ conta: '4.3.1.05 Juros e multa s/ parcelamentos', valor: '1.320,00' }, { c: true, conta: '2.1.2.20 Parcelamentos de impostos a pagar', valor: '1.320,00' }]} />
          <Note>A parcela mensal (principal) é baixada pelo banco, na Conciliação — o bloco não gera esse lançamento.</Note>
        </UploadFlow>
      </Card>
      <Card>
        <SecTitle>Parcelamentos armazenados</SecTitle>
        <Tabela head={['Órgão / nº', 'Tributo', { t: 'Saldo devedor', r: 1 }, { t: 'Parcela', r: 1 }, { t: 'Juros/multa Jul', r: 1 }, 'Arquivo']}>
          <tr><td style={td}><b>PGFN</b> 19.884-0</td><td style={td}>IRPJ/CSLL</td><td style={{ ...td, textAlign: 'right' }}>{money(132000)}</td><td style={{ ...td, textAlign: 'right' }}>{money(3500)}</td><td style={{ ...td, textAlign: 'right' }}>{money(1320)}</td><td style={td}><Chip tone="mut"><i className="ti ti-paperclip" /> armazenado</Chip></td></tr>
          <tr><td style={td}><b>ICMS-SP</b> 7742/2025</td><td style={td}>ICMS</td><td style={{ ...td, textAlign: 'right' }}>{money(61000)}</td><td style={{ ...td, textAlign: 'right' }}>{money(2100)}</td><td style={{ ...td, textAlign: 'right' }}>{money(610)}</td><td style={td}><Chip tone="mut"><i className="ti ti-paperclip" /> armazenado</Chip></td></tr>
        </Tabela>
      </Card>
    </div>
  )
}

function PaneEquivalencia() {
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Card style={{ background: hexA('#E06C9F', 0.07), border: `1px solid ${hexA('#E06C9F', 0.25)}`, display: 'flex', alignItems: 'center', gap: 13 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: hexA('#E06C9F', 0.16), color: '#EE93BC', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><i className="ti ti-link" /></div>
        <div style={{ flex: 1, fontSize: 12.5, color: theme.text }}><b>Habilitado no cadastro.</b> Na Base de Informações consta que a empresa <b>participa de outras empresas</b> — a equivalência é <b>obrigatória</b> e vira <b>apontamento</b> se não for lançada.</div>
      </Card>
      <Card style={{ border: `1px solid ${hexA('#E5484D', 0.4)}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <i className="ti ti-alert-triangle" style={{ fontSize: 22, color: theme.red }} />
          <div style={{ flex: 1 }}><b>Apontamento aberto — equivalência de Julho/2026 não lançada</b><p style={{ margin: '2px 0 0', color: theme.sub, fontSize: 12.5 }}>1 de 2 investidas ainda sem MEP. Suba o resultado da investida para resolver.</p></div>
        </div>
      </Card>
      <Card>
        <SecTitle><i className="ti ti-scale" style={{ color: ACC.equivalencia }} /> Reconhecer equivalência patrimonial</SecTitle>
        <SecSub>Jogue o balancete da investida — a plataforma aplica o % de participação e monta o MEP.</SecSub>
        <UploadFlow file="frenax_balancete_jul26.xlsx" hint="Balancete / DRE da coligada ou controlada" btnLabel="Ler resultado e contabilizar" saveLabel="Salvar e baixar apontamento" saveDone="apontamento baixado"
          dados={[{ k: 'Investida', v: 'Frenax Distribuidora' }, { k: 'Vínculo', v: 'Coligada' }, { k: 'Participação', v: '30%' }, { k: 'Resultado', v: '− R$ 10.000 (prejuízo)' }, { k: 'MEP', v: '− R$ 3.000' }]}>
          <SecTitle style={{ fontSize: 14 }}>Contabilização gerada automaticamente</SecTitle>
          <Partida titulo="Equivalência — Frenax (coligada 30%) · Jul/2026" lote="origem: Equivalência" linhas={[{ conta: '4.3.2.01 Result. negativo de equivalência', desc: 'Despesa — indedutível (LALUR)', valor: '3.000,00' }, { c: true, conta: '1.2.1.03 Investimentos — Frenax', valor: '3.000,00' }]} />
          <Note>Ao salvar, o apontamento é baixado, a <b>Conciliação é atualizada</b> e o lançamento entra no lote do mês.</Note>
        </UploadFlow>
      </Card>
      <Card>
        <SecTitle>Participações societárias (do cadastro)</SecTitle>
        <Tabela head={['Investida', 'Vínculo', { t: 'Particip.', r: 1 }, { t: 'MEP mês', r: 1 }, 'Status']}>
          <tr><td style={td}><b>Euro Brake Peças</b></td><td style={td}>Controlada</td><td style={{ ...td, textAlign: 'right' }}>80%</td><td style={{ ...td, textAlign: 'right', color: theme.green }}>+{money(20000)}</td><td style={td}><Chip tone="good"><i className="ti ti-check" /> lançado</Chip></td></tr>
          <tr><td style={td}><b>Frenax Distribuidora</b></td><td style={td}>Coligada</td><td style={{ ...td, textAlign: 'right' }}>30%</td><td style={{ ...td, textAlign: 'right', color: theme.red }}>−{money(3000)}</td><td style={td}><Chip tone="warn">◔ pendente</Chip></td></tr>
        </Tabela>
      </Card>
    </div>
  )
}

function PaneOutros() {
  const [modo, setModo] = useState('manual')
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Card>
        <SecTitle><i className="ti ti-pencil-plus" style={{ color: ACC.outros }} /> Novo lançamento avulso</SecTitle>
        <SecSub>Substitui o antigo Contabilizar. Escreva a partida manualmente, ou suba um relatório para a plataforma ler e sugerir.</SecSub>
        <div style={{ display: 'inline-flex', background: theme.input, border: `1px solid ${theme.border}`, borderRadius: 9, padding: 3, gap: 3, margin: '4px 0 16px' }}>
          <button className={modo === 'manual' ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 12.5, padding: '7px 14px' }} onClick={() => setModo('manual')}><i className="ti ti-pencil" /> Manual</button>
          <button className={modo === 'relatorio' ? 'btn' : 'btn btn-ghost'} style={{ fontSize: 12.5, padding: '7px 14px' }} onClick={() => setModo('relatorio')}><i className="ti ti-cloud-upload" /> Por relatório</button>
        </div>
        {modo === 'manual' ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr 1fr 130px', gap: 10, alignItems: 'end' }}>
              <div><label>Data</label><input className="input" defaultValue="31/07/2026" /></div>
              <div><label>Conta débito</label><input className="input" placeholder="buscar conta…" /></div>
              <div><label>Conta crédito</label><input className="input" placeholder="buscar conta…" /></div>
              <div><label>Valor</label><input className="input" placeholder="0,00" style={{ textAlign: 'right' }} /></div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 150px', gap: 10, alignItems: 'end', marginTop: 12 }}>
              <div><label>Histórico</label><input className="input" placeholder="Descrição do lançamento" /></div>
              <SaveBtn label="＋ Lançar" doneLabel="lançado" />
            </div>
            <Note>Só entra no arquivo do Domínio quando tem <b>débito E crédito</b>. Ajuste de nome/histórico ou justificativa não vira lançamento.</Note>
          </>
        ) : (
          <UploadFlow file="rateio_despesas_jul26.xlsx" hint="Extrato, planilha de rateio, relatório de despesas" btnLabel="Ler e sugerir lançamentos" saveLabel="Confirmar selecionados" saveDone="sugestões confirmadas"
            dados={[{ k: 'Arquivo', v: 'rateio_despesas' }, { k: 'Linhas', v: '3 sugestões' }, { k: 'Período', v: 'Julho/2026' }]}>
            <SecTitle style={{ fontSize: 14 }}>Lançamentos sugeridos</SecTitle>
            <SecSub>Confira, edite ou descarte cada sugestão.</SecSub>
            <ConfirmRow icon="ti-bolt" color={ACC.outros} title="Energia elétrica — rateio matriz" partida="D 4.1.2.05 · C 1.1.1.02" amount={3480} />
            <ConfirmRow icon="ti-phone" color={ACC.outros} title="Telefonia / internet" partida="D 4.1.2.09 · C 1.1.1.02" amount={920} />
            <ConfirmRow icon="ti-notebook" color={ACC.outros} title="Material de escritório" partida="D 4.1.2.11 · C 1.1.1.02" amount={610} />
          </UploadFlow>
        )}
      </Card>
      <Card>
        <SecTitle>Lançamentos avulsos — Julho / 2026</SecTitle>
        <Tabela head={['Data', 'Débito', 'Crédito', 'Histórico', { t: 'Valor', r: 1 }, 'Origem']}>
          {[['05/07', '4.1.2.05', '1.1.1.02', 'Energia elétrica — rateio', 3480, 'sugestão'], ['05/07', '4.1.2.09', '1.1.1.02', 'Telefonia / internet', 920, 'sugestão'], ['12/07', '1.1.1.02', '1.1.1.05', 'Transferência entre contas', 15000, 'manual'], ['18/07', '4.1.2.22', '2.1.1.01', 'Provisão de férias', 6240, 'manual'], ['31/07', '4.1.2.40', '1.1.1.02', 'Taxa de manutenção de conta', 1250, 'manual']].map((r, i) => (
            <tr key={i}><td style={{ ...td, fontFamily: 'monospace' }}>{r[0]}</td><td style={{ ...td, fontFamily: 'monospace' }}>{r[1]}</td><td style={{ ...td, fontFamily: 'monospace' }}>{r[2]}</td><td style={td}>{r[3]}</td><td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{money(r[4])}</td><td style={td}><Chip tone={r[5] === 'sugestão' ? 'info' : 'mut'}>{r[5]}</Chip></td></tr>
          ))}
        </Tabela>
      </Card>
    </div>
  )
}

const PANES = { seguro: PaneSeguro, importacao: PaneImportacao, emprestimo: PaneEmprestimo, parcelamento: PaneParcelamento, equivalencia: PaneEquivalencia, outros: PaneOutros }

// ---------------------------------------------------------------- PÁGINA
export default function OutrasContabilizacoes() {
  const { empresaNome, competencia } = useAppData()
  const [tab, setTab] = useState('seguro')
  const [modal, setModal] = useState(null)
  const Pane = PANES[tab]

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4 }}>Outras Contabilizações</h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 18, maxWidth: 820 }}>
        Cada contabilização é confirmada dentro do seu card. Tudo que você <b style={{ color: theme.text }}>confirma ou corrige atualiza a Conciliação</b>. O que ficar sem confirmar vira pendência no Status, de onde sai o arquivo do Domínio.
        {empresaNome && <> · <b style={{ color: theme.text }}>{empresaNome}</b> · {competencia}</>}
      </p>

      <Observacoes irPara={setTab} abrirModal={setModal} />

      {/* Blocos */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(168px,1fr))', gap: 12, marginBottom: 18 }}>
        {BLOCOS.map(b => {
          const on = tab === b.key
          return (
            <div key={b.key} onClick={() => setTab(b.key)} style={{ background: theme.card, border: `1px solid ${on ? ACC[b.key] : theme.border}`, borderRadius: 12, padding: 16, cursor: 'pointer', position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: ACC[b.key] }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 38, height: 38, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19, background: hexA(ACC[b.key], 0.16), color: ACC[b.key] }}><i className={`ti ${b.icon}`} /></div>
                <div><div style={{ fontSize: 14, fontWeight: 700 }}>{b.label}</div><div style={{ fontSize: 11.5, color: theme.sub }}>{b.sub}</div></div>
              </div>
              <div style={{ fontSize: 26, fontWeight: 750, letterSpacing: -.5 }}>{b.num}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: theme.sub, borderTop: `1px solid ${theme.border}`, paddingTop: 10 }}><span>no mês</span><b style={{ color: theme.green }}>{b.foot}</b></div>
            </div>
          )
        })}
      </div>

      {/* Abas */}
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${theme.border}`, marginBottom: 20, flexWrap: 'wrap' }}>
        {BLOCOS.map(b => (
          <button key={b.key} onClick={() => setTab(b.key)} style={{ background: 'none', border: 'none', padding: '10px 14px', fontSize: 13.5, fontWeight: 600, color: tab === b.key ? theme.text : theme.sub, borderBottom: `2px solid ${tab === b.key ? theme.accent : 'transparent'}`, marginBottom: -1 }}>
            <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', marginRight: 7, background: ACC[b.key] }} />{b.label}
          </button>
        ))}
      </div>

      <Pane />
      <Modal cfg={modal} onClose={() => setModal(null)} />
    </div>
  )
}
