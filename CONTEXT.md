# Contabilidade by Attentive — Contexto do Projeto

> **Para o Claude Code:** leia este arquivo inteiro antes de agir. Ele consolida todas as
> decisões de produto e regras de negócio tomadas nas sessões de design. O `index.html`
> (cópia em `prototipo/prototipo-plataforma-contabil.html`) é o **protótipo navegável de
> referência** — define a UX e as regras, mas **ainda é HTML estático** (não chama o
> Supabase). Não invente comportamento: quando algo não existir, pergunte ou marque como
> pendente.

---

## 1. Visão do produto

Plataforma web para **padronizar o fechamento contábil mensal** dos ~150 clientes do
escritório do Fernando (Brasil). Hoje o trabalho é manual e depende de cada analista;
o objetivo é ter um fluxo único, com farol de pendências, trilha de auditoria e geração
dos arquivos de importação para o **Domínio (Thomson Reuters)**.

- **Fernando** — dono do produto, decide tudo.
- **João** — especialista no Domínio e nas regras contábeis.
- **Origem dos dados:** Domínio, exportado em Excel (razão, balancete, fiscal, folha, patrimônio).
- **Idioma:** português do Brasil. Convenções contábeis brasileiras (LALUR, ICMS/PIS/COFINS, etc.).

Uma "unidade de trabalho" = **cliente × competência** (mês/ano). Ex.: Euro Brake × Abril/2026.

---

## 2. Infra / contas

- **GitHub:** usuário `fe-moreira`.
- **Supabase:** projeto ref `dwuxrlxuusjcggvkfjza`, região `us-west-2`,
  URL `https://dwuxrlxuusjcggvkfjza.supabase.co` (conectado via conector oficial).
- **Vercel:** deploy do protótipo (estático).
- **Ambiente local:** Windows, Node v24.16.0, Claude Code, Claude Pro.

**Segurança (inegociável):** a chave `service_role` do Supabase **nunca** vai para o front
nem para o Git. Só a chave `anon`/publishable pode ir em variável de ambiente. `.env`,
`.env.local`, `.vercel` sempre no `.gitignore`.

---

## 3. Ordem de construção acordada

1. **NÚCLEO primeiro:** cadastro de clientes + importação e validação do **razão** +
   **balancete** + **conciliação com farol**.
2. Provar com **2–3 clientes reais**.
3. Coletar os layouts de exportação do Domínio com o João.
4. Só então: integrações, comparativo, relatórios e automação, em ondas.

O protótipo já desenhou as ondas seguintes (abaixo), mas o código de produção começa pelo núcleo.

---

## 4. Módulos já desenhados (no protótipo)

Menu por competência, grupo "Fechamento Contábil":
Fechamentos · Documentos Recebidos · Importar Razão · Integração · Conciliação ·
Comp. Movimento · **Contabilizar** · Relatórios · Status.
Item separado (nível cliente): **Base de Informações**.

### 4.1 Conciliação (com farol verde/amarelo/vermelho)
- Contas com tipo de conciliação: **Saldo simples** (banco), **Composição** (clientes,
  estoques, fornecedores) e **Imposto** (ICMS, PIS, COFINS).
- **Composição:** lançamentos agrupados por cliente/fornecedor, em formato de **razão**
  (Data · NF · Histórico · Débito · Crédito · Confiança). Itens quitados no mês somem.
  Baixa confiança → laranja + "corrigir" (corrige a leitura do cliente/NF).
  Card de amarração: Saldo atual × Composição × Diferença.
- **Impostos:** dois checks. (a) **Baixa do mês anterior** — o imposto do mês anterior
  tem de ter sido recolhido e zerado; se divergir, justificar ou corrigir (gera D imposto /
  C banco). (b) **Memória de cálculo** — importa a memória e compara com o balancete;
  se divergir, pergunta "houve recolhimento no mês?" e "houve PER/DCOMP?".
- Export Excel/PDF nas telas de detalhe.

### 4.2 Comparativo de Movimento
- Mostra **só o ano do fechamento**, colunas Jan → mês atual (acumulando).
- Sinaliza em **vermelho** desvio > 10% da média dos meses carregados.
- **Todos os números são clicáveis** (vermelho ou não). Ao clicar, abre o **razão da conta**:
  Data · Histórico · Débito · Crédito · **Saldo** (acumulado pela natureza da conta).
- A plataforma **aponta o provável culpado** (lançamento suspeito) com o motivo
  (não recorre nos meses anteriores, histórico genérico, valor fora do padrão).
- Ações por lançamento: **justificar** (texto, tira a pendência) e **corrigir**
  (reclassifica → gera lançamento no Contabilizar e marca a célula como corrigida).
- "Carga anterior" para clientes que entram no meio do ano.

### 4.3 Integração Financeira (pipeline PRÉ-razão, separado do Contabilizar)
- Importa o extrato/arquivo → dois baldes: "Contabilizado automaticamente" e
  "Não identificado".
- "Gerar arquivo financeiro" baixa CSV no layout do Domínio.
- Só vale para clientes marcados com integração financeira = "Excel".

