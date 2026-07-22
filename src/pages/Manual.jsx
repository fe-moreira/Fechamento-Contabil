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
      <li><a href="#m-massa"><span class="n">05</span> Ações em Massa</a></li>
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
  <div class="m-rule"><span class="k">Nova versão do sistema</span> Quando publicamos uma atualização, quem está com o sistema <b>já aberto</b> continua na versão antiga até recarregar a página. Agora aparece um aviso <b>"Saiu uma versão nova — Atualizar agora"</b> no rodapé assim que um deploy novo é detectado (ao voltar para a aba ou a cada poucos minutos); clique nele para pegar as últimas melhorias. Não recarrega sozinho para não atrapalhar um preenchimento em andamento. Ao atualizar (ou dar F5), a <b>Integração reabre sozinha o banco</b> que você estava conferindo — inclusive o <b>cruzamento</b>, se estava aberto — para você não refazer o caminho.</div>
  <div class="m-rule"><span class="k">Campos de conta e centro de custo (F4 + nome)</span> Em <b>todo</b> campo de conta contábil ou centro de custo — carga inicial (digitação manual), Outras Contabilizações, Conciliação (novo lançamento e correções), Sugestões, Contabilizar, Integração — aperte <b>F4</b> (ou clique na lupa) para buscar no plano/lista por código ou nome. Ao escolher, o <b>nome</b> da conta/centro aparece logo abaixo do campo, para conferir se está certo na hora.</div>
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
  <div class="m-rule"><span class="k">Trava do arquivo × empresa (matriz + filiais consolidadas)</span> Na importação, o sistema confere se o <b>código do Domínio</b> da empresa aparece no <b>nome</b> ou no <b>conteúdo</b> do arquivo — para não subir arquivo de uma empresa em outra. Numa <b>matriz</b>, ele aceita também os arquivos das <b>filiais marcadas como “Consolidado”</b> que apontam para o código dela (o fechamento consolidado da filial entra na matriz). Filial com <b>Tipo de fechamento = Individualizado</b> fecha sozinha e <b>não</b> libera o arquivo na matriz.</div>
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
  <div class="m-rule"><span class="k">Editar conta importada</span> Nas <b>Contas já cadastradas</b> (inclusive as que vieram por <b>planilha</b>), cada conta tem um <b>lápis</b> para editar <b>código, classificação, nome</b> e <b>tipo (sintética/analítica)</b> direto na carga atual — sem precisar reimportar tudo. No plano de contas, a linha mostra se a conta é <b>sintética</b> (soma as analíticas) ou <b>analítica</b>.</div>
  <div class="m-rule"><span class="k">Importar planilha</span> O botão <b>Importar planilha</b> abre o seletor de arquivo direto (ou arraste no campo). O plano é lido pela <b>hierarquia real</b> da classificação (por prefixo) — as sintéticas somam as analíticas mesmo quando a largura dos níveis é irregular entre formatos de plano diferentes.</div>
  <div class="m-rule"><span class="k">Ajustar colunas do plano (quando a detecção erra)</span> Na prévia <b>Confira antes de importar</b>, o plano mostra quantas <b>contas foram reconhecidas</b>. Se o sistema ficar <b>em dúvida</b> (não achou a Classificação, ou reconheceu poucas contas) — ou se você <b>não concordar</b> com o que ele entendeu — clique em <b>Ajustar colunas</b> e indique, num seletor, qual coluna do <b>seu</b> arquivo é a <b>Classificação</b> (obrigatória), o <b>Código reduzido</b>, o <b>Nome</b>, o <b>Tipo (S/A)</b> e a <b>Máscara</b>. A contagem de contas reconhecidas atualiza na hora; quando ficar certo, é só <b>Confirmar</b>. Assim qualquer formato de plano sobe certo, mesmo com nomes de coluna diferentes.</div>
  <div class="m-rule"><span class="k">Qual conta vai em cada bloco (ⓘ)</span> Cada bloco da carga inicial tem um <b>ícone de informação</b> que explica o que entra nele: <b>1 · Saldos de abertura</b> — contas que <b>só precisam do saldo</b> (bancos, aplicações, capital social, reservas, empréstimos, impostos a recolher, imobilizado…); <b>2 · Clientes e fornecedores</b> — contas <b>por entidade, com NF</b> (clientes, fornecedores, adiantamento de clientes/fornecedores e venda futura), um título por linha; <b>3 · Outras contas com composição</b> — <b>todas as demais</b>, com composição <b>sem NF</b> (adiantamentos diversos, provisões, empréstimos a sócios…), onde o “quem” é o histórico.</div>
  <div class="m-rule"><span class="k">Carga inicial — vários arquivos, sem fundir</span> Na <b>Carga inicial de saldos</b> você pode subir <b>vários arquivos no mesmo bloco</b> (ex.: fornecedores em duas planilhas). Ao subir um 2º arquivo num bloco que já tem dados, escolha <b>Complementar</b> (adiciona <b>sem fundir</b> — cada arquivo continua separado) ou <b>Substituir</b> (troca tudo). Cada linha guarda de <b>qual arquivo</b> veio.</div>
  <div class="m-rule"><span class="k">Saldo inicial soma TODAS as fontes</span> O saldo/composição de abertura de uma conta é a <b>soma de todas as cargas iniciais</b> daquele cliente: o que veio da <b>Base de Informações</b> (planilhas + <b>complementos digitados</b>) <b>mais</b> o que foi enviado pelo <b>contrato</b> (ex.: saldo inicial do seguro em Outras Contabilizações) <b>mais</b> matriz/filiais. Então, se você subiu o saldo pelo contrato e depois digitou um <b>complemento</b> na carga inicial para acertar um errinho, os dois <b>somam</b> — a conta lê o saldo inicial completo.</div>
  <div class="m-rule"><span class="k">Carga inicial — excluir um arquivo por vez</span> Como os arquivos não são fundidos, dá para <b>excluir um de cada vez</b> sem perder os outros. Na lista <b>Carga inicial de saldos</b> (base do cliente) aparece <b>cada arquivo</b> que subiu, com a quantidade de linhas e o botão <b>excluir</b> (tira só as linhas daquele arquivo). Dentro do modal, cada arquivo do bloco também tem uma <b>lixeira</b> própria. Arquivos antigos (subidos antes desta melhoria) aparecem como um só — nesse caso o excluir apaga a carga inteira; refaça subindo os arquivos de novo para tê-los separados.</div>
  <div class="m-rule"><span class="k">Excluir o saldo inicial (para re-subir)</span> Se precisar <b>refazer</b> o saldo inicial, o botão <b>Excluir saldo inicial (tudo)</b> apaga toda a carga inicial (saldos + composições, todos os arquivos) para você <b>subir de novo</b>. Ele existe em <b>dois lugares</b>: em <b>Base de Informações</b> (na lista de Carga inicial de saldos) e um atalho na <b>Conciliação</b> (barra de faróis). <b>Trava por período:</b> só libera se a <b>competência de abertura</b> do cliente <b>não</b> estiver fechada — se estiver, o botão fica bloqueado (<i>cadeado</i>) com o aviso para <b>reabrir a abertura</b> antes. A exclusão registra <b>usuário e data</b> na auditoria.</div>
  <div class="m-rule"><span class="k">Carga inicial — digitar / editar à mão</span> Cada um dos três blocos (saldos, clientes/fornecedores, outras contas) tem os botões <b>Arquivo</b> (subir planilha) e <b>Digitar / editar</b>. No modo digitar você <b>implanta o saldo inicial à mão</b> (uma linha por item, com <b>Adicionar linha</b> e o botão <b>Excluir</b> em cada linha — pede confirmação quando a linha já tem dados) — ou <b>corrige o que veio de um arquivo</b>: suba a planilha, mude para <b>Digitar / editar</b> e ajuste ou <b>exclua</b> linha a linha. Na lista da base, o botão <b>editar</b> reabre a carga para ajustar. Ao informar o código, o <b>nome</b> vem do plano de contas.</div>
</section>

