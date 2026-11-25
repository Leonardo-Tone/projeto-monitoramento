# Vigia - monitor integrado 0.11.0

## Abrir o painel

1. Dê dois cliques em **INICIAR-PAINEL.cmd** nesta pasta.
2. Abra **http://127.0.0.1:4318** no Chrome ou Edge.
3. Adicione produtos ou clique em **Carregar lista do projeto** para importar os anúncios dos coletores existentes (até 10 por plataforma). A importação não inicia consultas nem substitui suas regras.
4. Para o Mercado Livre, prepare o perfil conforme abaixo. Depois, clique em **Iniciar monitoramento**.

Mantenha a janela do serviço aberta durante o uso. **Parar monitoramento** aguarda as consultas em andamento e libera o navegador ML. Ctrl+C na janela do serviço encerra o painel e os monitores. Fechar apenas a página não encerra as consultas.

Abrir index.html diretamente mostra a estrutura, mas os controles reais dependem do serviço local. Os coletores reutilizam os pacotes já instalados. As notificações incluem uma cópia independente do runtime Electron usado pelo CEPO. Requer Node.js 20.18.1 ou mais recente e Chrome para o ML.

## Mecanismos integrados

**Amazon:** Amazon/amazon-monitor-core, versão **0.3.0**. Usa diretamente Monitor, FileStore e consultarAod existentes. Mantém contratos, confirmação em duas observações, tratamento de bloqueios, eventos persistidos e agendamento sem rajadas. Consulta a primeira página AOD a cada 60 segundos, concorrência 3, timeout de 12 segundos. As consultas AOD agora são executadas dentro do perfil Chrome de monitoramento Amazon, aproveitando a sessão desse perfil, enquanto análise, regras e persistência continuam no núcleo v0.3.

**Mercado Livre:** mecanismo de Mercado_Livre/teste-ml-persistente-v3.mjs, integracao-native.mjs e runtime instalado. Reutiliza o perfil Mercado_Livre/perfis/ml-chrome-headless-v3, navegador headless persistente, pool de até três fetches da mesma origem para anúncios tradicionais e uma aba de navegação sequencial para catálogos. Intervalo de 60 segundos. Restrições de acesso, origem divergente e erros de parser interrompem esse monitor. A outra loja mantém status independente.

Durante uma falha transitória de rede ou timeout, o painel mostra **Reconectando** e o monitor repete o ciclo em abas novas. Falhas simultâneas nas duas lojas, desconexão do Chrome ou repetição de timeout do protocolo podem reiniciar o navegador de monitoramento compartilhado uma vez por recuperação. Cada loja revalida sua sessão ao retomar. O histórico em `.data/monitoring/events.jsonl` registra a falha, a ação de recuperação e o código de rede ou HTTP quando disponível.

server/ml-v3-core.mjs contém as funções extraídas da v3, sem executar a bateria. As adaptações incluem vendedor esperado por produto, extração de entrega/reputação e remoção de diagnósticos com texto privado da página. Os arquivos originais foram preservados.

## Contas: dois perfis Chrome

Há somente dois perfis em uso pelo painel:

| Perfil | Logins | Pasta |
| --- | --- | --- |
| Monitoramento | Amazon e Mercado Livre | Mercado_Livre/perfis/ml-chrome-headless-v3 |
| Compra | Amazon e Mercado Livre | interface/.data/chrome-profiles/purchase |

O perfil de monitoramento reaproveita a sessão ML v3 existente. Faça o login Amazon também nesse perfil. O perfil de compra é separado: faça nele os dois logins de compra. Nenhum perfil pessoal do Chrome é utilizado e não é necessário conectar uma conta Google nem ativar sincronização.

Os quatro botões permanecem, um por loja/finalidade. Cada botão abre a loja em uma aba do perfil correspondente. Botões da mesma finalidade compartilham o mesmo processo Chrome e os mesmos dados de perfil. Fechar a preparação de uma loja fecha somente sua aba; o navegador permanece enquanto houver outra aba ou monitor usando o perfil.

