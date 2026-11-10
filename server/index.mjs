import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {makePassword,checkPassword,signToken,readToken,validListing,slugSafe} from './security.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const publicDir=path.resolve(here,'../web');
const prod=process.env.NODE_ENV==='production';
const port=Number(process.env.PORT||10000);
const demoMode=process.env.DEMO_MODE==='true';
const secret=process.env.JWT_SECRET || (demoMode?crypto.randomBytes(48).toString('hex'):(!prod?'development-only-change-before-deploy':null));
if(prod && !demoMode && (!process.env.DATABASE_URL || !secret || secret.length<40 || !process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD)){
 console.error('Production requires DATABASE_URL, JWT_SECRET (40+ chars), ADMIN_EMAIL, ADMIN_PASSWORD.');process.exit(1);
}
const id=()=>crypto.randomUUID();
const sample=[
 {id:'demo-1',title:'شقة راقية بإطلالة مفتوحة',city:'القاهرة الجديدة',area:'التجمع الخامس',price:5200000,rooms:3,baths:2,size:185,kind:'شقة',transaction:'بيع',image:'https://images.unsplash.com/photo-1600607687920-4e2a09cf159d?w=1000&q=80',status:'published',description:'تصميم عصري ومساحات واسعة وقريبة من الخدمات',org_id:'demo-org'},
 {id:'demo-2',title:'فيلا مستقلة بحديقة خاصة',city:'الشيخ زايد',area:'الحي السابع',price:12750000,rooms:5,baths:4,size:360,kind:'فيلا',transaction:'بيع',image:'https://images.unsplash.com/photo-1613977257363-707ba9348227?w=1000&q=80',status:'published',description:'فيلا حديثة مع حديقة وموقف للسيارات',org_id:'demo-org'},
 {id:'demo-3',title:'شقة مفروشة للإيجار',city:'القاهرة',area:'المعادي',price:34000,rooms:2,baths:2,size:145,kind:'شقة',transaction:'إيجار',image:'https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?w=1000&q=80',status:'published',description:'تشطيب مميز وجاهزة للسكن الفوري',org_id:'demo-org'},
 {id:'demo-4',title:'دوبلكس قريب من الخدمات',city:'الجيزة',area:'حدائق أكتوبر',price:3900000,rooms:4,baths:3,size:245,kind:'دوبلكس',transaction:'بيع',image:'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=1000&q=80',status:'published',description:'مساحة كبيرة ومدخل مستقل',org_id:'demo-org'},
 {id:'demo-5',title:'ستوديو مميز للاستثمار',city:'العاصمة الإدارية',area:'R7',price:2450000,rooms:1,baths:1,size:78,kind:'ستوديو',transaction:'بيع',image:'https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?w=1000&q=80',status:'published',description:'مناسب للإقامة أو الاستثمار طويل المدى',org_id:'demo-org'},
 {id:'demo-6',title:'مكتب إداري مجهز بالكامل',city:'القاهرة الجديدة',area:'التسعين',price:68000,rooms:3,baths:1,size:130,kind:'تجاري',transaction:'إيجار',image:'https://images.unsplash.com/photo-1497366811353-6870744d04b2?w=1000&q=80',status:'published',description:'مكتب بموقع حيوي ومداخل منظمة',org_id:'demo-org'}
];
let pool=null;
const memory={users:[],listings:sample,leads:[],appointments:[],favorites:[],organizations:[{id:'demo-org',name:'SakanGo Demo'}]};
if(process.env.DATABASE_URL && !demoMode){
  const {Pool}=await import('pg');
  pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSLMODE==='require'?{rejectUnauthorized:true}:false,max:5,connectionTimeoutMillis:12000});
  await pool.query(`CREATE TABLE IF NOT EXISTS organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,pass_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'customer',org_id TEXT REFERENCES organizations(id),created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS listings(id TEXT PRIMARY KEY,org_id TEXT REFERENCES organizations(id),title TEXT NOT NULL,city TEXT NOT NULL,area TEXT NOT NULL,price NUMERIC NOT NULL,rooms INTEGER NOT NULL,baths INTEGER NOT NULL,size INTEGER NOT NULL,kind TEXT NOT NULL,transaction TEXT NOT NULL,image TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'published',created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS leads(id TEXT PRIMARY KEY,listing_id TEXT NOT NULL REFERENCES listings(id),user_id TEXT REFERENCES users(id),name TEXT NOT NULL,phone TEXT NOT NULL,message TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'new',created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS appointments(id TEXT PRIMARY KEY,listing_id TEXT NOT NULL REFERENCES listings(id),user_id TEXT REFERENCES users(id),name TEXT NOT NULL,phone TEXT NOT NULL,scheduled_at TIMESTAMPTZ NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS favorites(user_id TEXT NOT NULL REFERENCES users(id),listing_id TEXT NOT NULL REFERENCES listings(id),PRIMARY KEY(user_id,listing_id));`);
}
async function rows(table,where='',values=[]){if(pool)return (await pool.query(`SELECT * FROM ${table} ${where}`,values)).rows;return memory[table]||[];}
async function insert(table,record){if(pool){const keys=Object.keys(record);const val=Object.values(record);let placeholders=keys.map((_,i)=>'$'+(i+1)).join(',');return (await pool.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${placeholders}) RETURNING *`,val)).rows[0];} memory[table].push(record);return record;}
async function update(table,recordId,changes){if(pool){const keys=Object.keys(changes),vals=Object.values(changes);return (await pool.query(`UPDATE ${table} SET ${keys.map((k,i)=>`${k}=$${i+1}`).join(',')} WHERE id=$${keys.length+1} RETURNING *`,[...vals,recordId])).rows[0];}let x=memory[table].find(y=>y.id===recordId);if(x)Object.assign(x,changes);return x;}
async function getUser(email){if(pool)return (await pool.query('SELECT * FROM users WHERE email=$1',[email])).rows[0];return memory.users.find(u=>u.email===email);}
async function byId(table,pk){if(pool)return (await pool.query(`SELECT * FROM ${table} WHERE id=$1`,[pk])).rows[0];return memory[table].find(x=>x.id===pk);}
async function ensureAdmin(){const email=process.env.ADMIN_EMAIL?.trim().toLowerCase(),password=process.env.ADMIN_PASSWORD;if(!email||!password)return;const existing=await getUser(email);if(existing)return;let org=await (pool?pool.query('SELECT * FROM organizations WHERE id=$1',['sakango-root']).then(r=>r.rows[0]):Promise.resolve(memory.organizations.find(x=>x.id==='sakango-root')));if(!org)org=await insert('organizations',{id:'sakango-root',name:'SakanGo'});await insert('users',{id:id(),name:'System Administrator',email,pass_hash:makePassword(password),role:'superadmin',org_id:org.id});console.log('Superadmin provisioned.');}
await ensureAdmin();
const json=(res,status,obj)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj));};
const error=(status,message)=>Object.assign(new Error(message),{status});
const limits=new Map();
function throttle(ip){let v=limits.get(ip)||{n:0,reset:Date.now()+60000};if(Date.now()>v.reset)v={n:0,reset:Date.now()+60000};v.n++;limits.set(ip,v);if(v.n>15)throw error(429,'محاولات كثيرة، حاول بعد دقيقة');}
async function body(req){let b='';for await(const chunk of req){b+=chunk;if(b.length>35000)throw error(413,'الطلب كبير');}try{return JSON.parse(b||'{}');}catch{throw error(400,'JSON غير صالح');}}
async function principal(req){const token=req.headers.authorization?.replace(/^Bearer /i,'');let claims=readToken(token,secret);return claims?await byId('users',claims.sub):null;}
function guard(user,roles){if(!user||!roles.includes(user.role))throw error(403,'غير مصرح بهذه العملية');}
function canManage(user,listing){return user?.role==='superadmin'||(user && ['agency_admin','broker'].includes(user.role)&&user.org_id&&user.org_id===listing.org_id);}
const safeUser=u=>({id:u.id,name:u.name,email:u.email,role:u.role,org_id:u.org_id});
async function api(req,res,url){
 const route=url.pathname,method=req.method,user=await principal(req);
 if(route==='/api/health')return json(res,200,{ok:true,service:'SakanGo',database:pool?'postgres':'development-demo'});
 if(route==='/api/me')return json(res,200,{user:user?safeUser(user):null});
 if(route==='/api/auth/register'&&method==='POST'){throttle(req.socket.remoteAddress);const d=await body(req);const email=String(d.email||'').trim().toLowerCase();if(!/^\S+@\S+\.\S+$/.test(email)||String(d.password||'').length<10||String(d.name||'').trim().length<2)throw error(400,'الاسم والبريد وكلمة المرور (10 أحرف على الأقل) مطلوبة');if(await getUser(email))throw error(409,'البريد مسجل بالفعل');const u=await insert('users',{id:id(),name:String(d.name).slice(0,90),email,pass_hash:makePassword(String(d.password)),role:'customer',org_id:null});return json(res,201,{token:signToken({sub:u.id},secret),user:safeUser(u)});}
 if(route==='/api/auth/login'&&method==='POST'){throttle(req.socket.remoteAddress);const d=await body(req);const u=await getUser(String(d.email||'').trim().toLowerCase());if(!u||!checkPassword(String(d.password||''),u.pass_hash))throw error(401,'بيانات الدخول غير صحيحة');return json(res,200,{token:signToken({sub:u.id},secret),user:safeUser(u)});}
 if(route==='/api/listings'&&method==='GET'){let all=await rows('listings');all=all.filter(x=>x.status==='published'||canManage(user,x));const p=url.searchParams;const search=(p.get('search')||'').toLowerCase();const city=p.get('city')||'',kind=p.get('kind')||'',transaction=p.get('transaction')||'',max=Number(p.get('max')||0);all=all.filter(x=>(!search||[x.title,x.city,x.area].join(' ').toLowerCase().includes(search))&&(!city||x.city===city)&&(!kind||x.kind===kind)&&(!transaction||x.transaction===transaction)&&(!max||Number(x.price)<=max));return json(res,200,{items:all.sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||''))),demo:!pool});}
 if(route==='/api/listings'&&method==='POST'){guard(user,['superadmin','agency_admin','broker']);const d=await body(req),v=validListing(d);if(!v.ok)throw error(400,v.message);const obj={id:id(),org_id:user.org_id,title:d.title.trim(),city:d.city.trim(),area:d.area.trim(),price:Number(d.price),rooms:Number(d.rooms),baths:Number(d.baths),size:Number(d.size),kind:d.kind,transaction:d.transaction,image:slugSafe(d.image||''),description:String(d.description||'').slice(0,2000),status:'published'};return json(res,201,{item:await insert('listings',obj)});}
 const itemMatch=route.match(/^\/api\/listings\/([a-zA-Z0-9-]+)$/);
 if(itemMatch){const l=await byId('listings',itemMatch[1]);if(!l)throw error(404,'العقار غير موجود');if(method==='GET'&& (l.status==='published'||canManage(user,l)))return json(res,200,{item:l});if(method==='PATCH'){if(!canManage(user,l))throw error(403,'غير مصرح');const d=await body(req);const keys=['title','city','area','price','rooms','baths','size','kind','transaction','description','image','status'];const patch={};for(const k of keys)if(d[k]!==undefined)patch[k]=d[k];const test=validListing({...l,...patch});if(!test.ok)throw error(400,test.message);if(patch.status&&!['published','hidden'].includes(patch.status))throw error(400,'حالة غير صالحة');if('image'in patch)patch.image=slugSafe(patch.image);if('description'in patch)patch.description=String(patch.description).slice(0,2000);for(const n of ['price','rooms','baths','size'])if(n in patch)patch[n]=Number(patch[n]);return json(res,200,{item:await update('listings',l.id,patch)});}throw error(405,'الطريقة غير مدعومة');}
 if(route==='/api/favorites'&&method==='GET'){guard(user,['customer','broker','agency_admin','superadmin']);let ids=pool?(await pool.query('SELECT listing_id FROM favorites WHERE user_id=$1',[user.id])).rows.map(x=>x.listing_id):memory.favorites.filter(x=>x.user_id===user.id).map(x=>x.listing_id);return json(res,200,{ids});}
 if(route==='/api/favorites'&&method==='POST'){guard(user,['customer','broker','agency_admin','superadmin']);const d=await body(req);if(!(await byId('listings',d.listing_id)))throw error(404,'العقار غير موجود');if(pool)await pool.query('INSERT INTO favorites(user_id,listing_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[user.id,d.listing_id]);else if(!memory.favorites.some(x=>x.user_id===user.id&&x.listing_id===d.listing_id))memory.favorites.push({user_id:user.id,listing_id:d.listing_id});return json(res,200,{ok:true});}
 if(route==='/api/leads'&&method==='POST'){throttle(req.socket.remoteAddress);const d=await body(req),listing=await byId('listings',d.listing_id);if(!listing||listing.status!=='published')throw error(404,'العقار غير متاح');if(String(d.name||'').length<2||!/^[+\d\s()-]{8,22}$/.test(String(d.phone||'')))throw error(400,'الاسم ورقم هاتف صحيح مطلوبان');return json(res,201,{item:await insert('leads',{id:id(),listing_id:listing.id,user_id:user?.id||null,name:String(d.name).slice(0,90),phone:String(d.phone).slice(0,22),message:String(d.message||'').slice(0,1000),status:'new'})});}
 if(route==='/api/appointments'&&method==='POST'){throttle(req.socket.remoteAddress);const d=await body(req),listing=await byId('listings',d.listing_id);if(!listing||listing.status!=='published')throw error(404,'العقار غير متاح');const when=new Date(d.scheduled_at);if(!Number.isFinite(when.getTime())||when<Date.now())throw error(400,'اختر موعدًا مستقبليًا');if(String(d.name||'').length<2||!/^[+\d\s()-]{8,22}$/.test(String(d.phone||'')))throw error(400,'الاسم ورقم الهاتف مطلوبان');return json(res,201,{item:await insert('appointments',{id:id(),listing_id:listing.id,user_id:user?.id||null,name:String(d.name).slice(0,90),phone:String(d.phone),scheduled_at:when.toISOString(),status:'pending'})});}
 if(route==='/api/admin/summary'&&method==='GET'){guard(user,['superadmin','agency_admin','broker']);const listings=(await rows('listings')).filter(x=>canManage(user,x));const listingIds=new Set(listings.map(x=>x.id));const leads=(await rows('leads')).filter(x=>listingIds.has(x.listing_id));const appointments=(await rows('appointments')).filter(x=>listingIds.has(x.listing_id));const users=user.role==='superadmin'?await rows('users'):[];return json(res,200,{listings:listings.length,leads:leads.length,appointments:appointments.length,users:users.length,recentLeads:leads.slice(-15).reverse(),recentAppointments:appointments.slice(-15).reverse()});}
 if(route==='/api/admin/staff'&&method==='POST'){guard(user,['superadmin']);const d=await body(req),email=String(d.email||'').trim().toLowerCase();if(!['agency_admin','broker'].includes(d.role)||!/^\S+@\S+\.\S+$/.test(email)||String(d.password||'').length<10||String(d.name||'').length<2)throw error(400,'البيانات غير صالحة');if(await getUser(email))throw error(409,'البريد مستخدم');let orgId=String(d.org_id||'').trim();if(!orgId){orgId=id();await insert('organizations',{id:orgId,name:String(d.organization||'New Agency').slice(0,100)});}else{let org=pool?(await pool.query('SELECT * FROM organizations WHERE id=$1',[orgId])).rows[0]:memory.organizations.find(o=>o.id===orgId);if(!org)throw error(400,'الشركة غير موجودة');}const u=await insert('users',{id:id(),name:String(d.name).slice(0,90),email,pass_hash:makePassword(String(d.password)),role:d.role,org_id:orgId});return json(res,201,{user:safeUser(u)});}
 if(route==='/api/assistant'&&method==='POST'){const d=await body(req);const all=(await rows('listings')).filter(x=>x.status==='published');const t=String(d.message||'').slice(0,400).toLowerCase();const maxMatch=t.match(/(\d[\d,]*)\s*(?:مليون|million)/);const max=maxMatch?Number(maxMatch[1].replaceAll(',',''))*1e6:null;let picks=all.filter(x=>(!max||Number(x.price)<=max)&&(!/إيجار|rent/.test(t)||x.transaction==='إيجار')&&(!/فيلا|villa/.test(t)||x.kind==='فيلا')&&(!/شقة|apartment/.test(t)||x.kind==='شقة')).slice(0,3);return json(res,200,{message:picks.length?'لقيت لك اختيارات مبدئية حسب المعايير المكتوبة. يمكنك فتح تفاصيل كل عقار للمقارنة.':'لم أجد عقارات مطابقة حاليًا؛ جرّب توسيع شروط البحث.',items:picks,notice:'ترشيحات تجريبية بقواعد بحث، وليست نموذج ذكاء اصطناعي توليديًا.'});}
 throw error(404,'الرابط غير موجود');
}
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.json':'application/json','.webmanifest':'application/manifest+json'};
const server=http.createServer(async(req,res)=>{
 try{
  const u=new URL(req.url,'http://localhost');
  if(req.method==='OPTIONS'){res.writeHead(204,{'Allow':'GET, POST, PATCH, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization'});return res.end();}
  const origin=req.headers.origin,allowed=process.env.ALLOWED_ORIGIN;
  if(prod&&origin&&allowed&&origin!==allowed)throw error(403,'Origin not allowed');
  if(u.pathname.startsWith('/api/'))return await api(req,res,u);
  if(req.method!=='GET'&&req.method!=='HEAD')throw error(405,'Method not allowed');
  let rel=decodeURIComponent(u.pathname);if(rel==='/'||rel==='/index.html')rel='/index.html';
  const file=path.resolve(publicDir,'.'+rel);
  if(!file.startsWith(publicDir+path.sep))throw error(403,'Forbidden');
  let data;try{data=await fs.readFile(file);}catch{return json(res,404,{error:'Not found'});}
  res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; img-src 'self' https://images.unsplash.com data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});res.end(req.method==='HEAD'?undefined:data);
 }catch(e){if((e.code||'')==='23505')return json(res,409,{error:'البيانات مسجلة بالفعل'});console.error(e.status?e.message:e);return json(res,e.status||500,{error:e.status?e.message:'خطأ داخلي في الخادم'});}
});
server.listen(port,'0.0.0.0',()=>console.log(`SakanGo listening on ${port} (${pool?'PostgreSQL':'local demo'})`));