<section id="m-massa">
  <h2 class="m-sec">05 · Ações em Massa</h2>
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
  <h3><span class="m-dot db"></span> Folha em massa</h3>
  <p>Um único relatório de rubricas do Domínio traz <b>várias empresas</b> (coluna A = código no Domínio). Em vez de subir a folha empresa por empresa na Integração, suba <b>o arquivo inteiro aqui</b>: escolha o <b>tipo</b> (Folha mensal, Adiantamento, 13º Adiantamento, Folha Complementar ou Participação de Lucros) e a competência, e o sistema <b>quebra por empresa</b> e joga a folha na Integração de cada cliente.</p>
  <div class="m-rule"><span class="k">Como casa e roteia</span> Cada empresa é casada pelo <b>código do Domínio</b> (CNPJ de reserva). O destino segue o cadastro: <b>filial "Consolidado"</b> tem a folha <b>somada na matriz</b>; empresa <b>"Individualizado"</b> (ou matriz) recebe a sua própria. Antes de gravar, uma <b>tela de conferência</b> mostra cada destino (com o total e quantas rubricas), quem <b>consolida em quem</b>, e o que não entrou: empresa <b>sem cadastro</b>, filial <b>sem matriz cadastrada</b> ou linha <b>sem rubrica</b>. Na hora de gravar você escolhe <b>Complementar</b> (soma ao que já existe) ou <b>Substituir</b>. Há também a opção (ligada por padrão) de <b>marcar os outros tipos opcionais vazios como "sem movimento"</b> — assim, subindo só a folha, o adiantamento/13º/complementar/PLR já ficam resolvidos nas empresas do envio (a folha mensal nunca é marcada; subir aquele tipo depois substitui o "sem movimento"). Para os arquivos que já estavam lá (subidos antes dessa opção), o botão <b>"Marcar vazios sem movimento"</b> aplica isso de forma <b>retroativa</b>: em todas as empresas da competência que já têm folha mensal, marca os tipos opcionais vazios como sem movimento de uma vez. O botão <b>"Revalidar folha (verde só se bate)"</b> recalcula o cruzamento com o razão de <b>todas as empresas</b> da competência e deixa a integração <b>verde só onde as rubricas batem</b> — o resto volta a pendente. Serve para consertar o verde que ficou preso de uploads antigos (que validavam só por ter subido o arquivo), sem abrir empresa por empresa. Como o razão não é cruzado aqui, a folha fica <b>pendente</b> até validar na tela por cliente. Competências <b>fechadas</b> são puladas.</div>
  <div class="m-rule"><span class="k">Envios — conferir e desfazer</span> O botão <b>Envios de MM/AAAA</b> lista cada arquivo que você subiu em massa naquela competência (nome, data, tipo, quantas empresas e rubricas). Se subiu algo errado, o <b>excluir</b> tira aquele arquivo <b>de todas as empresas de uma vez</b> — as rubricas dele saem, o resto continua. Arquivos subidos <b>antes desta versão</b> (sem o carimbo de origem) também aparecem, agrupados pelo nome do arquivo, e podem ser excluídos do mesmo jeito. Também dá para excluir arquivo por arquivo dentro de cada empresa, na Integração › Folha.</div>
  <h3><span class="m-dot db"></span> Distribuição de Lucros / JCP</h3>
  <p>Na tela <b>Relatórios em massa</b>, gera o relatório de <b>Distribuição de Lucros</b> de <b>todas as empresas</b> de uma vez. Cada empresa sai com <b>dois blocos</b>, ambos <b>por sócio</b> (com a <b>conta contábil</b> numa coluna do lado do nome, a <b>data de cada distribuição</b>, subtotal por sócio e total do bloco): <b>1 · Distribuição Normal (do período)</b> — os lançamentos do razão nas <b>contas observadas</b>, casados ao sócio pela identificação; e <b>2 · Distribuição da Ata (Lucros Apurados até 2025)</b> — os pagamentos registrados em <b>ata</b>. Entram as distribuições cuja <b>data</b> cai no período, em ordem de data. O cabeçalho traz <b>Código + Nome + CNPJ</b>.</p>
  <div class="m-rule"><span class="k">Período (com Personalizado)</span> Escolha <b>Mensal</b>, <b>Trimestral</b>, <b>Semestral</b>, <b>Anual</b> ou <b>Personalizado</b> (você informa a <b>data de início e fim</b> que quiser). Vale para os dois blocos — só entram as distribuições com data dentro do período.</div>
  <div class="m-rule"><span class="k">Saída: zip ou relatório único</span> Você escolhe: <b>um PDF por empresa</b> (baixados num <b>.zip</b>) ou um <b>relatório único</b> com todas as empresas juntas (uma por página) num único PDF.</div>
  <div class="m-rule"><span class="k">Nome do arquivo</span> No modo por empresa: <b>Código - Nome da Empresa - «Período» - Distribuição de Lucros.pdf</b>. O período nomeia o arquivo: <b>01.2026</b> (mês), <b>1T2026</b> (trimestre), <b>1S2026</b> (semestre), <b>2026</b> (ano) ou <b>01.01.2026 a 30.06.2026</b> (personalizado). O <b>CPF</b> vem do cadastro em <b>Base de Informações → Distribuição de Lucros</b>.</div>
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
  <div class="m-rule"><span class="k">Progresso %</span> O <b>Progresso</b> do card mede quantos <b>gates do Status</b> já estão sem pendência (razão, conciliação, variações, banco × resultado, etc.). É <b>recalculado automaticamente ao abrir a lista de Fechamentos</b> de qualquer cliente (não precisa entrar no Status de cada um) e também ao abrir/atualizar o Status — conforme você resolve pendências, a porcentagem sobe; <b>fechado</b> fica 100%. O valor é salvo e reaproveitado no <b>Dashboard</b>.</div>
  <div class="m-rule"><span class="k">100% = verde</span> Ao chegar a <b>100%</b> (todos os gates OK), o card fica <b>verde “Concluído”</b> e passa a contar em <b>Fechados</b> no resumo e no <b>Dashboard</b>, mesmo antes de você clicar em <b>Encerrar fechamento</b>. Encerrar continua sendo o passo formal (trava a competência para edição).</div>
  <div class="m-rule"><span class="k">Botões no card (Encerrar / Reabrir)</span> Na lista de <b>Fechamentos</b>, cada card mostra a ação direto. O card <b>Concluído (100%)</b> tem o botão <b>Encerrar</b>: clica, <b>pergunta se tem certeza</b> e, confirmando, a competência fica <b>verde “Encerrado”</b> (somente leitura) na hora. O card <b>Encerrado</b> ganha o botão <b>Reabrir</b> (só <b>administrador</b>): clica, <b>pergunta se tem certeza</b> e, confirmando, volta a ficar <b>aberta</b> para edição. Tudo no próprio card, sem telas extras. Clicar no corpo do card sempre <b>abre</b> a competência (a encerrada abre em somente leitura). <i>(No Status também existe o “Encerrar fechamento” com a conferência do balancete, para quem quiser esse passo extra antes de encerrar.)</i></div>
  <div class="m-rule"><span class="k">Conferir o balancete (Excel ou PDF) e exportar</span> No bloco <b>“Arquivo para importação no Domínio”</b> há três botões. <b>Importar balancete (Excel/PDF)</b> — sobe o balancete exportado do Domínio, em <b>Excel</b> (.xlsx/.xls/.csv) <b>ou PDF</b>, e <b>confere conta a conta</b> com o que a plataforma calculou (razão vivo + correções). Se <b>bater</b>, libera o encerramento; se <b>não bater</b>, mostra uma tabela com <b>exatamente as contas divergentes</b> (Conciliação × Balancete × Diferença) para você achar e corrigir. <b>Exportar balancete</b> — baixa em Excel o balancete <b>que a plataforma está considerando</b> (para conferir de fora ou usar de base). <b>Gerar arquivo</b> — gera o arquivo de lançamentos (estornos/correções) para subir no Domínio. <i>(A leitura de PDF é por heurística do layout do Domínio; se um PDF específico não for reconhecido, use o Excel.)</i></div>
  <div class="m-rule warn"><span class="k">Somente leitura</span> Fechamento marcado como <b>fechado</b> fica <b>travado em toda a plataforma</b> (bloqueio no banco): aparece uma <b>faixa de “somente leitura”</b> no topo e <b>nenhuma alteração é permitida</b> (conciliação, correção, integração, contabilização, documentos…) enquanto estiver fechado. Ações em massa também pulam competências fechadas.</div>
  <div class="m-rule"><span class="k">Reabrir</span> Ao <b>clicar num fechamento fechado</b> na lista, a plataforma pergunta se você quer <b>Reabrir</b> (volta a editar) ou <b>só visualizar</b>. Reabrir é uma ação de <b>administrador</b>.</div>
  <div class="m-rule stop"><span class="k">Excluir (com motivo)</span> Excluir um fechamento é <b>só do administrador</b> e <b>exige escrever o motivo</b> — que fica <b>registrado com usuário e data</b>. Apaga a competência e todos os dados dela (razão, balancete, lançamentos, auditoria, conciliação). Se estiver fechada, a exclusão reabre automaticamente antes de apagar.</div>
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
  <div class="m-rule"><span class="k">Saldo do extrato: amarelo × automático</span> Ao subir um <b>extrato PDF</b>, o sistema lê o saldo e avisa <b>como</b> leu: se você <b>pintou de amarelo</b> os saldos (destaque), ele mostra “saldo = <b>SOMA</b> de N valores destacados” — use isso quando o saldo é a <b>soma de vários</b> (ex.: extrato de investimento com vários CDBs). Se não achar amarelo, lê <b>automaticamente</b> e avisa “saldo lido AUTOMATICAMENTE — confira”: nesse caso ele pega <b>um</b> saldo (o mais provável), então, se precisava somar vários, <b>pinte-os de amarelo e suba de novo</b>. Importante: o amarelo precisa ser um <b>destaque de verdade</b> (anotação Highlight) sobre o texto — PDF “achatado”/impresso ou escaneado não tem o destaque legível e cai no automático. Não precisa cobrir o número inteiro com precisão: <b>basta o grifo tocar/sobrepor o valor</b> (mesmo parcialmente) que ele é somado.</div>
</section>

