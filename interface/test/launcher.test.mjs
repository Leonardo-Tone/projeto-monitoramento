import test from'node:test';import assert from'node:assert/strict';import{panelIsRunning,panelStatus}from'../launch.mjs';
import {apiVersion} from '../panel-api.mjs';
const respond=version=>async()=>({ok:true,json:async()=>({apiVersion:version,products:[],shops:{amazon:{},ml:{}}})});
test('launcher recognizes an existing Vigia service without starting another instance',async()=>{
 assert.equal(await panelIsRunning(respond(apiVersion)),true);
});
test('launcher distinguishes the old settings API from a compatible running service',async()=>{
 assert.equal(await panelStatus(respond(3)),'outdated');
 assert.equal(await panelStatus(respond(4)),'outdated');
 assert.equal(await panelStatus(respond(6)),'outdated');
 assert.equal(await panelStatus(respond(7)),'outdated');
 assert.equal(await panelStatus(respond(8)),'outdated');
 assert.equal(await panelStatus(respond(9)),'outdated');
 assert.equal(await panelIsRunning(respond(3)),false);
});
test('launcher does not mistake an unavailable port or unrelated service for Vigia',async()=>{
 assert.equal(await panelIsRunning(async()=>{throw Error('ECONNREFUSED');}),false);
 assert.equal(await panelIsRunning(async()=>({ok:false})),false);
 assert.equal(await panelIsRunning(async()=>({ok:true,json:async()=>({products:[]})})),false);
});
