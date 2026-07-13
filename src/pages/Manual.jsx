// Manual do Time — documentação viva da plataforma. Mora dentro do sistema (menu Ajuda)
// e é versionada no repo: quando o sistema muda, o manual muda junto. Tem busca (leva
// direto à seção) e "Gerar PDF" pela impressão do navegador — sai fiel e sempre atualizado.
import { useEffect, useMemo, useRef, useState } from 'react'

const CSS = `
/* Espelha a estrutura de tema do app: ESCURO é a base (:root), CLARO é o override
   ([data-theme="light"]). O manual pinta o próprio fundo (--m-bg) com a mesma paleta
   do texto (--m-ink), então o contraste nunca quebra, seja qual for o tema do app. */
#manual-root{
  --m-bg:#161B29; --m-surface:#1F2634; --m-surface2:#1A2231;
  --m-ink:#E8EAF0; --m-muted:#9DA8BD; --m-faint:#6E7A90;
  --m-line:#2B3446; --m-line2:#232C3D;
  --m-accent:#6E97FF; --m-accent-weak:#6e97ff22; --m-accent-line:#6e97ff55;
  --m-green:#41B883; --m-amber:#E0A93B; --m-red:#F0645A;
  --m-green-weak:#41b88326; --m-amber-weak:#e0a93b26; --m-red-weak:#f0645a26;
  --m-navy:#0A0F1A;
  --m-mono:ui-monospace,"SF Mono","Cascadia Code",Menlo,Consolas,monospace;
  background:var(--m-bg); color:var(--m-ink); max-width:900px;
  font-feature-settings:"kern","liga";
}
:root[data-theme="light"] #manual-root{
  --m-bg:#FFFFFF; --m-surface:#F4F6FA; --m-surface2:#FAFBFE;
  --m-ink:#1A2236; --m-muted:#5A6474; --m-faint:#8A94A6;
  --m-line:#E4E8F0; --m-line2:#EEF1F6;
  --m-accent:#3B6EF5; --m-accent-weak:#3b6ef514; --m-accent-line:#3b6ef540;
  --m-green:#1E9E63; --m-amber:#B9820A; --m-red:#D6392F;
  --m-green-weak:#1e9e6316; --m-amber-weak:#b9820a1a; --m-red-weak:#d6392f16;
  --m-navy:#131A2B;
}
#manual-root h1,#manual-root h2,#manual-root h3,#manual-root h4{margin:0;line-height:1.2;text-wrap:balance}
#manual-root p{margin:10px 0;line-height:1.62}
#manual-root .m-code{font-family:var(--m-mono);font-size:.87em;background:var(--m-accent-weak);
  color:var(--m-accent);padding:1px 6px;border-radius:6px;white-space:nowrap}
#manual-root .m-eyebrow{font-size:11.5px;font-weight:700;letter-spacing:.11em;text-transform:uppercase;color:var(--m-accent)}
#manual-root .m-dot{width:9px;height:9px;border-radius:50%;display:inline-block;flex-shrink:0;vertical-align:middle}
#manual-root .dg{background:var(--m-green)} #manual-root .da{background:var(--m-amber)}
#manual-root .dr{background:var(--m-red)} #manual-root .db{background:var(--m-accent)}
#manual-root .dgray{background:var(--m-faint)}

#manual-root .m-hero{border:1px solid var(--m-line);border-radius:16px;padding:30px 30px;margin-bottom:16px;
  background:radial-gradient(120% 130% at 100% 0%, var(--m-accent-weak), transparent 55%), var(--m-surface)}
#manual-root .m-hero h1{font-size:clamp(26px,4vw,38px);font-weight:800;letter-spacing:-.03em}
#manual-root .m-lead{font-size:17px;color:var(--m-muted);max-width:64ch}
#manual-root .m-hero .m-lead{margin-top:12px}
#manual-root .m-pills{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}
#manual-root .m-pill{font-size:12.5px;font-weight:600;padding:6px 12px;border-radius:20px;border:1px solid var(--m-line);
  background:var(--m-surface2);color:var(--m-muted);display:inline-flex;align-items:center;gap:7px}

#manual-root .m-index{border:1px solid var(--m-line);background:var(--m-surface);border-radius:14px;padding:16px 20px;margin:16px 0 30px}
#manual-root .m-index .t{font-size:11.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--m-faint);margin-bottom:10px}
#manual-root .m-index ol{margin:0;padding:0;list-style:none;columns:2;column-gap:26px}
#manual-root .m-index li{break-inside:avoid;margin:2px 0}
#manual-root .m-index a{display:flex;gap:9px;text-decoration:none;color:var(--m-muted);font-size:13.5px;padding:4px 6px;border-radius:7px}
#manual-root .m-index a:hover{background:var(--m-accent-weak);color:var(--m-ink)}
#manual-root .m-index a .n{font-family:var(--m-mono);font-size:11.5px;color:var(--m-accent);width:20px;flex-shrink:0}

#manual-root section{scroll-margin-top:20px;margin:0 0 40px;padding-top:6px}
#manual-root h2.m-sec{font-size:clamp(21px,3vw,27px);font-weight:750;letter-spacing:-.02em;margin:6px 0 0}
#manual-root h3{font-size:17px;font-weight:700;letter-spacing:-.01em;margin:24px 0 6px;display:flex;align-items:center;gap:9px}
#manual-root ul{margin:10px 0;padding-left:0;list-style:none}
#manual-root ul li{position:relative;padding:3px 0 3px 22px;max-width:74ch;line-height:1.55}
#manual-root ul li::before{content:"";position:absolute;left:4px;top:11px;width:6px;height:6px;border-radius:2px;background:var(--m-accent-line)}
#manual-root .m-muted{color:var(--m-muted)}

#manual-root .m-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;margin:14px 0}
#manual-root .m-mod{border:1px solid var(--m-line);background:var(--m-surface);border-radius:12px;padding:16px 18px}
#manual-root .m-mod .h{display:flex;align-items:center;gap:10px;font-weight:700;font-size:15px}
#manual-root .m-mod .ic{width:30px;height:30px;border-radius:8px;background:var(--m-accent-weak);color:var(--m-accent);
  display:grid;place-items:center;font-size:14px;font-weight:800;flex-shrink:0}
#manual-root .m-mod p{margin:6px 0 0;font-size:13.5px;color:var(--m-muted)}

#manual-root .m-rule{border-left:3px solid var(--m-accent);background:var(--m-accent-weak);
  border-radius:0 10px 10px 0;padding:12px 16px;margin:14px 0;font-size:14.5px}
#manual-root .m-rule.warn{border-color:var(--m-amber);background:var(--m-amber-weak)}
#manual-root .m-rule.stop{border-color:var(--m-red);background:var(--m-red-weak)}
#manual-root .m-rule .k{display:block;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:3px;color:var(--m-accent)}
#manual-root .m-rule.warn .k{color:var(--m-amber)} #manual-root .m-rule.stop .k{color:var(--m-red)}

#manual-root .m-steps{counter-reset:s;margin:14px 0}
#manual-root .m-step{display:grid;grid-template-columns:44px 1fr;gap:14px;padding:13px 0;border-top:1px solid var(--m-line2)}
#manual-root .m-step:first-child{border-top:none}
#manual-root .m-step .num::before{counter-increment:s;content:counter(s,decimal-leading-zero);font-family:var(--m-mono);
  font-size:13px;font-weight:700;color:var(--m-accent);background:var(--m-accent-weak);
  width:34px;height:34px;border-radius:9px;display:grid;place-items:center}
#manual-root .m-step h4{font-size:15px;font-weight:700}
#manual-root .m-step p{margin:3px 0 0;font-size:13.5px;color:var(--m-muted)}

#manual-root .m-farol{display:grid;gap:8px;margin:14px 0}
#manual-root .m-farol .row{display:grid;grid-template-columns:130px 1fr;gap:14px;align-items:start;
  padding:11px 14px;border:1px solid var(--m-line);border-radius:10px;background:var(--m-surface)}
#manual-root .m-farol .lbl{display:inline-flex;align-items:center;gap:8px;font-weight:650;font-size:13.5px}
#manual-root .m-farol .row p{margin:0;font-size:13.5px;color:var(--m-muted)}

#manual-root .m-kv{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:12px 0;font-size:14px}
#manual-root .m-kv dt{font-weight:650}
#manual-root .m-kv dd{margin:0;color:var(--m-muted)}

#manual-root .m-card{border:1px solid var(--m-line);background:var(--m-surface);border-radius:14px;padding:8px 18px 18px;margin:14px 0}
#manual-root hr.m-div{border:none;border-top:1px solid var(--m-line);margin:38px 0}
#manual-root .m-foot{color:var(--m-faint);font-size:13px;border-top:1px solid var(--m-line);padding-top:18px;margin-top:30px}

/* Barra de ações (fica fora do PDF) */
#manual-root .manual-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
#manual-root .manual-actions .hint{font-size:12.5px;color:var(--m-muted)}

/* Busca no manual (fica fora do PDF) */
#manual-root .manual-search{position:relative;margin-bottom:22px;max-width:560px}
#manual-root .manual-search .box{display:flex;align-items:center;gap:10px;border:1px solid var(--m-line);
  background:var(--m-surface);border-radius:11px;padding:11px 14px}
#manual-root .manual-search .box:focus-within{border-color:var(--m-accent);box-shadow:0 0 0 3px var(--m-accent-weak)}
#manual-root .manual-search input{flex:1;border:none;outline:none;background:transparent;color:var(--m-ink);
  font-size:14.5px;font-family:inherit}
#manual-root .manual-search input::placeholder{color:var(--m-faint)}
#manual-root .manual-search .ico{color:var(--m-faint);font-size:18px}
#manual-root .manual-search .clr{color:var(--m-faint);font-size:16px;cursor:pointer}
#manual-root .m-res{margin-top:8px;border:1px solid var(--m-line);background:var(--m-surface);border-radius:11px;
  overflow:hidden;box-shadow:0 10px 30px rgba(10,20,40,.10)}
#manual-root .m-res .head{font-size:11.5px;color:var(--m-faint);padding:9px 14px 4px;font-weight:600}
#manual-root .m-res button{display:block;width:100%;text-align:left;background:none;border:none;cursor:pointer;
  padding:10px 14px;border-top:1px solid var(--m-line2);font-family:inherit}
#manual-root .m-res button:first-of-type{border-top:none}
#manual-root .m-res button:hover{background:var(--m-accent-weak)}
#manual-root .m-res .rt{font-size:13.5px;font-weight:650;color:var(--m-ink);display:flex;align-items:center;gap:8px}
#manual-root .m-res .rt .tag{font-family:var(--m-mono);font-size:11px;color:var(--m-accent)}
#manual-root .m-res .rs{font-size:12.5px;color:var(--m-muted);margin-top:2px;line-height:1.45}
#manual-root .m-res mark{background:var(--m-amber-weak);color:inherit;font-weight:700;border-radius:3px;padding:0 2px}
#manual-root .m-res .vazio{padding:14px;font-size:13px;color:var(--m-muted)}
@keyframes m-flash{0%{background:var(--m-amber-weak)}100%{background:transparent}}
#manual-root section.m-hit{animation:m-flash 1.6s ease-out}
@media (prefers-reduced-motion:reduce){#manual-root section.m-hit{animation:none}}

/* ===== Impressão / PDF: isola o manual, força tema claro, mantém as cores ===== */
@media print{
  body *{visibility:hidden !important}
  #manual-root, #manual-root *{visibility:visible !important}
  #manual-root{position:absolute;left:0;top:0;width:100%;max-width:none;
    -webkit-print-color-adjust:exact;print-color-adjust:exact;
    --m-bg:#FFFFFF; --m-surface:#FFFFFF; --m-surface2:#F7F9FC;
    --m-ink:#10151F; --m-muted:#44505F; --m-faint:#7A8496; --m-line:#DCE2EC; --m-line2:#EAEEF4;
    --m-accent:#2E5FE0; --m-accent-weak:#2e5fe012; --m-accent-line:#2e5fe040;
    --m-green:#137A49; --m-amber:#9A6D06; --m-red:#C22C22;
    --m-green-weak:#137a4912; --m-amber-weak:#9a6d0612; --m-red-weak:#c22c2212;}
  #manual-root .manual-actions, #manual-root .manual-search{display:none !important}
  #manual-root section{break-inside:avoid-page}
  #manual-root .m-hero{break-after:avoid}
  @page{margin:14mm}
}
@media (max-width:640px){ #manual-root .m-index ol{columns:1} }
`