Faça login manualmente e encerre as abas de preparação de monitoramento antes de iniciar os coletores. O painel não lê sua senha nem considera a existência do perfil como prova de autenticação. Enquanto qualquer monitor estiver ativo, a preparação do perfil de monitoramento fica bloqueada para ambas as lojas.

Amazon e ML monitoram em abas separadas de um único navegador headless, compartilhando o perfil Monitoramento. O navegador só é encerrado quando o último monitor o libera. Uma falha ou parada de um monitor fecha somente as abas que ele criou; a outra loja continua. Não execute a bateria ML v3 externa simultaneamente, pois ela usa o mesmo perfil.

O perfil Compra é independente do Monitoramento. Encerre as abas de preparação do perfil Compra para liberar a geração automática de Pix. Somente preparar os logins não inicia compras: é preciso ativar a geração de Pix nas configurações ML e a compra em cada produto.

As pastas dos perfis individuais da versão anterior foram preservadas, mas não são mais usadas pelo painel. Nenhum cookie ou login foi copiado automaticamente entre finalidades. Caso tenha feito login Amazon no perfil individual anterior, faça-o novamente no perfil Monitoramento compartilhado.

## Produtos e horários

- Até 10 anúncios por plataforma, validados no serviço local.
- Catálogos ML precisam da oferta selecionada: parâmetro pdp_filters=item_id:MLB…; catálogo sem identidade de oferta é rejeitado.
- O cadastro aceita ID de vendedor esperado no ML. Quando informado, outro vendedor gera **Oferta divergente**, sem disponibilidade. A lista da v3 mantém o vendedor 768826009 e o anúncio originalmente monitorado do Greninja; não troca silenciosamente pela oferta de outro vendedor. Os nomes de Lapras Day e Espeon Day foram corrigidos conforme o relato do teste.
- **Último monitoramento:** data e hora da última leitura interpretada com sucesso, em Brasília, com segundos. Produtos novos mostram **Ainda não consultado**.
- Falhas preservam preço e horário anteriores, marcam **Leitura desatualizada** e exibem horário e causa da tentativa com erro. Falha na preparação da loja não inventa consultas para seus produtos.
- Ausência na primeira página Amazon é **Não observado**, nunca prova de esgotamento.
- Preços sem frete; frete desconhecido permanece **não informado**. O ML fornece o ID do vendedor, shipping_mode/logistic_type, reputation_level e power_seller_status. A modalidade de entrega e a reputação são exibidas quando fornecidas, depois da validação de identidade.
- Alertas aparecem no painel e, quando habilitados, em notificações nativas fixas. A disponibilidade exige duas leituras válidas consecutivas; erros e divergências de identidade interrompem a confirmação. O estado é persistido. A Amazon também mantém os eventos próprios do núcleo.
- Pare o monitoramento antes de editar produtos ou regras, mantendo configuração estável durante cada execução.

## Dados locais

.data/registry.json armazena produtos, regras, leituras, horários e últimos eventos por gravação atômica. .data/amazon é o FileStore exclusivo da interface, separado dos dados do monitor antigo. O serviço impede duas instâncias no mesmo cadastro. Reinicia parado e preserva as últimas leituras.

O serviço escuta somente em 127.0.0.1, confere Host/Origin, exige token para alterações e serve apenas HTML/CSS/JS da interface. Perfis, dados e código do servidor não são publicados pela página. O runtime Electron é usado somente nas notificações nativas; a página não carrega bibliotecas externas.

Os exemplos fictícios da interface 0.1 não são importados para o monitor real. Preferências antigas permanecem no navegador da versão anterior; o cadastro atual é independente.

## Verificação

Na pasta interface, execute **npm test** para os testes offline. Usam transporte injetado, servidores locais e HTML salvo, sem login nem consultas às lojas. Acesso autenticado ML precisa ser verificado após a preparação manual do perfil.

O núcleo Amazon mantém sua suíte em Amazon/amazon-monitor-core. O replay dos JSONL reais é executado sem rede. Aprovação offline não comprova estabilidade de uma sessão online prolongada.

