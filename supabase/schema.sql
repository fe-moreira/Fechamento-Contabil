-- ============================================================
-- Contabilidade by Attentive — Schema do núcleo (Supabase / Postgres)
-- Rodar no SQL Editor do Supabase (projeto dwuxrlxuusjcggvkfjza).
-- Idempotente: pode rodar de novo sem quebrar.
-- ============================================================

-- ---------- CLIENTES ----------
create table if not exists public.clientes (
  id                uuid primary key default gen_random_uuid(),
  codigo_dominio    text not null,
  tipo              text not null default 'Matriz' check (tipo in ('Matriz','Filial')),
  codigo_matriz     text,                       -- preenchido só para filiais
  razao_social      text not null,
  nome_fantasia     text,
  cnpj              text,
  regime_tributario text,                        -- Simples / Presumido / Real Anual / Real Trimestral
  regime_calculo_imposto text not null default 'COMPETENCIA'  -- 'CAIXA' | 'COMPETENCIA' (base do PIS/COFINS/Simples)
    check (regime_calculo_imposto in ('CAIXA','COMPETENCIA')),
  tipo_fechamento   text,
  prazo_entrega     int,                           -- dia do mês p/ entrega do balancete (5,10,15,20,25,30)
  competencia_inicio text,                        -- 'MM/AAAA'
  carga_saldos      boolean default false,
  coleta_razao      boolean default false,
  sistema_financeiro text,
  integracao_financeira text default 'Não usa',  -- 'Sistema' | 'Excel' | 'Não usa'
  usa_centro_custo  boolean not null default false, -- financeiro com centro de custo
  analista          text,
  observacoes       text,
  ativo             boolean default true,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);
create unique index if not exists clientes_codigo_dominio_uidx on public.clientes(codigo_dominio);
-- Duplicidade amarrada pelo CNPJ normalizado (só dígitos), ignorando quem não tem CNPJ.
create unique index if not exists clientes_cnpj_norm_uidx
  on public.clientes ((regexp_replace(coalesce(cnpj,''), '\D', '', 'g')))
  where nullif(regexp_replace(coalesce(cnpj,''), '\D', '', 'g'), '') is not null;

-- ---------- COMPETÊNCIAS (cliente x mês/ano) ----------
create table if not exists public.competencias (
  id          uuid primary key default gen_random_uuid(),
  cliente_id  uuid not null references public.clientes(id) on delete cascade,
  ano         int  not null,
  mes         int  not null check (mes between 1 and 12),
  status      text not null default 'andamento' check (status in ('andamento','fechado','pendente')),
  pct         int  default 0,
  integracoes jsonb not null default '{}'::jsonb,  -- estado por integração (fiscal/folha/patrimonio/financeira)
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  unique (cliente_id, ano, mes)
);

-- ---------- CADASTROS COM VIGÊNCIA (plano, de/para, apelidos, banco x resultado) ----------
-- Histórico preservado: cada carga é uma linha nova com sua vigência; nunca sobrescreve.
create table if not exists public.cargas_cadastro (
  id          uuid primary key default gen_random_uuid(),
  cliente_id  uuid not null references public.clientes(id) on delete cascade,
  tipo        text not null check (tipo in ('plano','depara','apelidos','bancoresult','financeiro','contas_bancarias','memoria_financeira','centro_custo','lalur','conciliacao_nomes')),
  vigencia    text not null,            -- 'MM/AAAA'
  dados       jsonb not null default '[]'::jsonb,  -- conteúdo da carga
  usuario     text,
  obs         text,
  created_at  timestamptz default now()
);
create index if not exists cargas_cadastro_idx on public.cargas_cadastro(cliente_id, tipo);

-- ---------- RAZÃO (linhas importadas do Domínio) ----------
create table if not exists public.razao (
  id            uuid primary key default gen_random_uuid(),
  competencia_id uuid not null references public.competencias(id) on delete cascade,
  data          date,
  conta         text,
  contrapartida text,
  historico     text,
  debito        numeric(16,2) default 0,
  credito       numeric(16,2) default 0,
  created_at    timestamptz default now()
);
create index if not exists razao_comp_idx on public.razao(competencia_id);
create index if not exists razao_conta_idx on public.razao(competencia_id, conta);
-- Centro de custo do lançamento (opcional; vem do razão do Domínio) — base do Relatório Gerencial por CC.
alter table public.razao add column if not exists centro_custo text;
create index if not exists razao_ccu_idx on public.razao(competencia_id, centro_custo);