<section id="m-razao">
  <h2 class="m-sec">09 · Importar Razão</h2>
  <p>Traz o razão exportado do Domínio (Excel). É a <b>base de tudo</b>: dele saem o balancete, o comparativo e as conciliações. O código da conta é lido <b>exatamente como vem no arquivo</b> (o <b>código reduzido</b> do Domínio, sem pontos) — e é ele que identifica cada conta e casa com o plano e com o saldo inicial. As sintéticas (totais) são montadas por prefixo da <b>classificação</b>. Para clientes que entram no meio do ano, dá para importar os <b>meses anteriores</b> num arquivo único, lá no Comparativo (dá histórico para a régua de variação). Essa importação <b>confere a empresa do arquivo</b> (código Domínio / matriz-filial) para não misturar com outra, e <b>sempre pergunta</b> se é para <b>substituir</b> ou <b>complementar</b> (matriz + filiais).</p>
  <div class="m-rule"><span class="k">Código reduzido é a identidade</span> Várias contas analíticas podem dividir a mesma classificação (ex.: todos os bancos, ou vários custos no mesmo grupo). O que separa uma da outra é o <b>código reduzido</b> (ex.: Itaú 11202 ≠ Bradesco 11201) — por isso o razão é lido por ele, sem máscara/pontos. Se você já tinha razão importado com pontos, <b>reimporte</b> o mesmo arquivo para atualizar.</div>
  <div class="m-rule"><span class="k">Trava: o arquivo precisa ser da empresa (código no nome ou no conteúdo)</span> Para <b>não importar o arquivo de uma empresa em outra</b> (muitos arquivos do Domínio não trazem o CNPJ), toda importação de <b>dados da empresa</b> confere o <b>código da empresa</b> (o código do Domínio). Para <b>razão, fiscal, folha, patrimônio, plano de contas e saldo inicial</b>, o sistema procura o código no <b>nome</b> <b>ou</b> no <b>conteúdo</b> do arquivo (o código costuma vir no cabeçalho do relatório) — se não achar em nenhum dos dois, <b>bloqueia</b> e pede para conferir/renomear. Para o <b>financeiro</b> (extrato bancário), que vem do <b>banco</b> e não traz o código do Domínio dentro, a conferência é <b>só pelo nome</b> do arquivo (ex.: <b>“1181 extrato safra.xlsx”</b>). <b>Matriz e filiais:</b> quando a empresa é <b>matriz</b>, também valem os códigos das <b>filiais</b> — o consolidado da filial pode ser importado na matriz. O código é reconhecido como número (com ou sem zeros à esquerda). Importações <b>multiempresa</b> (por CNPJ) e <b>documentos anexos</b> (contratos, atas) não entram nessa trava.</div>
  <div class="m-rule"><span class="k">Vários arquivos — matriz + filiais (substituir × complementar)</span> Quando a competência <b>já tem</b> razão e você importa <b>outro</b> arquivo, a tela pergunta <b>Substituir</b> (troca tudo pelo novo) ou <b>Complementar</b> — que <b>soma</b> as linhas do novo arquivo às que já estavam, <b>sem apagar</b> nem fundir (cada arquivo continua separado, como na implantação do saldo inicial). É o caminho para empresas com <b>matriz e filiais</b>: cada estabelecimento tem seu razão. A tela lista <b>todos os arquivos</b> importados, com quantas linhas cada um trouxe, um botão para <b>extrair (baixar)</b> o original e um para <b>excluir só aquele</b> — ao excluir, o razão é <b>reconstruído</b> com os que sobraram. O balancete, o comparativo e a <b>conciliação</b> sempre leem a <b>união</b> dos arquivos ativos (a conciliação enxerga os dois razões automaticamente; não precisa saber de qual arquivo veio cada lançamento).</div>
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
  <div class="m-rule"><span class="k">Clique na linha para ver/editar</span> Em <b>Seguro</b> e <b>Despesa a Apropriar</b>, clicar em <b>qualquer linha</b> da lista (ou no botão <b>Editar</b>) abre o cadastro <b>já preenchido</b> com aquele registro — você confere/ajusta como ele foi cadastrado sem precisar procurar. Os botões de ação da linha (Apropriações, Apropriar, Saldo inicial, excluir) continuam funcionando normalmente.</div>
  <div class="m-rule"><span class="k">Apropriação: uma vez por mês + estorno</span> Cada contrato só apropria <b>uma vez</b> na competência. Depois de lançada, aparece o selo <b>Apropriado</b> e o botão vira <b>Estornar</b> — não dá mais para lançar de novo por cima (evita a duplicidade). Se precisar refazer, clique em <b>Estornar</b> (exclui o lançamento do Status → Domínio) e apropria de novo.</div>
  <div class="m-rule"><span class="k">Saldo inicial pelo cronograma</span> O botão <b>Saldo inicial</b> calcula o que <b>falta apropriar na abertura</b> do cliente pelo <b>mesmo cronograma</b> mostrado em <b>Apropriações</b> (respeita o método <b>“por dia”</b>) — é o valor “a apropriar após” do último mês antes da abertura. Esse valor vai para a <b>carga inicial</b> (Base de Informações) datado no último dia do mês anterior à competência de início, <b>na Conta a apropriar / ativo</b>.</div>
  <div class="m-rule"><span class="k">Complemento da abertura entra no saldo (a composição manda)</span> Na <b>abertura</b>, o saldo inicial de cada conta é a <b>soma dos itens da composição</b> (contrato <b>+ complementos + correções</b>) — é ela que <b>manda</b> quando a conta aparece nos dois blocos (saldos e composição). Assim, quando você lança um <b>complemento</b> na composição para bater o saldo (ex.: seguro/despesa a apropriar), ele <b>entra na conta</b> — no balancete e no razão da Conciliação (as linhas “Saldo anterior” somam ao saldo do mês e arrastam para os meses seguintes). O bloco de <b>saldos</b> serve de fallback só para contas que vieram <b>sem</b> composição itemizada. Em carga consistente (composição = saldo) nada muda; só corrige as que divergem.</div>
  <div class="m-rule warn"><span class="k">Preencha a “Conta a apropriar / ativo”</span> É a conta (ativo) que recebe o saldo de abertura e a contrapartida da apropriação. <b>Sem ela, a apropriação do mês e o Saldo inicial não sobem</b> — o contrato mostra o aviso <b>“Falta a conta a apropriar”</b> na lista. Edite o contrato e informe a conta (F4).</div>
  <div class="m-grid">
    <div class="m-mod"><div class="h"><span class="ic">PD</span> PER/DCOMP</div><p>Crédito e compensação — a declaração que o time fiscal faz. Registra o crédito e o abatimento.</p></div>
    <div class="m-mod"><div class="h"><span class="ic">%</span> JSCP</div><p>Juros sobre capital próprio, com os campos da planilha real. IRRF padrão <b>17,5%</b> (alíquota vigente em 2026).</p></div>
    <div class="m-mod"><div class="h"><span class="ic">LR</span> LALUR</div><p>Só para <b>Lucro Real</b>. Puxa o resultado acumulado do Comparativo, aplica adições/exclusões e prejuízo (limite 30%) e calcula <b>IRPJ 15% + adicional 10%</b> (acima de R$ 20 mil/mês) <b>+ CSLL 9%</b>. Anual (acumula no ano) ou Trimestral. Usa o Cadastro do Lucro Real e contabiliza a provisão.</p></div>
    <div class="m-mod"><div class="h"><span class="ic">RD</span> Receitas Diferidas</div><p>Faturamento reconhecido aos poucos (<b>baixa manual</b>). Você informa quanto reconhecer no mês e gera a <b>receita</b> (D receita diferida / C receita) e os impostos <b>PIS/COFINS/ISS</b> proporcionais (D despesa / C imposto diferido). Mostra faturamento, reconhecido e saldo.</p></div>
  </div>
  <div class="m-rule"><span class="k">Cartão de Crédito</span> Funciona como a <b>integração financeira</b>, para a fatura do cartão. Cadastre os <b>cartões do cliente</b> (nome + <b>conta a pagar</b> — pode ter vários). Depois, no cartão escolhido, <b>importe a fatura em Excel</b> (lê Data · Estabelecimento · Valor, com <b>perfil de leitura salvo por cartão</b> e arrasto de data) ou <b>lance manual</b>. Cada gasto é <b>classificado pela memória</b> (estabelecimento → conta de despesa) — verde/amarelo/vermelho — e você ajusta com <b>F4</b>, <b>aplica conta em lote</b> nas selecionadas e <b>exclui</b> o que não vai. Salva sozinho (rascunho). Ao <b>Concluir</b>, a <b>memória aprende</b> (mês que vem a mesma loja já vem classificada) e o sistema <b>gera os lançamentos</b> (<b>D</b> conta de despesa · <b>C</b> conta do cartão a pagar) na fila do <b>Status → Domínio</b>. Concluído trava; dá para <b>Reabrir</b> (ao concluir de novo os lançamentos são regerados). O <b>pagamento</b> da fatura (baixa do cartão a pagar quando sai do banco) continua na <b>conciliação/financeira</b>. <i>(Leitura de PDF entra numa próxima etapa; por ora, Excel.)</i></div>
  <div class="m-rule"><span class="k">Lançamento avulso — lançar vários e ver tudo</span> Na aba <b>Outros Lançamentos</b> você escreve a partida (data · débito · crédito · valor · histórico) e gera. Ao gerar, o <b>formulário limpa sozinho</b> (mantém a data) para você lançar o próximo <b>sem sair da tela</b>. Abaixo, a lista <b>Lançamentos gerados nesta competência</b> mostra <b>tudo</b> que foi contabilizado no fechamento (de todas as abas), com a <b>origem</b> de cada um — e dá para <b>excluir</b> o que estiver errado (sai do Status → Domínio e da conciliação).</div>
</section>

