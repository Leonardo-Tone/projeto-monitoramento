import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile}from'node:fs/promises';
import {dirname,resolve}from'node:path';
import {fileURLToPath}from'node:url';
import {parseNordicRendering,checkoutItemsFromFlox}from'../server/checkout-items.mjs';
import {createCheckoutParser}from'../server/purchase-html.mjs';
import {reviewLines}from'../server/purchase-rules.mjs';
const projectRoot = process.env.MONITOR_PROJECT_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture=await readFile(new URL('./fixtures/checkout-flox.html',import.meta.url),'utf8');
const state=()=>parseNordicRendering(fixture);
const data=json=>json.appProps.pageProps.flox.floxPreloadedState['@meli/web/flox/FLOX_STATE'].pendingTracks[0].tracking.tracks[0].data.event_data;
test('observed checkout state binds product prices, seller and quantity to delivery packs',()=>{
  const result=checkoutItemsFromFlox(state());assert.equal(result.present,true);assert.equal(result.lines[0].itemId,'MLB5276063543');assert.equal(result.lines[0].quantity,2);assert.equal(result.lines[0].unitCents,19995);assert.equal(result.lines[0].sellerId,'768826009');
});
test('multi-product checkout evidence requires complete matching item and delivery sets',()=>{
  const json=state(),d=data(json);d.items.push({item:{id:'MLB1002',variation:null,seller_id:'123'},quantity:1,unit_price:90,currency_id:'BRL'});d.shipping.pack_details[0].items.push({id:'MLB1002',quantity:1,variation:null});
  assert.equal(checkoutItemsFromFlox(json).lines.length,2);d.shipping.pack_details[0].items[1].quantity=2;assert.equal(checkoutItemsFromFlox(json).invalid,true);
});
test('unknown currency, duplicate products and conflicting variants invalidate checkout evidence',()=>{
  const a=state();data(a).items[0].currency_id='USD';assert.equal(checkoutItemsFromFlox(a).invalid,true);
  const b=state();data(b).items.push({...data(b).items[0]});assert.equal(checkoutItemsFromFlox(b).invalid,true);
  const c=state();data(c).shipping.pack_details[0].items[0].variation='44';assert.equal(checkoutItemsFromFlox(c).invalid,true);
});
test('parser uses the observed checkout state and never executes scripts following JSON',()=>{
  assert.deepEqual(parseNordicRendering('_n.ctx.r={"safe":"brace } in string"}; throw Error("must not execute");'),{safe:'brace } in string'});
  const parser=createCheckoutParser(projectRoot),review=parser.review(fixture);
  const expected=[{itemId:'MLB5276063543',quantity:2,sellerId:'768826009',limitCents:20000}];
  assert.equal(reviewLines(review,expected,new Map(),String)[0].unitCents,19995);
  assert.equal(parseNordicRendering('_n.ctx.r={notJSON:true}'),null);
});
test('conflicting checkout evidence cannot fall back to matching title and aggregate total',()=>{
  assert.throws(()=>reviewLines({lineEvidenceInvalid:true,lines:[],titles:['Produto'],subtotalCents:100},[{name:'Produto',quantity:1}],new Map(),String),/conflitantes/);
});
