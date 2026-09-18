// ---- Vocabulário GENÉRICO de nome (fonte ÚNICA) ----
// Palavras que NÃO distinguem um cliente/fornecedor de outro: razão social genérica
// ("...DE FORCA E LUZ"), tipo de operação/transação do Domínio ("PAGAMENTO VALE TRANSPORTE …")
// e CLASSIFICAÇÃO CONTÁBIL / RUBRICA de despesa ("OUTRAS DESPESAS DE CONSUMO …"). O matcher
// ignora essas palavras (ficam só os tokens distintivos), senão fornecedores diferentes que
// compartilham a mesma rubrica/tipo encadeiam num bloco só.
//
// IMPORTANTE: esta lista é compartilhada por `Conciliacao.jsx` (tela) e `aberturaArrasto.js`
// (arrasto do saldo anterior + testes). Antes eram DUAS listas que DIVERGIRAM — a tela usava a
// incompleta e fundia dezenas de fornecedores (ex.: "OUTRAS DESPESAS DE CONSUMO" juntando
// SUPRICORP × BIANCA × OXIMAR), enquanto os testes passavam contra a lista completa. Uma fonte
// única elimina esse descompasso. Set() já deduplica, então a ordem/repetição não importa.
export const GENERICAS = new Set([
  // Razão social genérica
  'COMPANHIA', 'CIA', 'DISTRIBUIDORA', 'DISTRIBUIDOR', 'ENERGIA', 'ENERGIAS', 'ELETRICA', 'ELETRICAS', 'FORCA', 'LUZ', 'COMERCIO', 'COMERCIAL', 'INDUSTRIA', 'INDUSTRIAL', 'SERVICO', 'SERVICOS', 'BRASIL', 'NACIONAL', 'GRUPO', 'HOLDING', 'PARTICIPACOES', 'EMPREENDIMENTOS', 'EMPREENDIMENTO', 'TRANSPORTE', 'TRANSPORTES', 'LOGISTICA', 'SOLUCOES', 'TECNOLOGIA', 'SISTEMAS', 'ASSOCIACAO', 'INSTITUTO', 'FUNDACAO', 'BANCO', 'SUPERMERCADO', 'SUPERMERCADOS', 'ALIMENTOS',
  // Tipo de operação / lançamento
  'REVENDA', 'REVENDAS', 'MERCADORIA', 'MERCADORIAS', 'ESPERA', 'ANCORAGEM', 'FATURAMENTO', 'FATURAM', 'FUTURO', 'RECEB', 'RECEBER', 'SIMPLES', 'LCTO', 'LANCAMENTO', 'ACUM', 'TRIB', 'ANTECIPACAO', 'ANTECIPACOES',
  'RECEITA', 'RECEITAS', 'MONTAGEM', 'MONTAGENS', 'PROJETO', 'PROJETOS', 'REDES', 'REDE', 'PRESTACAO', 'PREST', 'PROPAGANDA', 'CUMULATIVO',
  // Estrutura societária de incorporadoras/imobiliárias/engenharia
  'INCORPORACOES', 'INCORPORACAO', 'INCORPORADORA', 'IMOBILIARIOS', 'IMOBILIARIO', 'IMOBILIARIA', 'IMOBILIARIAS', 'SPE', 'CONSTRUTORA', 'CONSTRUCAO', 'CONSTRUCOES', 'ENGENHARIA', 'ENGENHARIAS', 'DESENVOLVIMENTO', 'DESENVOLVIMENTOS',
  // Escritório contábil / prefixo fiscal
  'SERV', 'CONTABIL', 'CONTABEIS', 'CONTABILIDADE', 'CONTABILIDADES', 'CONTABILISTAS', 'ASSESSORIA', 'ASSESSORIAS', 'CONSULTORIA', 'CONSULTORIAS', 'EMPRESARIAL', 'EMPRESARIAIS', 'GESTAO', 'TRIBUTARIA', 'TRIBUTARIOS', 'TRIBUTARIO', 'ADMINISTRATIVA', 'ADMINISTRATIVOS', 'ADMINISTRATIVO', 'PERICIA', 'AUDITORIA', 'AUDITORES', 'ESCRITORIO', 'ORGANIZACAO', 'ORGANIZACOES', 'FINANCEIRA', 'FINANCEIRO', 'FINANCEIRAS', 'RECURSOS', 'HUMANOS', 'NEGOCIOS', 'INTEGRAL', 'INTELIGENTE', 'CONSULTIVA', 'RESOLUTIVA', 'ESPECIALIZADA', 'ESPECIALIZADOS', 'INVESTIMENTOS', 'CONTADORES',
  // Tipos de transação do Domínio (aparecem ANTES do nome, sobretudo em pagamentos)
  'MATERIA', 'MATERIAS', 'PRIMA', 'PRIMAS', 'INDUSTRIALIZACAO', 'VENDA', 'VENDAS', 'COMPRA', 'COMPRAS', 'VALE', 'VALES', 'BONIFICACAO', 'DOACAO', 'BRINDE', 'BRINDES', 'COMISSAO', 'COMISSOES', 'EQUIPE', 'FRETE', 'FRETES', 'CARRETO', 'CARRETOS', 'MANUFATURADOS', 'ADIANTAMENTO', 'ADTO', 'PREMIACAO', 'PRODUTIVIDADE',
  // Rubrica / classificação contábil de despesa (histórico sem separador: "PAGAMENTO <RUBRICA> <FORNECEDOR>")
  'OUTRAS', 'OUTROS', 'DESPESAS', 'DESPESA', 'CONSUMO', 'MATERIAIS', 'MATERIAL', 'EQUIPAMENTOS', 'EQUIPAMENTO', 'FERRAMENTAS', 'FERRAMENTA', 'MAQUINAS', 'MAQUINA', 'MANUTENCAO', 'MANUTENCOES', 'IMPRESSOS', 'AQUISICAO', 'AQUISICOES', 'LOCACAO', 'LOCACOES', 'PROTECAO', 'INDIVIDUAL', 'INDIVIDUAIS', 'INDUSTRIAIS', 'ALUGUEL', 'ALUGUEIS', 'PEDAGIO', 'ESTACIONAMENTO', 'BENEFICIOS', 'BENEFICIO', 'FLEXIVEL', 'COMBUSTIVEL', 'COMBUSTIVEIS', 'VIAGENS', 'VIAGEM', 'REFEICAO', 'ALIMENTACAO', 'MAO', 'OBRA', 'TERCEIRIZADA', 'TERCEIRIZADAS',
  // Operação / comércio exterior
  'IMPORTACAO', 'IMPORTACOES', 'EXPORTACAO', 'EXPORTACOES', 'IMPORT', 'EXPORT', 'COMEX', 'ATACADO', 'VAREJO', 'ATACADISTA',
  // Formas jurídicas e sufixo fiscal
  'LTDA', 'EIRELI', 'EPP', 'MEI', 'CF', 'RPS',
  'DO', 'DA', 'DE', 'DOS', 'DAS', 'E', 'EM',
])