<section id="m-integracao">
  <h2 class="m-sec">12 · Integração Financeira</h2>
  <p>Pipeline <b>pré-razão</b>, separado do Contabilizar. Importa o extrato/planilha do cliente e separa em dois baldes: <b>contabilizado automaticamente</b> e <b>não identificado</b>. Usa o perfil de leitura e a memória do cliente para classificar e sugerir a partida. Ao final, gera o arquivo financeiro no layout do Domínio.</p>
  <div class="m-rule"><span class="k">Quando se aplica</span> Só para clientes marcados com <b>integração financeira = Excel</b>. O extrato Excel subido em massa já cai aqui como rascunho, com os lançamentos sugeridos.</div>
  <div class="m-rule"><span class="k">Data que arrasta + filtro por valor + data em lote</span> Quando o relatório traz a <b>data só na 1ª linha do dia</b> (às vezes numa célula <b>mesclada</b>) e as seguintes vêm em branco, o sistema <b>herda a última data</b> (arrasta para baixo) na importação — sem transformar linha de total em lançamento. Para o que <b>já está na tela</b> sem data, o botão <b>Arrastar datas</b> preenche as datas em branco com a anterior de uma vez. Nos filtros dá para procurar por <b>valor</b> (aceita <b>1.200,00</b> ou <b>1200</b>), além de histórico, data, conta e nome. E para os lançamentos que subiram <b>sem data</b>: filtre por <b>Sem data</b>, <b>selecione</b> as linhas e use o campo de <b>data → Data (n)</b> para preencher/alterar a data <b>em lote</b> (recruza o extrato na hora). Do mesmo jeito já existia o <b>aplicar conta em lote</b> e o <b>excluir em lote</b>.</div>
  <div class="m-rule warn"><span class="k">Perfil de leitura — 1ª vez, por banco</span> O perfil é <b>por banco</b> (cada conta contábil tem o seu): um cliente com Itaú e Bradesco, por exemplo, exporta layouts diferentes, então cada banco guarda seu próprio mapeamento. Para cada banco, a <b>primeira</b> importação é feita <b>aqui na Integração</b>: o sistema mostra o mapeamento das colunas (Data · Valor · Histórico · D/C) — confira em <b>“Ajustar leitura”</b> e salve. Isso grava o <b>perfil daquele banco</b>. A partir daí, subir o Excel daquele banco (individual ou em massa) já classifica sozinho. Sem o perfil do banco, o upload marca o documento como recebido mas <b>não</b> alimenta a Integração — e avisa que falta configurar o perfil. Depois de importado, dá para <b>“Ajustar leitura” no próprio arquivo já importado</b> (o extrato fica guardado com o rascunho) — muda o mapeamento e atualiza, sem precisar subir o arquivo de novo.</div>
  <div class="m-rule"><span class="k">Centro de custo</span> Para clientes que usam centro de custo, a grade ganha a coluna <b>C. Custo</b>. O valor vem da <b>planilha do mês</b> (mapeie a coluna em “Ajustar leitura” → Centro de Custo) e <b>não</b> entra na memória — se vier vazio, você preenche à mão (digite ou aperte <b>F4</b> para buscar na lista de centros de custo cadastrada em Base de Informações). O campo mostra o <b>código e o nome</b> do centro logo abaixo — para conferir na hora se está certo (e avisa se o código não existe na lista). Se a planilha do mês trouxer o <b>nome</b> do centro em vez do código (ou vice-versa), o sistema resolve pela lista cadastrada e guarda sempre o <b>código</b> — mostrando o nome do lado. É <b>obrigatório apenas na contrapartida de resultado</b> (grupos 3, 4 e 5): sem ele, o banco não conclui. No arquivo do Domínio o centro de custo sai no lado da contrapartida (débito na saída, crédito na entrada).</div>
  <div class="m-rule"><span class="k">Cruzar com o extrato (Importado × Extrato)</span> Depois de classificar, clique em <b>Achar diferença por dia</b> e suba o <b>extrato do banco</b>. O sistema tenta achar sozinho as colunas <b>Data</b> e <b>Saldo</b>; se o layout for diferente, abre <b>Ajustar colunas</b> — você escolhe qual coluna é a Data, o Saldo e (opcional) o <b>Valor/movimento</b>, e isso fica <b>salvo por banco</b> (mês que vem lê sozinho). Se o extrato só tiver a coluna de <b>Saldo</b> (sem Valor), o movimento de cada linha é <b>derivado da variação do saldo</b> — o confronto lado a lado funciona igual. Cruzamentos feitos numa <b>versão anterior</b> aparecem no formato antigo: clique em <b>Trocar extrato</b> e suba de novo para ver o confronto novo. O cruzamento mostra, dia a dia, duas colunas <b>Importado</b> × <b>Extrato</b> (saldo e, se mapeado, o movimento) e aponta a <b>diferença do dia</b>; abrindo um dia, confronta <b>lançamento a lançamento</b> lado a lado. O pareamento é <b>inteligente</b>: casa o <b>exato</b>, reconhece quando a <b>soma de vários</b> lançamentos bate com <b>um</b> movimento do extrato (ex.: dois pagamentos = uma remessa — marca <b>soma ✓</b>), e casa os <b>quase-iguais</b> (diferença de centavos). Tem uma coluna <b>Diferença</b> à direita que mostra, em cada par, o quanto sobrou: <b>✓</b> quando bate (inclusive na soma), o valor em <b>amarelo</b> quando é só de centavos, e em <b>vermelho ⚠</b> quando sobrou de verdade de um lado (é a diferença real). Lançamentos que <b>se anulam entre si</b> (um <b>+X</b> e um <b>−X</b> sem nada no extrato — típico de lançamento errado + estorno) são reconhecidos como <b>efeito zero</b> e saem do confronto, resumidos num rodapé, para não poluir. No topo do dia mostra os <b>totais</b> (Importado, Extrato e a Diferença), para bater de relance. <b>Descobrir E corrigir na hora:</b> quando um valor está no extrato num dia mas o financeiro classificou <b>noutro dia</b> (data lançada errada), aparece um aviso <b>"Provável data trocada"</b> com o botão <b>Corrigir data →</b> que move o lançamento para o dia certo com um clique. E em cada lançamento do confronto há os ícones <b>✏️ Editar</b> (mudar data, valor, Entrada/Saída, histórico ou contrapartida) e <b>🗑 Excluir</b> — se você identificar um lançamento a mais (ex.: lançado e estornado), exclui direto ali. <b>Qualquer edição, exclusão ou correção de data recruza na hora</b>: os totais, a <b>diferença do dia</b> e a tabela se atualizam sozinhos e o <b>dia some assim que zera</b>, sem sair da tela — funciona inclusive depois de reabrir o banco (o lado do extrato fica guardado no cruzamento). Dá para reabrir em <b>Ver cruzamento</b> e trocar o mapeamento em <b>Ajustar colunas</b>. <b>Exportar cruzamento (Excel p/ cliente):</b> gera uma planilha <b>no papel timbrado</b> da Attentive, no mesmo formato da tela — <b>Importado × Extrato lado a lado</b>, com a coluna <b>Diferença/situação</b> (bate, soma, centavos ou SEM PAR) e um bloco por dia com o total do dia, além das <b>possíveis datas trocadas</b> — pronta para enviar ao cliente.</div>
  <div class="m-rule"><span class="k">Folha — relatórios de rubricas</span> Na aba <b>Folha</b>, importe os relatórios de rubricas do Domínio (colunas V/W/Z) — o sistema cruza cada rubrica com o razão e mostra a diferença. Há cards para <b>Folha mensal</b> (único obrigatório), <b>Adiantamento</b>, <b>13º Adiantamento</b>, <b>Folha Complementar</b> e <b>Participação de Lucros</b>. Todos os rendimentos importados são <b>somados por rubrica</b> antes de cruzar. A aba <b>Folha</b> só fica <b>verde (validada)</b> quando o razão está <b>cruzado e batendo</b> — toda rubrica bate com a contabilidade ou foi justificada; só ter subido o arquivo não valida (fica pendente até conferir). Atualiza sozinho quando o razão muda. Os cards além da folha mensal são <b>opcionais</b>: se não houve no mês, marque <b>Sem movimento</b>; se houve, importe o relatório. <b>Vários arquivos por tipo:</b> ao <b>Subir outro</b> arquivo do mesmo tipo, o sistema pergunta se é para <b>Substituir</b> ou <b>Complementar</b> (soma sem apagar o anterior) — igual à carga inicial de saldos. Cada arquivo do tipo aparece <b>listado</b> no card, com a data, quantas rubricas trouxe, um botão para <b>baixar</b> e um para <b>excluir só aquele arquivo</b> (as rubricas dele saem do total, os outros continuam). <b>Limpar tudo</b> remove todos os arquivos do tipo. <b>Reclassificação não conta em dobro:</b> o cruzamento soma o razão do Domínio mais as contabilizações da folha, mas <b>ignora as correções/reclassificações</b> (lançamentos de acerto que só <b>mudam a conta</b>) — assim, corrigir a conta de uma rubrica <b>não</b> faz o valor do razão aparecer dobrado nem reabre a folha. <b>Leitura robusta da rubrica no razão:</b> o número da rubrica é lido logo após “VALOR REF.” <b>mesmo sem o traço</b> depois do número (alguns históricos do Domínio vêm sem o “-”). E quando o razão <b>reutiliza o mesmo número</b> para rubricas diferentes (ex.: “REF. 23” em F.G.T.S de rescisão e em INSS de terceiros), o cruzamento casa pela do <b>mesmo nome</b> da folha — não soma tudo junto.</div>
  <div class="m-rule"><span class="k">Fiscal — matriz + filiais (substituir × complementar)</span> Na aba <b>Fiscal</b>, cada tipo (<b>Entradas</b>, <b>Saídas</b>, <b>Serviços</b>) cruza o acumulador do Domínio com o razão. Quando o tipo <b>já tem</b> arquivo e você importa <b>outro</b>, o sistema pergunta <b>Substituir</b> (troca tudo pelo novo) ou <b>Complementar</b> — que <b>junta as linhas</b> do novo arquivo com as que já estavam, sem apagar nada, e recalcula o cruzamento sobre o total. É o caminho para empresas com <b>matriz e filiais</b>: cada arquivo é de um estabelecimento e o Complementar soma todos no mesmo tipo. Se o tipo ainda estava vazio, o primeiro arquivo entra direto (sem perguntar). Cada arquivo do tipo aparece <b>listado</b>, com quantas linhas trouxe, um botão para <b>baixar</b> e um para <b>excluir só aquele arquivo</b> (as linhas dele saem do total; os outros continuam e o cruzamento recalcula na hora). <b>Leitura completa do acumulador (total não vem mais curto):</b> quando uma nota tem <b>várias linhas de item</b> e o Domínio traz o acumulador <b>só na 1ª linha</b> (as de continuação vêm com o acumulador em branco, mas com valor), a plataforma <b>arrasta o último acumulador</b> para essas linhas — antes elas caíam fora e o total do acumulador vinha <b>menor</b> que o do Resumo. As linhas de <b>Total/Subtotal</b> do relatório continuam <b>fora da soma</b> (não duplicam) — e isso <b>não</b> afeta notas de fornecedor cujo <b>nome contém "Total"</b> (ex.: <b>“TOTAL PASS PARTICIPAÇÕES”</b>): a nota é somada normalmente (a checagem de “linha de total” ignora a coluna do fornecedor). O mesmo vale no <b>Resumo por Acumulador (Domínio)</b> (aba <b>Resumo final</b>): a regra é subir o <b>Excel</b> — é dele que o sistema <b>lê</b> os totais de cada seção (Entradas/Saídas/Serviços) para conferir com o acumulador importado — e, opcionalmente, o <b>PDF</b> como <b>conferência do analista</b> (fica anexado, <b>não é lido</b>). Cada arquivo aparece listado marcado como <b>lido</b> (Excel) ou <b>conferência</b> (PDF), com baixar e excluir individual. Vários <b>Excel</b> (matriz + filiais) <b>somam</b> os totais; o PDF nunca entra na soma. O leitor do Excel entende o formato do Domínio de cabeçalho nomeado (colunas <span class="m-code">codi_acu</span>, <span class="m-code">valor_contabil</span>…), que vem já agregado por acumulador. <b>Justificar a diferença — só nas Saídas:</b> quando a Saída fica com diferença, aparece um aviso amarelo com <b>Justificar diferença</b> (ex.: operação interna, rendimento de aplicação, transferência) — ao justificar, a Saída fica <b>validada</b> mesmo sem bater no centavo. <b>Entradas e Serviços não têm justificar</b> — a diferença delas tem que ser <b>corrigida</b> (o valor precisa aparecer no razão). O cruzamento casa o acumulador do arquivo com o <b>"Acum. N"</b> (ou "Acumulador N") citado no histórico do razão e dos lançamentos.</div>
  <div class="m-rule"><span class="k">Semáforo do Fiscal e da Folha (verde só quando bate)</span> Cada tipo do <b>Fiscal</b> (Entradas/Saídas/Serviços) e a <b>Folha</b> seguem a mesma régua: <b>vermelho</b> = nada importado; <b>amarelo</b> = importou o arquivo mas <b>ainda não bateu</b> (há diferença com o razão); <b>verde</b> = importou <b>e</b> zerou (bate com o razão, ou está justificado, ou sem movimento). A aba só fica <b>verde</b> quando os <b>três</b> tipos do Fiscal batem. Enquanto estiver amarelo, o <b>Status</b> mostra a integração como <b>“com diferença (não bateu)”</b> — apontando que falta conferir — e não deixa fechar. Atualiza sozinho quando o razão muda (corrigiu/importou), sem reimportar. <b>NF em qualquer acumulador:</b> nas Entradas, uma nota é dada como <b>encontrada</b> se a <b>NF</b> estiver no razão fiscal — no mesmo acumulador ou em outro (antes, se o acumulador do arquivo não tinha lançamento, a nota vinha como “não achei” mesmo estando no razão). O índice do razão é lido <b>paginado</b> (sem o corte de 1000 linhas), então notas no fim de um razão grande também são conferidas. <b>No Status:</b> quando o Fiscal ou a Folha estão amarelos, o item aparece com o <b>valor da diferença</b> (ex.: “com diferença de R$ 512,30”). Você pode <b>resolver</b> a diferença na Integração (corrigir/justificar até bater) ou, se a diferença for aceitável, clicar em <b>Justificar</b> no próprio Status: o responsável <b>aceita</b> a diferença, a integração fica <b>verde</b> e <b>libera o fechamento</b> (registra usuário e data). Subir um arquivo novo <b>reabre</b> a conferência (a justificativa anterior é solta). <b>Banco concluído</b> (financeira) conta como resolvido pelo flag de <b>concluído</b> — um banco já concluído não volta mais como pendente no Status por causa de um salvamento posterior.</div>
  <div class="m-rule"><span class="k">Salvamento por banco (não perde o que já foi feito)</span> Cada banco é gravado <b>de forma independente</b> na competência: concluir/salvar um banco <b>nunca apaga</b> os outros — nem o que <b>outra aba ou outra pessoa</b> salvou ao mesmo tempo. O sistema sempre mescla a partir do estado <b>atual do banco de dados</b> (e não de uma cópia carregada quando a tela abriu), então bancos concluídos, a folha e as demais integrações da mesma competência convivem sem sobrescrever um ao outro.</div>
  <div class="m-rule"><span class="k">Cadastro de contas herda do mês anterior (Patrimônio e Financeiro via sistema)</span> A <b>lista de contas</b> cadastrada no <b>Patrimônio</b> (conta(s) do imobilizado líquido) e no <b>Financeiro via sistema</b> (contas bancárias de quem integra pelo sistema, não por Excel) <b>vale para o cliente</b>, não só para o mês. Ao abrir uma competência sem cadastro, o sistema <b>herda automaticamente</b> a lista do <b>mês anterior mais recente</b> — aparece a etiqueta <b>“herdadas do mês anterior”</b>. Só a <b>lista de contas</b> é herdada; a <b>conferência do mês</b> (o Resumo da Depreciação no Patrimônio, as contas conciliadas no Financeiro via sistema) continua por competência. Se você <b>ajustar</b> a lista no mês atual, vale <b>deste mês em diante</b> e <b>não</b> mexe nos meses anteriores. Assim, o que você cadastrou uma vez já sobe sozinho para os próximos meses.</div>
  <div class="m-rule"><span class="k">Vários arquivos no mês</span> Quando o banco já tem lançamentos, há <b>dois botões explícitos</b> — tanto no <b>card do banco</b> quanto no painel aberto: <b>Substituir arquivo</b> (troca tudo pelo novo extrato) e <b>Importar complemento</b> (soma os lançamentos de outro arquivo aos que já estão, sem apagar nada — ex.: 2º extrato para fechar o mês). Cada botão faz exatamente o que diz, sem pergunta. Dá também para <b>excluir em lote</b> as linhas selecionadas e filtrar por <b>nome da conta</b> (contém/não contém) e por <b>sem data</b>. Linhas de <b>total/subtotal</b> do relatório não sobem.</div>
</section>