const HTML = `
<section id="m-visao">
  <div class="m-hero">
    <div class="m-eyebrow">Manual operacional</div>
    <h1>O fechamento contábil, do jeito padronizado.</h1>
    <p class="m-lead">Esta plataforma unifica o fechamento mensal dos clientes do escritório: um único fluxo, com farol de pendências, trilha de auditoria e geração dos arquivos de importação do <b>Domínio</b>. Este manual explica cada módulo e as regras que todo o time precisa seguir.</p>
    <div class="m-pills">
      <span class="m-pill"><span class="m-dot db"></span> Cliente × Competência</span>
      <span class="m-pill"><span class="m-dot dg"></span> Farol de pendências</span>
      <span class="m-pill"><span class="m-dot db"></span> Razão vivo</span>
      <span class="m-pill"><span class="m-dot db"></span> Trilha de auditoria</span>
    </div>
  </div>
  <p class="m-muted">A unidade de trabalho é sempre <b>um cliente em uma competência</b> (mês/ano) — por exemplo, <i>APPROVATA × Maio/2026</i>. Você seleciona a empresa no topo do menu, abre o fechamento daquela competência e trabalha dentro dele.</p>

  <div class="m-index">
    <div class="t">Índice</div>
    <ol>
      <li><a href="#m-conceitos"><span class="n">01</span> Conceitos-chave</a></li>
      <li><a href="#m-fluxo"><span class="n">02</span> Fluxo do fechamento</a></li>
      <li><a href="#m-clientes"><span class="n">03</span> Clientes</a></li>
      <li><a href="#m-base"><span class="n">04</span> Base de Informações</a></li>
      <li><a href="#m-massa"><span class="n">05</span> Importação em massa</a></li>
      <li><a href="#m-relmassa"><span class="n">06</span> Relatórios em massa</a></li>
      <li><a href="#m-fechamentos"><span class="n">07</span> Fechamentos</a></li>
      <li><a href="#m-documentos"><span class="n">08</span> Documentos Recebidos</a></li>
      <li><a href="#m-razao"><span class="n">09</span> Importar Razão</a></li>
      <li><a href="#m-sugestoes"><span class="n">10</span> Sugestões de Contab.</a></li>
      <li><a href="#m-outras"><span class="n">11</span> Outras Contabilizações</a></li>
      <li><a href="#m-integracao"><span class="n">12</span> Integração Financeira</a></li>
      <li><a href="#m-conciliacao"><span class="n">13</span> Conciliação</a></li>
      <li><a href="#m-comparativo"><span class="n">14</span> Comp. de Movimento</a></li>
      <li><a href="#m-contabilizar"><span class="n">15</span> Contabilizar</a></li>
      <li><a href="#m-status"><span class="n">16</span> Status</a></li>
      <li><a href="#m-relatorios"><span class="n">17</span> Relatórios</a></li>
      <li><a href="#m-cockpit"><span class="n">18</span> Cockpit Financeiro</a></li>
      <li><a href="#m-regras"><span class="n">19</span> Regras de ouro</a></li>
      <li><a href="#m-atalhos"><span class="n">20</span> Dicas e atalhos</a></li>
    </ol>
  </div>
</section>

<section id="m-conceitos">
  <div class="m-eyebrow">01 · Fundamentos</div>
  <h2 class="m-sec">Conceitos-chave</h2>
  <p class="m-lead">Quatro ideias sustentam todo o sistema. Entendendo elas, o resto encaixa.</p>
  <h3><span class="m-dot db"></span> Competência</h3>
  <p>Cada mês de cada cliente é uma <b>competência</b>. As funções do fechamento só abrem com um <b>fechamento aberto</b> naquela competência. Sem fechamento aberto, o sistema mostra “Abra um fechamento para continuar”.</p>
  <h3><span class="m-dot dg"></span> Farol (verde / amarelo / vermelho)</h3>
  <p>A lógica visual de todo o produto. Verde é o que está resolvido; amarelo é o que falta alguma coisa; vermelho é o que exige ação.</p>
  <div class="m-farol">
    <div class="row"><span class="lbl"><span class="m-dot dg"></span> Verde</span><p>Pronto / reconhecido / dentro da faixa. Segue o fluxo.</p></div>
    <div class="row"><span class="lbl"><span class="m-dot da"></span> Amarelo</span><p>Falta um dado (ex.: a conta contábil) ou está aguardando. Um toque resolve.</p></div>
    <div class="row"><span class="lbl"><span class="m-dot dr"></span> Vermelho</span><p>Exige decisão: justificar, corrigir ou identificar. Bloqueia o fechamento até tratar.</p></div>
  </div>
  <h3><span class="m-dot db"></span> Razão vivo</h3>
  <p>O conceito mais importante. <b>Todos os relatórios são alimentados pelo razão importado do Domínio <span class="m-muted">mais</span> todos os ajustes que você faz</b> (correções, estornos, apropriações, contabilizações). Quando você corrige um lançamento na Conciliação, aquele ajuste vira um <b>lançamento</b> e passa a aparecer no Comparativo, no Cockpit e no razão da conta — sem reimportar nada.</p>
  <div class="m-rule"><span class="k">Por que importa</span> A correção <b>nunca</b> altera o razão importado direto; ela vive como lançamento e é sobreposta ao razão. Assim Cockpit, Conciliação e Comparativo mostram sempre o mesmo número, e nada é contado em dobro.</div>
  <h3><span class="m-dot db"></span> Domínio</h3>
  <p>O sistema de escrituração (Thomson Reuters) de onde vêm os dados e para onde a plataforma gera os arquivos de importação de lançamentos. O objetivo de cada competência é entregar o fechamento pronto e o arquivo para subir no Domínio.</p>
</section>

<section id="m-fluxo">
  <div class="m-eyebrow">02 · Passo a passo</div>
  <h2 class="m-sec">O fluxo do fechamento</h2>
  <p class="m-lead">A ordem recomendada para fechar uma competência. Cada passo tem uma tela dedicada.</p>
  <div class="m-steps">
    <div class="m-step"><div class="num"></div><div><h4>Abrir o fechamento</h4><p>Selecione o cliente e abra (ou crie) o fechamento da competência em <b>Fechamentos</b>.</p></div></div>
    <div class="m-step"><div class="num"></div><div><h4>Conferir os documentos</h4><p>Em <b>Documentos Recebidos</b>, veja o que o cliente enviou. Suba os arquivos — o “recebido” é automático.</p></div></div>
    <div class="m-step"><div class="num"></div><div><h4>Importar o razão</h4><p>Traga o razão do Domínio em <b>Importar Razão</b> — é a base do balancete e de tudo o mais.</p></div></div>
    <div class="m-step"><div class="num"></div><div><h4>Integração financeira</h4><p>Para clientes com integração por Excel, classifique o extrato em <b>Integração</b> e gere os lançamentos.</p></div></div>
    <div class="m-step"><div class="num"></div><div><h4>Conciliar as contas</h4><p>Em <b>Conciliação</b>, feche banco, clientes/fornecedores e impostos. Justifique ou corrija o que divergir.</p></div></div>
    <div class="m-step"><div class="num"></div><div><h4>Contabilizações e sugestões</h4><p>Confirme as <b>Sugestões</b>, registre <b>Outras Contabilizações</b> (PER/DCOMP, JSCP) e revise a fila em <b>Contabilizar</b>.</p></div></div>
    <div class="m-step"><div class="num"></div><div><h4>Comparar o movimento</h4><p>No <b>Comparativo</b>, investigue variações fortes mês a mês; justifique ou corrija.</p></div></div>
    <div class="m-step"><div class="num"></div><div><h4>Zerar o Status</h4><p>O <b>Status</b> é o gate: só libera quando as pendências (banco × resultado, LALUR, etc.) zeram.</p></div></div>
    <div class="m-step"><div class="num"></div><div><h4>Gerar relatórios e o arquivo Domínio</h4><p>Emita os <b>Relatórios</b>, revise o <b>Cockpit</b> com o cliente e baixe o arquivo de lançamentos.</p></div></div>
  </div>
</section>

<hr class="m-div">

<section id="m-clientes">
  <div class="m-eyebrow">Nível cliente</div>
  <h2 class="m-sec">03 · Clientes</h2>
  <p>Cadastro das empresas (matriz e filiais). Cada cliente tem <b>código no Domínio</b> (a chave que amarra tudo), CNPJ, <b>regime tributário</b>, <b>regime de cálculo do imposto</b> (Caixa/Competência), tipo de fechamento, analista e as flags de integração. O onboarding em lote é por planilha; matriz e filiais são linhas na mesma aba, ligadas pelo código da matriz.</p>
  <div class="m-rule"><span class="k">Regime de cálculo do imposto</span> <b>Caixa</b> ou <b>Competência</b> — define a base de PIS/COFINS e do Simples. É o que habilita esses itens no card <b>Impostos</b> (só entram para empresas em regime <b>Caixa</b>). Todos começam em Competência.</div>
  <div class="m-rule"><span class="k">Chaves que o sistema usa</span> <b>Código do Domínio</b> identifica o cliente no roteamento de arquivos por nome; o <b>CNPJ</b> identifica pela leitura de conteúdo (ver Importação em massa).</div>
</section>

<section id="m-base">
  <h2 class="m-sec">04 · Base de Informações</h2>
  <p>O “cadastro vivo” de cada cliente, com dois blocos:</p>
  <ul>
    <li><b>Particularidades e Contatos</b> — listas com incluir/editar/excluir, cada mudança carimbada com <b>usuário e data</b>.</li>
    <li><b>Parâmetros do fechamento</b> — cargas com <b>vigência versionada</b>: plano de contas, de/para de integrações, apelidos de leitura, contas bancárias, amarração banco × resultado, período de início e histórico de lançamentos financeiros.</li>
    <li><b>Cadastro do Lucro Real (LALUR)</b> — só para clientes no Lucro Real. Define o que o card LALUR usa: contas de <b>adição</b> e <b>exclusão</b>, contas de <b>IRRF</b> (retido e sobre aplicação financeira), o saldo de <b>prejuízo a compensar</b> (limite de 30%) e as <b>contas de contabilização</b> (IRPJ/CSLL despesa e a pagar).</li>
  </ul>
  <div class="m-rule warn"><span class="k">Regra de vigência</span> Toda carga de cadastro <b>preserva o histórico</b>. Ao atualizar, cria-se uma nova vigência — o passado continua íntegro para reprocessar meses anteriores.</div>
  <div class="m-rule"><span class="k">Carga inicial — vários arquivos por bloco</span> Na <b>Carga inicial de saldos</b>, se você subir um 2º arquivo num bloco que já tem dados (ex.: fornecedores em duas planilhas), o sistema pergunta <b>Complementar</b> (soma ao que já está) ou <b>Substituir</b> (troca tudo).</div>
</section>

<section id="m-massa">
  <h2 class="m-sec">05 · Importação em massa</h2>
  <p>Sobe informação de vários clientes de uma vez, amarrando pelo CNPJ. Dois usos:</p>
  <h3><span class="m-dot db"></span> Relação de documentos</h3>
  <p>Uma planilha (CNPJ · Cliente · Documento) define a lista de documentos esperados de cada cliente na competência — e propaga para os fechamentos abertos dali em diante.</p>
  <h3><span class="m-dot db"></span> Recebimento de arquivos — sem renomear</h3>
  <p>Arraste os extratos de vários clientes de uma vez. O sistema <b>reconhece cada arquivo pelo conteúdo</b> e monta uma grade de conferência. Duas vias, nesta ordem:</p>
  <ul>
    <li><b>Nome <span class="m-code">código-conta-…</span></b> — atalho: se o arquivo já vem nomeado, roteia direto.</li>
    <li><b>Conteúdo</b> — lê o <b>CNPJ</b> (→ cliente) e a <b>agência/conta</b> (→ conta contábil, pela memória aprendida).</li>
  </ul>
  <div class="m-farol">
    <div class="row"><span class="lbl"><span class="m-dot dg"></span> Pronto</span><p>Cliente e conta reconhecidos. Recebe direto.</p></div>
    <div class="row"><span class="lbl"><span class="m-dot da"></span> Falta conta</span><p>Cliente ok, conta nova: um toque no <b>F4</b> e o sistema memoriza.</p></div>
    <div class="row"><span class="lbl"><span class="m-dot dr"></span> Sem cliente</span><p>CNPJ não bateu: escolha no dropdown ou renomeie <span class="m-code">código-conta</span>.</p></div>
  </div>
  <div class="m-rule"><span class="k">Aprende sozinho</span> O número da conta confirmado no F4 é gravado no cadastro de contas bancárias. Do <b>2º mês em diante</b>, a mesma conta é reconhecida automaticamente (etiqueta “memória”). A extensão decide o destino: <b>PDF → Conciliação</b>; <b>Excel → Integração</b>.</div>
</section>

<section id="m-relmassa">
  <h2 class="m-sec">06 · Relatórios em massa</h2>
  <p>Emite relatórios de vários clientes de uma vez, para consolidação e conferência do escritório — sem entrar cliente a cliente.</p>
</section>

<hr class="m-div">

<section id="m-fechamentos">
  <div class="m-eyebrow">No fechamento</div>
  <h2 class="m-sec">07 · Fechamentos</h2>
  <p>A porta de entrada do trabalho mensal. Lista as competências do cliente e o andamento de cada uma. Aqui você <b>abre</b> um fechamento existente ou <b>cria</b> um novo. A competência ativa aparece no topo da tela; use <b>Trocar</b> para mudar.</p>
  <div class="m-rule warn"><span class="k">Somente leitura</span> Fechamento marcado como <b>fechado</b> fica travado: nada muda até reabrir. Ações em massa também pulam competências fechadas.</div>
</section>

<section id="m-documentos">
  <h2 class="m-sec">08 · Documentos Recebidos</h2>
  <p>Checklist do que o cliente precisa entregar. Cada documento tem uma <b>conta contábil</b> (F4) e um <b>tipo</b>. Situações:</p>
  <div class="m-farol">
    <div class="row"><span class="lbl"><span class="m-dot da"></span> Pendente</span><p>Aguardando — bloqueia o Status.</p></div>
    <div class="row"><span class="lbl"><span class="m-dot dg"></span> Recebido</span><p>Automático ao subir o arquivo. <b>Sem baixa manual.</b></p></div>
    <div class="row"><span class="lbl"><span class="m-dot dgray"></span> Não tem</span><p>Não se aplica no mês (some, sem cobrança).</p></div>
    <div class="row"><span class="lbl"><span class="m-dot dr"></span> Não enviou</span><p>Não bloqueia o fechamento, mas entra no relatório de pendências para cobrar o cliente.</p></div>
  </div>
  <h3><span class="m-dot db"></span> Tipo do documento (mesma conta, dois arquivos)</h3>
  <p>Uma conta bancária costuma ter <b>dois</b> documentos na mesma conta contábil: o <b>extrato do banco (PDF)</b> → Conciliação e a <b>planilha do sistema (Excel)</b> → Integração. O <b>tipo</b> distingue os dois para um não marcar o outro. Deixe em <b>Auto</b> que o sistema deduz pelo formato (“(PDF)”/“(Excel)”), ou fixe manualmente.</p>
  <div class="m-rule"><span class="k">Ver / excluir arquivo</span> Todo arquivo recebido pode ser aberto (“ver arquivo”) e, se subiu na conta errada, excluído — o documento volta a pendente e a conciliação é limpa.</div>
</section>

<section id="m-razao">
  <h2 class="m-sec">09 · Importar Razão</h2>
  <p>Traz o razão exportado do Domínio (Excel). É a <b>base de tudo</b>: dele saem o balancete, o comparativo e as conciliações. O código da conta é lido <b>exatamente como vem no arquivo</b> (o <b>código reduzido</b> do Domínio, sem pontos) — e é ele que identifica cada conta e casa com o plano e com o saldo inicial. As sintéticas (totais) são montadas por prefixo da <b>classificação</b>. Para clientes que entram no meio do ano, dá para importar os <b>meses anteriores</b> num arquivo único (dá histórico para a régua de variação).</p>
  <div class="m-rule"><span class="k">Código reduzido é a identidade</span> Várias contas analíticas podem dividir a mesma classificação (ex.: todos os bancos, ou vários custos no mesmo grupo). O que separa uma da outra é o <b>código reduzido</b> (ex.: Itaú 11202 ≠ Bradesco 11201) — por isso o razão é lido por ele, sem máscara/pontos. Se você já tinha razão importado com pontos, <b>reimporte</b> o mesmo arquivo para atualizar.</div>
</section>

<section id="m-sugestoes">
  <h2 class="m-sec">10 · Sugestões de Contabilização</h2>
  <p>A plataforma sugere lançamentos que você confirma, edita ou descarta. Exemplos:</p>
  <ul>
    <li><b>Desconto / juros</b> nas diferenças de conciliação de clientes e fornecedores (desconto quando a diferença é a menor; juros quando é a maior).</li>
    <li><b>Baixa de adiantamento</b> — compensa o menor entre título e adiantamento.</li>
  </ul>
  <div class="m-rule warn"><span class="k">Regra do banco</span> Quando se fala em <b>pagamento ou recebimento</b>, só é considerado o que <b>veio do banco</b> (contrapartida = conta bancária). O que não passou pelo banco é outra coisa — não vira baixa automática.</div>
</section>

<section id="m-outras">
  <h2 class="m-sec">11 · Outras Contabilizações</h2>
  <p>Lançamentos específicos que fogem do fluxo automático, em cards enxutos:</p>
  <div class="m-grid">
    <div class="m-mod"><div class="h"><span class="ic">PD</span> PER/DCOMP</div><p>Crédito e compensação — a declaração que o time fiscal faz. Registra o crédito e o abatimento.</p></div>
    <div class="m-mod"><div class="h"><span class="ic">%</span> JSCP</div><p>Juros sobre capital próprio, com os campos da planilha real. IRRF padrão <b>17,5%</b> (alíquota vigente em 2026).</p></div>
    <div class="m-mod"><div class="h"><span class="ic">LR</span> LALUR</div><p>Só para <b>Lucro Real</b>. Puxa o resultado acumulado do Comparativo, aplica adições/exclusões e prejuízo (limite 30%) e calcula <b>IRPJ 15% + adicional 10%</b> (acima de R$ 20 mil/mês) <b>+ CSLL 9%</b>. Anual (acumula no ano) ou Trimestral. Usa o Cadastro do Lucro Real e contabiliza a provisão.</p></div>
    <div class="m-mod"><div class="h"><span class="ic">RD</span> Receitas Diferidas</div><p>Faturamento reconhecido aos poucos (<b>baixa manual</b>). Você informa quanto reconhecer no mês e gera a <b>receita</b> (D receita diferida / C receita) e os impostos <b>PIS/COFINS/ISS</b> proporcionais (D despesa / C imposto diferido). Mostra faturamento, reconhecido e saldo.</p></div>
  </div>
</section>

<section id="m-integracao">
  <h2 class="m-sec">12 · Integração Financeira</h2>
  <p>Pipeline <b>pré-razão</b>, separado do Contabilizar. Importa o extrato/planilha do cliente e separa em dois baldes: <b>contabilizado automaticamente</b> e <b>não identificado</b>. Usa o perfil de leitura e a memória do cliente para classificar e sugerir a partida. Ao final, gera o arquivo financeiro no layout do Domínio.</p>
  <div class="m-rule"><span class="k">Quando se aplica</span> Só para clientes marcados com <b>integração financeira = Excel</b>. O extrato Excel subido em massa já cai aqui como rascunho, com os lançamentos sugeridos.</div>
  <div class="m-rule warn"><span class="k">Perfil de leitura — 1ª vez, por banco</span> O perfil é <b>por banco</b> (cada conta contábil tem o seu): um cliente com Itaú e Bradesco, por exemplo, exporta layouts diferentes, então cada banco guarda seu próprio mapeamento. Para cada banco, a <b>primeira</b> importação é feita <b>aqui na Integração</b>: o sistema mostra o mapeamento das colunas (Data · Valor · Histórico · D/C) — confira em <b>“Ajustar leitura”</b> e salve. Isso grava o <b>perfil daquele banco</b>. A partir daí, subir o Excel daquele banco (individual ou em massa) já classifica sozinho. Sem o perfil do banco, o upload marca o documento como recebido mas <b>não</b> alimenta a Integração — e avisa que falta configurar o perfil. Depois de importado, dá para <b>“Ajustar leitura” no próprio arquivo já importado</b> (o extrato fica guardado com o rascunho) — muda o mapeamento e atualiza, sem precisar subir o arquivo de novo.</div>
  <div class="m-rule"><span class="k">Centro de custo</span> Para clientes que usam centro de custo, a grade ganha a coluna <b>C. Custo</b>. O valor vem da <b>planilha do mês</b> (mapeie a coluna em “Ajustar leitura” → Centro de Custo) e <b>não</b> entra na memória — se vier vazio, você preenche à mão (digite ou aperte <b>F4</b> para buscar na lista de centros de custo cadastrada em Base de Informações). O campo mostra o <b>código e o nome</b> do centro logo abaixo — para conferir na hora se está certo (e avisa se o código não existe na lista). Se a planilha do mês trouxer o <b>nome</b> do centro em vez do código (ou vice-versa), o sistema resolve pela lista cadastrada e guarda sempre o <b>código</b> — mostrando o nome do lado. É <b>obrigatório apenas na contrapartida de resultado</b> (grupos 3, 4 e 5): sem ele, o banco não conclui. No arquivo do Domínio o centro de custo sai no lado da contrapartida (débito na saída, crédito na entrada).</div>
  <div class="m-rule"><span class="k">Vários arquivos no mês</span> Quando o banco já tem lançamentos, há <b>dois botões explícitos</b> — tanto no <b>card do banco</b> quanto no painel aberto: <b>Substituir arquivo</b> (troca tudo pelo novo extrato) e <b>Importar complemento</b> (soma os lançamentos de outro arquivo aos que já estão, sem apagar nada — ex.: 2º extrato para fechar o mês). Cada botão faz exatamente o que diz, sem pergunta. Dá também para <b>excluir em lote</b> as linhas selecionadas e filtrar por <b>nome da conta</b> (contém/não contém) e por <b>sem data</b>. Linhas de <b>total/subtotal</b> do relatório não sobem.</div>
</section>

<section id="m-conciliacao">
  <h2 class="m-sec">13 · Conciliação</h2>
  <p>O coração do fechamento, com farol por conta. Três tipos:</p>
  <dl class="m-kv">
    <dt>Saldo simples</dt><dd>Banco — confere o saldo do balancete com o do extrato.</dd>
    <dt>Composição</dt><dd>Clientes, estoques, fornecedores — lançamentos agrupados por entidade, em formato de razão. Itens quitados no mês somem; o card mostra Saldo × Composição × Diferença.</dd>
    <dt>Imposto</dt><dd>ICMS, PIS, COFINS — confere a baixa do mês anterior e a memória de cálculo contra o balancete.</dd>
  </dl>
  <p>Cada linha pode ser <b>justificada</b> (texto, com usuário e data) ou <b>corrigida</b>. Corrigir gera um <b>lançamento de acerto</b> (estorno/reclassificação) — que faz o saldo reconferir na hora e sobe para o Contabilizar e para o Domínio.</p>
  <div class="m-rule"><span class="k">Contas redutoras</span> Contas <b>retificadoras</b> (ex.: “(–) Depreciações Acumuladas”, PCLD, amortização) têm saldo na natureza invertida por natureza — e <b>não</b> são marcadas como “saldo credor/devedor invertido”. Vale tanto quando o próprio nome indica a redução quanto quando é a <b>sintética-mãe</b> que é redutora: a analítica <b>herda</b> a natureza da sintética.</div>
  <div class="m-rule"><span class="k">Nome está certo (o sistema aprende)</span> Quando uma linha fica em <b>“revisar”</b> só porque falta a NF (o nome já foi identificado), a coluna Conf. mostra um botão <b>“está certo”</b>: clica e o sistema registra a conferência (usuário e data), tira o “revisar” e <b>aprende</b> — esse nome vira <b>confiável</b> do cliente e <b>não pede revisão dele nos próximos meses</b>. Não precisa zerar a conta nem abrir a correção.</div>
  <div class="m-rule"><span class="k">Desvincular nomes unidos por engano</span> Se o sistema uniu dois nomes parecidos que são <b>clientes/fornecedores diferentes</b>, abra o lançamento (clique na linha) → em <b>Ajustar leitura</b> há o botão <b>“Desvincular”</b>: mantém esse nome separado dos parecidos, <b>valendo para todos os meses</b>. É uma regra do cliente, guardada no cadastro.</div>
  <div class="m-rule"><span class="k">Buscar por nome</span> Na composição de clientes/fornecedores tem um campo de <b>busca</b>: digite parte do nome e a lista mostra só os que batem — pelo nome da entidade, pelos nomes unidos ou pelo histórico dos lançamentos.</div>
  <div class="m-rule"><span class="k">Filtrar por situação</span> Cada <b>faixa de aviso</b> da composição (saldo em natureza invertida, baixa com NF sem título, nomes unificados, leitura incerta) é <b>clicável</b> — clique em “Filtrar” para ver só os clientes/fornecedores daquela situação; clique de novo (ou “Limpar filtro”) para voltar. É só filtro, para revisar a situação — não altera nada. O aviso e o filtro de <b>“leitura incerta”</b> só contam o que <b>ainda não foi tratado</b>: assim que você confere/corrige (ou confirma o nome), a linha sai da conta.</div>
  <div class="m-rule"><span class="k">Saldo inicial = razão</span> Os títulos que vieram da <b>implantação do saldo inicial</b> (linhas “Saldo anterior”) entram na composição como se fossem razão: <b>casam por NF</b> com a baixa do mês (zeram e vão para “Conciliados”) e, quando zeram <b>sem NF</b>, entram no <b>Confirmar</b> em lote igual às demais. Dá para conferir/desfazer cada um também.</div>
  <div class="m-rule"><span class="k">Ações em lote (seleção)</span> Marque vários lançamentos (checkbox) e use a barra: <b>Nome está certo</b> confirma que o sistema leu o nome certo em todos de uma vez (tira o “revisar” e <b>aprende</b>); <b>Corrigir</b> aplica o <b>nome certo</b> a todos os selecionados de uma vez — inclusive linhas de <b>saldo inicial</b> — renomeando esse cliente/fornecedor em <b>todos os meses</b> (apelido), com opção de aprender — o mesmo vale ao editar uma linha de saldo inicial individualmente (clique na linha → Ajustar leitura): dá para corrigir o <b>nome</b>, o <b>número da NF</b> e o <b>histórico</b> — fica salvo por item (vale nos próximos meses); <b>Desvincular</b> mantém os nomes marcados separados (não unir com parecidos), valendo para todos os meses; <b>Conectar (baixar)</b> baixa a nota + pagamento selecionados. Nas confirmações/correções de nome, linhas de saldo inicial/acerto podem ser ignoradas (o nome delas vem de outra origem).</div>
  <div class="m-rule"><span class="k">Conectar (baixa manual)</span> Quando o sistema não casou a nota com o pagamento sozinho (NF diferente, sem NF, ou nomes separados), <b>marque os lançamentos</b> (checkbox na primeira coluna) — pode ser em cards diferentes — e clique em <b>Conectar (baixar)</b> na barra que aparece embaixo. A barra mostra o <b>líquido</b> (se zera) e os conectados vão para <b>Conciliados</b> (dá para reabrir depois). Se <b>não zerar</b>, é <b>obrigatório</b> apontar se a diferença é <b>Desconto</b> ou <b>Juros/multa</b> e a conta — o sistema gera o lançamento de acerto (que zera a conta e vai para o Contabilizar) e só então baixa. Não dá para conectar deixando diferença solta. Linhas que já estão <b>corrigidas/conferidas</b> (mas cuja entidade ainda não zerou — ex.: saldo devedor residual) <b>também podem ser marcadas</b> e conectadas com outro lançamento: ter o nome já certo não impede a baixa manual.</div>
  <div class="m-rule"><span class="k">Confirmado sai para Conciliados</span> Ao <b>Confirmar</b> (ou quando uma entidade <b>zera e todas as linhas já estão tratadas</b> — conferido/corrigido/baixado), os lançamentos saem do “em aberto” e vão para <b>Conciliados (o que zerou)</b> — some da tela. Para rever ou desfazer, abra <b>“Conferidos neste mês”</b> (no fim da composição) e clique em <b>Reabrir</b>: eles voltam para o em aberto. A baixa automática <b>por NF</b> casa por número da nota <b>dentro de cada cliente</b> (números pequenos, como NF 64, se repetem entre fornecedores — cada par é conciliado separadamente).</div>
  <div class="m-rule"><span class="k">Confirmar em lote</span> Quando a composição de um cliente/fornecedor já <b>zerou</b> (título e baixa se compensam) e o nome está identificado, mas falta a NF (linhas em “revisar”), o card mostra o botão <b>Confirmar</b> — marca todas as linhas como conferidas de uma vez, com justificativa (usuário e data), sem abrir uma a uma. Só aparece quando o saldo zerou e não há erro de NF ou natureza invertida. No topo, uma faixa verde mostra <b>quantos</b> clientes/fornecedores estão nessa situação. Marque no <b>checkbox</b> de cada card os que quer baixar (ou use <b>“Selecionar todos”</b>), filtre com <b>“Mostrar só esses”</b> e clique em <b>“Confirmar selecionados (N)”</b> — confirma só os marcados, de uma vez. Cada linha pode ser desfeita depois.</div>
  <div class="m-rule"><span class="k">Razão vivo na prática</span> O estorno que você faz aqui aparece no débito da conta no <b>Comparativo</b> e no razão vivo — é o mesmo ajuste em todo lugar. Uma correção só existe uma vez por lançamento; para refazer, use <b>Desfazer</b>.</div>
</section>

<section id="m-comparativo">
  <h2 class="m-sec">14 · Comparativo de Movimento</h2>
  <p>Matriz conta × mês das contas de resultado (grupos 3, 4 e 5). Marca em <b>vermelho</b> quem desvia mais de <b>10% do mês anterior</b> (o primeiro mês nunca é comparado). <b>Todos os números são clicáveis</b>: abrem o razão da conta.</p>
  <ul>
    <li>A plataforma <b>aponta o provável culpado</b> da variação, com o motivo (valor fora do padrão, histórico genérico, não recorre nos meses anteriores).</li>
    <li>Por lançamento: <b>justificar</b> (tira a pendência) ou <b>corrigir</b> (reclassifica → vira lançamento).</li>
    <li>O drill-down do razão mostra o razão importado <b>e</b> as linhas de <b>AJUSTE</b> (os lançamentos feitos), fechando o total no valor vivo.</li>
    <li>Ao clicar num lançamento de despesa, dá para marcar <b>Dedutível / Indedutível</b> (LALUR). O <b>indedutível</b> vira <b>adição</b> no card do LALUR e no relatório de despesas indedutíveis — sem duplicar contas já cadastradas.</li>
  </ul>
</section>

<section id="m-contabilizar">
  <h2 class="m-sec">15 · Contabilizar</h2>
  <p>A fila central de lançamentos <span class="m-code">{data, débito, crédito, valor, histórico, origem, doc}</span>. Reúne o que veio das sugestões, das correções e do que você lança à mão (partida pelos selects do plano, ou subindo documento). O relatório de lançamentos é a auditoria do analista — <b>não há etapa de aprovação</b>.</p>
  <div class="m-rule"><span class="k">Entrega final</span> O botão <b>Gerar arquivo Domínio</b> baixa o CSV no layout exato (separador <span class="m-code">;</span>, BOM UTF-8, valor em pt-BR) pronto para importar.</div>
</section>

<section id="m-status">
  <h2 class="m-sec">16 · Status</h2>
  <p>O gate de pendências: o fechamento só libera quando zera. Vários checks clicáveis; o destaque é <b>Lançamentos banco × resultado</b> — aponta quando um banco cai direto numa conta de resultado (prefixo 3/4/5) que <b>não</b> está na lista de exceções liberadas.</p>
  <div class="m-rule stop"><span class="k">LALUR — obrigatório</span> Ao <b>justificar</b> um lançamento de despesa (classificação que começa com <span class="m-code">4</span>), é preciso classificar como <b>dedutível</b> ou <b>indedutível</b> — isso alimenta o relatório de despesas indedutíveis do LALUR.</div>
  <p>Cada apontamento tem justificar ou corrigir (reclassifica → Contabilizar). O relatório do gate sai em Excel/PDF, com as despesas indedutíveis.</p>
</section>

<section id="m-relatorios">
  <h2 class="m-sec">17 · Relatórios</h2>
  <p>A saída do fechamento: <b>Book de Composições, Relatório de Pendências, DRE, Comparativo, Balanço, DFC e Balancete</b>. Todos leem o razão vivo. Destaque para o relatório de <b>Justificativas e Correções</b> — o raio-x da competência, que consolida todas as justificativas (Comparativo, Banco × Resultado, Impostos) e todas as correções lançadas, cada uma com <b>usuário e data</b>.</p>
</section>

<section id="m-cockpit">
  <h2 class="m-sec">18 · Cockpit Financeiro</h2>
  <p>A visão gerencial para conversar com o cliente: receita, custo, despesa e resultado do mês e acumulado, DRE estruturada e a evolução no ano. Lê o <b>razão vivo</b> — a mesma fonte da Conciliação e do Comparativo — então o balanço e o resultado fecham na identidade <b>Ativo − (Passivo + PL) = Resultado acumulado</b>.</p>
  <div class="m-rule"><span class="k">Fonte única</span> Se Cockpit, Conciliação e Comparativo divergirem, é sinal de que algum ajuste não foi confirmado como lançamento — não de conta errada. Todos bebem da mesma fonte viva.</div>
</section>

<hr class="m-div">

<section id="m-regras">
  <div class="m-eyebrow">Referência</div>
  <h2 class="m-sec">19 · Regras de ouro</h2>
  <p class="m-lead">O inegociável. Em dúvida em qualquer tela, volte para estas regras.</p>
  <div class="m-card">
    <div class="m-rule"><span class="k">1 · Razão vivo</span> Relatório é razão importado <b>+</b> todos os ajustes. Correção vira <b>lançamento</b>, nunca reescreve o razão.</div>
    <div class="m-rule"><span class="k">2 · Recebido é automático</span> Documento fica “recebido” ao subir o arquivo. Não existe baixa manual.</div>
    <div class="m-rule warn"><span class="k">3 · Regra do banco</span> Pagamento/recebimento = só o que passou pela conta bancária.</div>
    <div class="m-rule stop"><span class="k">4 · LALUR</span> Justificativa de despesa (grupo 4) exige classificar dedutível/indedutível.</div>
    <div class="m-rule warn"><span class="k">5 · Vigência</span> Cadastro nunca é sobrescrito — cada mudança cria uma nova vigência.</div>
    <div class="m-rule"><span class="k">6 · Auditoria</span> Toda justificativa e correção grava <b>usuário e data</b>.</div>
    <div class="m-rule stop"><span class="k">7 · Segurança</span> A chave de serviço do Supabase nunca vai ao front nem ao Git. Só a chave pública.</div>
  </div>
</section>

<section id="m-atalhos">
  <h2 class="m-sec">20 · Dicas e atalhos</h2>
  <div class="m-grid">
    <div class="m-mod"><div class="h"><span class="ic">F4</span> Escolher conta</div><p>Em qualquer campo de conta, aperte <b>F4</b> (ou clique na lupa) para abrir o plano e buscar por código ou nome.</p></div>
    <div class="m-mod"><div class="h"><span class="ic">↯</span> Subir sem renomear</div><p>Na Importação em massa, arraste os extratos: o sistema lê CNPJ e conta. Só renomeie <span class="m-code">código-conta</span> se preferir.</p></div>
    <div class="m-mod"><div class="h"><span class="ic">◐</span> Tema</div><p>Alterna claro/escuro no rodapé do menu lateral — fica salvo no navegador.</p></div>
    <div class="m-mod"><div class="h"><span class="ic">⏱</span> Timesheet</div><p>O tempo da sessão conta no topo e zera ao trocar de empresa; o histórico fica em Tempo (Timesheet).</p></div>
    <div class="m-mod"><div class="h"><span class="ic">↺</span> Errou o arquivo?</div><p>Em Documentos, “excluir” apaga o arquivo, limpa a conciliação e volta o documento a pendente.</p></div>
    <div class="m-mod"><div class="h"><span class="ic">PDF</span> Gerar PDF</div><p>Use o botão <b>Gerar PDF</b> no topo desta tela e escolha “Salvar como PDF” na janela de impressão.</p></div>
    <div class="m-mod"><div class="h"><span class="ic">⌕</span> Buscar no manual</div><p>Manual grande? Use o campo de <b>busca</b> no topo: digite uma palavra (ex.: <span class="m-code">LALUR</span>, <span class="m-code">F4</span>) e clique no resultado para pular direto à seção.</p></div>
  </div>
  <div class="m-foot"><b>Contabilidade by Attentive</b> — Manual do Time. Documento vivo: acompanha as atualizações do sistema. Dúvida sobre regra contábil específica do Domínio: falar com o João. Decisões de produto: Fernando.</div>
</section>
`