## Título e imagem a partir do monitoramento

A extração ocorre no serviço local, com Cheerio já instalado no núcleo Amazon. Não executa scripts das páginas nem faz uma consulta extra à loja.

- Amazon AOD: título em #aod-asin-title e imagem em img#aod-asin-image-id. Os três HTMLs Amazon salvos contêm ambos. A resposta é associada ao ASIN da consulta.
- Mercado Livre: título em .ui-pdp-title (alternativas h1 e twitter:title); imagem em og:image, galeria ou twitter:image. Os arquivos Moltres e Bota comprovam esses campos. Apenas o Moltres integra a lista dos dez produtos da bateria v3; a Bota não é adicionada além do limite.
- Metadados ML só são aplicados depois da conferência de identidade do anúncio e vendedor. Oferta divergente nunca substitui o título ou a foto do produto correto.
- O nome manual permanece como alias. O título extraído é exibido no cartão e também participa da busca. O título não altera preço, disponibilidade, regras ou identidade.
- Imagens aceitas somente por HTTPS nos CDNs de produtos Amazon e ML. Sem imagem, ou se a imagem falhar, a ilustração local é mantida. O carregamento não envia o endereço do painel como referência.

A importação desta versão cadastrou os 20 produtos das baterias (10 por plataforma). Os três HTMLs Amazon e o HTML Moltres permitem preencher de imediato título e imagem de quatro produtos. Os demais ficam com o nome do teste e a imagem padrão até a próxima coleta válida. Os arquivos antigos não são apresentados como leituras atuais: último monitoramento permanece sem data até uma consulta real pelo painel.

Para repetir a importação offline, com o serviço parado, execute **node server/import-test-products.mjs** na pasta interface. O script preserva regras e metadados já obtidos pelo monitor, não inicia coleta e não copia cookies. O botão Carregar lista do projeto continua disponível para repor anúncios ausentes sem duplicar os existentes.

## Compra automática no Mercado Livre

A compra começa desativada. Configure o preço limite **por unidade** e a quantidade desejada em cada produto, marque **Comprar automaticamente** e ative a compra em **Configurações → Mercado Livre → Compra automática**. Escolha Pix ou cartão de crédito salvo e inicie o monitoramento.

Ao terminar o ciclo de leitura das plataformas, o sistema agrupa os produtos ML elegíveis com leituras recentes e disponibilidade confirmada. Revalida as ofertas no perfil Compra, adiciona ao carrinho e ajusta a quantidade absoluta. Se pedir 3 e o carrinho confirmar somente 2 disponíveis, usa 2. Os demais produtos do carrinho ficam desmarcados, sem serem removidos.

O envio escolhido é o mais barato entre as opções habilitadas, com o menor prazo em caso de empate. Preços antigos riscados não contam. As configurações permitem exigir frete grátis no extrato do carrinho e confirmar no checkout, definir teto de frete por pedido e incluir o frete no limite por unidade. O frete compartilhado é rateado proporcionalmente ao subtotal em centavos exatos, inclusive após redução de quantidade.

O fluxo confere carrinho, vendedor, quantidades, preços individuais, frete e total antes de clicar uma vez em **Pagar e finalizar**. O Pix fica disponível no painel quando o código e seu valor são verificados. Para pagar com cartão à vista, informe os quatro últimos dígitos de um cartão salvo na conta do perfil Compra. Quando solicitado pelo Mercado Livre, digite o código de segurança na própria janela de compra. O painel marca o pagamento no cartão como confirmado quando o checkout informa a aprovação.

O painel Pedidos Pix mostra produtos, quantidade efetiva, total e código para copiar. Pedidos pendentes, bloqueados ou de resultado incerto não são repetidos automaticamente. Após reinício, uma execução interrompida exige revisão manual em Minhas compras. Já revisei desativa a compra automática dos produtos; não paga nem cancela pedidos na plataforma. Parar monitoramento também interrompe a preparação de compra.