-- ---------- BALANCETE ----------
create table if not exists public.balancete (
  id            uuid primary key default gen_random_uuid(),
  competencia_id uuid not null references public.competencias(id) on delete cascade,
  conta         text,
  nome          text,
  saldo_inicial numeric(16,2) default 0,
  debito        numeric(16,2) default 0,
  credito       numeric(16,2) default 0,
  saldo_final   numeric(16,2) default 0
);
create index if not exists balancete_comp_idx on public.balancete(competencia_id);

-- ---------- LANÇAMENTOS (fila do Contabilizar) ----------
create table if not exists public.lancamentos (
  id            uuid primary key default gen_random_uuid(),
  competencia_id uuid not null references public.competencias(id) on delete cascade,
  data          date,
  conta_debito  text,
  conta_credito text,
  valor         numeric(16,2) default 0,
  historico     text,
  origem        text default 'manual',   -- manual | correcao | sugestao
  documento     text,
  usuario       text,
  created_at    timestamptz default now()
);
create index if not exists lancamentos_comp_idx on public.lancamentos(competencia_id);

-- ---------- AUDITORIA: justificativas e correções ----------
create table if not exists public.auditoria (
  id            uuid primary key default gen_random_uuid(),
  competencia_id uuid not null references public.competencias(id) on delete cascade,
  modulo        text,     -- 'Comparativo' | 'Banco x Resultado' | 'Impostos' | 'Correção'
  item          text,
  tipo          text check (tipo in ('Justificativa','Correção')),
  detalhe       text,
  dedutibilidade text,    -- 'dedutivel' | 'indedutivel' | null (p/ LALUR)
  usuario       text,
  created_at    timestamptz default now()
);
create index if not exists auditoria_comp_idx on public.auditoria(competencia_id);

-- ---------- CONCILIAÇÃO: tipo da conta, documento suporte e status por conta ----------
create table if not exists public.conciliacao_conta (
  id                uuid primary key default gen_random_uuid(),
  competencia_id    uuid not null references public.competencias(id) on delete cascade,
  conta             text not null,                 -- código reduzido da conta
  tipo              text,                          -- 'saldo' | 'composicao' (override manual; null = automático)
  documento         text,                          -- nome do extrato/documento suporte importado
  saldo_documento   numeric(16,2),                 -- saldo lido do documento (p/ conta de saldo)
  conciliada        boolean not null default false, -- confirmada manualmente ("está certo")
  justificativa     text,
  pendencia_cliente boolean not null default false, -- vai para o Relatório de Pendências
  usuario           text,
  updated_at        timestamptz default now(),
  unique (competencia_id, conta)
);
create index if not exists conciliacao_conta_comp_idx on public.conciliacao_conta(competencia_id);

-- ---------- AJUSTE DE LEITURA: correção de nome/NF/histórico de um lançamento ----------
create table if not exists public.ajuste_leitura (
  id             uuid primary key default gen_random_uuid(),
  competencia_id uuid references public.competencias(id) on delete cascade,
  razao_id       uuid not null,            -- lançamento do razão ajustado
  nf             text,                     -- número da nota corrigido
  entidade       text,                     -- nome do cliente/fornecedor corrigido
  historico      text,                     -- histórico corrigido (opcional)
  usuario        text,
  updated_at     timestamptz default now(),
  unique (razao_id)
);
create index if not exists ajuste_leitura_comp_idx on public.ajuste_leitura(competencia_id);

-- ---------- COMENTÁRIOS POR CONTA (histórico que acompanha a conta em todos os meses) ----------
-- Independe da competência: por cliente + conta, vai acumulando a cada fechamento. Escrito na
-- Conciliação e exibido no Book de Composições (tela e Excel).
create table if not exists public.conta_comentario (
  id          uuid primary key default gen_random_uuid(),
  cliente_id  uuid not null references public.clientes(id) on delete cascade,
  conta       text not null,                 -- código reduzido da conta
  texto       text not null,                 -- o comentário / observação
  usuario     text,
  created_at  timestamptz not null default now()
);
create index if not exists conta_comentario_cliente_conta_idx on public.conta_comentario(cliente_id, conta, created_at desc);