<section id="m-conciliacao">
  <h2 class="m-sec">13 · Conciliação</h2>
  <div class="m-rule"><span class="k">Lançamentos em ordem de data (mais antiga → mais nova)</span> Em <b>todas as contas</b>, os lançamentos da conta (razão, saldo anterior e acertos) aparecem <b>ordenados por data</b>, do <b>mais antigo para o mais novo</b> — facilita conferir e conciliar na sequência. A data é mostrada no padrão <b>DD.MM.AAAA</b> (ex.: <b>26.01.2026</b>).</div>
  <div class="m-rule"><span class="k">O ajuste de um mês entra no saldo inicial do mês seguinte</span> O saldo inicial de cada conta patrimonial é o <b>saldo final REAL do mês anterior</b> — e "real" inclui <b>tudo</b>: o razão <b>mais</b> os <b>ajustes/correções</b> feitos na conciliação, as <b>apropriações</b> (seguro/despesa) e demais lançamentos gerados. Assim, se você lança um <b>ajuste em maio</b> (ex.: acerta o caixa/banco, ou aproria o seguro), <b>junho abre já com esse ajuste</b> — o saldo final de maio e o inicial de junho <b>batem</b>. Antes, o arrasto pegava o mês anterior <b>sem</b> os lançamentos do sistema, então o mês seguinte abria com o valor de <b>antes do ajuste</b> (o banco fechava maio em X e junho abria em outro valor). Corrigido: mexeu no mês anterior, o saldo inicial deste mês e a conciliação <b>se atualizam sozinhos</b>.</div>
  <p>O coração do fechamento, com farol por conta. Três tipos:</p>
  <dl class="m-kv">
    <dt>Saldo simples</dt><dd>Banco — confere o saldo do balancete com o do extrato.</dd>
    <dt>Composição</dt><dd>Clientes, estoques, fornecedores — lançamentos agrupados por entidade, em formato de razão. Itens quitados no mês somem; o card mostra Saldo × Composição × Diferença.</dd>
    <dt>Imposto</dt><dd>ICMS, PIS, COFINS — confere a baixa do mês anterior e a memória de cálculo contra o balancete.</dd>
  </dl>
  <p>Cada linha pode ser <b>justificada</b> (texto, com usuário e data) ou <b>corrigida</b>. Corrigir gera um <b>lançamento de acerto</b> (estorno/reclassificação) — que faz o saldo reconferir na hora e sobe para o Contabilizar e para o Domínio.</p>
  <div class="m-rule"><span class="k">Correção se concilia sozinha com a origem</span> Quando você <b>corrige/estorna</b> um lançamento, o acerto gerado já <b>casa com a linha original</b> que corrigiu: se os dois se <b>anulam</b> nesta conta, o par <b>some do "em aberto" automaticamente</b> e vai para os <b>Conciliados</b> — sem virar uma linha nova de cliente/fornecedor para você reconectar depois. Eles ficam agrupados em <b>“Correções conciliadas (estorno ↔ origem)”</b> no fim da composição; <b>Reabrir</b> ali <b>desfaz a correção</b> (remove o lançamento de acerto e a marca da origem). Vale nas contas por entidade e nas de composição/reclassificação.</div>
  <div class="m-rule"><span class="k">Contas redutoras</span> Contas <b>retificadoras</b> (ex.: “(–) Depreciações Acumuladas”, PCLD, amortização) têm saldo na natureza invertida por natureza — e <b>não</b> são marcadas como “saldo credor/devedor invertido”. Vale tanto quando o próprio nome indica a redução quanto quando é a <b>sintética-mãe</b> que é redutora: a analítica <b>herda</b> a natureza da sintética.</div>
  <div class="m-rule"><span class="k">Nome está certo (o sistema aprende)</span> Quando uma linha fica em <b>“revisar”</b> só porque falta a NF (o nome já foi identificado), a coluna Conf. mostra um botão <b>“está certo”</b>: clica e o sistema registra a conferência (usuário e data), tira o “revisar” e <b>aprende</b> — esse nome vira <b>confiável</b> do cliente e <b>não pede revisão dele nos próximos meses</b>. Não precisa zerar a conta nem abrir a correção.</div>
  <div class="m-rule"><span class="k">Agrupa pelo nome distintivo</span> Ao juntar lançamentos por entidade, o sistema <b>ignora as palavras de operação e de estrutura</b> (revenda, mercadoria, espera de ancoragem, incorporações, imobiliária, SPE, faturamento…) e usa só a parte que <b>identifica o cliente</b> — assim “ESPERA DE ANCORAGEM <b>VILLA DI TRENTO</b>…” e “ESPERA DE ANCORAGEM <b>MANHATTAN</b>…” ficam em <b>grupos separados</b> (antes caíam juntos por causa do texto em comum). Cada cliente sai junto no mesmo grupo no PDF/Excel.</div>
  <div class="m-rule"><span class="k">Por nome também em Adiantamentos (e onde você quiser)</span> O agrupamento por nome (casa débito × crédito do mesmo cliente/fornecedor e o que <b>zera some</b>, ficando só o que compõe o saldo) vale automaticamente para <b>Clientes, Fornecedores, Duplicatas, Adiantamento de cliente e Adiantamento de fornecedor</b> — o sistema reconhece pelo nome da conta. Além disso, cada conta tem o botão <b>Por nome: ligado/desligado</b> — dá para <b>forçar</b> esse modo em qualquer conta (ou desligar), e a escolha fica <b>guardada por cliente</b>. Contas amarradas por <b>saldo</b> (banco) não usam esse modo.</div>
  <div class="m-rule"><span class="k">Combinar e baixar em qualquer conta</span> Em <b>toda</b> conta você pode <b>marcar</b> os lançamentos (checkbox) e clicar em <b>Conectar (baixar)</b>: quando a seleção <b>zera</b> (soma dá zero), eles são conciliados e <b>saem do “o que compõe o saldo”</b> — igual a clientes/fornecedores —, ficando só o que realmente sustenta o saldo. Se sobrar centavos, o botão <b>Corrigir a diferença</b> vira desconto/juros e fecha a baixa.</div>
  <div class="m-rule"><span class="k">Filtrar os lançamentos (toda conta)</span> Nas contas de <b>clientes/fornecedores</b> há a busca por <b>nome, NF ou valor</b>; nas <b>demais</b> contas (saldo/composição simples) há agora um <b>filtro</b> em cima da lista que casa por <b>histórico, contrapartida, valor ou data</b> — digite para afinar a lista e o <b>×</b> limpa. O <b>Selecionar tudo</b> passa a marcar só o que está <b>visível no filtro</b>.</div>
  <div class="m-rule"><span class="k">Desvincular nomes unidos por engano</span> Se o sistema uniu dois nomes parecidos que são <b>clientes/fornecedores diferentes</b> (ex.: “ATTENTIVE SERVIÇOS ADM” e “ATTENTIVE CONTABILIDADE”), abra o lançamento (clique na linha) → em <b>Ajustar leitura</b> há o botão <b>“Desvincular”</b>: mantém esse nome separado dos parecidos, <b>valendo para todos os meses</b>. É uma regra do cliente, guardada no cadastro. O desvínculo <b>acompanha o rename</b>: se você <b>desvincular e depois mudar o nome</b> daquele fornecedor, o nome novo continua desvinculado (os dois seguem separados). E se os dois já tinham sido <b>unidos por apelido</b> (rename anterior), o <b>Desvincular desfaz a união</b> — devolve o nome próprio à linha e separa de vez (vale no botão da linha e no <b>Desvincular</b> em lote da barra). Se a linha <b>já foi tratada</b> (tem correção/ajuste de leitura), clicar nela abre a tela <b>“Lançamento já tratado”</b>, que agora também tem o botão <b>Desvincular</b> — não precisa desfazer a correção antes.</div>
  <div class="m-rule"><span class="k">Corrigir nome/NF de uma linha já conferida</span> Na tela <b>“Lançamento já tratado”</b> (que abre ao clicar numa linha que você só <b>confirmou que estava certa</b>), há o botão <b>Ajustar leitura (nome / NF)</b> — abre o editor completo para corrigir o <b>nome do fornecedor/cliente</b>, o <b>número da NF</b> ou o <b>histórico</b>, e também reclassificar, sem precisar <b>desfazer</b> a conferência antes. A <b>conferência é mantida</b>: mesmo mudando o nome ou a NF (que fazem parte da identificação da linha de saldo inicial), a linha <b>continua conferida</b> — não volta para “revisar”.</div>
  <div class="m-rule"><span class="k">Corrigir o nome direto no card (✎)</span> No cabeçalho de cada cliente/fornecedor tem um <b>lápis</b>: clique para <b>corrigir o nome</b> que o sistema montou. O nome vale <b>para o cliente todo</b> e é <b>aprendido</b> — corrige um, arruma os outros meses e as próximas importações sozinho. Para <b>JUNTAR</b> dois grupos que são o mesmo cliente, renomeie um com <b>exatamente o nome</b> do outro (eles se fundem). E no rodapé <b>“Unificado de:”</b>, cada nome unido tem um <b>ícone de separar</b> (🔗) para tirá-lo do grupo quando a união foi indevida.</div>
  <div class="m-rule"><span class="k">Corrigiu um? A plataforma sugere os iguais</span> Assim que você corrige um nome, aparece um painel <b>“mesmo padrão”</b>: ela varre os outros grupos e propõe a mesma correção — seja por ser o <b>mesmo cliente</b>, seja pelo <b>mesmo recorte</b> de texto (ex.: você tirou o prefixo “RECEITA DE SERVICOS – MONTAGEM” de um → ela sugere tirar dos outros). Cada sugestão mostra <b>atual → sugerido</b> e você <b>aprova uma a uma</b> ou clica em <b>Aprovar todos</b>. Nada é aplicado sem o seu ok; o que você marcar como <b>Não</b> some da lista.</div>
  <div class="m-rule"><span class="k">Buscar por nome</span> Na composição de clientes/fornecedores tem um campo de <b>busca</b>: digite parte do nome e a lista mostra só os que batem — pelo nome da entidade, pelos nomes unidos ou pelo histórico dos lançamentos.</div>
  <div class="m-rule"><span class="k">Avisos em chips (filtrar por situação)</span> Os avisos da composição ficam numa <b>linha única de chips</b>, agrupados por <b>Precisa de ação</b> (saldo em natureza invertida, baixa com NF sem título, leitura incerta) e <b>Conferir</b> (NF aproximada, nomes unificados). Cada chip mostra a <b>quantidade</b> e um rótulo curto. <b>Clique</b> num chip para ver o detalhe completo logo abaixo e <b>filtrar</b> a lista só naquela situação; clique de novo (ou “limpar”) para voltar. <b>NF aproximada</b> marca os pares que casaram pela NF <b>ignorando zeros à esquerda</b> (ex.: 559 × 000559, ou 05602823 × 5602823) — é o <b>mesmo número</b>, só formatação do Domínio, então <b>são conciliados normalmente</b>; o chip é só para você conferir. Chip com contagem zero não aparece; sem nenhum aviso, a linha some. O aviso de <b>“leitura incerta”</b> só conta o que <b>ainda não foi tratado</b>: ao conferir/corrigir (ou confirmar o nome), a linha sai da conta.</div>
  <div class="m-rule"><span class="k">Nome do cliente/fornecedor pela NF do Fiscal</span> Quando o histórico do razão <b>não</b> deixa claro o nome, a plataforma busca o nome <b>oficial da nota</b> na <b>Integração Fiscal</b>: o acumulador (Entradas = fornecedores; Saídas/Serviços = clientes) traz o nome bem definido por <b>NF</b>. <b>Cada lado é usado no seu tipo de conta:</b> conta de <b>cliente</b> só pega nome das <b>Saídas/Serviços</b>; conta de <b>fornecedor</b> só pega das <b>Entradas</b> — assim um cliente nunca herda o nome de um fornecedor (e vice-versa), nem quando a mesma NF se repete entre os dois. O tipo da conta é decidido pelo <b>nome</b> (cobre “adiantamento a fornecedor” e “adiantamento de clientes”) e, na dúvida, pela classificação (ativo → cliente; passivo → fornecedor). Se a <b>NF</b> da linha bate com uma NF do fiscal, o nome de lá <b>substitui</b> a leitura do histórico — é o nome <b>oficial da nota</b> (ex.: histórico “COFINS MIRAGE RESIDENCE SPE” passa a mostrar o cliente correto do fiscal). Nas <b>saídas (clientes)</b> a planilha do fiscal <b>não traz a NF</b> (cruza por acumulador), então não dá para casar por número — nesse caso a plataforma compara <b>por nome</b>: se o nome lido do razão <b>contém</b> um nome oficial do fiscal, adota o nome limpo do fiscal (ex.: razão “REVENDA DE MERCADORIA – REDES/FACHADEIRO HM 26 EMPREENDIMENTO IMOBILIARIO” → cliente “HM 26 EMPREENDIMENTO IMOBILIARIO”). É <b>padrão do sistema</b> para todos os clientes; só não sobrepõe um ajuste manual do saldo inicial, e apelidos (renomear em todo lugar) ainda vêm por cima.</div>
  <div class="m-rule"><span class="k">Número da nota no formato do documento (série-número)</span> Nos recebimentos/pagamentos o Domínio costuma pôr o número no fim como <b>“&lt;série&gt;-&lt;número&gt;&lt;parcela&gt;”</b> — ex.: <b>“… MIRAGE RESIDENCE SPE LTDA 1-000584A”</b>. Antes o sistema não lia esse número (o “000584” fica grudado no “A”), então ficava <b>NF —</b>. Agora ele reconhece esse padrão e lê a <b>NF 584</b> (tira a série “1-”, os zeros à esquerda e a letra da parcela). Com a NF lida, o recebimento <b>casa por NF</b> com o título (mesmo número) e baixa automático quando cliente + NF + valor batem.</div>
  <div class="m-rule"><span class="k">Nome sem o prefixo do tipo de conta</span> Nas contas de <b>Adiantamento de Fornecedor</b> e <b>Adiantamento de Cliente</b>, o Domínio escreve o nome com o tipo da conta na frente (ex.: <b>“ADIANTAMENTO DE FORNECEDOR CONNECT FOR PEOPLE EDITORA E SOLUCOES 003881”</b>). A plataforma <b>tira esse prefixo</b> (e o código no fim) e identifica o cliente/fornecedor real — <b>“CONNECT FOR PEOPLE EDITORA E SOLUCOES”</b> — tanto no saldo inicial quanto no razão, para agrupar certo na composição. Vale também para <b>Adiantamento de Clientes</b> e para <b>prefixos de imposto</b> coladas no nome (COFINS, PIS, ICMS, ISS, IRPJ, CSLL, IRRF, INSS, IPI…) — todos são removidos do começo do nome. Também tira a <b>natureza da operação + acumulador</b> que o Domínio cola no nome dos lançamentos integrados pelo fiscal (ex.: <b>“REVENDA DE MERCADORIA – REDES/FACHADEIRO HM 26 …”</b> → <b>“HM 26 …”</b>): revenda/venda/compra/serviço… e o nome do acumulador logo após o traço saem da frente. E tira o prefixo de <b>baixa</b> (<b>“PAGAMENTO / RECEBIMENTO / BAIXA / QUITAÇÃO”</b> + eventual <b>NF/nota/duplicata/título + número</b>) — o fornecedor/cliente é o que vem <b>depois</b>. Ex.: <b>“PAGAMENTO NF 970 MAESTRO ABM LTDA”</b> → <b>“MAESTRO ABM LTDA”</b>.</div>
  <div class="m-rule"><span class="k">Conta sintética mostra a composição das analíticas</span> Quando a conta conciliada é <b>sintética</b> (agrupa outras — ex.: “Fornecedores” com uma analítica por fornecedor), a plataforma junta na composição <b>os lançamentos de todas as contas analíticas descendentes</b>, não só os postados diretamente na conta-mãe. Antes, uma sintética mostrava o <b>saldo</b> mas aparecia <b>“Sem lançamentos nesta conta”</b> — porque o movimento fica nas filhas. Agora o razão é lido da conta e de todas as suas analíticas (e sempre paginado, sem o corte de 1000 linhas).</div>
  <div class="m-rule"><span class="k">Saldo inicial = razão</span> Os títulos que vieram da <b>implantação do saldo inicial</b> (linhas “Saldo anterior”) entram na composição como se fossem razão: <b>casam por NF</b> com a baixa do mês (zeram e vão para “Conciliados”) e, quando zeram <b>sem NF</b>, entram no <b>Confirmar</b> em lote igual às demais. Dá para conferir/desfazer cada um também.</div>
  <div class="m-rule"><span class="k">Cada linha de saldo inicial é tratada individualmente</span> Conferir, <b>reclassificar</b> ou baixar uma linha “Saldo anterior” mexe <b>só naquela linha</b> — mesmo que exista outra <b>idêntica</b> (mesmo fornecedor, mesmo valor e <b>sem NF</b>, ex.: duas mensalidades de R$ 154,90 em datas diferentes). Antes, por não terem NF, duas linhas iguais eram vistas como a mesma e tratar uma marcava a outra “por tabela”; agora a <b>data</b> do título entra na identificação e cada uma segue seu caminho. (Corrigir o <b>nome</b> do fornecedor continua valendo para todas as linhas daquele nome — isso é proposital, para agrupar.)</div>
  <div class="m-rule"><span class="k">Saldo anterior nas contas de saldo (seguro / despesa a apropriar)</span> Em contas que <b>não</b> são de cliente/fornecedor — como <b>Seguro a apropriar</b> e <b>Despesa a apropriar</b> — o razão da Conciliação agora também mostra uma linha <b>“Saldo anterior”</b> com o <b>saldo que sobrou do mês anterior</b> (carga inicial pelo contrato <b>+</b> os complementos, menos as apropriações já feitas). Antes esse saldo entrava só na amarração (pelo número) e <b>não aparecia como lançamento</b> — agora você vê o saldo inicial ao lado das apropriações do mês. O valor da linha é o <b>líquido</b> (uma linha por conta), e a amarração continua exata.</div>
  <div class="m-rule"><span class="k">Excluir uma linha do saldo inicial (sem sair da conciliação)</span> Na <b>competência de abertura</b> do cliente, cada linha “Saldo anterior” ganha uma <b>lixeira</b> na coluna Ação: clica e a linha sai da <b>carga inicial</b> (composição e o saldo gêmeo, se houver) — útil para tirar um item <b>duplicado ou errado</b> sem ir à Base de Informações. Registra <b>usuário e data</b> na auditoria. Fica <b>travado</b> se a competência de abertura já estiver <b>fechada</b> (reabra-a para mexer). Só aparece na competência de abertura — nos meses seguintes o “Saldo anterior” é <b>arrasto</b> do mês anterior, não a carga.</div>
  <div class="m-rule"><span class="k">Selecionar para vincular (todas as linhas, sem exceção)</span> <b>Toda</b> linha da conta tem <b>checkbox</b> na primeira coluna — <b>sem exceção</b>: lançamentos do razão, linhas de <b>saldo inicial</b> e também os <b>lançamentos/estornos gerados pela plataforma</b> (etiquetas “lançamento”, “estorno”, “apropriação”). Vale nas contas por entidade e nas de <b>composição/reclassificação</b> sem entidade (ex.: “não identificado”). Há um <b>checkbox no cabeçalho</b> para <b>Selecionar tudo</b> (marca/desmarca todas as linhas de uma vez) — no card de cada fornecedor e na lista simples da conta —, além do individual. Marque dois ou mais e use <b>Conectar (baixar)</b> na barra que aparece embaixo para casá-los e mandá-los para os Conciliados.</div>
  <div class="m-rule"><span class="k">Ações em lote (seleção)</span> Marque vários lançamentos (checkbox) e use a barra: <b>Nome está certo</b> confirma que o sistema leu o nome certo em todos de uma vez (tira o “revisar” e <b>aprende</b>); <b>Corrigir</b> aplica o <b>nome certo</b> a todos os selecionados de uma vez — inclusive linhas de <b>saldo inicial</b> e os <b>lançamentos gerados/"não identificados"</b> (etiqueta “lançamento”/“estorno”): nesses, o nome fica <b>salvo por lançamento</b>, e a linha passa a aparecer com o fornecedor. Renomeia esse cliente/fornecedor em <b>todos os meses</b> (apelido), com opção de aprender — o mesmo vale ao editar uma linha de saldo inicial individualmente (clique na linha → Ajustar leitura): dá para corrigir o <b>nome</b>, o <b>número da NF</b> e o <b>histórico</b>. O <b>nome</b> corrigido vira <b>apelido</b> do fornecedor — vale para <b>todos os títulos daquele nome</b> (qualquer valor) e nos próximos meses, então <b>junta num grupo só</b> os vários saldos iniciais do mesmo fornecedor (renomeie os grupos para o mesmo nome que eles se unem). Já a <b>NF</b> e o <b>histórico</b> ficam salvos <b>por item</b> (são específicos de cada título); <b>Desvincular</b> mantém os nomes marcados separados (não unir com parecidos), valendo para todos os meses — <b>só para quem tem nome</b> (título/saldo anterior); <b>Conectar (baixar)</b> baixa a nota + pagamento selecionados.</div>
  <div class="m-rule"><span class="k">Reclassificar conta em lote</span> Quando você identifica <b>vários lançamentos na conta errada</b>, marque-os (checkbox) e clique em <b>Reclassificar conta</b> na barra de baixo. Abre uma tabela com <b>todos os selecionados</b> e você escolhe a <b>conta de destino de cada um</b> — ou, quando é tudo para a <b>mesma conta</b> (ex.: dez lançamentos que vão para uma única conta), digita a conta em <b>“Mesma conta para todos”</b> e clica <b>Aplicar a todos</b>. Ao confirmar, cada lançamento vira uma <b>correção</b> que move o valor desta conta para a de destino (mantendo o lado D/C original): aparece no <b>Contabilizar</b> e sai do em aberto. Se o destino for <b>despesa</b>, já registra a <b>dedutibilidade</b> (com NF → dedutível; sem NF → indedutível) e, se for conta de <b>resultado</b>, a variação recebida já entra <b>justificada</b> no Comparativo. Vale só para lançamentos do <b>razão</b> (não para saldo inicial nem lançamentos já gerados); linhas já corrigidas são <b>puladas</b> (desfaça na linha para refazer). Contas <b>sintéticas</b> como destino são bloqueadas (só analíticas). <b>A correção herda o cliente/fornecedor da linha reclassificada</b> (pelo lançamento de origem), então ela <b>agrupa junto do cliente</b> e o par (original + estorno) <b>zera</b> — em vez de cair em “não identificado” e desbalancear os totais. Vale também para reclassificações que já estavam no razão.</div>
  <div class="m-rule"><span class="k">Corrigir o nome de um estorno/reclassificação</span> Quando você reclassifica um lançamento para outra conta (ex.: joga um pagamento de <b>Fornecedores</b> para <b>Adiantamento de fornecedor</b>), o <b>estorno</b> aparece na conta de destino. Se ele vier <b>sem o nome</b> do fornecedor (ou com o nome errado), <b>clique na linha do estorno</b> → no modal, use <b>“Nome do fornecedor deste acerto”</b> e <b>Salvar nome</b>. O nome fica salvo <b>por lançamento</b> e o estorno passa a <b>agrupar pelo fornecedor certo</b> na conta nova (também dá para fazer em lote: marque o checkbox e use <b>Corrigir fornecedor</b> na barra de baixo).</div>
  <div class="m-rule"><span class="k">Conectar (baixa manual)</span> Quando o sistema não casou a nota com o pagamento sozinho (NF diferente, sem NF, ou nomes separados), <b>marque os lançamentos</b> (checkbox na primeira coluna) — pode ser em cards diferentes — e clique em <b>Conectar (baixar)</b> na barra que aparece embaixo. A barra mostra o <b>líquido</b> e os conectados vão para <b>Conciliados</b> (dá para reabrir depois). <b>Só dá para conectar quando o líquido ZERA:</b> se sobrar qualquer diferença, o botão <b>Conectar (baixar)</b> fica <b>desabilitado</b> (não dá nem para apertar) e a barra mostra quanto falta — ajuste a seleção até zerar. Ao conectar, o sistema <b>sempre pede confirmação</b> antes de baixar. Linhas que já estão <b>corrigidas/conferidas</b> (mas cuja entidade ainda não zerou — ex.: saldo devedor residual) <b>também podem ser marcadas</b> e conectadas com outro lançamento: ter o nome já certo não impede a baixa manual. Os lançamentos de <b>cartão de crédito</b> (pelo histórico ou pela contrapartida “Cartão de crédito a pagar”) são <b>agrupados num card único</b> — em vez de espalhados no “não identificado” — para você marcá-los e conectar de uma vez. <b>Unifica e aprende o fornecedor:</b> quando você conecta lançamentos com o <b>nome lido diferente</b> (ex.: o título veio como “ELETROLAR” e o pagamento como “LIKE DISTRIBUICAO E LOGISTICA”), a plataforma adota o <b>nome mais completo</b> como o <b>fornecedor final</b> e <b>aprende</b> que os outros são o mesmo (apelido) — passa a agrupá-los sozinho nos <b>próximos meses</b>.</div>
  <div class="m-rule"><span class="k">Saldo do documento digitado manda</span> Se você <b>digitar</b> o valor em <b>“Saldo conforme o documento”</b>, ele é <b>mantido</b> — a leitura automática do documento (ao subir o arquivo ou clicar <b>Reler documento</b>) <b>não sobrescreve</b> o que você digitou, e é o valor digitado que fica salvo. Para voltar a ler o saldo do próprio documento, <b>limpe o campo</b> e reimporte/releia.</div>
  <div class="m-rule"><span class="k">Conferência recolhível</span> No rodapé da conta, o bloco <b>Conferência da conta</b> (documento suporte, confirmar/justificar e comentários) pode ser <b>recolhido</b> pelo cabeçalho para a tela ficar mais limpa — recolhido, mostra só o <b>status</b> (verde/amarelo/vermelho). Começa <b>aberto</b> quando a conta está <b>pendente</b> (vermelho) e <b>recolhido</b> quando já está conferida.</div>
  <div class="m-rule"><span class="k">Relatório com a coluna Saldo</span> Os relatórios da composição (Excel/PDF, em aberto e conciliados) trazem, além de <b>Débito</b> e <b>Crédito</b>, uma coluna <b>Saldo</b> no <b>Subtotal de cada cliente/fornecedor</b> e no <b>Total</b>: mostra <b>R$ 0,00</b> quando o grupo <b>zerou</b> (título e baixa se compensam) e o <b>saldo em aberto</b> no que sobrou. Vale para <b>todas as contas</b> de composição.</div>
  <div class="m-rule"><span class="k">Novo lançamento na conta</span> No topo da conta (drill-down) há o botão <b>Novo lançamento</b>: inclui um lançamento direto nesta conta — ex.: uma <b>tarifa, IOF ou ajuste</b> que faltou no razão. A conta atual já vem preenchida em um dos lados (dá para <b>trocar débito ↔ crédito</b>); informe a contrapartida, o valor e o histórico. Ao gerar, ele entra no <b>Contabilizar</b> (Status → Domínio), aparece na composição e <b>atualiza o saldo</b> na hora.</div>
  <div class="m-rule"><span class="k">Confirmado sai para Conciliados</span> Ao <b>Confirmar</b> (ou quando uma entidade <b>zera e todas as linhas já estão tratadas</b> — conferido/corrigido/baixado), os lançamentos saem do “em aberto” e vão para <b>Conciliados (o que zerou)</b> — some da tela. Para rever ou desfazer, abra <b>“Conferidos neste mês”</b> (no fim da composição) e clique em <b>Reabrir</b>: eles voltam para o em aberto. As <b>baixas e conferências sobrevivem à reimportação do razão</b>: quando o razão é subido de novo (gera lançamentos com novo id interno), a baixa é reconhecida pela <b>chave estável do título</b> (conta · data · NF), e não só pelo id — assim um par já baixado (ex.: título + pagamento) não volta a aparecer só de um lado, e o <b>“Conciliados” continua batendo</b>. A baixa automática só acontece quando batem as <b>três</b> condições: <b>cliente</b> (nome), <b>NF</b> (mesmo número — <b>zeros à esquerda não contam</b>: 559 = 000559, é a mesma nota) e <b>valor</b> (o par zera). Faltando NF ou valor — <b>sem NF</b>, ou NF genuinamente diferente —, o par <b>não</b> baixa sozinho: quando zera <b>sem NF</b>, vira <b>sugestão</b> (faixa verde “identificado e zerado”) para você <b>aprovar e baixar em lote</b>, ou usar o <b>Conectar (baixar)</b> manual. Assim o painel <b>“Conciliados” sempre bate débito = crédito 100%</b> e o que não tem contrapartida certa fica <b>em aberto</b>. A baixa automática casa por número da nota <b>dentro de cada cliente</b> (números pequenos, como NF 64, se repetem entre fornecedores — cada par é conciliado separadamente). Quando a <b>NF é específica (5+ dígitos)</b>, com <b>um título (crédito) e um pagamento (débito) do mesmo valor</b>, o par <b>zera mesmo que o nome venha escrito diferente</b> nas duas linhas — ex.: “RSM ... Auditoria e Consultoria” no saldo anterior e “RSM ... Auditores Independentes” no pagamento; a NF idêntica é confiável e não precisa que os nomes sejam idênticos. Só a NF curta e repetida entre fornecedores continua exigindo o nome para separar os pares. No <b>relatório “Conciliados (o que zerou)”</b>, o título e o pagamento dessa mesma NF aparecem <b>no mesmo bloco do fornecedor</b> (não em blocos separados) — assim o <b>subtotal por fornecedor bate</b> (débito e crédito juntos), e não só o total geral.</div>
  <div class="m-rule"><span class="k">Confirmar em lote</span> Quando a composição de um cliente/fornecedor já <b>zerou</b> (título e baixa se compensam) e o nome está identificado, mas falta a NF (linhas em “revisar”), o card mostra o botão <b>Confirmar</b> — marca todas as linhas como conferidas de uma vez, com justificativa (usuário e data), sem abrir uma a uma. Só aparece quando o saldo zerou e não há erro de NF ou natureza invertida. No topo, uma faixa verde mostra <b>quantos</b> clientes/fornecedores estão nessa situação. Marque no <b>checkbox</b> de cada card os que quer baixar (ou use <b>“Selecionar todos”</b>), filtre com <b>“Mostrar só esses”</b> e clique em <b>“Confirmar selecionados (N)”</b> — confirma só os marcados, de uma vez. Cada linha pode ser desfeita depois.</div>
  <div class="m-rule"><span class="k">Sugestão de vínculo (cliente + valor batem, NF diferente)</span> Quando um <b>título (débito)</b> e um <b>pagamento (crédito)</b> do <b>mesmo cliente</b> têm o <b>mesmo valor</b> mas a <b>NF veio diferente ou ausente</b> (ex.: o histórico traz o nº do documento no lugar da nota — “…LTDA 003789”), o sistema <b>não</b> baixa no automático (a regra do automático é cliente + <b>NF idêntica</b> + valor). Em vez disso, ele <b>encontra o par sozinho</b> e mostra a <b>“Sugestão de vínculo”</b> <b>dentro do card daquele cliente</b> (no contexto, junto do resto da composição, para revisar sem se perder), com as duas linhas (título ↔ pagamento) e o valor. Uma faixa azul no topo só diz <b>quantas</b> sugestões há. Você <b>aprova</b> (botão <b>Aprovar/vincular</b>, um a um ou <b>Aprovar todas</b>) e o par vai para <b>Conciliados</b> — como se você tivesse feito o <b>Conectar (baixar)</b> manual, mas sem precisar caçar as linhas. Se os nomes vieram escritos diferentes, ao aprovar ele <b>unifica e aprende</b> o cliente (só dentro daquele par). Se <b>não</b> é o mesmo par, clique em <b>“Não aprovar”</b>: a sugestão é <b>descartada</b> e não volta a aparecer (fica registrado), e as linhas <b>continuam em aberto</b> para você tratar de outro jeito. Não aprovou nem descartou? Também fica em aberto — nada é baixado sem o seu ok. Cada par pode ser desfeito depois em “Conferidos neste mês”.</div>
  <div class="m-rule"><span class="k">Reabrir uma baixa automática por NF (vincular à mão)</span> Às vezes o sistema baixa um par por NF, mas você quer <b>desfazer e vincular manualmente</b> (ex.: a NF lida era o nº do documento e casou o par errado). No fim da composição há a seção <b>“Baixados automaticamente por NF”</b> — clique para ver os pares que zeraram por nota e use <b>“Reabrir p/ vincular”</b>: os lançamentos <b>voltam para o em aberto</b> e o sistema <b>não os baixa mais sozinho</b> por aquela NF (fica registrado, vale para os próximos meses também). Aí você seleciona as linhas certas e usa o <b>Conectar (baixar)</b> para vincular do jeito certo. É o <b>“traz o valor de volta para a tela”</b>: nada fica preso no “que zerou” sem como reabrir.</div>
  <div class="m-rule"><span class="k">Razão vivo na prática</span> O estorno que você faz aqui aparece no débito da conta no <b>Comparativo</b> e no razão vivo — é o mesmo ajuste em todo lugar. Uma correção só existe uma vez por lançamento; para refazer, use <b>Desfazer</b>.</div>
  <div class="m-rule"><span class="k">Movimentação reflete as correções</span> Na lista de contas da conciliação, <b>Débito</b>, <b>Crédito</b> e <b>Saldo atual</b> já <b>somam as correções/estornos pendentes</b> de contabilização (não só o saldo) — a coluna que muda ganha o sinal <b>±</b>. Assim, quando você lança uma reclassificação/estorno, a <b>movimentação</b> da conta atualiza junto com o saldo, batendo com o Comparativo. O alerta de <b>natureza invertida</b> (“saldo devedor”/“saldo credor”) também olha o <b>saldo já corrigido</b> — se o estorno arruma o lado, o alerta some sozinho; se não tinha correção nenhuma, ele continua apontando.</div>
