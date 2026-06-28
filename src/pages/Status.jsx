import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAppData } from '../lib/appData'
import { theme } from '../lib/theme'

export default function Status() {
  const { empresaId, empresaNome, competencia } = useAppData()
  const [dados, setDados] = useState(null)   // { razao, naoConciliadas, lancamentos, temCompetencia }
  const [carregando, setCarregando] = useState(false)

  useEffect(() => {
    setDados(null)
    if (!empresaId) return
    let vivo = true
    setCarregando(true)
    ;(async () => {
      try {
        const [mes, ano] = competencia.split('/').map(Number)
        const { data: comp } = await supabase.from('competencias').select('id')
          .eq('cliente_id', empresaId).eq('ano', ano).eq('mes', mes).maybeSingle()

        if (!comp) {
          if (vivo) setDados({ razao: 0, naoConciliadas: 0, lancamentos: 0, temCompetencia: false })
          return
        }

        const { count: razao } = await supabase.from('razao')
          .select('id', { count: 'exact', head: true }).eq('competencia_id', comp.id)

        const { data: balancete } = await supabase.from('balancete')
          .select('conta, saldo_final').eq('competencia_id', comp.id)
        const naoConciliadas = (balancete || []).filter(b => Number(b.saldo_final) !== 0).length

        const { count: lancamentos } = await supabase.from('lancamentos')
          .select('id', { count: 'exact', head: true }).eq('competencia_id', comp.id)

        if (vivo) setDados({
          razao: razao || 0,
          naoConciliadas,
          lancamentos: lancamentos || 0,
          temCompetencia: true,
        })
      } finally {
        if (vivo) setCarregando(false)
      }
    })()
    return () => { vivo = false }
  }, [empresaId, competencia])

  if (!empresaId) {
    return (
      <Wrapper>
        <Aviso icon="ti-building" texto="Selecione uma empresa no menu lateral." />
      </Wrapper>
    )
  }

  const d = dados || { razao: 0, naoConciliadas: 0, lancamentos: 0, temCompetencia: false }

  const gates = [
    {
      key: 'razao',
      nome: 'Carga inicial / Razão',
      icon: 'ti-file-import',
      descricao: 'Razão do Domínio importado para a competência.',
      pendencias: d.razao === 0 ? 1 : 0,
    },
    {
      key: 'conciliacao',
      nome: 'Conciliação',
      icon: 'ti-arrows-left-right',
      descricao: 'Contas do balancete com saldo final em aberto (≠ 0).',
      pendencias: d.naoConciliadas,
    },
    {
      key: 'lancamentos',
      nome: 'Lançamentos manuais',
      icon: 'ti-pencil',
      descricao: 'Ajustes manuais registrados na competência.',
      pendencias: 0,
      informativo: true,
      valor: d.lancamentos,
    },
    {
      key: 'variacoes',
      nome: 'Variações',
      icon: 'ti-chart-line',
      descricao: 'Análise de variações entre competências.',
      pendencias: 0,
      emBreve: true,
    },
    {
      key: 'banco',
      nome: 'Banco × resultado',
      icon: 'ti-building-bank',
      descricao: 'Conferência do banco contra o resultado apurado.',
      pendencias: 0,
      emBreve: true,
    },
    {
      key: 'distribuicao',
      nome: 'Distribuição de lucros · IRRF 2026',
      icon: 'ti-cash-banknote',
      descricao: 'Distribuição de lucros e retenção de IRRF.',
      pendencias: 0,
      emBreve: true,
    },
  ]

  const totalPendencias = gates.reduce((s, g) => s + g.pendencias, 0)
  const pronto = totalPendencias === 0

  return (
    <Wrapper>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 18 }}>
        <b style={{ color: theme.text }}>{empresaNome}</b> · competência <b style={{ color: theme.text }}>{competencia}</b>
      </p>

      {/* Cabeçalho geral */}
      <div style={{
        background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12,
        padding: 22, marginBottom: 18, display: 'flex', alignItems: 'center', gap: 18,
      }}>
        <div style={{
          width: 64, height: 64, borderRadius: 14, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: pronto ? 'rgba(48,164,108,0.14)' : 'rgba(229,72,77,0.14)',
          border: `0.5px solid ${pronto ? 'rgba(48,164,108,0.4)' : 'rgba(229,72,77,0.4)'}`,
        }}>
          <i className="ti ti-traffic-lights" style={{ fontSize: 30, color: pronto ? theme.green : theme.red }} />
        </div>
        <div style={{ flex: 1 }}>
          <p style={{ fontSize: 12.5, color: theme.sub, marginBottom: 4 }}>Total de pendências</p>
          {pronto ? (
            <p style={{ fontSize: 22, fontWeight: 700, color: theme.green }}>
              <i className="ti ti-circle-check" /> Fechamento pronto
            </p>
          ) : (
            <p style={{ fontSize: 22, fontWeight: 700, color: theme.red }}>
              {totalPendencias} pendência{totalPendencias > 1 ? 's' : ''}
            </p>
          )}
        </div>
        <span style={{
          fontSize: 20, fontWeight: 700, minWidth: 52, textAlign: 'center',
          padding: '8px 14px', borderRadius: 999,
          color: '#fff', background: pronto ? theme.green : theme.red,
        }}>
          {totalPendencias}
        </span>
      </div>

      {!d.temCompetencia && (
        <div style={{ background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 10, padding: '12px 14px', fontSize: 13, color: theme.sub, marginBottom: 18 }}>
          <i className="ti ti-info-circle" style={{ color: theme.accent }} /> Importe o razão para começar o fechamento.
        </div>
      )}

      {carregando && (
        <p style={{ color: theme.sub, fontSize: 12.5, marginBottom: 18 }}>Carregando gates…</p>
      )}

      {/* Gates */}
      <div style={{ display: 'grid', gap: 12 }}>
        {gates.map(g => {
          const pend = g.pendencias > 0
          const cor = pend ? theme.red : theme.green
          const badgeTexto = g.informativo ? g.valor : g.pendencias
          return (
            <div key={g.key} style={{
              background: theme.card, border: `0.5px solid ${theme.cb}`, borderRadius: 12,
              padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 16,
            }}>
              <div style={{
                width: 42, height: 42, borderRadius: 10, flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: g.emBreve ? 'rgba(255,255,255,0.04)' : (pend ? 'rgba(229,72,77,0.12)' : 'rgba(48,164,108,0.12)'),
                border: `0.5px solid ${theme.cb}`,
              }}>
                <i className={`ti ${g.icon}`} style={{ fontSize: 20, color: g.emBreve ? theme.sub : cor }} />
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 3, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {g.nome}
                  {g.emBreve && (
                    <span style={{
                      fontSize: 10.5, fontWeight: 600, color: theme.sub, textTransform: 'uppercase',
                      letterSpacing: .4, padding: '2px 7px', borderRadius: 6,
                      background: 'rgba(255,255,255,0.05)', border: `0.5px solid ${theme.cb}`,
                    }}>
                      em breve
                    </span>
                  )}
                </p>
                <p style={{ fontSize: 12.5, color: theme.sub }}>{g.descricao}</p>
              </div>

              <span style={{
                fontSize: 13, fontWeight: 700, minWidth: 30, textAlign: 'center',
                padding: '5px 12px', borderRadius: 999,
                color: g.emBreve ? theme.sub : '#fff',
                background: g.emBreve
                  ? 'rgba(255,255,255,0.05)'
                  : g.informativo
                    ? theme.green
                    : (pend ? theme.red : theme.green),
              }}>
                {badgeTexto}
              </span>
            </div>
          )
        })}
      </div>
    </Wrapper>
  )
}

function Wrapper({ children }) {
  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 9 }}>
        <i className="ti ti-traffic-lights" style={{ color: theme.accent }} /> Status
      </h1>
      <p style={{ color: theme.sub, fontSize: 13, marginBottom: 22 }}>
        Gates de pendência da competência. Vermelho com pendências, verde ao zerar.
      </p>
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