### 4.4 Contabilizar (fila central de lançamentos)
- Fila de lançamentos `{data, cdeb, ccre, valor, hist, origem, doc}`.
- Sugestões da plataforma (ex.: baixa de adiantamento, rendimento de aplicação) → confirmar/editar/descartar.
- Novo lançamento: escrever a partida (selects de plano) **ou** subir documento.
- Relatório de lançamentos (auditoria do analista; **sem** etapa de aprovação, por decisão do Fernando).
- **"Gerar arquivo Domínio"** baixa CSV no layout exato (ver §5).

### 4.5 Base de Informações (nível cliente)
- **Particularidades** e **Contatos:** listas com "incluir/editar/excluir" e carimbo
  "atualizado por <usuário> · <data>".
- **Parâmetros do fechamento** (cards de **carga** com vigência versionada; histórico preservado):
  - Plano de contas (com tipo de conciliação)
  - De/Para integrações (acumulador → conta)
  - Apelidos (leitura de histórico)
  - Modelos de relatório
  - Período de início
  - Histórico de lançamentos financeiros (carga inicial; depois atualiza sozinho a cada mês)
  - **Amarração banco × resultado** — **carga por Excel** (planilha única com colunas
    **Tipo** [Banco / Resultado liberado], **Código**, **Nome**). Ao abrir o card, mostra
    "Contas já cadastradas". Alimenta o gate de Status (§4.6).

### 4.6 Status (gate de pendências; libera o fechamento quando zera)
- Vários gates clicáveis. Destaque:
  **Lançamentos banco × resultado** — aponta lançamentos que jogam um banco direto numa
  conta de resultado (prefixo 3/4/5) que **não** está na lista de exceções liberadas.
  Cada apontamento tem **justificar** (se a conta for despesa /^4/, exige classificar
  **dedutível/indedutível** para o LALUR) e **corrigir** (reclassifica → Contabilizar).
- Relatório do gate com Excel/PDF + **Despesas indedutíveis (LALUR)**.

### 4.7 Relatórios
- Book de Composições, Relatório de Pendências, DRE, Comparativo, Balanço, DFC, Balancete.
- **Justificativas e correções do fechamento** — relatório de auditoria que consolida
  TODAS as justificativas (Comparativo, Banco × Resultado, Impostos) e TODAS as correções
  lançadas (as reclassificações que viraram lançamento), cada uma com usuário e data.
  Export Excel (CSV). É o "raio-x" final do que foi feito na competência.

---

## 5. Layout do arquivo de importação do Domínio (lançamentos)

CSV, separador `;`, com BOM UTF-8. Cabeçalho/colunas fixos:

```
Data ; Cód. Conta Débito ; Cód. Conta Crédito ; Valor ; Cód. Histórico ;
Complemento Histórico ; Inicia Lote ; Código Matriz/Filial ; Centro de Custo Débito ; Centro de Custo Crédito
```

- Valor em formato pt-BR (vírgula decimal).
- "Inicia Lote" = 1 só na primeira linha.
- Arquivo de referência real do Domínio: `POP1004 - Lançamentos Contábeis` (macro gera
  `lanctos.txt` em `C:\Contabil`).
- Razão de referência: `razao_-_approvata.xls` (layout confirmado, 30 colunas).

---

## 6. Planilha de importação de clientes (onboarding)

`layout-importacao-clientes.xlsx` — **2 abas**: Instruções + Clientes.
Colunas de Clientes: Código no Domínio (chave) · Tipo (Matriz/Filial) · Código da Matriz
(liga filial→matriz) · Razão Social · Nome Fantasia · CNPJ · Regime Tributário ·
Tipo de Fechamento · Competência de início · Fazer carga inicial de saldos ·
Coleta automática do razão · Sistema financeiro · Integração financeira (Sistema/Excel) ·
Analista · Observações.
Matriz e filiais são linhas na mesma aba. As demais listas (plano, de/para, apelidos,
particularidades, banco × resultado) entram como **cargas** dentro da Base de Informações.

---

## 7. Modelo de dados sugerido para o Supabase (próxima fase)

Tabelas iniciais (a confirmar com o Fernando antes de criar):
- `clientes` (matriz/filial, regime, tipo de fechamento, analista, flags de integração).
- `competencias` (cliente_id, ano, mes, status, pct).
- `plano_contas`, `de_para`, `apelidos`, `banco_resultado` (com **vigência** e histórico — nunca sobrescrever).
- `razao` (linhas importadas do Domínio) e `balancete`.
- `lancamentos` (fila do Contabilizar; origem = manual/correção/sugestão).
- `justificativas` e `correcoes` (módulo, item, tipo, detalhe, **usuário**, **data**) — viram
  o relatório de auditoria (§4.7) e dão histórico permanente entre competências.

Todas as tabelas de cadastro devem preservar histórico por vigência (não sobrescrever).

---

## 8. Estado atual

- Protótipo navegável publicado (GitHub → Vercel) como HTML estático.
- Supabase conectado, **sem tabelas ainda**.
- **Próximo passo:** criar as tabelas do núcleo no Supabase e ligar cadastro de clientes +
  importação/validação do razão + balancete + conciliação. Confirmar o modelo de dados
  com o Fernando antes de criar as tabelas.