const dobra = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

// Trecho do texto ao redor do 1º ponto onde o termo aparece, com o termo destacado.
function trecho(texto, termo) {
  const raw = String(texto || '')
  const i = dobra(raw).indexOf(dobra(termo))
  if (i < 0) return { pre: raw.slice(0, 96), hit: '', pos: raw.length > 96 ? '…' : '' }
  const ini = Math.max(0, i - 42)
  return {
    pre: (ini > 0 ? '…' : '') + raw.slice(ini, i),
    hit: raw.slice(i, i + termo.length),
    pos: raw.slice(i + termo.length, i + termo.length + 60) + (i + termo.length + 60 < raw.length ? '…' : ''),
  }
}

export default function Manual() {
  const contentRef = useRef(null)
  const [indice, setIndice] = useState([])
  const [q, setQ] = useState('')

  // Índice de busca: monta a partir das seções renderizadas (id · título · texto).
  useEffect(() => {
    const root = contentRef.current
    if (!root) return
    const itens = []
    root.querySelectorAll('section[id]').forEach(sec => {
      const tituloEl = sec.querySelector('h2.m-sec, .m-hero h1')
      const titulo = (tituloEl?.textContent || '').trim()
      const texto = (sec.textContent || '').replace(/\s+/g, ' ').trim()
      if (titulo) itens.push({ id: sec.id, titulo, texto })
    })
    setIndice(itens)
  }, [])

  const termo = q.trim()
  const resultados = useMemo(() => {
    if (termo.length < 2) return []
    const d = dobra(termo)
    return indice
      .map(it => {
        const noTitulo = dobra(it.titulo).includes(d)
        const noTexto = dobra(it.texto).includes(d)
        if (!noTitulo && !noTexto) return null
        return { ...it, score: noTitulo ? 0 : 1 }
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score)
      .slice(0, 8)
  }, [termo, indice])

  function irPara(id) {
    const el = document.getElementById(id)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    el.classList.remove('m-hit'); void el.offsetWidth; el.classList.add('m-hit')
    setQ('')
  }

  return (
    <div id="manual-root">
      <style>{CSS}</style>
      <div className="manual-actions">
        <button className="btn" onClick={() => window.print()} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <i className="ti ti-file-type-pdf" /> Gerar PDF
        </button>
        <span className="hint">Na janela de impressão, escolha <b>“Salvar como PDF”</b>.</span>
      </div>

      <div className="manual-search">
        <div className="box">
          <i className="ti ti-search ico" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar no manual (ex.: conciliação, LALUR, F4, razão vivo…)"
            onKeyDown={e => { if (e.key === 'Enter' && resultados[0]) irPara(resultados[0].id); if (e.key === 'Escape') setQ('') }} />
          {q && <i className="ti ti-x clr" title="Limpar" onClick={() => setQ('')} />}
        </div>
        {termo.length >= 2 && (
          <div className="m-res">
            {resultados.length === 0 ? (
              <div className="vazio">Nada encontrado para “{termo}”. Tente outra palavra.</div>
            ) : (
              <>
                <div className="head">{resultados.length} resultado(s) — clique para ir</div>
                {resultados.map(r => {
                  const t = trecho(r.texto, termo)
                  return (
                    <button key={r.id} onClick={() => irPara(r.id)}>
                      <span className="rt"><i className="ti ti-arrow-right tag" /> {r.titulo}</span>
                      <span className="rs">{t.pre}<mark>{t.hit}</mark>{t.pos}</span>
                    </button>
                  )
                })}
              </>
            )}
          </div>
        )}
      </div>

      <div ref={contentRef} dangerouslySetInnerHTML={{ __html: HTML }} />
    </div>
  )
}
