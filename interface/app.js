'use strict';
import { reconcileProductCards } from './cards.js';
// The local service owns products, collector state and timestamps.
const icons = {
  chevron:'<path d="m6 9 6 6 6-6"/>',
  copy:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4"/>',
  qr:'<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><path d="M15 15h3v3h3M15 21v-3M21 12v3M12 3v3M3 12h3m6 0v3"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-4-4L5 15Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/><path d="m12 12 7-7M12 3v2M3 12h2M12 19v2M19 12h2"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  settings: '<path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h5l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3Z"/><circle cx="11.5" cy="12" r="3"/>',
  box: '<path d="m3 7 9-4 9 4v11l-9 4-9-4Zm0 0 9 4 9-4M12 11v11M7 5l10 4"/>',
  check: '<path d="m7 12 3 3 7-7"/><circle cx="12" cy="12" r="9"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  bolt: '<path d="m14 2-10 12h7l-1 8 10-12h-7Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  play: '<path d="m8 4 12 8-12 8Z"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  shield: '<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6Z"/><path d="m8 12 3 3 5-6"/>',
  truck: '<path d="M2 5h12v12H2ZM14 9h4l4 4v4h-8"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
  shop: '<path d="M3 9h18l-2-6H5ZM4 9v12h16V9M9 21v-7h6v7"/><path d="M3 9c0 4 5 4 5 0 0 4 8 4 8 0 0 4 5 4 5 0"/>',
  external: '<path d="M14 3h7v7M21 3 11 13M10 3H4v17h17v-6"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
  flask: '<path d="M9 3h6M10 3v7L4 20h16l-6-10V3M7 15h10"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.box}</svg>`;
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = svg(el.dataset.icon); });
}
const $ = (id) => document.getElementById(id);
const themeSelect = $('theme-select');
const productList = $('product-list');
const productColumns = [...productList.querySelectorAll('.product-column')];
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const money = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const storeNames = { amazon: 'Amazon', ml: 'Mercado Livre' };
let products=[];
let monitoring=false;
let currentStore='all';
let removeId=null;
let editingId=null;
let state=null;
let token=null;
let busy=false;
let connected=false;
let serviceOutdated=false;
const requiredApiVersion=18;
const displayName=product=>product.name?.trim()||product.title||product.code;
const outdatedServiceMessage='Encerre a instância anterior do Vigia e execute INICIAR-PAINEL.cmd novamente.';
let toastTimer;
const seenEvents=new Set();
const failedImages=new Set();
let eventsPrimed=false;
const dateTime=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'medium'});
function formatTime(value){return value&&!Number.isNaN(Date.parse(value))?dateTime.format(new Date(value)):'Ainda não consultado';}
function toast(message){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;toastTimer=setTimeout(()=>{$('toast').hidden=true;},6000);}
async function api(path,method='GET',body){
  const response=await fetch('/api/'+path,{method,headers:method==='GET'?{}:{'Content-Type':'application/json','X-Vigia-Token':token},body:method==='GET'?undefined:JSON.stringify(body??{}),cache:'no-store'});
  const result=await response.json();
  if(!response.ok)throw new Error(response.status===404&&path==='settings'?'O serviço está desatualizado. Feche a janela do serviço e execute INICIAR-PAINEL.cmd novamente.':result.error??'O serviço local não respondeu.');
  return result;
}
function applyState(next){
  if(next.token)token=next.token;
  state=next;products=next.products;monitoring=next.running;serviceOutdated=!(next.apiVersion>=requiredApiVersion);connected=!serviceOutdated;
  for(const event of next.events??[]){
    if(!seenEvents.has(event.id)){
      seenEvents.add(event.id);
      const p=products.find(p=>p.id===event.productId);
      if(eventsPrimed&&p?.alert&&(p.target!=null?event.type==='ALVO_ATINGIDO':['AMAZON_DIRETA_AGORA_VISIVEL','DISPONIBILIDADE_CONFIRMADA'].includes(event.type)))toast(`Alerta: ${displayName(p)} · ${event.type==='ALVO_ATINGIDO'?'preço limite atingido':'disponibilidade observada'}`);
    }
  }
  if(next.appVersion&&$('app-version'))$('app-version').textContent=`Vigia · ${next.appVersion}`;
  eventsPrimed=true;
  render();updateMonitor();updateAccounts();renderPurchases();updateAuth();
}
async function action(path,method='POST',body){
  if(serviceOutdated)throw new Error(outdatedServiceMessage);
  if(busy)throw new Error('Aguarde a ação em andamento.');
  busy=true;updateStats();
  try{const next=await api(path,method,body);applyState(next);return next;}
  finally{busy=false;updateStats();}
}
function artwork(type) {
  const art = {
    watch:'<path d="m18 3-2 11m14-11 2 11M16 34l2 11m14-11-2 11"/><rect x="12" y="12" width="24" height="24" rx="5" fill="#ceccc2"/><rect x="16" y="17" width="16" height="12" rx="1" fill="#e4e6d9"/><path d="M19 24h3m2 0h5M19 21h3m2 0h5"/>',
    headphones:'<path d="M10 25v-4a14 14 0 0 1 28 0v4M14 21a10 10 0 0 1 20 0"/><rect x="7" y="22" width="9" height="17" rx="4" fill="#454d57"/><rect x="32" y="22" width="9" height="17" rx="4" fill="#454d57"/>',
    console:'<path d="M16 5c-4 12-4 25-1 36h15c-2-15-2-24 1-36Z" fill="#fdfdfd"/><path d="M20 5c-3 14-3 25-1 36M26 5c-2 13-2 24 0 36"/><path d="M31 32c-1-4 11-4 11 0l2 9c-1 4-5 0-7-1-2 1-6 5-7 1Z" fill="#e2e4e8"/><path d="M33 34h4m-2-2v4m5-2h.1"/>',
    cards:'<rect x="10" y="8" width="27" height="34" rx="2" fill="#e8b37a"/><path d="M10 15h27M10 36h27"/><rect x="15" y="19" width="17" height="13" rx="2" fill="#faf2d2"/><path d="m18 29 5-8 6 8Z"/>',
    speaker:'<rect x="9" y="7" width="28" height="35" rx="12" fill="#75828b"/><path d="M14 13h18M13 17h20M13 21h20M13 25h20M13 29h20M14 33h18M17 37h12" stroke="#a5afb5"/><rect x="19" y="21" width="9" height="8" rx="1" fill="#d9825e" stroke="none"/>',
    shoe:'<path d="m9 18 8-5 8 11 12 4 7 7-1 6H7c-5-1-4-7-2-10Z" fill="#fdfdfd"/><path d="M5 35h39M18 22l7-3M21 26l7-3M17 28c4 7 11 3 20 0"/>',
  };
  return `<svg viewBox="0 0 48 48" aria-hidden="true">${art[type] || '<rect x="9" y="10" width="30" height="30" rx="4"/><path d="M9 18h30M24 18v22M19 10v8"/>'}</svg>`;
}
function productEditLocked(){return Boolean(state?.purchases?.busy);}
function isLocked(){return monitoring||Boolean(state?.purchases?.busy);}
const amazonPurchaseFields=['enabled','payment-method','card-last-four','free-shipping','max-shipping','include-shipping'].map(field=>'amazon-purchase-'+field);
function switchControl(p, key, label, icon) {
  return `<label class="control-label">${svg(icon)}${escapeHtml(label)}<span class="switch"><input type="checkbox" data-action="${key}" data-id="${escapeHtml(p.id)}" aria-label="${escapeHtml(label+' para '+displayName(p))}" ${p[key]?'checked':''} ${productEditLocked()?'disabled':''}><span class="switch-track"></span></span></label>`;
}
function productCard(p) {
  const status = p.error ? ['unknown','Leitura desatualizada'] : p.rawAvailable===true&&p.eligible===false ? ['unavailable','Fora do filtro'] : p.available === true ? ['available','Disponível'] : p.available === false ? ['unavailable','Indisponível'] : ['unknown',p.observation==='identity_mismatch'?'Oferta divergente':p.observation==='unknown_identity'?'Identidade não confirmada':p.lastCheckedAt?'Não observado':'Aguardando consulta'];
  const price = p.price === null ? '<div class="price empty">Preço não informado</div>' : `<div class="price"><small>R$</small>${money.format(p.price)}</div>`;
  return `<article class="product-card ${p.error?'has-error':''}" data-product="${escapeHtml(p.id)}" aria-label="${escapeHtml(displayName(p))}">
    <div class="product-main"><div class="product-art ${escapeHtml(p.art)}">${p.imageUrl&&!failedImages.has(p.imageUrl)?`<img class="product-photo" src="${escapeHtml(p.imageUrl)}" alt="${escapeHtml(displayName(p))}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`:''}${artwork(p.art)}</div><div class="product-info"><div class="product-tags"><span class="store-name ${p.store==='amazon'?'amazon':'ml'}">${storeNames[p.store]}</span><span class="sku">${escapeHtml(p.code)}</span>${p.pendingEdit?'<span class="sample-label">Alteração salva · próximo ciclo</span>':''}${p.sample?'<span class="sample-label">EXEMPLO</span>':''}</div><h3 class="product-title" title="${escapeHtml(displayName(p))}">${escapeHtml(displayName(p))}</h3><div class="seller-info"><span>${svg('shop')}Vendido por <strong>${escapeHtml(p.seller)}</strong></span><span>${svg('truck')}Entregue por <strong>${escapeHtml(p.delivery)}</strong></span>${p.store==='ml'?`<span class="reputation-label">Reputação: <strong>${escapeHtml(reputationLabel(p))}</strong>${p.sellerInfoSource==='saved-test-html'?' · HTML salvo':''}</span>`:''}</div><div class="last-check">${svg('clock')}<span>Último monitoramento: <strong>${escapeHtml(formatTime(p.lastCheckedAt))}</strong></span>${p.error?'<span class="stale-tag">Desatualizado</span>':''}${p.eligibilityReason?`<span class="eligibility-note">${escapeHtml(p.eligibilityReason)}</span>`:''}</div>${p.error?`<div class="product-error">Tentativa em ${escapeHtml(formatTime(p.lastAttemptAt))}: ${escapeHtml(p.error)}</div>`:''}</div><div class="price-area">${price}<div class="freight-note">Preço sem frete · ${p.freight==null?'frete não informado':'frete R$ '+money.format(p.freight)}</div><span class="badge ${status[0]}"><i class="status-dot ${p.available===true?'green':''}"></i>${status[1]}</span></div><div class="product-actions">${p.url?`<a class="icon-button" href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer" aria-label="Abrir ${escapeHtml(displayName(p))} na loja" title="Abrir na loja">${svg('external')}</a>`:''}<button class="icon-button" data-action="history" data-id="${escapeHtml(p.id)}" title="Histórico de disponibilidade" aria-label="Histórico de disponibilidade de ${escapeHtml(displayName(p))}">${svg('clock')}</button><button class="icon-button" ${productEditLocked()?'disabled':''} data-action="edit" data-id="${escapeHtml(p.id)}" aria-label="Editar ${escapeHtml(displayName(p))}" title="Editar produto">${svg('edit')}</button><button class="icon-button delete-button" ${isLocked()?'disabled':''} data-action="remove" data-id="${escapeHtml(p.id)}" aria-label="Remover ${escapeHtml(displayName(p))}" title="Remover produto">${svg('trash')}</button></div></div>
    <div class="product-controls">${switchControl(p,'alert','Alerta de disponibilidade','bell')}<span class="controls-divider"></span><label class="quantity-control">Quantidade<input class="quantity-input" type="number" min="1" max="100" step="1" data-action="quantity" data-id="${escapeHtml(p.id)}" value="${p.quantity??1}" ${productEditLocked()?'disabled':''} aria-label="Quantidade desejada para ${escapeHtml(displayName(p))}"></label><label class="target-control">Limite por unidade<span class="target-wrap"><span>R$</span><input class="target-input" ${productEditLocked()?'disabled':''} inputmode="decimal" maxlength="15" placeholder="Sem limite" data-action="target" data-id="${escapeHtml(p.id)}" value="${p.target===null?'':money.format(p.target)}" aria-label="Preço limite para ${escapeHtml(displayName(p))}"></span></label><span class="controls-divider"></span>${switchControl(p,'auto','Comprar automaticamente','bolt')}</div>
  </article>`;
}
function updateStats(){
  $('nav-count').textContent=products.length;$('total-badge').textContent=products.length;
  $('count-all').textContent=products.length;
  for(const store of ['amazon','ml']){
    const storeProducts=products.filter(p=>p.store===store);
    const counts={
      total:storeProducts.length,
      available:storeProducts.filter(p=>p.available===true&&!p.error&&p.eligible!==false).length,
      alerts:storeProducts.filter(p=>p.alert).length,
      auto:storeProducts.filter(p=>p.auto).length,
    };
    for(const [metric,count] of Object.entries(counts))$('stat-'+store+'-'+metric).textContent=String(count).padStart(2,'0');
    $('count-'+store).textContent=counts.total+'/10';
  }
  $('add-top').disabled=!connected||busy||monitoring||products.length>=20;
  $('import-products').disabled=!connected||busy||isLocked();
  $('empty-add').disabled=!connected||busy||isLocked();
  $('monitor-toggle').disabled=!connected||busy||(!monitoring&&!products.length);
  $('notification-test').disabled=!connected||busy;
  for(const id of [...amazonPurchaseFields,'amazon-only','ml-reputation-required','ml-leader-required','save-settings','purchase-enabled','purchase-payment-method','purchase-card-last-four','purchase-free-shipping','purchase-max-shipping','purchase-include-shipping'])$(id).disabled=!connected||busy||isLocked();
  $('ml-min-reputation').disabled=!connected||busy||isLocked()||!$('ml-reputation-required').checked;
  $('ml-min-leader').disabled=!connected||busy||isLocked()||!$('ml-leader-required').checked;
  $('ml-reputation-match').disabled=!connected||busy||isLocked()||!$('ml-reputation-required').checked||!$('ml-leader-required').checked;
  document.querySelectorAll('[data-settings-lock-note]').forEach(note=>{note.hidden=!isLocked();});
  document.querySelectorAll('.account-login').forEach(b=>{const store=b.dataset.account==='Amazon'?'amazon':'ml';const monitorBusy=b.dataset.purpose==='monitoramento'&&monitoring;b.disabled=!connected||busy||monitorBusy;});
}
function render(){
  const query=$('search').value.trim().toLocaleLowerCase('pt-BR');
  const visible=products.filter(p=>(!$('available-only').checked||(p.available===true&&!p.error&&p.eligible!==false))&&(currentStore==='all'||p.store===currentStore)&&`${p.name} ${p.title??''} ${p.code} ${p.seller}`.toLocaleLowerCase('pt-BR').includes(query));
  productList.classList.toggle('by-platform',currentStore==='all');
  let productRows=1;
  for(const column of productColumns){
    const offers=visible.filter(product=>product.store===column.dataset.store);
    productRows=Math.max(productRows,offers.length);
    column.hidden=visible.length===0||(currentStore!=='all'&&currentStore!==column.dataset.store);
    column.querySelector('.product-column-empty').hidden=offers.length>0;
    reconcileProductCards(column.querySelector('.product-grid'),offers,productCard);
  }
  productList.style.setProperty('--product-rows',String(productRows));
  $('empty-state').hidden=visible.length>0;
  $('empty-message').textContent=query?'Nenhum resultado para essa busca. Tente outro nome.':$('available-only').checked?'Nenhum produto disponível atende aos filtros atuais.':'Adicione um produto ou carregue os anúncios já usados nos testes do projeto.';
  $('empty-add').hidden=Boolean(query)||$('available-only').checked;
  $('list-summary').textContent=`Mostrando ${visible.length} de ${products.length} produto${products.length===1?'':'s'}`;
  updateStats();
}
function parseMoney(value){
  const clean=value.trim();if(!clean)return null;
  if(!/^(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?$/.test(clean))return NaN;
  const n=Number(clean.replaceAll('.','').replace(',','.'));return n>0&&n<=99999999.99?n:NaN;
}
function updateMonitor(){
  const shops=state?.shops??{};
  const errors=Object.values(shops).filter(s=>s.status==='error');
  const starting=Object.values(shops).some(s=>s.status==='starting');
  const reconnecting=Object.values(shops).some(s=>s.status==='reconnecting');
  const stopping=Object.values(shops).some(s=>s.status==='stopping');
  const paused=state?.monitoringPaused===true;
  document.querySelector('.monitor-bar').classList.toggle('running',monitoring);
  document.querySelector('.monitor-console').classList.toggle('sweeping',connected&&monitoring&&!paused&&!starting&&!reconnecting&&!stopping);
  $('monitor-title').textContent=serviceOutdated?'Serviço precisa ser reiniciado':!connected?'Serviço local desconectado':stopping?'Encerrando monitoramento':reconnecting?'Reconectando o monitoramento':starting?'Preparando os monitores':paused?'Monitoramento pausado durante a compra':monitoring?'Monitoramento em andamento':errors.length?'Monitoramento requer atenção':'Tudo pronto para começar';
  $('monitor-state').textContent=!connected?'Offline':stopping?'Parando':reconnecting?'Reconectando':starting?'Iniciando':paused?'Pausado':monitoring?'Ativo':errors.length?'Interrompido':'Parado';
  $('monitor-state').className='badge '+(monitoring?'available':errors.length?'unavailable':'neutral');
  $('monitor-description').textContent=serviceOutdated?outdatedServiceMessage:!connected?'Abra INICIAR-PAINEL.cmd para conectar o serviço local.':'Amazon e Mercado Livre · atualizações a cada 15 segundos';
  $('monitor-toggle').innerHTML=svg(monitoring?'stop':'play')+`<span>${monitoring?'Parar monitoramento':'Iniciar monitoramento'}</span>`;
  $('monitor-toggle').setAttribute('aria-pressed',String(monitoring));
  $('shop-status').innerHTML=['amazon','ml'].map(s=>`<div class="shop-status ${shops[s]?.status==='error'?'shop-error':''}"><strong>${storeNames[s]}</strong><span>${escapeHtml(shops[s]?.message??'Serviço não conectado.')}</span></div>`).join('');
  if(state?.storageError)$('monitor-description').textContent=state.storageError;
}
function updateAccounts(){
  document.querySelectorAll('.account-login').forEach(b=>{
    const store=b.dataset.account==='Amazon'?'amazon':'ml';
    const purpose=b.dataset.purpose==='compra'?'purchase':'monitor';
    const account=state?.accounts?.[store+'/'+purpose];
    const preparing=['open','opening'].includes(account?.status);
    b.innerHTML=(preparing?'Encerrar preparação':'Abrir perfil')+svg('external');
    b.dataset.loginOpen=preparing?'true':'false';
    const status=b.closest('.account-session').querySelector('small');
    status.textContent=preparing?'Perfil aberto · faça login':'Login não verificado';
  });
}
function setTabs(){document.querySelectorAll('.store-tab').forEach(b=>{const selected=b.dataset.store===currentStore;b.classList.toggle('active',selected);b.setAttribute('aria-selected',String(selected));b.tabIndex=selected?0:-1;});}
function updateCapacity(){
  const store=$('product-store').value;const count=products.filter(p=>p.store===store).length;
  $('capacity-note').textContent=`${count}/10 produtos na ${storeNames[store]}.`;
  $('product-url').placeholder=store==='amazon'?'https://www.amazon.com.br/dp/...':'https://produto.mercadolivre.com.br/...';
  $('seller-field').hidden=store!=='ml';
}
function openProductDialog(){
  editingId=null;$('product-store').disabled=false;$('product-dialog-title').textContent='Adicionar produto';$('product-submit').innerHTML=svg('plus')+'Adicionar ao radar';
  $('product-form').reset();$('product-name').placeholder='Título do anúncio';$('product-quantity').value='1';$('product-error').textContent='';
  const preferred=currentStore==='all'?'amazon':currentStore;
  $('product-store').value=products.filter(p=>p.store===preferred).length<10?preferred:preferred==='amazon'?'ml':'amazon';
  updateCapacity();$('product-dialog').showModal();
}
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>$(b.dataset.close).close()));
function applyTheme(value){
  const theme=value==='dark'?'dark':'light';
  document.documentElement.dataset.theme=theme;
  themeSelect.value=theme;
  document.querySelector('meta[name="theme-color"]').content=theme==='dark'?'#191a18':'#f4f3ef';
}
let savedTheme;
try{savedTheme=localStorage.getItem('vigia:theme');}catch{}
applyTheme(savedTheme);
themeSelect.addEventListener('change',()=>{
  applyTheme(themeSelect.value);
  try{localStorage.setItem('vigia:theme',themeSelect.value);}catch{}
});
document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}}));
['settings-top','nav-settings'].forEach(id=>$(id).addEventListener('click',()=>{
  loadSettingsForm();
  $('settings-dialog').showModal();
  document.querySelector('.settings-platforms .settings-tab.active').focus();
}));
$('nav-products').addEventListener('click',()=>{currentStore='all';$('search').value='';setTabs();render();window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});});
['add-top','empty-add'].forEach(id=>$(id).addEventListener('click',openProductDialog));
document.querySelectorAll('.store-tab').forEach(b=>b.addEventListener('click',()=>{currentStore=b.dataset.store;setTabs();render();}));
document.querySelector('.store-tabs').addEventListener('keydown',e=>{const tabs=[...document.querySelectorAll('.store-tab')],i=tabs.indexOf(document.activeElement);if(i<0||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();tabs[e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length].click();document.querySelector('.store-tab.active').focus();});
$('available-only').addEventListener('change',render);
$('search').addEventListener('input',render);$('product-store').addEventListener('change',updateCapacity);
$('product-form').addEventListener('submit',async e=>{
  e.preventDefault();const target=parseMoney($('product-target').value);
  if(Number.isNaN(target)){$('product-error').textContent='Use um preço maior que zero, como 1.299,90.';return;}
  try{
    const payload={name:$('product-name').value.trim(),url:$('product-url').value.trim(),target,quantity:Number($('product-quantity').value),expectedSellerId:$('product-seller').value.trim()||null};
    const editing=Boolean(editingId);if(!editing)payload.store=$('product-store').value;
    await action(editing?'products/'+encodeURIComponent(editingId):'products',editing?'PATCH':'POST',payload);
    $('product-dialog').close();toast(editing?(monitoring?'Alteração salva. Será aplicada no próximo ciclo.':'Produto atualizado. Outro anúncio exige uma nova leitura.'):'Produto adicionado. A próxima consulta preencherá os dados.');
  }catch(error){$('product-error').textContent=error.message;}
});
$('product-list').addEventListener('error',e=>{if(e.target.classList.contains('product-photo')){failedImages.add(e.target.src);e.target.hidden=true;}},true);
$('product-list').addEventListener('change',async e=>{
  const el=e.target,p=products.find(p=>p.id===el.dataset.id);if(!p)return;
  let patch;
  if(el.dataset.action==='quantity'){const quantity=Number(el.value);if(!Number.isInteger(quantity)||quantity<1||quantity>100){toast('Use uma quantidade inteira entre 1 e 100.');render();return;}patch={quantity};}
  else if(el.dataset.action==='target'){const value=parseMoney(el.value);if(Number.isNaN(value)){toast('Preço não salvo. Use um valor como 1.299,90.');render();return;}patch={target:value};}
  else if(['alert','auto'].includes(el.dataset.action)){if(el.dataset.action==='auto'&&el.checked&&p.target===null){el.checked=false;toast('Defina primeiro um preço limite.');return;}patch={[el.dataset.action]:el.checked};}
  else return;
  try{await action('products/'+encodeURIComponent(p.id),'PATCH',patch);if(monitoring)toast('Alteração salva para o próximo ciclo.');else if(patch.auto)toast('Produto habilitado. Confira a compra automática nas configurações da loja.');}
  catch(error){toast(error.message);render();}
});
$('product-list').addEventListener('click',e=>{
  const b=e.target.closest('button[data-action]');if(!b)return;const p=products.find(p=>p.id===b.dataset.id);if(!p)return;
  if(b.dataset.action==='history'){void showAvailabilityHistory(p);return;}
  if(b.dataset.action==='edit'){
    editingId=p.id;$('product-form').reset();$('product-store').value=p.store;$('product-store').disabled=true;
    $('product-url').value=p.url;$('product-name').value=p.name??'';$('product-name').placeholder=p.title||'Título do anúncio';$('product-target').value=p.target===null?'':money.format(p.target);$('product-seller').value=p.expectedSellerId??'';$('product-quantity').value=String(p.quantity??1);
    $('product-error').textContent='';$('product-dialog-title').textContent='Editar produto';$('product-submit').innerHTML=svg('check')+'Salvar alterações';updateCapacity();$('product-dialog').showModal();
  }else if(b.dataset.action==='remove'){removeId=p.id;$('remove-message').textContent=displayName(p);$('remove-dialog').showModal();}
});
$('confirm-remove').addEventListener('click',async()=>{try{await action('products/'+encodeURIComponent(removeId),'DELETE');$('remove-dialog').close();toast('Produto removido.');}catch(error){toast(error.message);}});
$('monitor-toggle').addEventListener('click',async()=>{
  const stopping=monitoring;
  if(stopping){$('monitor-state').textContent='Parando…';$('monitor-toggle').disabled=true;}
  try{await action('monitor/'+(stopping?'stop':'start'));toast(stopping?'Monitoramento encerrado.':'Monitoramento solicitado. Acompanhe o estado de cada loja.');}
  catch(error){toast(error.message);}
});
$('import-products').addEventListener('click',async()=>{try{await action('import');toast('Lista do projeto carregada, sem duplicar os anúncios existentes.');}catch(error){toast(error.message);}});
document.querySelectorAll('.account-login').forEach(b=>b.addEventListener('click',async()=>{
  const store=b.dataset.account==='Amazon'?'amazon':'ml';
  const purpose=b.dataset.purpose==='compra'?'purchase':'monitor';
  const closing=b.dataset.loginOpen==='true';
  try{
    await action('accounts/'+store+'/'+purpose+'/'+(closing?'close':'open'));
    toast(closing?'Preparação encerrada. A sessão fica salva somente neste perfil.':'Faça login manualmente no perfil aberto. Depois encerre a preparação.');
  }catch(error){toast(error.message);}
}));

function reputationLabel(p){
  const levels={'1_red':'Vermelha','2_orange':'Laranja','3_yellow':'Amarela','4_light_green':'Verde-claro','5_green':'Verde'};
  const medals={silver:'MercadoLíder',gold:'MercadoLíder Gold',platinum:'MercadoLíder Platinum'};
  return [levels[p.reputationLevel],medals[p.powerSellerStatus]].filter(Boolean).join(' · ')||'Não informada';
}
function loadSettingsForm(){
  const rules=state?.settings;$('amazon-only').checked=rules?.amazon.onlyAmazon??false;
  const amazonPurchase=rules?.amazon.purchase??{};
  $('amazon-purchase-enabled').checked=amazonPurchase.enabled??false;
  $('amazon-purchase-payment-method').value=amazonPurchase.paymentMethod??'pix';
  $('amazon-purchase-card-last-four').value=amazonPurchase.cardLastFour??'';
  updateAmazonCardField();
  $('amazon-purchase-free-shipping').checked=amazonPurchase.freeShippingOnly??false;
  $('amazon-purchase-max-shipping').value=amazonPurchase.maxShippingCents==null?'':money.format(amazonPurchase.maxShippingCents/100);
  $('amazon-purchase-include-shipping').checked=amazonPurchase.includeShipping??false;
  $('ml-reputation-required').checked=rules?.ml.requireReputation??false;$('ml-min-reputation').value=rules?.ml.minReputation??'5_green';$('ml-leader-required').checked=rules?.ml.requireLeader??false;$('ml-min-leader').value=rules?.ml.minLeader??'silver';$('ml-reputation-match').value=rules?.ml.matchMode??'all';const purchase=rules?.ml.purchase??{};$('purchase-payment-method').value=purchase.paymentMethod??'pix';$('purchase-card-last-four').value=purchase.cardLastFour??'';updateCardField();$('purchase-enabled').checked=purchase.enabled??false;$('purchase-free-shipping').checked=purchase.freeShippingOnly??false;$('purchase-max-shipping').value=purchase.maxShippingCents==null?'':money.format(purchase.maxShippingCents/100);$('purchase-include-shipping').checked=purchase.includeShipping??false;
  $('settings-error').textContent='';updateStats();
}
function selectSettingsTab(selected){
  if(selected.getAttribute('aria-selected')==='true')return;
  for(const tab of selected.parentElement.children){
    const active=tab===selected;
    $(tab.getAttribute('aria-controls')).hidden=!active;
    tab.classList.toggle('active',active);
    tab.setAttribute('aria-selected',String(active));
    tab.tabIndex=active?0:-1;
  }
  $('settings-dialog').querySelector('.dialog-body').scrollTop=0;
}
document.querySelectorAll('.settings-tabs').forEach(tablist=>{
  const tabs=[...tablist.children];
  tabs.forEach(tab=>tab.addEventListener('click',()=>selectSettingsTab(tab)));
  tablist.addEventListener('keydown',e=>{
    const index=tabs.indexOf(e.target);
    if(index<0||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
    e.preventDefault();
    const last=tabs.length-1;
    const next=e.key==='Home'?0:e.key==='End'?last:(index+(e.key==='ArrowRight'?1:last))%tabs.length;
    selectSettingsTab(tabs[next]);
    tabs[next].focus();
  });
});
$('ml-reputation-required').addEventListener('change',updateStats);
$('ml-leader-required').addEventListener('change',updateStats);
function updateAmazonCardField(){$('amazon-purchase-card-field').hidden=$('amazon-purchase-payment-method').value==='pix';}
$('amazon-purchase-payment-method').addEventListener('change',updateAmazonCardField);
function updateCardField(){$('purchase-card-field').hidden=$('purchase-payment-method').value==='pix';}
$('purchase-payment-method').addEventListener('change',updateCardField);
function readFreight(id){
  const value=$(id).value.trim();
  return !value?null:/^0(?:,0{1,2})?$/.test(value)?0:parseMoney(value);
}
$('save-settings').addEventListener('click',async()=>{
  const maxShipping=readFreight('purchase-max-shipping');
  const amazonMaxShipping=readFreight('amazon-purchase-max-shipping');
  const amazonPaymentMethod=$('amazon-purchase-payment-method').value;
  const amazonCardLastFour=amazonPaymentMethod==='pix'?null:$('amazon-purchase-card-last-four').value.trim();
  const paymentMethod=$('purchase-payment-method').value;
  const cardLastFour=paymentMethod==='pix'?null:$('purchase-card-last-four').value.trim();
  const invalidField=Number.isNaN(amazonMaxShipping)?$('amazon-purchase-max-shipping'):
    amazonCardLastFour!==null&&!/^\d{4}$/.test(amazonCardLastFour)?$('amazon-purchase-card-last-four'):
    Number.isNaN(maxShipping)?$('purchase-max-shipping'):
    cardLastFour!==null&&!/^\d{4}$/.test(cardLastFour)?$('purchase-card-last-four'):null;
  if(invalidField){
    const shop=invalidField.id.startsWith('amazon-')?'amazon':'ml';
    selectSettingsTab($('settings-tab-'+shop));
    selectSettingsTab($('settings-tab-'+shop+'-purchase'));
    $('settings-error').textContent=invalidField.id.endsWith('max-shipping')
      ?'Teto de frete inválido. Use 0, 19,90 ou deixe em branco.'
      :'Informe os quatro últimos dígitos do cartão salvo no perfil Compra.';
    invalidField.focus();
    return;
  }
  $('settings-error').textContent='';
  try{
    await action('settings','PATCH',{
      amazon:{onlyAmazon:$('amazon-only').checked,purchase:{
        enabled:$('amazon-purchase-enabled').checked,
        paymentMethod:amazonPaymentMethod,
        cardLastFour:amazonCardLastFour,
        freeShippingOnly:$('amazon-purchase-free-shipping').checked,
        maxShippingCents:amazonMaxShipping===null?null:Math.round(amazonMaxShipping*100),
        includeShipping:$('amazon-purchase-include-shipping').checked,
      }},
      ml:{
        requireReputation:$('ml-reputation-required').checked,
        minReputation:$('ml-min-reputation').value,
        requireLeader:$('ml-leader-required').checked,
        minLeader:$('ml-min-leader').value,
        matchMode:$('ml-reputation-match').value,
        purchase:{
          enabled:$('purchase-enabled').checked,paymentMethod,cardLastFour,
          freeShippingOnly:$('purchase-free-shipping').checked,
          maxShippingCents:maxShipping===null?null:Math.round(maxShipping*100),
          includeShipping:$('purchase-include-shipping').checked,
        },
      },
    });
    $('settings-dialog').close();
    toast('Configurações salvas.');
  }catch(error){$('settings-error').textContent=error.message;}
});


let purchasesMarkup='';
const purchaseTime=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
try{$('purchase-panel').open=localStorage.getItem('vigia:pix-panel-open')==='true';}catch{}
$('purchase-panel').addEventListener('toggle',()=>{try{localStorage.setItem('vigia:pix-panel-open',String($('purchase-panel').open));}catch{}});
function purchaseOrderMarkup(o){
  const labels={QUEUED:'Na fila',PAUSING_MONITORS:'Pausando monitoramento',REVALIDATING:'Conferindo anúncios',CART:'Ajustando carrinho',CHECKOUT:'Conferindo checkout',WAITING_HUMAN:'Aguardando sua verificação',RESUMING:'Revalidando',FINALIZING:'Gerando pedido',PIX_PENDING:'Pix aguardando pagamento',CARD_PAID:'Pagamento confirmado no cartão',UNCERTAIN:'Confira Minhas compras',BLOCKED:'Compra interrompida',CANCELLED:'Interrompido',CLOSED:'Pedido revisado'};
  const tone=o.status==='PIX_PENDING'?'pending':['UNCERTAIN','BLOCKED'].includes(o.status)?'warning':['CLOSED','CANCELLED'].includes(o.status)?'muted':'progress';
  const items=o.items??[],units=items.reduce((sum,item)=>sum+(item.quantity??0),0);
  const time=o.createdAt&&!Number.isNaN(Date.parse(o.createdAt))?purchaseTime.format(new Date(o.createdAt)):'Horário não informado';
  const total=o.totalCents!=null?'R$ '+money.format(o.totalCents/100):'Em conferência';
  const historyLabel=o.store==='amazon'?'Seus pedidos':'Minhas compras';
  const historyUrl=o.store==='amazon'?'https://www.amazon.com.br/gp/your-account/order-history':'https://myaccount.mercadolivre.com.br/my_purchases/list#nav-header';
  const historyMessages={
    PENDING:'Consultando o histórico da loja.',
    VERIFIED:'Pedido localizado no histórico da loja.',
    NOT_FOUND:'O pedido ainda não apareceu no histórico da loja.',
    NO_REFERENCE:'Histórico consultado. O checkout não informou um identificador verificável.',
    UNAVAILABLE:'Não foi possível verificar o histórico da loja.',
  };
  const historyMessage=historyMessages[o.historyVerification?.status];
  const financialRow=(label,cents,discount=false)=>cents==null?'':`<div><span>${label}</span><strong>${discount?'− ':''}R$ ${money.format(cents/100)}</strong></div>`;
  return `<details class="purchase-order" data-purchase-order="${escapeHtml(o.id)}"><summary class="purchase-order-summary"><span class="purchase-order-dot ${tone}"></span><span class="purchase-order-overview"><span class="purchase-order-line"><strong class="order-status ${tone}">${escapeHtml(labels[o.status]??'Pedido')}</strong><time title="${escapeHtml(formatTime(o.createdAt))}">${escapeHtml(time)}</time></span><span class="purchase-order-description">${storeNames[o.store]??storeNames.ml} · ${items.length} ${items.length===1?'produto':'produtos'} · ${units} ${units===1?'unidade':'unidades'} · ${o.payment==='credit_card'?'Cartão':o.payment==='pix'?'Pix':'Pagamento a definir'}<span class="purchase-order-product"> · ${escapeHtml(items[0]?.name??'Lote de compra')}${items.length>1?' + '+(items.length-1):''}</span></span></span><span class="purchase-order-total"><small>Total do pedido</small><strong>${total}</strong></span><span class="purchase-chevron">${svg('chevron')}</span></summary>
    <div class="purchase-order-body"><p class="purchase-order-message">${escapeHtml(o.message??'')}</p><div class="purchase-detail-grid"><div><h3>Produtos do pedido</h3><ul class="purchase-item-list">${items.map(i=>`<li><span>${escapeHtml(i.name??i.itemId)}</span><small>${i.quantity} ${i.quantity===1?'unidade':'unidades'}${i.requestedQuantity!=null&&i.requestedQuantity!==i.quantity?' de '+i.requestedQuantity+' solicitadas':''}${i.unitCents!=null?' · R$ '+money.format(i.unitCents/100)+' por unidade':''}</small></li>`).join('')}</ul></div><div class="purchase-recap"><h3>Resumo</h3>${financialRow('Produtos',o.subtotalCents)}${o.couponDiscountCents>0?financialRow('Cupons',o.couponDiscountCents,true):''}${o.pixDiscountCents>0?financialRow('Desconto Pix',o.pixDiscountCents,true):''}${financialRow('Frete',o.shippingCents)}${o.totalCents!=null?`<div class="purchase-recap-total"><span>Total</span><strong>${total}</strong></div>`:'<p>Valores exibidos após a conferência.</p>'}</div></div>
    ${o.status==='PIX_PENDING'?`<div class="purchase-pix"><div class="purchase-pix-heading"><div><h3>Pix Copia e Cola</h3><p>Confira o valor no aplicativo do banco antes de pagar.</p></div><button class="button primary" data-copy-pix="${escapeHtml(o.id)}">${svg('copy')}Copiar Pix</button></div><textarea readonly class="pix-code" aria-label="Código Pix do pedido de ${escapeHtml(time)}">${escapeHtml(o.code??'')}</textarea><span class="purchase-disarmed">${svg('shield')}${o.autoDisabledAt?'Compra automática desativada nos produtos deste pedido.':'Pagamento manual no aplicativo do banco.'}</span></div>`:''}
  ${historyMessage?`<p class="purchase-order-message">${historyMessage} <a href="${historyUrl}" target="_blank" rel="noopener noreferrer">${historyLabel}</a></p>`:''}
  ${['PIX_PENDING','CARD_PAID','UNCERTAIN','BLOCKED','CANCELLED'].includes(o.status)?`<div class="purchase-order-footer"><button class="button secondary resolve-order" data-resolve-order="${escapeHtml(o.id)}">Já revisei ${svg('check')}</button></div>`:''}</div></details>`;
}
function renderPurchases(){
  const purchase=state?.purchases,orders=purchase?.orders??[];
  const waiting=orders.find(o=>o.status==='WAITING_HUMAN'),pending=orders.filter(o=>o.status==='PIX_PENDING').length;
  const enabled=['amazon','ml'].filter(store=>state?.settings?.[store]?.purchase?.enabled).map(store=>storeNames[store]);
  $('purchase-status').textContent=waiting?waiting.message:purchase?.busy?'Preparando um pedido no perfil Compra.':enabled.length?'Compra automática ativa em '+enabled.join(' e ')+'.':'Compra automática desativada.';
  $('purchase-count').textContent=String(orders.length);
  $('purchase-summary-meta').textContent=orders.length?'Expanda para consultar valores, produtos e códigos Pix.':'Seu histórico de pedidos, em um só lugar.';
  const attention=$('purchase-attention');attention.hidden=!pending&&!purchase?.busy;attention.textContent=pending?`${pending} Pix ${pending===1?'pendente':'pendentes'}`:waiting?'Verificação necessária':'Preparando compra';
  const markup=orders.length?orders.slice().reverse().map(purchaseOrderMarkup).join(''):'<div class="purchase-empty">'+svg('qr')+'<div><strong>Nenhum pedido por enquanto</strong><p>Os pedidos e seus pagamentos aparecerão aqui.</p></div></div>';
  if(markup!==purchasesMarkup){
    const list=$('purchase-orders'),scroll=list.scrollTop,open=new Set([...list.querySelectorAll('details[data-purchase-order][open]')].map(d=>d.dataset.purchaseOrder));
    list.innerHTML=markup;list.querySelectorAll('details[data-purchase-order]').forEach(d=>{d.open=open.has(d.dataset.purchaseOrder);});list.scrollTop=scroll;purchasesMarkup=markup;
  }
  const last=state?.notifications?.at(-1);$('notification-status').textContent=last?.status==='FAILED'?'Falha ao notificar o Windows: '+last.error:last?.status==='SENT'?'Última notificação enviada ao Windows.':'';
}
$('notification-test').addEventListener('click',async()=>{try{await action('notifications/test');const last=state.notifications.at(-1);toast(last?.status==='SENT'?'Notificação enviada ao Windows.':last?.error??'Confira o estado das notificações.');}catch(e){toast(e.message);}});
$('purchase-orders').addEventListener('click',async e=>{
  const copy=e.target.closest('[data-copy-pix]');if(copy){const order=state.purchases.orders.find(o=>o.id===copy.dataset.copyPix);if(order)try{await navigator.clipboard.writeText(order.code);toast('Código Pix copiado. Confira o valor no banco antes de pagar.');}catch{toast('Selecione o código no campo para copiar.');}return;}
  const resolve=e.target.closest('[data-resolve-order]');if(resolve)try{await action('purchases/'+encodeURIComponent(resolve.dataset.resolveOrder)+'/resolve');toast('Produtos desarmados. O estado de pagamento não foi alterado.');}catch(error){toast(error.message);}
});

async function refresh(){
  if(busy)return;
  // Avoid replacing an input while the user types a target price.
  if(document.activeElement?.matches('.target-input,.quantity-input,.pix-code'))return;
  try{applyState(await api('state'));}
  catch{connected=false;updateStats();updateMonitor();}
}
hydrateIcons();setTabs();render();updateMonitor();
if(location.protocol==='file:'){toast('Para usar o monitoramento real, abra INICIAR-PAINEL.cmd e acesse http://127.0.0.1:4318.');}
else{refresh();setInterval(refresh,2000);}

let historyRequest=0,historyEntries=[];
$('global-history').addEventListener('click',()=>showAvailabilityHistory());
for(const id of ['history-search','history-store','history-period','history-sort'])$(id).addEventListener(id==='history-search'?'input':'change',renderAvailabilityHistory);
async function showAvailabilityHistory(product){
 const request=++historyRequest;$('history-title').textContent=product?'Histórico do produto':'Histórico global';$('history-product').textContent=product?displayName(product):'Linha do tempo de ofertas elegíveis na Amazon e no Mercado Livre';$('history-search').value='';$('history-store').value='all';$('history-period').value='all';$('history-sort').value='recent';$('history-stats').textContent='';$('history-content').textContent='Carregando histórico…';$('history-dialog').showModal();
 try{
  const {entries}=await api('availability-history'+(product?'?productId='+encodeURIComponent(product.id):''));if(request!==historyRequest)return;
  historyEntries=entries;renderAvailabilityHistory();
 }catch(error){if(request===historyRequest)$('history-content').textContent=error.message;}
}
function renderAvailabilityHistory(){
 const query=$('history-search').value.trim().toLocaleLowerCase('pt-BR'),store=$('history-store').value,days=$('history-period').value,sort=$('history-sort').value;
 const entries=historyEntries.filter(row=>(store==='all'||row.product.store===store)&&(days==='all'||Date.parse(row.at)>=Date.now()-Number(days)*86400000)&&(!query||[row.product.name,row.product.title,row.product.code,row.product.seller].some(v=>String(v??'').toLocaleLowerCase('pt-BR').includes(query))));
 entries.sort((a,b)=>sort==='price'?(a.product.price??Infinity)-(b.product.price??Infinity):sort==='oldest'?Date.parse(a.at)-Date.parse(b.at):Date.parse(b.at)-Date.parse(a.at));
 const priced=entries.filter(row=>Number.isFinite(row.product.price));
 $('history-stats').innerHTML=`<span><strong>${entries.length}</strong> disponibilidades</span><span><strong>${new Set(entries.map(row=>row.productId)).size}</strong> produtos</span><span><strong>${priced.length?'R$ '+money.format(Math.min(...priced.map(row=>row.product.price))):'—'}</strong> menor preço no recorte</span>`;
  const field=(label,value)=>`<div><dt>${label}</dt><dd>${escapeHtml(value??'Não informado')}</dd></div>`;
  $('history-content').innerHTML=entries.length?entries.map(row=>{
   const p=row.product,f=row.filters,filters=p.store==='amazon'?(f.onlyAmazon?'Somente vendidos e entregues pela Amazon':'Todas as ofertas Amazon elegíveis'):[f.requireReputation?'Reputação mínima: '+f.minReputation:null,f.requireLeader?'Medalha mínima: '+f.minLeader:null].filter(Boolean).join(f.matchMode==='any'?' OU ':' E ')||'Sem filtro de reputação';
   return `<details class="history-entry"><summary><span><strong>${escapeHtml(displayName(p))}</strong><small>${escapeHtml(storeNames[p.store])} · ${row.type==='PRIMEIRA_OBSERVACAO_DISPONIVEL'?'Primeira observação disponível':'Disponibilidade confirmada'} · ${escapeHtml(formatTime(row.at))}</small></span><b>${p.price==null?'Preço não informado':'R$ '+money.format(p.price)}</b></summary><div class="history-entry-body"><h3>${escapeHtml(displayName(p))}</h3><p class="history-filters">Filtros na leitura: ${escapeHtml(filters)}</p><dl>${field('Plataforma',storeNames[p.store])}${field('Anúncio',p.code)}${field('Vendido por',p.seller)}${field('ID do vendedor',p.sellerId)}${field('Entregue por',p.delivery)}${field('Frete',p.freight==null?'Não informado':'R$ '+money.format(p.freight))}${field('Reputação',p.reputationLevel)}${field('MercadoLíder',p.powerSellerStatus)}${field('Quantidade configurada',p.quantity??1)}${field('Limite por unidade',p.target==null?'Sem limite':'R$ '+money.format(p.target))}</dl><p class="history-url">${escapeHtml(p.url)}</p></div></details>`;
  }).join(''):'<div class="purchase-empty"><div><strong>Nenhuma disponibilidade neste recorte</strong><p>Ajuste os filtros ou aguarde uma nova confirmação. O histórico começa nesta atualização e funciona mesmo com os alertas desativados.</p></div></div>';
}

let waitingForUpdateReload = false;

function updateAuth() {
  const auth = state?.auth;
  const upd = state?.update;
  const gate = $('auth-gate');
  const pill = $('auth-user-pill');
  const adminTab = $('settings-tab-admin');
  const banner = $('update-banner');
  const bannerText = $('update-banner-text');

  if (banner && bannerText) {
    if (upd && ['downloading', 'installing', 'restarting'].includes(upd.status)) {
      banner.hidden = false;
      const ver = upd.availableVersion ? ` v${upd.availableVersion}` : '';
      bannerText.textContent = upd.status === 'downloading'
        ? `Baixando atualização${ver}…`
        : upd.status === 'installing'
          ? `Instalando atualização${ver}…`
          : `Atualização${ver} pronta · reiniciando Vigia…`;
      if (upd.status === 'restarting' && !waitingForUpdateReload) {
        waitingForUpdateReload = true;
        setTimeout(() => location.reload(), 2500);
      }
    } else {
      banner.hidden = true;
    }
  }

  const syncNote = $('storage-sync-note');
  if (syncNote) {
    const synced = Boolean(auth?.enabled && auth.authenticated && !auth.offlineMode);
    syncNote.innerHTML = `<span class="status-dot"></span> ${synced ? 'Sincronizado automaticamente' : 'Salvo localmente'}`;
  }

  if (!auth || !auth.enabled) {
    if (gate) gate.hidden = true;
    if (pill) pill.hidden = true;
    if (adminTab) adminTab.hidden = true;
    return;
  }
  if (!auth.authenticated) {
    if (gate) gate.hidden = false;
    if (pill) pill.hidden = true;
    if (adminTab) adminTab.hidden = true;
    const btn = $('auth-google-btn');
    if (btn && auth.loginUrl) btn.href = auth.loginUrl;
    const note = $('auth-gate-note');
    if (note) {
      note.textContent = auth.offlineExpired
        ? 'Sua sessão offline expirou (mais de 7 dias sem conexão com o servidor VPS). Conecte-se para renovar.'
        : (auth.vpsUrl ? `Servidor: ${auth.vpsUrl}` : '');
    }
    return;
  }
  if (gate) gate.hidden = true;
  if (pill) pill.hidden = false;
  const emailEl = $('auth-user-email');
  if (emailEl) {
    const statusTag = auth.offlineMode
      ? ` · offline (${auth.offlineDaysRemaining}d)`
      : auth.syncStatus === 'error'
        ? ' · erro sync'
        : auth.syncStatus === 'syncing'
          ? ' · sincronizando…'
          : '';
    emailEl.textContent = (auth.user?.email ?? '') + statusTag;
    emailEl.title = auth.lastSyncError || (auth.lastSyncedAt ? `Última sincronização: ${formatTime(auth.lastSyncedAt)}` : 'Conectado ao servidor VPS');
  }
  const avatarEl = $('auth-user-avatar');
  if (avatarEl) {
    if (auth.user?.picture) {
      avatarEl.src = auth.user.picture;
      avatarEl.hidden = false;
    } else {
      avatarEl.hidden = true;
    }
  }
  if (adminTab) adminTab.hidden = auth.user?.role !== 'admin' || auth.offlineMode;
}

async function loadAdminAllowlist() {
  const list = $('admin-allowlist-list');
  const errEl = $('admin-allowlist-error');
  if (!list) return;
  errEl.textContent = '';
  list.textContent = 'Carregando lista de acessos…';
  try {
    const { entries } = await api('admin/allowlist');
    renderAdminAllowlist(entries ?? []);
  } catch (err) {
    errEl.textContent = err.message;
    list.textContent = '';
  }
}

function renderAdminAllowlist(entries) {
  const list = $('admin-allowlist-list');
  if (!list) return;
  if (!entries.length) {
    list.innerHTML = '<p class="dialog-intro">Nenhum Gmail cadastrado.</p>';
    return;
  }
  const currentEmail = state?.auth?.user?.email;
  list.innerHTML = entries.map(entry => `
    <div class="admin-allowlist-item">
      <div class="admin-allowlist-meta">
        <strong>${escapeHtml(entry.email)} <span class="badge ${entry.role === 'admin' ? 'ok' : 'neutral'}">${entry.role === 'admin' ? 'Admin' : 'Usuário'}</span></strong>
        <small>${entry.note ? escapeHtml(entry.note) + ' · ' : ''}${entry.lastLoginAt ? 'Último login: ' + escapeHtml(formatTime(entry.lastLoginAt)) : 'Nunca entrou'}</small>
      </div>
      ${entry.email === currentEmail ? '' : `<button type="button" class="button secondary" data-remove-allowlist="${escapeHtml(entry.email)}">Remover</button>`}
    </div>
  `).join('');
}

$('auth-logout')?.addEventListener('click', () => {
  const email = state?.auth?.user?.email;
  const msg = $('logout-message');
  if (msg) msg.textContent = email ? `Deseja encerrar a sessão de ${email}?` : 'Deseja encerrar sua sessão no Vigia?';
  $('logout-dialog')?.showModal();
});

$('confirm-logout')?.addEventListener('click', async () => {
  try {
    await action('auth/logout', 'POST', {});
    $('logout-dialog')?.close();
    toast('Sessão encerrada.');
  } catch (err) {
    toast(err.message);
  }
});

$('settings-tab-admin')?.addEventListener('click', () => {
  void loadAdminAllowlist();
});

$('admin-allowlist-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('admin-allowlist-error');
  errEl.textContent = '';
  try {
    const email = $('admin-email-input').value.trim();
    const role = $('admin-role-input').value;
    const note = $('admin-note-input').value.trim();
    const result = await api('admin/allowlist', 'POST', { email, role, note });
    $('admin-email-input').value = '';
    $('admin-note-input').value = '';
    renderAdminAllowlist(result.entries ?? []);
    toast(`Acesso liberado para ${email}.`);
  } catch (err) {
    errEl.textContent = err.message;
  }
});

$('admin-allowlist-list')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-remove-allowlist]');
  if (!btn) return;
  const email = btn.dataset.removeAllowlist;
  const errEl = $('admin-allowlist-error');
  errEl.textContent = '';
  try {
    const result = await api('admin/allowlist/' + encodeURIComponent(email), 'DELETE', {});
    renderAdminAllowlist(result.entries ?? []);
    toast(`Acesso removido de ${email}.`);
  } catch (err) {
    errEl.textContent = err.message;
  }
});

