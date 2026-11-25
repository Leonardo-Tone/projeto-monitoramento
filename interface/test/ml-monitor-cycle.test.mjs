import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMLProducts } from '../server/adapters.mjs';

test('falha de um anúncio sem estoque não interrompe os demais nem remove o link do ciclo', async()=>{
  const traditional=Array.from({length:5},(_,i)=>({id:`p${i}`,url:`https://produto.mercadolivre.com.br/${i}`}));
  const catalogs=[{id:'c1',url:'https://www.mercadolivre.com.br/p/c1'}];
  let calls=0;
  const results=await collectMLProducts({traditional,catalogs,productPage:{},catalogPage:{},signal:new AbortController().signal,
    consult:async product=>{calls++;if(product.id==='p1')throw new Error('página alternativa por falta de estoque');return {observed:true};}});
  assert.equal(calls,6);
  assert.equal(results.length,6);
  assert.equal(results.find(r=>r.product.id==='p1').ok,false);
  assert.equal(results.filter(r=>r.ok).length,5);
});
