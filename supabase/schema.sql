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
  regime_tributario text,                        -- Simples / Presumido / Real
  tipo_fechamento   text,
  competencia_inicio text,                        -- 'MM/AAAA'
  carga_saldos      boolean default false,
  coleta_razao      boolean default false,
  sistema_financeiro text,
  integracao_financeira text default 'Não usa',  -- 'Sistema' | 'Excel' | 'Não usa'
  analista          text,
  observacoes       text,
  ativo             boolean default true,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);
create unique index if not exists clientes_codigo_dominio_uidx on public.clientes(codigo_dominio);

-- ---------- COMPETÊNCIAS (cliente x mês/ano) ----------
create table if not exists public.competencias (
  id          uuid primary key default gen_random_uuid(),
  cliente_id  uuid not null references public.clientes(id) on delete cascade,
  ano         int  not null,
  mes         int  not null check (mes between 1 and 12),
  status      text not null default 'andamento' check (status in ('andamento','fechado','pendente')),
  pct         int  default 0,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  unique (cliente_id, ano, mes)
);

-- ---------- CADASTROS COM VIGÊNCIA (plano, de/para, apelidos, banco x resultado) ----------
-- Histórico preservado: cada carga é uma linha nova com sua vigência; nunca sobrescreve.
create table if not exists public.cargas_cadastro (
  id          uuid primary key default gen_random_uuid(),
  cliente_id  uuid not null references public.clientes(id) on delete cascade,
  tipo        text not null check (tipo in ('plano','depara','apelidos','bancoresult','financeiro')),
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

do $$
declare t text;
begin
  foreach t in array array['clientes','competencias','cargas_cadastro','razao','balancete','lancamentos','auditoria','conciliacao_conta','ajuste_leitura']
  loop
    execute format('drop policy if exists "auth_all_%1$s" on public.%1$s;', t);
    execute format(
      'create policy "auth_all_%1$s" on public.%1$s for all to authenticated using (true) with check (true);', t);
  end loop;
end $$;

-- ============================================================
-- (Opcional) Seed mínimo para testar o cadastro de clientes.
-- Descomente se quiser dados de exemplo.
-- ============================================================
-- insert into public.clientes (codigo_dominio, razao_social, regime_tributario, analista)
-- values ('0370','Euro Brake Com. Imp. e Exp. LTDA','Real','João')
-- on conflict (codigo_dominio) do nothing;
