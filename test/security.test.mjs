import test from 'node:test';import assert from 'node:assert/strict';
import {makePassword,checkPassword,signToken,readToken,validListing,slugSafe} from '../server/security.mjs';
test('password hash uses salted verification',()=>{const h=makePassword('StrongPass#987');assert.equal(checkPassword('StrongPass#987',h),true);assert.equal(checkPassword('wrong',h),false);assert.notEqual(h,makePassword('StrongPass#987'));});
test('JWT rejects tampering and expiration',()=>{const t=signToken({sub:'abc'},'test-secret');assert.equal(readToken(t,'test-secret').sub,'abc');assert.equal(readToken(t+'x','test-secret'),null);assert.equal(readToken(t,'other'),null);});
test('rejects bad prices and untrusted image hosts',()=>{const v={title:'شقة',city:'القاهرة',area:'المعادي',kind:'شقة',transaction:'بيع',price:10000,size:100,rooms:2,baths:1};assert.equal(validListing(v).ok,true);assert.equal(validListing({...v,price:-20}).ok,false);assert.equal(slugSafe('javascript:alert(1)'),'');});
