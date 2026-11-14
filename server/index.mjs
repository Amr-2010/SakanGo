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
const demoMode=process.env.DEMO_MODE==='true' && !process.env.DATABASE_URL;
if(process.env.DATABASE_URL && process.env.DEMO_MODE==='true')console.warn('DATABASE_URL provided: ignoring DEMO_MODE to protect persistent data.');
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
  await pool.query(await fs.readFile(path.join(here,'modules-schema.sql'),'utf8'));
  await pool.query('ALTER TABLE listings ADD COLUMN IF NOT EXISTS advertiser_name TEXT');
  await pool.query('ALTER TABLE listings ADD COLUMN IF NOT EXISTS advertiser_phone TEXT');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query("CREATE TABLE IF NOT EXISTS featured_requests(id TEXT PRIMARY KEY,listing_id TEXT NOT NULL REFERENCES listings(id),requested_by TEXT NOT NULL REFERENCES users(id),duration_days INTEGER NOT NULL CHECK(duration_days IN (7,14,30)),status TEXT NOT NULL DEFAULT 'pending_payment' CHECK(status IN ('pending_payment','pending_review','approved','rejected')),payment_reference TEXT,approved_by TEXT,starts_at TIMESTAMPTZ,ends_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT now())");
  await pool.query('CREATE TABLE IF NOT EXISTS listing_images(id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL REFERENCES users(id),mime_type TEXT NOT NULL,image_bytes BYTEA NOT NULL,created_at TIMESTAMPTZ DEFAULT now())');
  // Idempotent demonstration catalog. All records are explicitly tagged as samples.
  // Seed only the demo organization; never overwrite actual user-created listings.
  await pool.query("INSERT INTO organizations(id,name,organization_type,approval_status) VALUES ('demo-org','SakanGo Sample Properties','agency','approved') ON CONFLICT (id) DO NOTHING");
  for(const item of sample){
    await pool.query(`INSERT INTO listings
      (id,org_id,title,city,area,price,rooms,baths,size,kind,transaction,image,description,status,section)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'published','marketplace')
      ON CONFLICT (id) DO NOTHING`,
      [item.id,item.org_id,item.title,item.city,item.area,item.price,item.rooms,item.baths,item.size,item.kind,item.transaction,item.image,'[بيانات تجريبية] '+item.description]);
  }
  console.log('SakanGo demo listings available in PostgreSQL.');

}
async function rows(table,where='',values=[]){if(pool)return (await pool.query(`SELECT * FROM ${table} ${where}`,values)).rows;return memory[table]||[];}
async function insert(table,record){if(pool){const keys=Object.keys(record);const val=Object.values(record);let placeholders=keys.map((_,i)=>'$'+(i+1)).join(',');return (await pool.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${placeholders}) RETURNING *`,val)).rows[0];} memory[table].push(record);return record;}
async function update(table,recordId,changes){if(pool){const keys=Object.keys(changes),vals=Object.values(changes);return (await pool.query(`UPDATE ${table} SET ${keys.map((k,i)=>`${k}=$${i+1}`).join(',')} WHERE id=$${keys.length+1} RETURNING *`,[...vals,recordId])).rows[0];}let x=memory[table].find(y=>y.id===recordId);if(x)Object.assign(x,changes);return x;}
async function getUser(email){if(pool)return (await pool.query('SELECT * FROM users WHERE email=$1',[email])).rows[0];return memory.users.find(u=>u.email===email);}
async function byId(table,pk){if(pool)return (await pool.query(`SELECT * FROM ${table} WHERE id=$1`,[pk])).rows[0];return memory[table].find(x=>x.id===pk);}
async function ensureAdmin(){const email=process.env.ADMIN_EMAIL?.trim().toLowerCase(),password=process.env.ADMIN_PASSWORD;if(!email||!password)return;const existing=await getUser(email);
 if(existing){
   // Only the explicitly configured bootstrap email may be reconciled.
   // Keep the unique superadmin role attached to that email and align its password
   // with the protected Render environment variable.
   if(existing.role!=='superadmin'){
     const other=pool?(await pool.query("SELECT id FROM users WHERE role='superadmin' AND id<>$1 LIMIT 1",[existing.id])).rows[0]:memory.users.find(u=>u.role==='superadmin'&&u.id!==existing.id);
     if(other)throw new Error('Another superadmin already exists; manual account review required.');
   }
   const changes={};
   if(existing.role!=='superadmin')changes.role='superadmin';
   if(!checkPassword(password,existing.pass_hash))changes.pass_hash=makePassword(password);
   if(Object.keys(changes).length)await update('users',existing.id,changes);
   console.log('Configured superadmin account verified.');
   return;
 }let org=await (pool?pool.query('SELECT * FROM organizations WHERE id=$1',['sakango-root']).then(r=>r.rows[0]):Promise.resolve(memory.organizations.find(x=>x.id==='sakango-root')));if(!org)org=await insert('organizations',{id:'sakango-root',name:'SakanGo'});await insert('users',{id:id(),name:'System Administrator',email,pass_hash:makePassword(password),role:'superadmin',org_id:org.id});console.log('Superadmin provisioned.');}
await ensureAdmin();
const json=(res,status,obj)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj));};
const error=(status,message)=>Object.assign(new Error(message),{status});
const limits=new Map();
function throttle(ip){let v=limits.get(ip)||{n:0,reset:Date.now()+60000};if(Date.now()>v.reset)v={n:0,reset:Date.now()+60000};v.n++;limits.set(ip,v);if(v.n>15)throw error(429,'محاولات كثيرة، حاول بعد دقيقة');}
async function body(req){let b='';for await(const chunk of req){b+=chunk;if(b.length>35000)throw error(413,'الطلب كبير');}try{return JSON.parse(b||'{}');}catch{throw error(400,'JSON غير صالح');}}
async function principal(req){const token=req.headers.authorization?.replace(/^Bearer /i,'');let claims=readToken(token,secret);if(!claims)return null;const account=await byId('users',claims.sub);return account&&!account.disabled?account:null;}
function guard(user,roles){if(!user||!roles.includes(user.role))throw error(403,'غير مصرح بهذه العملية');}
function canManage(user,listing){return !!user&&(['superadmin','agency_admin'].includes(user.role)||(user.role==='broker'&&user.org_id&&user.org_id===listing.org_id));}
async function accountTypeFor(user){if(!user)return 'customer';if(user.role==='superadmin')return 'superadmin';if(user.role==='agency_admin')return 'agency';if(!pool)return user.role==='broker'?'broker':'customer';const r=await pool.query('SELECT account_type FROM account_profiles WHERE user_id=$1 LIMIT 1',[user.id]);return r.rows[0]?.account_type||(user.role==='broker'?'broker':'customer');}
const safeUser=u=>({id:u.id,name:u.name,email:u.email,role:u.role,org_id:u.org_id,disabled:!!u.disabled});
async function hasPermission(user,permission){if(!user)return false;if(user.role==='superadmin')return true;if(user.role==='agency_admin')return true;if(!pool)return false;return (await pool.query('SELECT 1 FROM user_permissions WHERE user_id=$1 AND permission=$2',[user.id,permission])).rowCount>0;}
// Persistent module endpoints. Only explicitly allowed columns are accepted.
const moduleDefinitions={
 projects:{table:'projects',required:['name'],fields:['name','city','status']},
 units:{table:'project_units',required:['project_id','unit_code'],fields:['project_id','unit_code','price','status']},
 contacts:{table:'crm_contacts',required:['name'],fields:['name','phone','email']},
 deals:{table:'crm_deals',required:[],fields:['contact_id','listing_id','assigned_to','stage','amount']},
 referrals:{table:'broker_referrals',required:['deal_id','broker_id'],fields:['deal_id','broker_id','commission_rate','commission_amount','status']},
 contracts:{table:'rental_contracts',required:['listing_id','tenant_name','start_date','end_date'],fields:['listing_id','tenant_name','start_date','end_date','rent_amount','status']},
 maintenance:{table:'maintenance_tickets',required:['title'],fields:['listing_id','title','status']},
 payments:{table:'rent_payments',required:['contract_id','amount','due_date'],fields:['contract_id','amount','due_date','paid_at','status']}
};
async function moduleApi(req,res,route,user){
 const match=route.match(/^\/api\/modules\/([a-z]+)$/),cfg=match&&moduleDefinitions[match[1]];
 if(!cfg)throw error(404,'القسم غير موجود');
 if(!user)throw error(401,'سجل الدخول أولاً');
 if(!pool)throw error(503,'يلزم اتصال PostgreSQL');
 if(!user.org_id)throw error(403,'لا توجد شركة مفعلة');
 const allowed=user.role==='superadmin'||user.role==='agency_admin'||(await pool.query("SELECT 1 FROM organization_memberships WHERE user_id=$1 AND org_id=$2 AND status='active'",[user.id,user.org_id])).rowCount>0;
 if(!allowed)throw error(403,'غير مصرح');
 if(req.method==='GET'){
  return json(res,200,{items:(await pool.query('SELECT * FROM '+cfg.table+' WHERE org_id=$1 ORDER BY created_at DESC LIMIT 200',[user.org_id])).rows});
 }
 if(req.method==='POST'){
  const data=await body(req);
  for(const k of cfg.required)if(!String(data[k]??'').trim())throw error(400,'مطلوب: '+k);
  const record={id:id(),org_id:user.org_id};
  for(const k of cfg.fields)if(data[k]!==undefined){if(typeof data[k]==='object')throw error(400,'قيمة غير صالحة');record[k]=String(data[k]).slice(0,300);}
  return json(res,201,{item:await insert(cfg.table,record)});
 }
 throw error(405,'غير مدعوم');
}
async function api(req,res,url){
 const route=url.pathname,method=req.method,user=await principal(req);
 if(route.startsWith('/api/modules/'))return await moduleApi(req,res,route,user);
 if(route==='/api/health')return json(res,200,{ok:true,service:'SakanGo',database:pool?'postgres':'development-demo',persistent:!!pool});
 if(route==='/api/images/upload'&&method==='POST'){
  if(!user)throw error(401,'سجل الدخول أولاً');
  if(!pool)throw error(503,'قاعدة البيانات غير متصلة');
  let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1900000)throw error(413,'الصورة كبيرة؛ الحد الأقصى 1 ميجابايت');}
  let data;try{data=JSON.parse(raw);}catch{throw error(400,'بيانات الصورة غير صالحة');}
  const mime=String(data.mime||'');
  if(!['image/jpeg','image/png','image/webp'].includes(mime)||typeof data.base64!=='string'||!/^[-A-Za-z0-9+/=]+$/.test(data.base64))throw error(400,'صيغة الصورة غير مدعومة');
  const bytes=Buffer.from(data.base64,'base64');
  if(!bytes.length||bytes.length>1048576)throw error(413,'حجم الصورة يتجاوز 1 ميجابايت');
  const signature=mime==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):mime==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
  if(!signature)throw error(400,'ملف الصورة غير صحيح');
  const imageId=id();await pool.query('INSERT INTO listing_images(id,owner_user_id,mime_type,image_bytes) VALUES($1,$2,$3,$4)',[imageId,user.id,mime,bytes]);
  return json(res,201,{url:'/api/images/'+imageId});
 }
 const imageMatch=route.match(/^\/api\/images\/([0-9a-f-]{36})$/);
 if(imageMatch&&method==='GET'){if(!pool)throw error(404,'الصورة غير موجودة');const image=(await pool.query('SELECT mime_type,image_bytes FROM listing_images WHERE id=$1',[imageMatch[1]])).rows[0];if(!image)throw error(404,'الصورة غير موجودة');res.writeHead(200,{'Content-Type':image.mime_type,'Cache-Control':'public, max-age=86400','X-Content-Type-Options':'nosniff'});return res.end(image.image_bytes);}
 if(route==='/api/me')return json(res,200,{user:user?{...safeUser(user),account_type:await accountTypeFor(user),permissions:{dashboard:await hasPermission(user,'dashboard_view'),reports:await hasPermission(user,'reports_view')}}:null});

 if(route==='/api/account/types'&&method==='GET')return json(res,200,{types:['customer','owner','agency','developer','broker','property_manager'],applicationRequired:[]});
 if(route==='/api/account/apply'&&method==='POST'){
  if(!user)throw error(401,'يجب تسجيل الدخول');
  const d=await body(req),type=String(d.account_type||'');
  if(!['owner','agency','developer','broker','property_manager'].includes(type))throw error(400,'نوع الحساب غير صالح');
  if(!pool)throw error(503,'طلبات تفعيل الحسابات تحتاج قاعدة بيانات دائمة');
  const existing=await pool.query("SELECT id FROM account_applications WHERE user_id=$1 AND requested_type=$2 AND status='pending'",[user.id,type]);
  if(existing.rowCount)throw error(409,'لديك طلب قيد المراجعة بالفعل');
  const item=await insert('account_applications',{id:id(),user_id:user.id,requested_type:type,status:'pending'});
  return json(res,201,{item:{id:item.id,requested_type:item.requested_type,status:item.status}});
 }
 if(route==='/api/account/applications'&&method==='GET'){
  if(!user)throw error(401,'يجب تسجيل الدخول');
  if(!pool)throw error(503,'قاعدة البيانات الدائمة غير متصلة');
  const items=(await pool.query('SELECT id,requested_type,status,created_at FROM account_applications WHERE user_id=$1 ORDER BY created_at DESC',[user.id])).rows;
  return json(res,200,{items});
 }
 if(route==='/api/admin/account-applications'&&method==='GET'){
  guard(user,['superadmin']);
  if(!pool)throw error(503,'قاعدة البيانات الدائمة غير متصلة');
  const items=(await pool.query("SELECT a.id,a.user_id,u.name,u.email,a.requested_type,a.status,a.created_at FROM account_applications a JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 100")).rows;
  return json(res,200,{items});
 }

 if(route==='/api/admin/users'&&method==='GET'){
  guard(user,['superadmin','agency_admin']);const all=await rows('users');
  return json(res,200,{items:all.map(safeUser)});
 }
 const userManage=route.match(/^\/api\/admin\/users\/([a-zA-Z0-9-]+)$/);
 if(userManage&&(method==='PATCH'||method==='DELETE')){
  guard(user,['superadmin','agency_admin']);const target=await byId('users',userManage[1]);if(!target)throw error(404,'المستخدم غير موجود');
  if(target.role==='superadmin'||target.id===user.id||(user.role==='agency_admin'&&target.role==='agency_admin'))throw error(403,'لا يمكن تعديل أو حذف السوبر أدمن أو حساب أدمن آخر');
  if(method==='DELETE'){const item=await update('users',target.id,{disabled:true});return json(res,200,{user:safeUser(item),message:'تم تعطيل الحساب مع الاحتفاظ بسجلاته'});}
  const d=await body(req),patch={};
  if(d.name!==undefined){if(String(d.name).trim().length<2)throw error(400,'الاسم غير صالح');patch.name=String(d.name).trim().slice(0,90);}
  if(d.email!==undefined){const email=String(d.email).trim().toLowerCase();if(!/^\S+@\S+\.\S+$/.test(email))throw error(400,'البريد غير صالح');const other=await getUser(email);if(other&&other.id!==target.id)throw error(409,'البريد مستخدم');patch.email=email;}
  if(d.role!==undefined){if(!['customer','broker','agency_admin'].includes(d.role))throw error(400,'الدور غير صالح');if(d.role==='agency_admin'&&!target.org_id)throw error(400,'يجب ربط المدير بشركة أولاً');patch.role=d.role;}
  if(d.disabled!==undefined){if(typeof d.disabled!=='boolean')throw error(400,'حالة غير صالحة');patch.disabled=d.disabled;}
  if(d.password!==undefined&&String(d.password).length){if(String(d.password).length<10)throw error(400,'كلمة المرور قصيرة');patch.pass_hash=makePassword(String(d.password));}
  if(!Object.keys(patch).length)throw error(400,'لا توجد تغييرات');
  return json(res,200,{user:safeUser(await update('users',target.id,patch))});
 }
 if(route==='/api/admin/permissions'&&method==='GET'){
  guard(user,['superadmin']);if(!pool)throw error(503,'قاعدة بيانات PostgreSQL مطلوبة');
  const items=(await pool.query('SELECT user_id,permission,granted_by,created_at FROM user_permissions ORDER BY created_at DESC')).rows;
  return json(res,200,{items});
 }
 if(route==='/api/admin/permissions'&&method==='POST'){
  guard(user,['superadmin']);if(!pool)throw error(503,'قاعدة بيانات PostgreSQL مطلوبة');
  const d=await body(req),permission=String(d.permission||''),target=await byId('users',String(d.user_id||''));
  if(!target||!['dashboard_view','reports_view','reports_export'].includes(permission)||typeof d.enabled!=='boolean')throw error(400,'بيانات الصلاحية غير صالحة');
  if(target.role==='superadmin')throw error(400,'صلاحيات السوبر أدمن ثابتة');
  if(d.enabled)await pool.query('INSERT INTO user_permissions(user_id,permission,granted_by) VALUES($1,$2,$3) ON CONFLICT(user_id,permission) DO UPDATE SET granted_by=EXCLUDED.granted_by',[target.id,permission,user.id]);
  else await pool.query('DELETE FROM user_permissions WHERE user_id=$1 AND permission=$2',[target.id,permission]);
  return json(res,200,{ok:true});
 }
 if(route==='/api/admin/reports'&&method==='GET'){
  if(!await hasPermission(user,'reports_view'))throw error(403,'غير مصرح بالتقارير');
  const owned=(await rows('listings')).filter(l=>['superadmin','agency_admin'].includes(user.role)||(l.created_by&&l.created_by===user.id));
  const ids=new Set(owned.map(l=>l.id));
  const leads=(await rows('leads')).filter(l=>ids.has(l.listing_id));
  const appointments=(await rows('appointments')).filter(a=>ids.has(a.listing_id));
  return json(res,200,{scope:user.role==='superadmin'?'platform':'own_organization',totals:{listings:owned.length,published:owned.filter(l=>l.status==='published').length,leads:leads.length,appointments:appointments.length},byTransaction:{sale:owned.filter(l=>l.transaction==='بيع').length,rent:owned.filter(l=>l.transaction==='إيجار').length}});
 }
 if(route==='/api/admin/location-prices'&&method==='GET'){
  guard(user,['superadmin','agency_admin']);
  const all=(await rows('listings')).filter(l=>l.status==='published');
  const groups=new Map();
  for(const l of all){const place=[String(l.city||'غير محدد').trim(),String(l.area||'غير محدد').trim()].join(' / '),key=place+'|'+String(l.transaction||'');
   if(!groups.has(key))groups.set(key,{city:l.city||'غير محدد',area:l.area||'غير محدد',transaction:l.transaction||'',count:0,sum:0,min:null,max:null});
   const g=groups.get(key),price=Number(l.price);g.count++;if(Number.isFinite(price)&&price>=0){g.sum+=price;g.min=g.min===null?price:Math.min(g.min,price);g.max=g.max===null?price:Math.max(g.max,price);}
  }
  return json(res,200,{items:[...groups.values()].map(g=>({...g,average:g.count?Math.round(g.sum/g.count):0})).sort((a,b)=>a.city.localeCompare(b.city,'ar')||a.area.localeCompare(b.area,'ar'))});
 }
 if(route==='/api/admin/identity'&&method==='GET'){guard(user,['superadmin']);return json(res,200,{superadmin:safeUser(user),database:pool?'postgres':'ephemeral-demo'});}
 if(route==='/api/auth/register'&&method==='POST'){throttle(req.socket.remoteAddress);const d=await body(req);const email=String(d.email||'').trim().toLowerCase();if(!/^\S+@\S+\.\S+$/.test(email)||String(d.password||'').length<10||String(d.name||'').trim().length<2)throw error(400,'الاسم والبريد وكلمة المرور (10 أحرف على الأقل) مطلوبة');if(await getUser(email))throw error(409,'البريد مسجل بالفعل');const accountType=String(d.account_type||'customer');if(!['customer','owner','agency','developer','broker','property_manager'].includes(accountType))throw error(400,'نوع الحساب غير صالح');const u=await insert('users',{id:id(),name:String(d.name).slice(0,90),email,pass_hash:makePassword(String(d.password)),role:'customer',org_id:null});if(pool){await insert('account_profiles',{user_id:u.id,account_type:accountType});if(accountType!=='customer')await insert('account_applications',{id:id(),user_id:u.id,requested_type:accountType,status:'pending'});}return json(res,201,{token:signToken({sub:u.id},secret),user:{...safeUser(u),account_type:accountType},account_type:accountType,approval_status:accountType==='customer'?'not_required':pool?'pending':'demo_not_saved'});}
 if(route==='/api/auth/login'&&method==='POST'){throttle(req.socket.remoteAddress);const d=await body(req);const u=await getUser(String(d.email||'').trim().toLowerCase());if(!u||u.disabled||!checkPassword(String(d.password||''),u.pass_hash))throw error(401,'بيانات الدخول غير صحيحة');return json(res,200,{token:signToken({sub:u.id},secret),user:{...safeUser(u),account_type:await accountTypeFor(u)}});}
 if(route==='/api/listings'&&method==='GET'){let all=await rows('listings');all=all.filter(x=>x.status==='published'||canManage(user,x));const p=url.searchParams;const search=(p.get('search')||'').toLowerCase();const city=p.get('city')||'',kind=p.get('kind')||'',transaction=p.get('transaction')||'',max=Number(p.get('max')||0);all=all.filter(x=>(!search||[x.title,x.city,x.area].join(' ').toLowerCase().includes(search))&&(!city||x.city===city)&&(!kind||x.kind===kind)&&(!transaction||x.transaction===transaction)&&(!max||Number(x.price)<=max));return json(res,200,{items:all.sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||''))),demo:!pool});}
 if(route==='/api/listings'&&method==='POST'){if(!user)throw error(401,'سجل الدخول لإضافة إعلان');const d=await body(req),v=validListing(d);if(!v.ok)throw error(400,v.message);if(!/^\+?[0-9]{10,15}$/.test(String(d.advertiser_phone||'').replace(/[\s-]/g,'')))throw error(400,'رقم هاتف المعلن غير صالح');if(String(d.image||'').startsWith('/api/images/')){const imageId=String(d.image).split('/').pop();const found=pool?(await pool.query('SELECT id FROM listing_images WHERE id=$1 AND owner_user_id=$2',[imageId,user.id])).rowCount:0;if(!found)throw error(403,'الصورة غير مسموح بها');}const obj={id:id(),org_id:user.org_id||null,title:d.title.trim(),city:d.city.trim(),area:d.area.trim(),price:Number(d.price),rooms:Number(d.rooms),baths:Number(d.baths),size:Number(d.size),kind:d.kind,transaction:d.transaction,image:String(d.image||'').startsWith('/api/images/')?d.image:slugSafe(d.image||''),description:String(d.description||'').slice(0,2000),status:'pending',advertiser_name:user.name,advertiser_phone:String(d.advertiser_phone||'').replace(/[\s-]/g,''),created_by:user.id,owner_user_id:user.id,section:'marketplace'};return json(res,201,{item:await insert('listings',obj)});}
 if(route==='/api/featured/request'&&method==='POST'){
  if(!user)throw error(401,'سجل الدخول');if(!pool)throw error(503,'يلزم قاعدة بيانات');
  const d=await body(req),l=await byId('listings',String(d.listing_id||''));
  if(!l||l.owner_user_id!==user.id)throw error(403,'لا يمكنك تمييز هذا الإعلان');
  if(l.status!=='published')throw error(409,'يجب نشر الإعلان أولاً');
  const duration=Number(d.duration_days);if(![7,14,30].includes(duration))throw error(400,'المدة غير صالحة');
  const active=await pool.query("SELECT 1 FROM featured_requests WHERE listing_id=$1 AND (status IN ('pending_payment','pending_review') OR (status='approved' AND ends_at>now())) LIMIT 1",[l.id]);
  if(active.rowCount)throw error(409,'يوجد طلب تمييز قائم لهذا العقار');
  const result=await pool.query("INSERT INTO featured_requests(id,listing_id,requested_by,duration_days) VALUES($1,$2,$3,$4) RETURNING id,status,duration_days",[id(),l.id,user.id,duration]);
  return json(res,201,{item:result.rows[0],message:'تم تسجيل الطلب؛ لا يبدأ التمييز قبل تأكيد الدفع وموافقة الإدارة'});
 }
 if(route==='/api/admin/featured'&&method==='GET'){guard(user,['superadmin','agency_admin']);if(!pool)throw error(503,'يلزم قاعدة بيانات');return json(res,200,{items:(await pool.query("SELECT f.*,l.title,l.city,l.area,u.name AS advertiser_name FROM featured_requests f JOIN listings l ON l.id=f.listing_id JOIN users u ON u.id=f.requested_by ORDER BY f.created_at DESC LIMIT 200")).rows});}
 const featuredAction=route.match(/^\/api\/admin\/featured\/([a-zA-Z0-9-]+)$/);
 if(featuredAction&&method==='POST'){guard(user,['superadmin','agency_admin']);if(!pool)throw error(503,'يلزم قاعدة بيانات');const d=await body(req);if(!['confirm_payment','approve','reject'].includes(d.action))throw error(400,'قرار غير صالح');const f=(await pool.query('SELECT * FROM featured_requests WHERE id=$1',[featuredAction[1]])).rows[0];if(!f)throw error(404,'الطلب غير موجود');
  if(d.action==='confirm_payment'){if(f.status!=='pending_payment')throw error(409,'الحالة لا تسمح بتأكيد الدفع');if(!String(d.reference||'').trim())throw error(400,'أدخل مرجع الدفع');await pool.query("UPDATE featured_requests SET status='pending_review',payment_reference=$2 WHERE id=$1",[f.id,String(d.reference).slice(0,120)]);}
  if(d.action==='approve'){if(f.status!=='pending_review')throw error(409,'يجب تأكيد الدفع أولاً');const l=await byId('listings',f.listing_id);if(l?.status!=='published')throw error(409,'الإعلان غير منشور');await pool.query("UPDATE featured_requests SET status='approved',approved_by=$2,starts_at=now(),ends_at=now()+duration_days*interval '1 day' WHERE id=$1",[f.id,user.id]);}
  if(d.action==='reject'){if(!['pending_payment','pending_review'].includes(f.status))throw error(409,'لا يمكن رفض طلب مفعل');await pool.query("UPDATE featured_requests SET status='rejected',approved_by=$2 WHERE id=$1",[f.id,user.id]);}
  return json(res,200,{ok:true});
 }
 if(route==='/api/my/listings'&&method==='GET'){if(!user)throw error(401,'سجل الدخول');return json(res,200,{items:(await rows('listings')).filter(l=>l.owner_user_id===user.id||l.created_by===user.id)});}
 if(route==='/api/admin/listing-review'&&method==='GET'){guard(user,['superadmin','agency_admin']);const items=(await rows('listings')).filter(l=>user.role==='superadmin'||(user.org_id&&l.org_id===user.org_id)).sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')));return json(res,200,{items});}
 const reviewMatch=route.match(/^\/api\/admin\/listing-review\/([a-zA-Z0-9-]+)$/);
 if(reviewMatch&&method==='POST'){guard(user,['superadmin','agency_admin']);const l=await byId('listings',reviewMatch[1]);if(!l)throw error(404,'الإعلان غير موجود');if(l.status!=='pending')throw error(409,'تمت مراجعة الإعلان بالفعل');const d=await body(req);if(!['approved','rejected'].includes(d.action))throw error(400,'قرار غير صالح');const item=await update('listings',l.id,{status:d.action==='approved'?'published':'rejected'});return json(res,200,{item});}
 const adminListing=route.match(/^\/api\/admin\/listings\/([a-zA-Z0-9-]+)$/);
 if(adminListing&&(method==='PATCH'||method==='DELETE')){
  guard(user,['superadmin','agency_admin']);const l=await byId('listings',adminListing[1]);if(!l)throw error(404,'الإعلان غير موجود');
  
  if(method==='DELETE'){if(pool)await pool.query('DELETE FROM listings WHERE id=$1',[l.id]);else memory.listings=memory.listings.filter(x=>x.id!==l.id);return json(res,200,{ok:true});}
  const d=await body(req);const patch={};for(const k of ['title','city','area','description','price','rooms','baths','size'])if(d[k]!==undefined)patch[k]=d[k];
  const test=validListing({...l,...patch});if(!test.ok)throw error(400,test.message);
  for(const n of ['price','rooms','baths','size'])if(n in patch)patch[n]=Number(patch[n]);
  return json(res,200,{item:await update('listings',l.id,patch)});
 }
 const itemMatch=route.match(/^\/api\/listings\/([a-zA-Z0-9-]+)$/);
 if(itemMatch){const l=await byId('listings',itemMatch[1]);if(!l)throw error(404,'العقار غير موجود');if(method==='GET'&& (l.status==='published'||canManage(user,l)))return json(res,200,{item:l});if(method==='PATCH'){if(!user||!(canManage(user,l)||l.owner_user_id===user.id))throw error(403,'غير مصرح');const d=await body(req);const keys=['title','city','area','price','rooms','baths','size','kind','transaction','description','image'];const patch={};for(const k of keys)if(d[k]!==undefined)patch[k]=d[k];const test=validListing({...l,...patch});if(!test.ok)throw error(400,test.message);if('image'in patch)patch.image=slugSafe(patch.image);if('description'in patch)patch.description=String(patch.description).slice(0,2000);for(const n of ['price','rooms','baths','size'])if(n in patch)patch[n]=Number(patch[n]);patch.status='pending';return json(res,200,{item:await update('listings',l.id,patch)});}throw error(405,'الطريقة غير مدعومة');}
 if(route==='/api/favorites'&&method==='GET'){guard(user,['customer','broker','agency_admin','superadmin']);let ids=pool?(await pool.query('SELECT listing_id FROM favorites WHERE user_id=$1',[user.id])).rows.map(x=>x.listing_id):memory.favorites.filter(x=>x.user_id===user.id).map(x=>x.listing_id);return json(res,200,{ids});}
 if(route==='/api/favorites'&&method==='POST'){guard(user,['customer','broker','agency_admin','superadmin']);const d=await body(req);if(!(await byId('listings',d.listing_id)))throw error(404,'العقار غير موجود');if(pool)await pool.query('INSERT INTO favorites(user_id,listing_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[user.id,d.listing_id]);else if(!memory.favorites.some(x=>x.user_id===user.id&&x.listing_id===d.listing_id))memory.favorites.push({user_id:user.id,listing_id:d.listing_id});return json(res,200,{ok:true});}
 if(route==='/api/leads'&&method==='POST'){throttle(req.socket.remoteAddress);const d=await body(req),listing=await byId('listings',d.listing_id);if(!listing||listing.status!=='published')throw error(404,'العقار غير متاح');if(String(d.name||'').length<2||!/^[+\d\s()-]{8,22}$/.test(String(d.phone||'')))throw error(400,'الاسم ورقم هاتف صحيح مطلوبان');return json(res,201,{item:await insert('leads',{id:id(),listing_id:listing.id,user_id:user?.id||null,name:String(d.name).slice(0,90),phone:String(d.phone).slice(0,22),message:String(d.message||'').slice(0,1000),status:'new'})});}
 if(route==='/api/appointments'&&method==='POST'){throttle(req.socket.remoteAddress);const d=await body(req),listing=await byId('listings',d.listing_id);if(!listing||listing.status!=='published')throw error(404,'العقار غير متاح');const when=new Date(d.scheduled_at);if(!Number.isFinite(when.getTime())||when<Date.now())throw error(400,'اختر موعدًا مستقبليًا');if(String(d.name||'').length<2||!/^[+\d\s()-]{8,22}$/.test(String(d.phone||'')))throw error(400,'الاسم ورقم الهاتف مطلوبان');return json(res,201,{item:await insert('appointments',{id:id(),listing_id:listing.id,user_id:user?.id||null,name:String(d.name).slice(0,90),phone:String(d.phone),scheduled_at:when.toISOString(),status:'pending'})});}
 if(route==='/api/admin/summary'&&method==='GET'){if(!await hasPermission(user,'dashboard_view'))throw error(403,'غير مصرح بلوحة الإدارة');const listings=(await rows('listings')).filter(x=>canManage(user,x)||(x.created_by&&x.created_by===user.id));const listingIds=new Set(listings.map(x=>x.id));const leads=(await rows('leads')).filter(x=>listingIds.has(x.listing_id));const appointments=(await rows('appointments')).filter(x=>listingIds.has(x.listing_id));const users=['superadmin','agency_admin'].includes(user.role)?await rows('users'):[];return json(res,200,{listings:listings.length,leads:leads.length,appointments:appointments.length,users:users.length,recentLeads:leads.slice(-15).reverse(),recentAppointments:appointments.slice(-15).reverse()});}
 if(route==='/api/admin/staff'&&method==='POST'){guard(user,['superadmin','agency_admin']);const d=await body(req),email=String(d.email||'').trim().toLowerCase();if(!['agency_admin','broker'].includes(d.role)||!/^\S+@\S+\.\S+$/.test(email)||String(d.password||'').length<10||String(d.name||'').length<2)throw error(400,'البيانات غير صالحة');if(await getUser(email))throw error(409,'البريد مستخدم');let orgId=String(d.org_id||'').trim();if(!orgId){orgId=id();await insert('organizations',{id:orgId,name:String(d.organization||'New Agency').slice(0,100)});}else{let org=pool?(await pool.query('SELECT * FROM organizations WHERE id=$1',[orgId])).rows[0]:memory.organizations.find(o=>o.id===orgId);if(!org)throw error(400,'الشركة غير موجودة');}const u=await insert('users',{id:id(),name:String(d.name).slice(0,90),email,pass_hash:makePassword(String(d.password)),role:d.role,org_id:orgId});return json(res,201,{user:safeUser(u)});}
 if(route==='/api/assistant'&&method==='POST'){const d=await body(req);const all=(await rows('listings')).filter(x=>x.status==='published');const t=String(d.message||'').slice(0,400).toLowerCase();const maxMatch=t.match(/(\d[\d,]*)\s*(?:مليون|million)/);const max=maxMatch?Number(maxMatch[1].replaceAll(',',''))*1e6:null;let picks=all.filter(x=>(!max||Number(x.price)<=max)&&(!/إيجار|rent/.test(t)||x.transaction==='إيجار')&&(!/فيلا|villa/.test(t)||x.kind==='فيلا')&&(!/شقة|apartment/.test(t)||x.kind==='شقة')).slice(0,3);return json(res,200,{message:picks.length?'لقيت لك اختيارات مبدئية حسب المعايير المكتوبة. يمكنك فتح تفاصيل كل عقار للمقارنة.':'لم أجد عقارات مطابقة حاليًا؛ جرّب توسيع شروط البحث.',items:picks,notice:'ترشيحات تجريبية بقواعد بحث، وليست نموذج ذكاء اصطناعي توليديًا.'});}
 throw error(404,'الرابط غير موجود');
}
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.json':'application/json','.webmanifest':'application/manifest+json'};
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