Os parsers foram verificados com HTML fornecido e capturas autenticadas do carrinho e da entrega. O fluxo completo foi testado em Chrome real, com todas as respostas interceptadas e Pix fictício, sem pedidos reais. A revisão de lotes usa os itens com preço, vendedor e quantidade do estado FLOX do checkout, corroborados pelos respectivos pacotes de entrega. Evidências conflitantes ou formatos desconhecidos interrompem o fluxo para revisão manual.

## Notificações fixas do Windows

Alerta de disponibilidade gera uma notificação nativa após confirmação em duas leituras, mesmo sem o painel aberto. Também há notificações de Pix gerado e compra interrompida, além do botão Testar notificação. O envio e seu resultado ficam registrados para evitar repetição do mesmo evento.

O componente usa Electron Notification com timeoutType never, como o alerta de CAPTCHA do CEPO. O teste real foi confirmado pelo usuário. Clicar abre o painel local; o X fecha. O runtime está em .runtime/electron, separado do CEPO, com suas licenças preservadas. O serviço confirma o evento show, e registra falha caso a notificação não seja exibida.

## Atualização de título e foto

Cada consulta continua lendo o HTML necessário ao monitoramento. O parser compara o título e a URL da imagem já presentes nesse HTML, sem requisição extra de metadados. Somente valores diferentes alteram o cadastro e a data de atualização dos metadados. Ausência temporária de metadados mantém os valores anteriores.

O painel mantém os mesmos elementos de título e foto ao atualizar preço, disponibilidade e horários. A foto só é substituída quando sua URL muda; não é recriada a cada atualização do painel. Uma reabertura da página ou uma troca de filtro pode carregar a imagem novamente conforme o cache normal do navegador. Mudanças no arquivo de imagem mantendo exatamente a mesma URL dependem da política de cache da loja.

## Configurações de disponibilidade por loja

A janela Configurações possui abas **Amazon** e **Mercado Livre**. Os filtros começam desativados e são salvos no serviço local. Pare o monitoramento antes de alterá-los.

- Amazon: **Considerar disponibilidade apenas de produtos vendidos e entregues pela Amazon?** Quando ativo, somente ofertas AMAZON_DIRETA qualificam. Terceiros enviados pela Amazon não qualificam. O preço exibido passa a ser o da menor oferta direta válida, mesmo que exista terceiro mais barato. A seleção também é aplicada às regras de alvo do núcleo AOD.
- Mercado Livre: o critério de cor e o critério MercadoLíder são independentes. Verde (5_green) é o padrão do critério de cor. A medalha mínima pode ser MercadoLíder (silver ou superior), Gold ou Platinum. Marque apenas um critério para usá-lo sozinho; com ambos ativos, escolha **E** (exigir os dois) ou **OU** (aceitar qualquer um).
- Informações ausentes não satisfazem o respectivo critério ativo. A medalha não é usada como prova de cor verde. A validação de identidade do anúncio e vendedor continua obrigatória, independentemente dos filtros.
- A disponibilidade observada é preservada em rawAvailable. Ofertas disponíveis na loja, mas rejeitadas pelas regras, aparecem como **Fora do filtro**, não como falta de estoque. Não contam como disponíveis nem geram alerta de disponibilidade ou de preço elegível.
- A lista possui **Apenas disponíveis**, que respeita os critérios das lojas e exclui leituras desatualizadas. Desmarcar permite consultar também os itens indisponíveis, desconhecidos e fora do filtro.

Modalidades ML reconhecidas incluem Mercado Envios Full (fulfillment), Coleta (cross_docking), agência/postagem e Flex. Esses códigos identificam a logística, sem inventar o nome da transportadora final. Nos HTMLs salvos, Moltres tem Full, 5_green e Platinum; Bota tem Coleta, 5_green e Platinum. O Moltres pode exibir esses dados arquivados antes da nova consulta, com indicação HTML salvo.

