import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const port=18100+Math.floor(Math.random()*1500);
const url=`http://127.0.0.1:${port}`;
let child;
async function api(path,method='GET',data,token){const response=await fetch(url+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:data?JSON.stringify(data):undefined});return {status:response.status,data:await response.json()};}
test('end-to-end real estate user and admin APIs',async t=>{
 child=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,NODE_ENV:'development',DATABASE_URL:'',PORT:String(port),ADMIN_EMAIL:'admin@example.test',ADMIN_PASSWORD:'LocalDemoAdmin#1234'},cwd:process.cwd(),stdio:'ignore'});
 t.after(()=>child?.kill());let connected=false;
 for(let i=0;i<40;i++){try{const r=await api('/api/health');if(r.status===200){connected=true;break;}}catch{}await delay(120);}
 assert.equal(connected,true,'Server starts');
 const catalog=await api('/api/listings');assert.equal(catalog.status,200);assert.ok(catalog.data.items.length>=6);
 const customer=await api('/api/auth/register','POST',{name:'Test Client',email:'client@example.test',password:'ClientPassword#1234'});assert.equal(customer.status,201);const customerToken=customer.data.token;
 const unauthorized=await api('/api/listings','POST',{title:'bad'},customerToken);assert.equal(unauthorized.status,403);
 const favorite=await api('/api/favorites','POST',{listing_id:'demo-1'},customerToken);assert.equal(favorite.status,200);
 const inquiry=await api('/api/leads','POST',{listing_id:'demo-1',name:'Test Client',phone:'01012345678'},customerToken);assert.equal(inquiry.status,201);
 const appointment=await api('/api/appointments','POST',{listing_id:'demo-1',name:'Test Client',phone:'01012345678',scheduled_at:new Date(Date.now()+86400000).toISOString()},customerToken);assert.equal(appointment.status,201);
 const login=await api('/api/auth/login','POST',{email:'admin@example.test',password:'LocalDemoAdmin#1234'});assert.equal(login.status,200);const adminToken=login.data.token;
 const created=await api('/api/listings','POST',{title:'New Apartment',city:'Cairo',area:'Maadi',price:999999,size:125,rooms:2,baths:1,kind:'شقة',transaction:'بيع'},adminToken);assert.equal(created.status,201);
 const summary=await api('/api/admin/summary','GET',null,adminToken);assert.equal(summary.status,200);assert.equal(summary.data.leads,1);assert.equal(summary.data.appointments,1);
 const assistant=await api('/api/assistant','POST',{message:'شقة للبيع'});assert.equal(assistant.status,200);assert.ok(assistant.data.items.length>0);
});
