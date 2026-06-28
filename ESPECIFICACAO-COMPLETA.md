# ESPECIFICAÇÃO FUNCIONAL — Contabilidade by Attentive

> **Para o Claude Code.** Este documento é a fonte de verdade do produto. Use-o para
> **auditar o app que já está no repositório** e **corrigir/completar** o que estiver
> faltando ou divergente. O protótipo navegável (`prototipo/prototipo-plataforma-contabil.html`,
> servido em `/prototipo.html`) é a **referência visual e de comportamento** de cada tela.
>
> **Como trabalhar com este documento:**
> 1. Primeiro, rode o **Gap Check** (seção 2): compare cada módulo abaixo com o que existe
>    no `src/` e me devolva um relatório do que está OK, parcial ou ausente. **Pare e me mostre
>    antes de corrigir.**
> 2. Depois, corrija/complete **uma onda por vez** (seção 11), testando cada uma.
> 3. **Não** reescreva do zero o que já funciona — só ajuste o que diverge desta spec.

---

## 1. Visão e princípios

Plataforma web para padronizar o **fechamento contábil mensal** dos ~150 clientes do
escritório. Origem dos dados: **Domínio (Thomson Reuters)**, exportado em Excel.
Unidade de trabalho = **cliente × competência (mês/ano)**.

Princípios inegociáveis:
- **Português do Brasil** em toda a interface.
- **Histórico por vigência** nas tabelas de cadastro — nunca sobrescrever.
- Toda **justificativa/correção** registra **usuário e data** (trilha de auditoria).
- **Segurança:** a chave `service_role` do Supabase nunca vai ao front nem ao Git. Só a
  `anon`/publishable, via `VITE_SUPABASE_ANON_KEY` em `.env.local` (no `.gitignore`).
- **Sem dados fake em produção:** as telas devem ler/gravar no Supabase de verdade. O que
  ainda não estiver implementado deve aparecer como "em breve", não como dado fictício.

Stack: **React + Vite + Supabase (Auth + Postgres com RLS)**. Deploy **Vercel**.
Infra: GitHub `fe-moreira`; Supabase ref `dwuxrlxuusjcggvkfjza` (us-west-2).

---

## 2. Gap Check (rode primeiro, antes de corrigir)

Para cada módulo das seções 4–9, responda:
- **Existe** no `src/`? (arquivo/rota)
- Está **só visual (placeholder)** ou **lê/grava no Supabase**?
- O que **diverge** desta especificação?

Liste também: tabelas existentes no Supabase vs seção 10; e se o cadastro de clientes
grava de verdade. Entregue como tabela "Módulo | Estado | O que falta" e **aguarde meu OK**.

---

## 3. Navegação (estrutura de menu)

**PRINCIPAL**
- Dashboard
- Cadastro de Clientes

**FECHAMENTO CONTÁBIL** (operam sobre a competência selecionada)
- Fechamentos
- Documentos Recebidos
- Importar Razão
- Integração (financeira/fiscal/folha/patrimônio)
- Conciliação
- Comp. Movimento
- Contabilizar
- Relatórios
- Status (com badge de pendências; vermelho > 0, verde quando zera)

**Nível cliente** (não por competência)
- Base de Informações

**SISTEMA**
- Configurações
- Ajuda

Seletor de **empresa** (cliente) e seletor de **competência** no topo. Tema escuro padrão
(sidebar `#1A2236`, acento `#4A7CFF`, fonte DM Sans). Paleta completa no protótipo.

---

## 4. Cadastro de Clientes

Lista + formulário (criar/editar/excluir), gravando na tabela `clientes`.
Campos: código no Domínio (chave), tipo (Matriz/Filial), código da matriz (para filiais),
razão social, nome fantasia, CNPJ, regime tributário (Simples/Presumido/Real),
tipo de fechamento, competência de início, carga inicial de saldos (sim/não),
coleta automática do razão (sim/não), sistema financeiro, **integração financeira**
(Sistema/Excel/Não usa — "Excel" liga o pipeline financeiro), analista, observações.

Importação em lote via planilha (`prototipo/layout-importacao-clientes.xlsx`):
abas **Instruções + Clientes**; matriz e filiais como linhas na mesma aba.

---

## 5. Base de Informações (nível cliente)

### 5.1 Particularidades e Contatos
Listas com incluir/editar/excluir e carimbo "atualizado por <usuário> · <data>".

### 5.2 Parâmetros do fechamento (cards de carga com **vigência** versionada)
Cada carga é importada por Excel, cria uma vigência e **preserva o histórico**:
- **Plano de contas** (com tipo de conciliação por conta)
- **De/Para integrações** (acumulador → conta)
- **Apelidos** (leitura de histórico)
- **Modelos de relatório**
- **Período de início**
- **Histórico de lançamentos financeiros** (carga inicial; depois atualiza a cada mês)
- **Amarração banco × resultado** — carga por Excel (planilha única: colunas **Tipo**
  [Banco / Resultado liberado], **Código**, **Nome**). Ao abrir, mostra "Contas já cadastradas".
  Alimenta o gate de Status (§9).