Referências: [Reputação de vendedores](https://developers.mercadolivre.com.br/pt_br/produto-consulta-de-usuarios/reputacao-de-vendedores) e [Mercado Envios 2](https://developers.mercadolivre.com.br/en_us/mercadoenvios-mode-2).

## Editar um produto

O botão de lápis no cartão abre a edição de nome, link, preço limite e vendedor esperado. A loja permanece fixa. Links inválidos e anúncios duplicados são rejeitados pelo serviço. Alterar parâmetros do mesmo anúncio preserva suas leituras. Ao trocar de anúncio, catálogo ou vendedor esperado, limpa preço, disponibilidade, metadados, reputação e horários anteriores; preserva nome, preço limite e alerta, mas desativa a preferência de compra automática. A nova leitura deve preencher os dados do anúncio correto. Os eventos e arquivos históricos continuam preservados.

## Nome do vendedor no Mercado Livre

O parser procura o nome em seller_summary.seller.name e em seller_data/seller_header (alternativa shop_name). O nome só é usado quando o bloco pertence ao mesmo seller_id e, quando fornecido, ao mesmo item_id da oferta. O ID permanece em sellerId e na validação interna; não é apresentado como nome de loja. Na falta de nome válido, a interface mostra Não informado. Melhorias no nome exibido não geram alertas de mudança de vendedor, que continuam vinculados ao ID.

O limite do cadastro é por plataforma: 10 anúncios Amazon e 10 anúncios Mercado Livre, independentemente de quantas lojas ou vendedores apareçam nesses anúncios.


## Verificação do navegador no Mercado Livre

Na rota `/captcha/wall`, o monitor aguarda até 15 segundos enquanto a página executa a verificação do navegador. Se o anúncio esperado carregar, a consulta continua. A presença de um CAPTCHA interativo ou o fim do prazo interrompe a consulta do Mercado Livre.

Depois de duas verificações locais consecutivas indicando uma página normal, anúncios, quantidades, preços e carrinho são conferidos novamente. Durante a pausa não há inclusão de produtos, ajuste de quantidade ou finalização. Parar monitoramento cancela a espera; fechar o navegador interrompe a tentativa. O perfil fica reservado ao lote durante toda a pausa.

Na compra, a mesma espera ocorre antes de solicitar intervenção. O Pix começa com o navegador oculto e reabre o perfil Compra em uma janela visível quando necessário. O cartão já começa em uma janela visível para permitir a verificação do pagamento. Se houver intervenção após o clique final, o sistema aguarda a confirmação do pedido e mantém resultados incertos para revisão em **Minhas compras**.


## Monitoramento pausado durante a compra

Antes de abrir o lote de compra, novas consultas da Amazon e do Mercado Livre são suspensas, e o sistema aguarda terminar qualquer consulta que já estava em andamento. O painel mostra Monitoramento pausado durante a compra. A pausa continua no CAPTCHA ou login, mesmo que o usuário leve vários minutos para resolver. Ao terminar ou interromper a preparação do pedido, os monitores são liberados; Parar monitoramento cancela também as consultas que aguardavam essa liberação.

A identificação de CAPTCHA pela rota não depende da execução de scripts da página. Se a navegação expirar numa página de desafio, a janela ainda é restaurada e a intervenção humana é solicitada. O teste de restauração da janela real do perfil Compra e o alerta nativo foram confirmados pelo usuário.


O frete é validado no extrato do carrinho (cart-list), para os produtos selecionados e as quantidades efetivas, e conferido novamente na etapa de entrega do checkout. A página do produto não é usada como prova de gratuidade. A notificação fixa Compra iniciada aparece antes de abrir a preparação do lote.


## Extrato econômico do carrinho

A projeção reutiliza o contrato estudado em CEPO/agent/src/coupon-validator/manual-validator-page.js e confirmed-offer.js. Cada GET de /gz/cart/v3/api/cart-list fornece a seleção completa, as quantidades, os preços unitários, o resumo de produtos, frete atual, descontos, campanhas de cupom e total. Nenhuma consulta adicional é feita para cada campo. As leituras de estabilização e a revalidação final repetem o GET completo para detectar mudanças. O contador active_and_selected_items_size representa unidades, e não a quantidade de anúncios distintos.

O valor de frete usa a entrada atual price da linha shipping e a confirmação de tracking.summary.shipping_total. Entradas original/previous são ignoradas. Cupons exigem campanha aplicada, mínimo atendido, contagem e valores conciliados; descontos sem classificação ou estruturas desconhecidas interrompem o fluxo. Um cupom pode reduzir o total sem permitir exceder o limite conservador de preço unitário do produto.

Depois da aprovação do carrinho, o sistema aguarda a etapa de entrega carregar e escolhe o envio mais barato; em empate, o de menor prazo. Frete e limites são verificados novamente após a seleção e antes da finalização. Os nomes acessíveis das opções evitam duplicação de texto que prejudicava a leitura de amanhã no checkout capturado.

Capturas de diagnóstico ficam em .data/diagnostics e não são servidas pelo painel nem incluídas nos testes. Foram salvos o HTML completo do produto, carrinho, extrato JSON e etapa de entrega do checkout. O diagnóstico foi interrompido antes de selecionar pagamento ou gerar pedido. Os testes usam apenas trechos de entrega e um extrato reduzido sem endereço nem dados de sessão.


## Procedimento de compra aprovado (0.8)

1. Terminar o ciclo de leitura das plataformas e reunir os anúncios ML habilitados e elegíveis.
2. Pausar novas consultas nas duas plataformas, aguardar as que estavam em andamento e emitir Compra iniciada.
3. Abrir o perfil Compra em headless, separado do Monitoramento.
4. Revalidar anúncio, variação, vendedor, regras de reputação, disponibilidade e preço.
5. Adicionar os produtos ausentes por clique real e ajustar a quantidade absoluta. Comprar a quantidade parcial confirmada quando o estoque for menor.
6. Selecionar somente o lote e desmarcar os demais itens, sem removê-los.
7. Conferir o extrato cart-list: produtos, quantidades, preços, campanhas, descontos, frete e total, incluindo limites por unidade e regras de frete. Duas leituras coerentes confirmam a estabilização.
8. Clicar em Continuar pelo Puppeteer e aguardar a navegação e o carregamento da entrega. O href é validado, mas não é usado para navegação direta.
9. Selecionar o frete mais barato; em empate, o menor prazo. Usar clique real e conferir a seleção e a economia novamente.
10. Clicar em Mostrar mais ou Mostrar todos quando necessário, aguardar o modal e selecionar Pix com clique real. O modal de pagamentos tem prioridade sobre o cartão selecionado ao fundo.
11. Clicar em Continuar no pagamento e aguardar a revisão final.
12. Revalidar identidades, vendedores, quantidades, preços individuais, descontos, frete e total. Ler novamente o carrinho sem alterar a página de revisão.
13. Persistir a intenção de finalizar e clicar uma única vez em Pagar e finalizar pelo Puppeteer.
14. Confirmar o código Pix, seu valor e checksum; disponibilizar no painel e emitir a notificação fixa. O pagamento permanece manual.

CAPTCHA em qualquer etapa pausa o lote e mantém os monitores suspensos. Antes de finalizar, a resolução reinicia somente a conferência e o ajuste absoluto do carrinho, sem adicionar novamente itens já presentes. Após o clique final, apenas a confirmação do Pix pode continuar: não se repete o clique nem se reinicia o lote. Parar monitoramento cancela a espera. Reinícios ou resultados incertos exigem revisão manual.

Todos os botões e opções (adicionar, seleção do carrinho, frete, Mostrar mais/todos, Pix, Continuar e Pagar e finalizar) usam ElementHandle.click(). A aba é ativada antes do input, inclusive em headless, para permitir as verificações de visibilidade do Puppeteer e evitar o timeout de IntersectionObserver em segundo plano. Não há HTMLElement.click(), dispatchEvent ou atribuição de checked para substituir ações do usuário. A leitura de HTML usa DOM.getDocument/DOM.getOuterHTML, sem depender do contexto JavaScript transitório do checkout.

Ao terminar ou falhar, o navegador exclusivo da compra é encerrado. Se o encerramento normal falhar, somente o processo exato criado pelo lançador é encerrado. Não há busca ou encerramento de Chrome pessoal. Falhas registram a etapa e o detalhe técnico no pedido.

### Teste completo sem compras reais

Com MONITOR_PROJECT_ROOT apontando para a raiz do projeto e VIGIA_BROWSER_TESTS=1, execute node --test test/*.test.mjs na pasta interface. Os testes de navegador criam um perfil temporário, interceptam todas as requisições e usam um Pix fictício. Validam lote com dois produtos, pedido de 3 unidades reduzido para 2, produto alheio desmarcado, frete gratuito mais rápido, as duas variantes de Mostrar mais/todos, cartão ao fundo do modal, Pix e uma única finalização. O perfil de teste é removido após o encerramento do Chrome.


## Transição de Mostrar mais / Mostrar todos (0.8.1)

O botão pode abrir opções no mesmo documento, recarregar a página, navegar para a página de pagamentos ou abrir uma nova aba. O clique físico é único. O sistema acompanha a aba resultante e aguarda a opção Pix. Se a aba de pagamentos fechar após Continuar, a revisão é procurada na página de checkout de origem.

Leituras e buscas de elementos interrompidas pela destruição do contexto durante uma navegação podem ser repetidas por tempo limitado. POSTs de quantidade, inclusões e cliques não usam essa repetição. Se a troca de contexto acontecer durante um clique, o sistema verifica seu resultado em vez de clicar novamente. Depois do clique final, continua apenas a busca do Pix.

A suíte de navegador cobre os quatro cenários, incluindo perda de contexto induzida durante a navegação. Todas as requisições ficam interceptadas e a finalização usa Pix fictício.


## Pix gerado e histórico recolhível (0.8.2)

Ao confirmar a geração do Pix, o sistema desmarca Comprar automaticamente somente nos produtos daquele pedido e salva as preferências junto com o pedido, antes da notificação. Os produtos continuam no cadastro, com seus alertas e monitoramento preservados. A preferência não é reativada ao revisar um pedido ou reiniciar o painel. Pedidos Pix pendentes de versões anteriores também desativam seus produtos durante a atualização; a correção é persistida antes de o serviço ficar disponível.

Pedidos Pix começa recolhido e mostra a contagem de pedidos e de códigos pendentes. A seção inteira e cada pedido podem ser expandidos separadamente. O resumo apresenta status, horário de Brasília, produtos, unidades e total. Valores detalhados, o código e a ação de copiar ficam dentro do pedido. O histórico usa rolagem interna para não empurrar a lista de produtos. A abertura da seção é lembrada neste navegador, e as expansões dos pedidos são preservadas durante as atualizações automáticas.


## Recuperação da trava Amazon (0.8.3)

Um encerramento abrupto pode deixar .data/amazon/monitor.lock com o PID de uma execução que não existe mais. A interface agora verifica esse registro ao abrir o serviço e antes de iniciar o monitor Amazon. Só recupera quando o processo está comprovadamente encerrado, a instância atual possui o service.lock exclusivo e o registro não mudou durante a conferência. A recuperação é serializada e arquiva a trava em monitor.lock.abandoned-PID-ID.json.

Processos vivos, permissões insuficientes ou arquivos de identificação inválidos não são removidos. Nesse caso, o painel informa a condição para evitar duas execuções gravando os mesmos dados. state.json, observations.jsonl e events.jsonl não são alterados pela recuperação. O núcleo Amazon original permanece na versão 0.3; a recuperação é feita pela integração da interface.


## Logs ML e edição durante o monitoramento (0.9)

Cada leitura do Mercado Livre é anexada a .data/ml/observations.jsonl, incluindo falhas, data UTC, ID do produto/anúncio, preço, disponibilidade, vendedor, entrega, ciclo, quantidade e limite efetivos. .data/ml/events.jsonl registra início, término e conclusão dos ciclos. Não são registrados HTML, cookies, tokens ou endereços. O histórico começa nesta versão: consultas anteriores não podem ser reconstruídas.

Durante o monitoramento, nome, link, vendedor esperado, quantidade, limite por unidade e preferências podem ser editados. O cadastro guarda a edição como pendente; o painel mostra Alteração salva · próximo ciclo. Cada plataforma aplica suas edições antes de começar seu próximo ciclo, com um snapshot estável até o fim. Uma compra iniciada ao terminar o ciclo usa as regras daquele ciclo. Alterações pendentes sobrevivem ao reinício e entram no primeiro ciclo seguinte. A troca de anúncio limpa os dados antigos quando aplicada e desativa a compra automática.

Adicionar/remover produtos e alterar configurações gerais ainda exige parar o monitoramento. Durante uma compra, a edição de produtos fica bloqueada. Editar não reinicia os coletores nem altera o intervalo de consulta.


## Histórico global de disponibilidade (0.10)

O botão Histórico global, acima dos produtos, abre a linha do tempo de disponibilidades confirmadas dentro dos filtros. A busca aceita nome, código do anúncio e vendedor. É possível filtrar plataforma, últimas 24 horas, 7 ou 30 dias e ordenar por horário ou menor preço. O resumo mostra eventos, produtos distintos e menor preço no recorte; os preços de produtos diferentes não representam uma evolução de preço de um único item. O ícone de relógio no produto abre seu próprio histórico.

Cada evento conserva o preço, frete quando informado, vendedor, entrega, reputação, quantidade, limite por unidade, link e filtros vigentes na confirmação. Os dados ficam em availabilityHistory dentro de .data/registry.json, separados da lista de eventos recentes, sem descarte ao atingir 100 eventos. Não são alterados por edições posteriores. Os registros começam nesta atualização; não se inventam dados para os eventos antigos. Ofertas fora dos filtros não geram registros. A confirmação usa duas leituras, funciona sem notificação ativada e não registra repetidamente uma oferta que permanece disponível.

## Sessão e histórico de pedidos

Antes do primeiro ciclo, cada loja verifica sua página de conta no perfil Monitoramento. Quando há produto com compra automática ativa e a compra está habilitada na loja, também verifica o perfil Compra. Se a sessão não puder ser confirmada, o painel informa o perfil a preparar nas Configurações e interrompe a partida dessa loja.

Após salvar o Pix ou a aprovação do cartão, o Vigia abre o histórico no perfil Compra e procura o identificador recebido no checkout. O painel mostra o resultado da conferência e o link para a loja. Se o histórico estiver indisponível, o pedido demorar a aparecer ou faltar um identificador, o resultado do checkout permanece salvo.

## Compra Amazon por Pix em headless (0.11.0)

O painel abre o perfil Compra em headless por padrão. Ao selecionar Pix, espera os botões de avanço ficarem desabilitados antes do clique no rádio e aguarda a liberação estável para continuar. O Vigia valida a revisão, confirma o pedido uma única vez e confere o valor do Pix capturado com o total do pedido. O painel registra Pix pendente e o pagamento é manual.

Inicie normalmente por `INICIAR-PAINEL.cmd`. Se a janela do PowerShell ainda tiver `VIGIA_AMAZON_TESTE_HEADLESS=1` de um teste anterior, remova a variável antes de abrir o painel. O valor `1` encerra o diagnóstico na revisão e o valor `0` abre uma janela visível. O valor `2` executa o mesmo fluxo headless padrão.

As falhas com uma aba de compra disponível geram um HTML em `.data/diagnostics`, com prefixo `amazon-headless-` ou `amazon-falha-`. O arquivo registra a rota sem identificadores, a etapa e a estrutura sanitizada da tela. Se o navegador não responder, o diagnóstico tenta usar a última leitura bem-sucedida. Para desativar a captura, inicie o serviço com `VIGIA_AMAZON_DIAGNOSTICS=0`.