</section>

<section id="m-comparativo">
  <h2 class="m-sec">14 · Comparativo de Movimento</h2>
  <p>Matriz conta × mês das contas de resultado (grupos 3, 4 e 5). Marca em <b>vermelho</b> quem desvia mais de <b>10% do mês anterior</b> (o primeiro mês nunca é comparado). <b>Todos os números são clicáveis</b>: abrem o razão da conta. Contas <b>sem lançamento nenhum</b> (todas as colunas vazias) <b>não aparecem</b>, deixando a tela enxuta — e com o filtro de centro de custo a lista <b>se remodela</b> (some quem não tem movimento no centro escolhido).</p>
  <ul>
    <li>A plataforma <b>aponta o provável culpado</b> da variação, com o motivo (valor fora do padrão, histórico genérico, não recorre nos meses anteriores).</li>
    <li>Por lançamento: <b>justificar</b> (tira a pendência) ou <b>corrigir</b> (reclassifica → vira lançamento).</li>
    <li><b>Justificou uma conta, vale para o ano todo:</b> a justificativa de uma conta passa a valer em <b>todos os meses</b> dela — <b>para frente e para trás</b> —, não só no mês em que você registrou. Isso porque as contas de resultado <b>acumulam no ano</b>: uma despesa <b>recorrente</b> (ex.: aluguel fixo) faz o acumulado crescer e <b>estoura os 10% todo mês</b>; sem isso, você re-justificaria a mesma coisa mês após mês. Justifica <b>uma vez</b> e some da pendência em todos os meses (no Comparativo e no gate de Variações do Status). Se estiver fechando <b>vários meses</b>, justificar o último já cobre os anteriores; e justificar um mês antigo já cobre os seguintes. <b>Desfazer</b> tira a justificativa da conta <b>em todos os meses</b> (volta a pendente). As <b>correções/reclassificações</b> continuam específicas do mês (não são apagadas ao desfazer a justificativa).</li>
    <li><b>Correção só no mês do fechamento (só a justificativa viaja):</b> a regra "vale para o ano todo" é <b>só da justificativa</b>. Para <b>corrigir/reclassificar um lançamento</b>, você tem que estar no <b>mês do próprio lançamento</b>. Se estiver fechando <b>junho</b> e achar um erro em <b>maio</b>, o sistema <b>não deixa corrigir dali</b> — <b>mude o fechamento para maio</b>, corrija lá, e como o razão é <b>vivo</b>, <b>junho se atualiza sozinho</b> (o saldo inicial de junho já reflete o ajuste de maio). No Comparativo, ao abrir uma coluna de um mês diferente do fechamento, aparece o aviso e o botão de corrigir fica <b>bloqueado</b> (justificar continua liberado). Isso mantém cada lançamento no seu mês certo.</li>
    <li>O drill-down do razão mostra o razão importado <b>e</b> as linhas de <b>AJUSTE</b> (os lançamentos feitos), fechando o total no valor vivo. Tem uma coluna <b>C. Custo</b>: mostra o centro de custo de cada lançamento e, nas contas de resultado, marca em amarelo <b>"sem CC"</b> quem ainda não tem centro — pra você achar e lançar. <b>Razão vivo do CC:</b> o centro que você informa ao <b>criar</b> ou <b>editar</b> um lançamento (rateio) <b>entra no filtro de centro de custo</b> do comparativo na hora — o valor passa a aparecer no(s) centro(s) escolhido(s), e um lançamento de resultado ainda <b>sem CC</b> cai em <b>"Sem centro de custo"</b>. No rateio, cada centro entra com a <b>sua parte</b> do valor.</li>
    <li><b>Corrigido some da tela:</b> ao corrigir um lançamento, ele e o ajuste dele <b>saem da lista</b> e o <b>Total já reflete a correção</b>. Você vai reclassificando e a lista vai <b>afinando</b> só no que falta. Uma faixa verde mostra <b>quantos foram corrigidos</b>, com <b>Mostrar corrigidos</b> para revê-los ou desfazer.</li>
    <li><b>Corrigir em lote (contas diferentes):</b> marque vários lançamentos no <b>checkbox</b> e clique em <b>Corrigir selecionados (N)</b> — abre um painel com <b>um campo de conta para cada um</b> (podem ser <b>contas diferentes</b>, o valor vem do lançamento). <b>Gravar tudo</b> gera todas as reclassificações de uma vez (as em branco pula). Continua dando para corrigir <b>um a um</b> clicando na linha — o lote é só um atalho.</li>
    <li>Ao clicar num lançamento de despesa, dá para marcar <b>Dedutível / Indedutível</b> (LALUR). O <b>indedutível</b> vira <b>adição</b> no card do LALUR e no relatório de despesas indedutíveis — sem duplicar contas já cadastradas.</li>
    <li><b>Reclassificou para uma despesa? Pergunta o LALUR:</b> quando a <b>conta de destino</b> da correção é uma <b>despesa</b> (classificação 4), a plataforma pergunta <b>Dedutível / Indedutível</b> ali mesmo (vale para a correção individual e em lote). <b>Sem nota fiscal</b>, já sugere <b>Indedutível</b>. Vale também na <b>Conciliação</b> (ao reclassificar um fornecedor direto para uma despesa).</li>
    <li><b>A conta que RECEBE a reclassificação já sai justificada:</b> quando você reclassifica um valor <b>para</b> uma conta de resultado (grupos 3, 4 ou 5), o valor recebido movimenta essa conta de destino no mês. Como <b>foi você quem gerou esse movimento</b>, a plataforma <b>justifica automaticamente a variação da conta de destino</b> — ela não volta como pendência <b>"sem justificativa"</b> no Comparativo nem no gate de Variações do Status. Antes, só o lado de <b>origem</b> era justificado e o destino ficava aberto. (As demais variações — de contas que ninguém reclassificou — continuam pedindo justificativa normalmente.)</li>
    <li><b>Filtro por Centro de custo:</b> o <b>gatilho é o cadastro do cliente</b> — se o cadastro diz <b>"Usa centro de custo? = Sim"</b>, o filtro <b>Centro de custo</b> aparece <b>sempre</b> na barra (junto de Agrupar/Nível/Meses), com <b>marcar todos</b> ou seleção individual. A lista traz os centros <b>cadastrados</b> mais os que aparecem no <b>razão</b> — e aparece mesmo que o razão ainda não tenha nada (é importante você ver que está vazio). Ao escolher centros, o <b>resultado</b> (receitas/despesas) passa a considerar <b>só os lançamentos daqueles centros</b> — inclusive os subtotais das sintéticas e o Lucro/Prejuízo do período. As contas <b>patrimoniais</b> (1 e 2) não têm centro de custo, então <b>não são afetadas</b>. <b>Sem nada selecionado = todos</b>. A lista traz sempre a opção <b>"Sem centro de custo"</b> (junta vazio, <span class="m-code">-1</span> e "Sem Centro de Custo"). Na <b>importação</b>, o centro do arquivo é <b>casado com o cadastro</b> (por código ou por nome) e gravado pelo <b>código</b> — por isso o filtro mostra sempre <b>"código · nome"</b>, sem duplicar. Se o arquivo tiver um centro <b>fora do cadastro</b>, a plataforma <b>avisa e não deixa importar</b> — cadastre em Base de Informações → Centro de custo primeiro.</li>
  </ul>
