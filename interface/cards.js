// Keep stable product photos and titles attached while prices and timestamps change.
export function patchProductCard(current,next) {
  if(current.className!==next.className)current.className=next.className;
  if(current.ariaLabel!==next.ariaLabel)current.ariaLabel=next.ariaLabel;
  for(const selector of ['.product-art','.product-title','.product-tags','.seller-info','.last-check','.product-error','.price-area','.product-actions','.product-controls']) {
    const before=current.querySelector(selector),after=next.querySelector(selector);
    if(before&&after){if(before.outerHTML!==after.outerHTML)before.replaceWith(after);}
    else if(before)before.remove();
    else if(after&&selector==='.product-error')current.querySelector('.last-check').after(after);
  }
}
export function reconcileProductCards(list,products,renderCard) {
  const existing=new Map([...list.children].map(card=>[card.dataset.product,card]));
  const visible=new Set(products.map(p=>p.id));
  for(const card of [...list.children])if(!visible.has(card.dataset.product))card.remove();
  products.forEach((product,index)=>{
    const template=document.createElement('template');template.innerHTML=renderCard(product);
    const next=template.content.firstElementChild;
    const card=existing.get(product.id)??next;
    if(card!==next)patchProductCard(card,next);
    if(list.children[index]!==card)list.insertBefore(card,list.children[index]??null);
  });
}