- **Distribuição de lucros** (config, ver §8) — limite, alíquota, contas observadas, sócios.

---

## 6. Fechamento — núcleo

### 6.1 Importar Razão
Upload do Excel do Domínio (layout de referência: `razao_-_approvata.xls`, ~30 colunas).
Parsear e gravar em `razao` (data, conta, contrapartida, histórico, débito, crédito) por
competência. Validações: conferir contas contra o plano; sinalizar contas sem cadastro.

### 6.2 Balancete
Montar/importar o balancete por competência (`balancete`): conta, nome, saldo inicial,
débito, crédito, saldo final. Base para a conciliação.

### 6.3 Conciliação (com farol verde/amarelo/vermelho)
Tipos de conciliação por conta:
- **Saldo simples** (ex.: banco).
- **Composição** (clientes, estoques, fornecedores): lançamentos agrupados por
  cliente/fornecedor, em formato de **razão** (Data · NF · Histórico · Débito · Crédito ·
  Confiança). Itens quitados no mês somem. Baixa confiança → laranja + "corrigir" (corrige
  a leitura de cliente/NF). Card de amarração: Saldo atual × Composição × Diferença.
- **Imposto** (ICMS, PIS, COFINS): dois checks —
  (a) **Baixa do mês anterior**: o imposto do mês anterior deve ter sido recolhido e zerado;
      se divergir, justificar ou corrigir (gera D imposto / C banco).
  (b) **Memória de cálculo**: importa memória e compara com o balancete; se divergir,
      pergunta "houve recolhimento no mês?" e "houve PER/DCOMP?".
Export Excel/PDF nas telas de detalhe.

### 6.4 Comp. Movimento (comparativo)
Mostra só o ano do fechamento, colunas Jan → mês atual (acumulando). Sinaliza **vermelho**
desvio > 10% da média dos meses carregados. **Todos os números são clicáveis** (vermelho ou
não) → abre o **razão da conta**: Data · Histórico · Débito · Crédito · **Saldo** (acumulado).
A plataforma **aponta o lançamento provável culpado** com motivo (não recorre nos meses
anteriores, histórico genérico, valor fora do padrão). Por lançamento: **justificar** (tira a
pendência) e **corrigir** (reclassifica → gera lançamento no Contabilizar e marca a célula).

### 6.5 Integração Financeira (pipeline PRÉ-razão)
Só para clientes com integração financeira = "Excel". Importa extrato → dois baldes
("Contabilizado automaticamente" e "Não identificado"). "Gerar arquivo financeiro" baixa CSV
no layout do Domínio. Abas Fiscal/Folha/Patrimônio com importação + conferência.

### 6.6 Contabilizar (fila central de lançamentos)
Fila `{data, conta_débito, conta_crédito, valor, histórico, origem, documento, usuário}`.
Sugestões da plataforma (confirmar/editar/descartar). Novo lançamento: escrever partida
(selects do plano) ou subir documento. **Sem etapa de aprovação** (decisão do produto).
**"Gerar arquivo Domínio"** baixa CSV no layout exato (§10.2).

---

## 7. Status (gates de pendência) e Relatórios

### 7.1 Status
Lista de gates; cada um com contagem. Badge fica vermelho com pendências, verde ao zerar.
Gates: Carga inicial, Documentos, Conciliação, Integração, Variações, Ajustes,
**Lançamentos banco × resultado** e **Distribuição de lucros · IRRF 2026** (§8).
Gates clicáveis abrem o relatório com **justificar** e **corrigir**.

- **Banco × resultado:** aponta lançamentos que jogam um banco direto numa conta de
  resultado (prefixo 3/4/5) **não** liberada. Justificar exige, se for despesa (/^4/),
  classificar **dedutível/indedutível** (LALUR). Corrigir reclassifica → Contabilizar.
  Relatório com Excel/PDF + **Despesas indedutíveis (LALUR)**.

### 7.2 Relatórios
Book de Composições, Pendências, DRE, Comparativo, Balanço, DFC, Balancete, e
**Justificativas e correções do fechamento** — consolida TODAS as justificativas
(Comparativo, Banco × Resultado, Impostos, Distribuição de lucros) e TODAS as correções
lançadas, cada uma com usuário e data. Export Excel (CSV).

---

## 8. Distribuição de lucros (IRRF 2026) — regra detalhada

Base legal: **Lei nº 15.270/2025**, vigente desde jan/2026.

**Configuração (Base de Informações):** contas de distribuição observadas no razão;
**limite** (default R$ 50.000); **alíquota** (default 10%); **sócios** (nome + identificação
no razão por centro de custo/histórico).