</section>

<section id="m-contabilizar">
  <h2 class="m-sec">15 · Contabilizar</h2>
  <p>A fila central de lançamentos <span class="m-code">{data, débito, crédito, valor, histórico, origem, doc}</span>. Reúne o que veio das sugestões, das correções e do que você lança à mão (partida pelos selects do plano, ou subindo documento). O relatório de lançamentos é a auditoria do analista — <b>não há etapa de aprovação</b>.</p>
  <div class="m-rule stop"><span class="k">Centro de custo obrigatório (clientes que usam CC)</span> Quando o cliente <b>usa centro de custo</b> (ex.: Metroform) e o lançamento toca uma <b>conta de resultado</b> (classificação 3/4/5), a plataforma <b>obriga informar o centro de custo</b> — tanto ao <b>criar um lançamento manual</b> quanto ao <b>editar</b> um lançamento (no modal <b>Editar lançamento</b> do Status). Escolha o centro na lista dos <b>cadastrados</b> do cliente; um lançamento pode ter <b>um</b> centro (valor cheio) ou ser <b>rateado</b> em <b>vários</b> — nesse caso a <b>soma dos centros tem que bater com o valor</b> do lançamento. Sem o centro, o botão <b>Salvar</b> fica bloqueado. Contas patrimoniais (1/2) não pedem CC.</div>
  <div class="m-rule"><span class="k">Entrega final</span> O botão <b>Gerar arquivo Domínio</b> baixa o CSV no layout exato (separador <span class="m-code">;</span>, BOM UTF-8, valor em pt-BR) pronto para importar.</div>