-- ============================================================
-- OUTRAS CONTABILIZAÇÕES (contratos/processos por cliente)
-- Os lançamentos gerados usam a tabela public.lancamentos.
-- ============================================================
create table if not exists public.seguros (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  seguradora text, apolice text, ramo text,
  vigencia_inicio date, vigencia_fim date,
  premio_total numeric(16,2) default 0, num_parcelas int default 1,
  valor_parcela numeric(16,2) default 0, dia_pagto int,
  conta_apropriar text, conta_despesa text, conta_pagar text,
  saldo_inicial boolean default false, por_dia boolean default false,
  arquivo text, status text default 'ativo', usuario text,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create index if not exists seguros_cliente_idx on public.seguros(cliente_id);

-- Despesas a apropriar (IPVA, IPTU, aluguel antecipado…): funciona como o seguro,
-- mas genérico. Cadastra e gera a apropriação do mês; o saldo a apropriar na
-- abertura pode alimentar a carga inicial.
create table if not exists public.despesas_apropriar (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  tipo text, descricao text, documento text,
  valor_total numeric(16,2) default 0,
  vigencia_inicio date, vigencia_fim date,
  num_parcelas int default 1, valor_parcela numeric(16,2) default 0,
  conta_despesa text, conta_apropriar text, conta_pagar text,
  saldo_inicial boolean default false, por_dia boolean default false, arquivo text, usuario text,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create index if not exists despesas_apropriar_cliente_idx on public.despesas_apropriar(cliente_id);

create table if not exists public.emprestimos (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  banco text, contrato text, modalidade text,
  valor numeric(16,2) default 0, prazo int, taxa_mensal numeric(9,4),
  valor_parcela numeric(16,2) default 0, saldo_devedor numeric(16,2) default 0,
  arquivo text, status text default 'ativo', usuario text,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create index if not exists emprestimos_cliente_idx on public.emprestimos(cliente_id);

create table if not exists public.parcelamentos (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  orgao text, numero text, tributo text,
  consolidado numeric(16,2) default 0, num_parcelas int,
  valor_parcela numeric(16,2) default 0, saldo_devedor numeric(16,2) default 0,
  indice text, juros_multa_mes numeric(16,2) default 0,
  conta_despesa text, conta_passivo text,
  arquivo text, status text default 'ativo', usuario text,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create index if not exists parcelamentos_cliente_idx on public.parcelamentos(cliente_id);

create table if not exists public.participacoes (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  investida text, vinculo text,
  participacao_pct numeric(7,4) default 0, valor_investimento numeric(16,2) default 0,
  conta_investimento text, conta_resultado text,
  status text default 'ativo', usuario text,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create index if not exists participacoes_cliente_idx on public.participacoes(cliente_id);

create table if not exists public.importacoes (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  numero text, di text, fornecedor text, mercadoria text,
  invoice_moeda text, invoice_valor numeric(16,2), cambio numeric(12,4),
  custo_total numeric(16,2) default 0,
  etapa text default 'em curso', status text default 'a_nacionalizar',
  composicao jsonb default '[]'::jsonb, adiantamento_id uuid,
  arquivo text, usuario text,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create index if not exists importacoes_cliente_idx on public.importacoes(cliente_id);

create table if not exists public.adiantamentos_importacao (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  fornecedor text, data date, valor numeric(16,2) default 0,
  processo_id uuid references public.importacoes(id) on delete set null,
  status text default 'aguardando', usuario text,
  created_at timestamptz default now()
);
create index if not exists adiant_imp_cliente_idx on public.adiantamentos_importacao(cliente_id);

-- PER/DCOMP: crédito federal com saldo, baixado conforme compensa débitos de tributo.
create table if not exists public.perdcomp (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  numero_declaracao text, data date,
  credito_atualizado numeric(16,2) default 0,
  valor_utilizado numeric(16,2) default 0,
  tributo_compensado text,
  conta_credito text, conta_compensada text,
  observacao text,
  status text default 'ativo', usuario text,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create index if not exists perdcomp_cliente_idx on public.perdcomp(cliente_id);

-- Juros sobre Capital Próprio (JSCP): memória de cálculo e contabilização.
create table if not exists public.jcp (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  descricao text, data_base date,
  pl_ajustado numeric(16,2) default 0,
  taxa_tjlp numeric(9,4) default 0,
  valor_juros numeric(16,2) default 0,
  limite_dedutibilidade numeric(16,2) default 0,
  juros_provisionados numeric(16,2) default 0,
  juros_a_pagar numeric(16,2) default 0,
  irrf_pct numeric(7,4) default 0,
  irrf_valor numeric(16,2) default 0,
  liquido numeric(16,2) default 0,
  conta_despesa text, conta_irrf text, conta_pagar text,
  status text default 'ativo', usuario text,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create index if not exists jcp_cliente_idx on public.jcp(cliente_id);

alter table public.seguros                 enable row level security;
alter table public.despesas_apropriar      enable row level security;
alter table public.emprestimos             enable row level security;
alter table public.parcelamentos           enable row level security;
alter table public.participacoes           enable row level security;
alter table public.importacoes             enable row level security;
alter table public.adiantamentos_importacao enable row level security;
alter table public.perdcomp                 enable row level security;
alter table public.jcp                      enable row level security;

-- Receitas diferidas: faturamento reconhecido aos poucos (baixa manual), com PIS/COFINS/ISS.
create table if not exists public.receitas_diferidas (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  descricao text, data date,
  faturamento_total numeric(16,2) default 0,
  reconhecido numeric(16,2) default 0,
  conta_receita_diferida text, conta_receita text,
  pis_valor numeric(16,2) default 0, pis_despesa text, pis_diferido text,
  cofins_valor numeric(16,2) default 0, cofins_despesa text, cofins_diferido text,
  iss_valor numeric(16,2) default 0, iss_despesa text, iss_diferido text,
  usuario text, created_at timestamptz default now()
);
create index if not exists receitas_diferidas_cliente_idx on public.receitas_diferidas(cliente_id);
alter table public.receitas_diferidas       enable row level security;
do $$
declare t text;
begin
  foreach t in array array['seguros','despesas_apropriar','emprestimos','parcelamentos','participacoes','importacoes','adiantamentos_importacao','perdcomp','jcp','receitas_diferidas']
  loop
    execute format('drop policy if exists "auth_all_%1$s" on public.%1$s;', t);
    execute format('create policy "auth_all_%1$s" on public.%1$s for all to authenticated using (true) with check (true);', t);
  end loop;
end $$;

-- ============================================================
-- updated_at automático
-- ============================================================
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists trg_clientes_touch on public.clientes;
create trigger trg_clientes_touch before update on public.clientes
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_competencias_touch on public.competencias;
create trigger trg_competencias_touch before update on public.competencias
  for each row execute function public.touch_updated_at();

-- ============================================================
-- RLS — Row Level Security
-- Política inicial: qualquer usuário AUTENTICADO acessa (escritório interno).
-- Refinar depois por papel (coordenador/analista) e por cliente.
-- ============================================================
alter table public.clientes        enable row level security;
alter table public.competencias    enable row level security;
alter table public.cargas_cadastro enable row level security;
alter table public.razao           enable row level security;
alter table public.balancete       enable row level security;
alter table public.lancamentos     enable row level security;
alter table public.auditoria       enable row level security;
alter table public.conciliacao_conta enable row level security;
alter table public.ajuste_leitura   enable row level security;
alter table public.conta_comentario  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['clientes','competencias','cargas_cadastro','razao','balancete','lancamentos','auditoria','conciliacao_conta','ajuste_leitura','conta_comentario']
  loop
    execute format('drop policy if exists "auth_all_%1$s" on public.%1$s;', t);
    execute format(
      'create policy "auth_all_%1$s" on public.%1$s for all to authenticated using (true) with check (true);', t);
  end loop;
end $$;

-- ============================================================
-- Distribuição de lucros: cadastro dos lucros a distribuir em ATA
-- (passivo "a distribuir") — { houve, arquivo, documento, socios:[{nome,valor}] }.
-- ============================================================
alter table if exists public.dist_lucros_config add column if not exists ata jsonb;

-- ============================================================
-- Modelos de RELATÓRIO GERENCIAL (biblioteca) + vínculo no cliente.
-- Por enquanto o modelo é só um nome/rótulo; o cliente vinculado libera o
-- card "Relatório Gerencial" em Relatórios.
-- ============================================================
create table if not exists public.modelos_relatorio_gerencial (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  usuario text,
  created_at timestamptz default now()
);
alter table public.modelos_relatorio_gerencial enable row level security;
drop policy if exists "auth_all_modelos_relatorio_gerencial" on public.modelos_relatorio_gerencial;
create policy "auth_all_modelos_relatorio_gerencial" on public.modelos_relatorio_gerencial for all to authenticated using (true) with check (true);
alter table public.clientes add column if not exists modelo_rel_gerencial_id uuid references public.modelos_relatorio_gerencial(id) on delete set null;

-- ============================================================
-- (Opcional) Seed mínimo para testar o cadastro de clientes.
-- Descomente se quiser dados de exemplo.
-- ============================================================
-- insert into public.clientes (codigo_dominio, razao_social, regime_tributario, analista)
-- values ('0370','Euro Brake Com. Imp. e Exp. LTDA','Real','João')
-- on conflict (codigo_dominio) do nothing;
