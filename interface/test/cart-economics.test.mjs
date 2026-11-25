import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { projectCart } from '../server/purchase-cart.mjs';
import { validateCartStatement, purchaseDefaults } from '../server/purchase-rules.mjs';
import { createCheckoutParser, chooseShipping } from '../server/purchase-html.mjs';

const fixture=JSON.parse(await readFile(new URL('./fixtures/cart-statement.json',import.meta.url),'utf8'));
const expected=[{itemId:'MLB5276063543',quantity:2,limitCents:20000,name:'Produto'}];
const options={...purchaseDefaults(),freeShippingOnly:true};
const current=(row,value)=>{row.value={values:[{key:'price',type:'price',price:{value,currency:'BRL'}}]};};
function couponCart(){
  const cart=structuredClone(fixture),group=cart.tracking.grouping_items.find(g=>g.group_status==='selected');
  group.coupons=[{type:'applied_coupon',campaign_id:'12345',given_discount:10,reach_minimum:true}];
  cart.tracking.summary.used_coupons=1;cart.tracking.summary.coupons_type.type='APPLIED_COUPON';cart.tracking.summary.discount_amount=10;
  current(cart.summary.coupon_row,-10);current(cart.summary.total_row,389.9);cart.tracking.summary.total.amount=389.9;
  cart.tracking.items[0].price_decrement_campaigns=[{id:'12345',type:'meli',amount:10}];return cart;
}
test('real cart statement counts units, excludes deselected items, ignores struck shipping and reconciles one GET',()=>{
  const projected=projectCart(fixture);assert.equal(projected.complete,true);assert.equal(projected.economics.complete,true);
  assert.equal(projected.items.filter(i=>i.checked).length,1);assert.equal(projected.economics.productsCents,39990);assert.equal(projected.economics.shippingCents,0);assert.equal(projected.economics.totalCents,39990);assert.equal(projected.economics.usedCoupons,0);
  assert.equal(validateCartStatement(projected,expected,options).totalCents,39990);
});
test('cart statement rejects contradictory totals and unknown shipping before checkout',()=>{
  const cart=structuredClone(fixture);cart.tracking.summary.total.amount=400;
  assert.throws(()=>validateCartStatement(projectCart(cart),expected,options),/conciliados/);
  cart.tracking.summary.total.amount=399.9;cart.summary.ticket_rows=cart.summary.ticket_rows.filter(r=>r.id!=='shipping');
  assert.throws(()=>validateCartStatement(projectCart(cart),expected,options),/conciliados/);
});
test('free shipping and per-order ceiling apply to actual cart freight, not product-page banners',()=>{
  const cart=structuredClone(fixture);current(cart.summary.ticket_rows.find(r=>r.id==='shipping'),18.3);cart.tracking.summary.shipping_total.amount=18.3;current(cart.summary.total_row,418.2);cart.tracking.summary.total.amount=418.2;
  const projected=projectCart(cart);assert.equal(projected.economics.complete,true);
  assert.throws(()=>validateCartStatement(projected,expected,options),/frete grátis/);
  assert.throws(()=>validateCartStatement(projected,expected,{...options,freeShippingOnly:false,maxShippingCents:1000}),/teto/);
  assert.throws(()=>validateCartStatement(projected,expected,{...options,freeShippingOnly:false,includeShipping:true}),/limite/);
});
test('applied coupon is recognized only with correlated campaign, amount and matching grand total',()=>{
  const cart=couponCart(),projected=projectCart(cart);assert.equal(projected.economics.complete,true);
  const result=validateCartStatement(projected,expected,options);assert.equal(result.usedCoupons,1);assert.equal(result.couponDiscountCents,1000);assert.equal(result.totalCents,38990);
  cart.tracking.summary.used_coupons=2;assert.equal(projectCart(cart).economics.complete,false);
});
test('unknown or conflicting discounts cannot silently pass as a valid cart',()=>{
  const cart=couponCart();cart.tracking.items[0].price_decrement_campaigns[0].amount=11;assert.equal(projectCart(cart).economics.complete,false);
  const noCoupon=structuredClone(fixture);noCoupon.tracking.summary.discount_amount=10;assert.equal(projectCart(noCoupon).economics.complete,false);
});
test('cart counts total units consistently for a product quantity greater than one',()=>{
  const cart=structuredClone(fixture);cart.cart_properties.active_and_selected_items_size=1;assert.equal(projectCart(cart).complete,false);
});
test('captured checkout shipping chooses tomorrow over the weekend when both are free',async()=>{
  const parser=createCheckoutParser(process.env.MONITOR_PROJECT_ROOT);
  const html=await readFile(new URL('./fixtures/shipping-live.html',import.meta.url),'utf8');
  const groups=parser.shipping(html,new Date('2026-11-05T17:00:33Z'));assert.equal(groups.length,1);
  const best=chooseShipping(groups[0].options);assert.equal(best.cents,0);assert.match(best.label,/amanhã/);assert.equal(best.value,'2167789377');
  assert.equal(groups[0].options.filter(o=>o.disabled).length,1);
});