</section>

<section id="m-status">
  <h2 class="m-sec">16 · Status</h2>
  <p>O gate de pendências: o fechamento só libera quando zera. Vários checks clicáveis; o destaque é <b>Lançamentos banco × resultado</b> — aponta quando um banco cai direto numa conta de resultado (prefixo 3/4/5) que <b>não</b> está na lista de exceções liberadas.</p>
  <div class="m-rule stop"><span class="k">LALUR — obrigatório</span> Ao <b>justificar</b> um lançamento de despesa (classificação que começa com <span class="m-code">4</span>), é preciso classificar como <b>dedutível</b> ou <b>indedutível</b> — isso alimenta o relatório de despesas indedutíveis do LALUR.</div>
  <p>Cada apontamento tem justificar ou corrigir (reclassifica → Contabilizar). O relatório do gate sai em Excel/PDF, com as despesas indedutíveis.</p>
  <div class="m-rule"><span class="k">Variações — justificar aqui OU no Comparativo</span> A pendência <b>Variações sem justificativa</b> pode ser resolvida <b>direto no gate do Status</b> (botão justificar) <b>ou</b> no <b>Comparativo de Movimento</b> — nos dois casos a variação <b>baixa da lista</b> na mesma conta e mês. Uma conta que <b>zerou/sumiu no mês</b> (tinha saldo no mês anterior e não veio no balancete) também conta como variação e precisa de justificativa — justificar num mês vale só para <b>aquele mês</b>.</div>
  <div class="m-rule"><span class="k">Ver lançamentos — buscar e corrigir em lote</span> No botão <b>Ver lançamentos</b> (lista dos que vão para o Domínio) o <b>cabeçalho fica fixo</b> ao rolar. <b>Passo 1:</b> <b>pesquise</b> por conta (código ou nome), histórico ou valor e <b>marque</b> os lançamentos (quantos quiser, ou todos do filtro pelo checkbox do topo). <b>Passo 2:</b> escolha <b>o que corrigir</b> — <b>Conta débito</b>, <b>Conta crédito</b>, <b>Histórico</b> ou <b>Centro de custo</b>: a tela passa a mostrar <b>só os selecionados</b>, com o campo editável em cada linha. Aí você corrige <b>em massa</b> (campo "em massa" + <b>Preencher todos</b> = o mesmo valor para todos) <b>ou individual</b> (edita cada linha com um valor diferente) e clica em <b>Salvar</b>. O <b>Centro de custo</b> só entra nos lançamentos de <b>conta de resultado</b> (coluna <b>C. Custo</b> mostra o atual ou <b>"sem CC"</b> em amarelo); os demais campos valem para qualquer lançamento. Para mexer em tudo de um lançamento de uma vez, o <b>Editar</b> da linha continua.</div>
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