**Cálculo no fechamento:** somar, no mês, quanto **cada sócio** recebeu (todos os lançamentos
de distribuição a ele). Se o total do sócio **> limite**:
- A retenção de IRRF incide sobre o **valor total** recebido por ele no mês (NÃO só o
  excedente). IRRF estimado = total × alíquota.
- Se houver **mais de um pagamento** ao mesmo sócio no mês, soma-se tudo antes de comparar
  com o limite (dois pagamentos abaixo do limite podem, somados, ultrapassá-lo).

**No Status:** gate "Distribuição de lucros · IRRF 2026" fica **vermelho** quando algum sócio
ultrapassa. Clicando, relatório por sócio com total recebido, IRRF estimado e total a reter.
- **Corrigir** → gera o lançamento da retenção (D conta de lucros a distribuir / C IRRF a
  recolher) na fila do Contabilizar.
- **Justificar** → o analista descreve **qual ação será tomada** (avisar o cliente, reter,
  segregar lucro de 2025). Inclui a opção **"lucro apurado até 2025 (isento)"** — que, pela
  regra de transição (aprovação em ata no prazo legal), mantém a isenção e tira a pendência.

**Importante (registrar na tela):** o alerta é uma **estimativa para revisão humana** — o
razão não distingue sozinho lucro de 2025 (isento) de lucro novo (tributável); por isso a
decisão de isenção fica com o analista. Não tratar como apuração automática definitiva.

---

## 9. (reservado)

---

## 10. Modelo de dados (Supabase)

### 10.1 Tabelas
Use o schema base já versionado em `supabase/schema.sql` (clientes, competencias,
cargas_cadastro [com vigência], razao, balancete, lancamentos, auditoria) e **acrescente**
a configuração de distribuição de lucros:

```sql
-- Config de distribuição de lucros por cliente (com vigência, como as demais cargas)
create table if not exists public.dist_lucros_config (
  id          uuid primary key default gen_random_uuid(),
  cliente_id  uuid not null references public.clientes(id) on delete cascade,
  limite      numeric(16,2) not null default 50000,
  aliquota    numeric(6,2)  not null default 10,
  contas      jsonb not null default '[]'::jsonb,   -- [{cod,nome}]
  socios      jsonb not null default '[]'::jsonb,   -- [{nome,ident}]
  vigencia    text,                                  -- 'MM/AAAA'
  usuario     text,
  created_at  timestamptz default now()
);
alter table public.dist_lucros_config enable row level security;
drop policy if exists "auth_all_dist_lucros_config" on public.dist_lucros_config;
create policy "auth_all_dist_lucros_config" on public.dist_lucros_config
  for all to authenticated using (true) with check (true);
```

A apuração por sócio (quem excedeu, IRRF) é **calculada** a partir do razão + config; o
resultado/justificativa de cada sócio vai para a tabela `auditoria` (módulo
"Distribuição de lucros", com usuário e data).

Todas as tabelas com **RLS habilitado**. Política inicial: qualquer usuário **autenticado**
acessa (refinar por papel/cliente depois).

### 10.2 Layout do arquivo Domínio (lançamentos)
CSV, separador `;`, BOM UTF-8. Colunas, na ordem:
`Data ; Cód. Conta Débito ; Cód. Conta Crédito ; Valor ; Cód. Histórico ;
Complemento Histórico ; Inicia Lote ; Código Matriz/Filial ; CC Débito ; CC Crédito`.
Valor em pt-BR (vírgula decimal). "Inicia Lote" = 1 só na primeira linha.
Referência real: `POP1004 - Lançamentos Contábeis`.

---

## 11. Ondas de execução (corrigir/completar nesta ordem)

1. **Fundação de dados** — aplicar todo o schema no Supabase (incluindo
   `dist_lucros_config`); confirmar que Cadastro de Clientes grava/lê de verdade.
2. **Base de Informações** — cargas com vigência (plano, de/para, apelidos, banco×resultado,
   distribuição de lucros) gravando no Supabase.
3. **Importar Razão + Balancete** — upload do Excel do Domínio, parse e gravação.
4. **Conciliação com farol** (saldo simples, composição, impostos).
5. **Comp. Movimento + Contabilizar** (correções viram lançamento; gerar arquivo Domínio).
6. **Status (todos os gates, incl. distribuição de lucros) + Relatórios** (auditoria + exports).

Para cada onda: implementar → testar localmente (`npm run dev`) → me mostrar funcionando →
commit → push. Pare e peça confirmação antes de: aplicar SQL no Supabase, push e deploy.

---

## 12. Critérios de "pronto" (definition of done)

- A tela lê e grava no Supabase (sem dado fake).
- Respeita vigência/histórico onde aplicável.
- Justificativas/correções gravam usuário e data e aparecem no relatório de auditoria.
- Nenhum segredo no Git; só `anon` no front.
- Funciona local e no deploy da Vercel (com as env vars configuradas lá).
