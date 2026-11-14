using static Helpers;
using Microsoft.AspNetCore.RateLimiting;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Npgsql;
using Org.BouncyCastle.Crypto.Generators;

var builder=WebApplication.CreateBuilder(args);
builder.WebHost.UseWebRoot("wwwroot");
builder.Services.AddSingleton<Db>();
builder.Services.AddSingleton<Auth>();
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode=429;
    options.AddFixedWindowLimiter("auth", x=> { x.PermitLimit=15; x.Window=TimeSpan.FromMinutes(1); x.QueueLimit=0; });
});
var app=builder.Build();
app.Use(async (ctx,next) =>
{
    try { await next(); }
    catch(ApiError ex) { if (!ctx.Response.HasStarted) { ctx.Response.StatusCode=ex.Status; await ctx.Response.WriteAsJsonAsync(new {error=ex.Message}); } }
    catch(PostgresException ex) { app.Logger.LogError("Database request rejected ({code})",ex.SqlState); if(!ctx.Response.HasStarted) {ctx.Response.StatusCode=503;await ctx.Response.WriteAsJsonAsync(new {error="تعذر تنفيذ الطلب بقاعدة البيانات"});} }
    catch(NpgsqlException ex) {app.Logger.LogError("PostgreSQL connection failed ({type})",ex.GetType().Name);if(!ctx.Response.HasStarted) {ctx.Response.StatusCode=503;await ctx.Response.WriteAsJsonAsync(new {error="قاعدة البيانات غير متاحة"});} }
});
app.UseRateLimiter();
app.UseDefaultFiles();app.UseStaticFiles();
app.MapGet("/api/health",(Db db)=> Results.Json(new {ok=true,service="SakanGo",engine="ASP.NET Core",database=db.Available?"postgres":"not-configured",persistent=db.Available}));
app.MapGet("/api/account/types",()=>Results.Json(new {types=new[]{"customer","owner","agency","developer","broker","property_manager"},applicationRequired=Array.Empty<string>()}));
app.MapGet("/api/me", async (HttpRequest req,Auth auth,Db db)=>{
    var u=await auth.User(req);
    if(u is null)return Results.Json(new {user=(object?)null});
    var type=await auth.Type(u);var role=S(u,"role");
    var safe=auth.Safe(u);safe["account_type"]=type;
    safe["permissions"]=new JsonObject {["dashboard"]=await auth.Permission(u,"dashboard_view"),["reports"]=await auth.Permission(u,"reports_view")};
    return Results.Json(new {user=safe});
});
app.MapPost("/api/auth/login",async(HttpRequest req,Auth auth,Db db)=>{
    var data=await Body(req);var email=S(data,"email").Trim().ToLowerInvariant();var password=S(data,"password");
    var user=await db.One("SELECT row_to_json(t)::text FROM (SELECT * FROM users WHERE email=@p0 LIMIT 1)t",email);
    if(user is null||B(user,"disabled")||!auth.VerifyPassword(password,S(user,"pass_hash")))throw new ApiError(401,"بيانات الدخول غير صحيحة");
    var safe=auth.Safe(user);safe["account_type"]=await auth.Type(user);
    return Results.Json(new {token=auth.Token(S(user,"id")),user=safe});
}).RequireRateLimiting("auth");
app.MapPost("/api/auth/register",async(HttpRequest req,Auth auth,Db db)=>{
    var d=await Body(req);var email=S(d,"email").Trim().ToLowerInvariant();var name=S(d,"name").Trim();var password=S(d,"password");var type=S(d,"account_type","customer");
    if(!ValidEmail(email)||password.Length<10||name.Length<2)throw new ApiError(400,"الاسم والبريد وكلمة المرور (10 أحرف على الأقل) مطلوبة");
    if(!new[]{"customer","owner","agency","developer","broker","property_manager"}.Contains(type))throw new ApiError(400,"نوع الحساب غير صالح");
    if(await db.One("SELECT row_to_json(t)::text FROM (SELECT id FROM users WHERE email=@p0)t",email) is not null)throw new ApiError(409,"البريد مسجل بالفعل");
    var id=Guid.NewGuid().ToString();
    var user=await db.Insert("users",new JsonObject {["id"]=id,["name"]=name[..Math.Min(90,name.Length)],["email"]=email,["pass_hash"]=auth.HashPassword(password),["role"]="customer"});
    await db.Insert("account_profiles",new JsonObject {["user_id"]=id,["account_type"]=type},key:"user_id");
    if(type!="customer")await db.Insert("account_applications",new JsonObject {["id"]=Guid.NewGuid().ToString(),["user_id"]=id,["requested_type"]=type,["status"]="pending"});
    var safe=auth.Safe(user);safe["account_type"]=type;
    return Results.Json(new {token=auth.Token(id),user=safe,account_type=type,approval_status=type=="customer"?"not_required":"pending"},statusCode:201);
}).RequireRateLimiting("auth");
app.MapGet("/api/listings",async(HttpRequest req,Db db,Auth auth)=>{
    var u=await auth.User(req);var q=req.Query;var values=new object?[]{q["search"].ToString(),q["city"].ToString(),q["kind"].ToString(),q["transaction"].ToString(),decimal.TryParse(q["max"],out var max)&&max>0?max:DBNull.Value,S(u,"role"),S(u,"org_id")};
    var items=await db.List(@"SELECT row_to_json(t)::text FROM (SELECT l.* FROM listings l WHERE
      (l.status='published' OR @p5='superadmin' OR (@p5 IN ('agency_admin','broker') AND l.org_id=@p6 AND @p6<>''))
      AND (@p0='' OR l.title ILIKE '%'||@p0||'%' OR l.city ILIKE '%'||@p0||'%' OR l.area ILIKE '%'||@p0||'%')
      AND (@p1='' OR l.city=@p1) AND (@p2='' OR l.kind=@p2)
      AND (@p3='' OR l.transaction=@p3) AND (@p4::numeric IS NULL OR l.price<=@p4::numeric)
      ORDER BY l.created_at DESC LIMIT 500)t",values);
    return Results.Json(new {items,demo=false});
});
app.MapGet("/api/listings/{id}",async(string id,HttpRequest req,Db db,Auth auth)=>{
    var u=await auth.User(req);var l=await db.Find("listings",id);
    if(l is null)throw new ApiError(404,"العقار غير موجود");
    if(S(l,"status")!="published"&&!auth.Manage(u,l)&&S(l,"owner_user_id")!=S(u,"id"))throw new ApiError(403,"غير مصرح");
    return Results.Json(new {item=l});
});
app.MapPost("/api/listings",async(HttpRequest req,Db db,Auth auth)=>{
    var u=await auth.Required(req);var d=await Body(req);CheckListing(d);
    var phone=Regex.Replace(S(d,"advertiser_phone"),@"[\s-]","");
    if(!Regex.IsMatch(phone,@"^\+?[0-9]{10,15}$"))throw new ApiError(400,"رقم هاتف المعلن غير صالح");
    var img=S(d,"image");
    if(img.StartsWith("/api/images/")){
        var found=await db.One("SELECT row_to_json(t)::text FROM (SELECT id FROM listing_images WHERE id=@p0 AND owner_user_id=@p1)t",img.Split('/').Last(),S(u,"id"));
        if(found is null)throw new ApiError(403,"الصورة غير مسموح بها");
    } else img=SafeImage(img);
    var x=new JsonObject {["id"]=Guid.NewGuid().ToString(),["title"]=S(d,"title"),["city"]=S(d,"city"),["area"]=S(d,"area"),["kind"]=S(d,"kind"),["transaction"]=S(d,"transaction"),
      ["image"]=img,["description"]=S(d,"description")[..Math.Min(2000,S(d,"description").Length)],["status"]="pending",["advertiser_name"]=S(u,"name"),
      ["advertiser_phone"]=phone,["created_by"]=S(u,"id"),["owner_user_id"]=S(u,"id"),["section"]="marketplace"};
    if(!string.IsNullOrEmpty(S(u,"org_id")))x["org_id"]=S(u,"org_id");
    foreach(var n in new[]{"price","rooms","baths","size"})x[n]=D(d,n);
    return Results.Json(new {item=await db.Insert("listings",x)},statusCode:201);
});
app.MapPatch("/api/listings/{id}",async(string id,HttpRequest req,Db db,Auth auth)=>{
    var u=await auth.Required(req);var old=await db.Find("listings",id)??throw new ApiError(404,"العقار غير موجود");
    if(!auth.Manage(u,old)&&S(old,"owner_user_id")!=S(u,"id"))throw new ApiError(403,"غير مصرح");
    var d=await Body(req);var patch=Patch(d,"title","city","area","price","rooms","baths","size","kind","transaction","description","image");
    var merged=(JsonObject)old.DeepClone();foreach(var kv in patch)merged[kv.Key]=kv.Value?.DeepClone();CheckListing(merged);
    if(patch.ContainsKey("image"))patch["image"]=SafeImage(S(patch,"image"));
    if(patch.ContainsKey("description"))patch["description"]=S(patch,"description")[..Math.Min(2000,S(patch,"description").Length)];
    patch["status"]="pending";
    return Results.Json(new {item=await db.Update("listings",id,patch)});
});
app.MapPost("/api/images/upload",async(HttpRequest req,Db db,Auth auth)=>{
    var u=await auth.Required(req);var d=await Body(req,2_000_000);var mime=S(d,"mime");
    if(!new[]{"image/jpeg","image/png","image/webp"}.Contains(mime))throw new ApiError(400,"صيغة الصورة غير مدعومة");
    byte[] image;try{image=Convert.FromBase64String(S(d,"base64"));}catch{throw new ApiError(400,"بيانات الصورة غير صالحة");}
    if(image.Length==0||image.Length>1048576)throw new ApiError(413,"حجم الصورة يتجاوز 1 ميجابايت");
    var good=mime switch{
        "image/png" => image.Length>8 && image.Take(8).SequenceEqual(new byte[]{137,80,78,71,13,10,26,10}),
        "image/jpeg" => image.Length>3 && image[0]==255&&image[1]==216&&image[2]==255,
        _=> image.Length>12&&Encoding.ASCII.GetString(image,0,4)=="RIFF"&&Encoding.ASCII.GetString(image,8,4)=="WEBP"
    };
    if(!good)throw new ApiError(400,"ملف الصورة غير صحيح");
    var id=Guid.NewGuid().ToString();
    await db.Exec("INSERT INTO listing_images(id,owner_user_id,mime_type,image_bytes) VALUES(@p0,@p1,@p2,@p3)",id,S(u,"id"),mime,image);
    return Results.Json(new {url="/api/images/"+id},statusCode:201);
});
app.MapGet("/api/images/{id:guid}",async(Guid id,Db db)=>{
    await using var cn=await db.Open();await using var cmd=new NpgsqlCommand("SELECT mime_type,image_bytes FROM listing_images WHERE id=@id LIMIT 1",cn);
    cmd.Parameters.AddWithValue("id",id.ToString());await using var rd=await cmd.ExecuteReaderAsync();
    if(!await rd.ReadAsync())return Results.NotFound();
    var mime=rd.GetString(0);if(!new[]{"image/jpeg","image/png","image/webp"}.Contains(mime))return Results.StatusCode(415);
    return Results.File((byte[])rd[1],mime);
});
app.MapGet("/api/my/listings",async(HttpRequest req,Db db,Auth auth)=>{
    var u=await auth.Required(req);var items=await db.List("SELECT row_to_json(t)::text FROM (SELECT * FROM listings WHERE created_by=@p0 OR owner_user_id=@p0 ORDER BY created_at DESC LIMIT 500)t",S(u,"id"));
    return Results.Json(new {items});
});
app.MapGet("/api/favorites",async(HttpRequest req,Db db,Auth auth)=>{
    var u=await auth.Required(req);var rows=await db.List("SELECT row_to_json(t)::text FROM (SELECT listing_id FROM favorites WHERE user_id=@p0)t",S(u,"id"));
    return Results.Json(new {ids=rows.Select(x=>S(x,"listing_id")).ToArray()});
});
app.MapPost("/api/favorites",async(HttpRequest req,Db db,Auth auth)=>{
    var u=await auth.Required(req);var d=await Body(req);var id=S(d,"listing_id");
    if(await db.Find("listings",id) is null)throw new ApiError(404,"العقار غير موجود");
    await db.Exec("INSERT INTO favorites(user_id,listing_id) VALUES(@p0,@p1) ON CONFLICT DO NOTHING",S(u,"id"),id);
    return Results.Json(new {ok=true});
});
app.MapPost("/api/leads",async(HttpRequest req,Db db,Auth auth)=>{
    var d=await Body(req);var l=await db.Find("listings",S(d,"listing_id"));
    if(l is null||S(l,"status")!="published")throw new ApiError(404,"العقار غير متاح");
    if(S(d,"name").Length<2||!Regex.IsMatch(S(d,"phone"),@"^[+\d\s()-]{8,22}$"))throw new ApiError(400,"الاسم ورقم هاتف صحيح مطلوبان");
    var u=await auth.User(req);
    var x=new JsonObject{["id"]=Guid.NewGuid().ToString(),["listing_id"]=S(l,"id"),["name"]=S(d,"name"),["phone"]=S(d,"phone"),["message"]=S(d,"message")[..Math.Min(1000,S(d,"message").Length)],["status"]="new"};
    if(u is not null)x["user_id"]=S(u,"id");
    return Results.Json(new {item=await db.Insert("leads",x)},statusCode:201);
}).RequireRateLimiting("auth");
app.MapPost("/api/appointments",async(HttpRequest req,Db db,Auth auth)=>{
    var d=await Body(req);var l=await db.Find("listings",S(d,"listing_id"));
    if(l is null||S(l,"status")!="published")throw new ApiError(404,"العقار غير متاح");
    if(!DateTimeOffset.TryParse(S(d,"scheduled_at"),out var when)||when<=DateTimeOffset.UtcNow)throw new ApiError(400,"اختر موعدًا مستقبليًا");
    if(S(d,"name").Length<2||!Regex.IsMatch(S(d,"phone"),@"^[+\d\s()-]{8,22}$"))throw new ApiError(400,"الاسم ورقم الهاتف مطلوبان");
    var u=await auth.User(req);
    var x=new JsonObject{["id"]=Guid.NewGuid().ToString(),["listing_id"]=S(l,"id"),["name"]=S(d,"name"),["phone"]=S(d,"phone"),["scheduled_at"]=when.UtcDateTime.ToString("O"),["status"]="pending"};
    if(u is not null)x["user_id"]=S(u,"id");
    return Results.Json(new {item=await db.Insert("appointments",x)},statusCode:201);
}).RequireRateLimiting("auth");
app.MapPost("/api/assistant",async(HttpRequest req,Db db)=>{
    var d=await Body(req);var msg=S(d,"message").ToLowerInvariant();
    var items=await db.List("SELECT row_to_json(t)::text FROM (SELECT * FROM listings WHERE status='published' ORDER BY created_at DESC LIMIT 100)t");
    var m=Regex.Match(msg,@"(\d[\d,]*)\s*(?:مليون|million)");
    decimal? max=m.Success?decimal.Parse(m.Groups[1].Value.Replace(",",""))*1_000_000m:null;
    var matches=items.Where(x=>(max is null||D(x,"price")<=max)&&(!msg.Contains("إيجار")&&!msg.Contains("rent")||S(x,"transaction")=="إيجار")&&(!msg.Contains("فيلا")&&!msg.Contains("villa")||S(x,"kind")=="فيلا")&&(!msg.Contains("شقة")&&!msg.Contains("apartment")||S(x,"kind")=="شقة")).Take(3).ToArray();
    return Results.Json(new {message=matches.Length>0?"لقيت لك اختيارات مبدئية حسب المعايير المكتوبة.":"لم أجد عقارات مطابقة حاليًا؛ جرّب توسيع شروط البحث.",items=matches,notice="ترشيحات تجريبية بقواعد بحث، وليست نموذج ذكاء اصطناعي توليديًا."});
});
app.MapGet("/api/account/applications",async(HttpRequest req,Db db,Auth auth)=>{
    var u=await auth.Required(req);return Results.Json(new {items=await db.List("SELECT row_to_json(t)::text FROM (SELECT id,requested_type,status,created_at FROM account_applications WHERE user_id=@p0 ORDER BY created_at DESC)t",S(u,"id"))});
});
app.MapPost("/api/account/apply",async(HttpRequest req,Db db,Auth auth)=>{
    var u=await auth.Required(req);var d=await Body(req);var type=S(d,"account_type");
    if(!new[]{"owner","agency","developer","broker","property_manager"}.Contains(type))throw new ApiError(400,"نوع الحساب غير صالح");
    var pending=await db.One("SELECT row_to_json(t)::text FROM (SELECT id FROM account_applications WHERE user_id=@p0 AND requested_type=@p1 AND status='pending' LIMIT 1)t",S(u,"id"),type);
    if(pending is not null)throw new ApiError(409,"لديك طلب قيد المراجعة بالفعل");
    var item=await db.Insert("account_applications",new JsonObject{["id"]=Guid.NewGuid().ToString(),["user_id"]=S(u,"id"),["requested_type"]=type,["status"]="pending"});
    return Results.Json(new {item=new {id=S(item,"id"),requested_type=S(item,"requested_type"),status=S(item,"status")}},statusCode:201);
});
app.MapGet("/api/admin/account-applications",async(HttpRequest req,Db db,Auth auth)=>{
    await auth.Role(req,"superadmin");
    var items=await db.List("SELECT row_to_json(t)::text FROM (SELECT a.id,a.user_id,u.name,u.email,a.requested_type,a.status,a.created_at FROM account_applications a JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 100)t");
    return Results.Json(new {items});
});
app.MapGet("/api/admin/users",async(HttpRequest req,Db db,Auth auth)=>{
    var u=await auth.Role(req,"superadmin","agency_admin");
    // An agency administrator can only see members of their own company.
    var users=await db.List("SELECT row_to_json(t)::text FROM (SELECT id,name,email,role,org_id,disabled FROM users WHERE @p0='superadmin' OR (org_id=@p1 AND @p1<>'') ORDER BY created_at DESC)t",S(u,"role"),S(u,"org_id"));
    return Results.Json(new {items=users});
});
app.MapMethods("/api/admin/users/{id}",new[]{"PATCH","DELETE"},async(string id,HttpRequest req,Db db,Auth auth)=>{
    var u=await auth.Role(req,"superadmin","agency_admin");var target=await db.Find("users",id)??throw new ApiError(404,"المستخدم غير موجود");
    if(S(target,"role")=="superadmin"||id==S(u,"id")||(S(u,"role")=="agency_admin"&&(S(target,"role")=="agency_admin"||S(target,"org_id")!=S(u,"org_id"))))throw new ApiError(403,"لا يمكن تعديل هذا المستخدم");
    if(req.Method=="DELETE")return Results.Json(new {user=auth.Safe(await db.Update("users",id,new JsonObject{["disabled"]=true})),message="تم تعطيل الحساب مع الاحتفاظ بسجلاته"});
    var d=await Body(req);var p=Patch(d,"name","email","role","disabled","password");
    if(p.Count==0)throw new ApiError(400,"لا توجد تغييرات");
    if(p.ContainsKey("name")&&S(p,"name").Trim().Length<2)throw new ApiError(400,"الاسم غير صالح");
    if(p.ContainsKey("email")&&!ValidEmail(S(p,"email")))throw new ApiError(400,"البريد غير صالح");
    if(p.ContainsKey("role")&&!new[]{"customer","broker","agency_admin"}.Contains(S(p,"role")))throw new ApiError(400,"الدور غير صالح");
    if(p.ContainsKey("role")&&S(p,"role")=="agency_admin"&&string.IsNullOrEmpty(S(target,"org_id")))throw new ApiError(400,"يجب ربط المدير بشركة أولاً");
    if(p.ContainsKey("password")){if(S(p,"password").Length<10)throw new ApiError(400,"كلمة المرور قصيرة");p["pass_hash"]=auth.HashPassword(S(p,"password"));p.Remove("password");}
    if(p.ContainsKey("disabled")&&p["disabled"] is not JsonValue)throw new ApiError(400,"حالة غير صالحة");
    return Results.Json(new {user=auth.Safe(await db.Update("users",id,p))});
});
app.MapGet("/api/admin/identity",async(HttpRequest req,Auth auth,Db db)=>{
    var u=await auth.Role(req,"superadmin");return Results.Json(new {superadmin=auth.Safe(u),database=db.Available?"postgres":"not-configured"});
});
app.MapGet("/api/admin/permissions",async(HttpRequest req,Auth auth,Db db)=>{
    await auth.Role(req,"superadmin");return Results.Json(new {items=await db.List("SELECT row_to_json(t)::text FROM (SELECT user_id,permission,granted_by,created_at FROM user_permissions ORDER BY created_at DESC)t")});
});
app.MapPost("/api/admin/permissions",async(HttpRequest req,Auth auth,Db db)=>{
    var u=await auth.Role(req,"superadmin");var d=await Body(req);var target=await db.Find("users",S(d,"user_id"));
    var perm=S(d,"permission");if(target is null||!new[]{"dashboard_view","reports_view","reports_export"}.Contains(perm)||d["enabled"] is not JsonValue)throw new ApiError(400,"بيانات الصلاحية غير صالحة");
    if(S(target,"role")=="superadmin")throw new ApiError(400,"صلاحيات السوبر أدمن ثابتة");
    if(B(d,"enabled"))await db.Exec("INSERT INTO user_permissions(user_id,permission,granted_by) VALUES(@p0,@p1,@p2) ON CONFLICT(user_id,permission) DO UPDATE SET granted_by=EXCLUDED.granted_by",S(target,"id"),perm,S(u,"id"));
    else await db.Exec("DELETE FROM user_permissions WHERE user_id=@p0 AND permission=@p1",S(target,"id"),perm);
    return Results.Json(new {ok=true});
});
app.MapGet("/api/admin/listing-review",async(HttpRequest req,Auth auth,Db db)=>{
    var u=await auth.Role(req,"superadmin","agency_admin");var items=await db.List("SELECT row_to_json(t)::text FROM (SELECT * FROM listings WHERE @p0='superadmin' OR (org_id=@p1 AND @p1<>'') ORDER BY created_at DESC LIMIT 500)t",S(u,"role"),S(u,"org_id"));
    return Results.Json(new {items});
});
app.MapPost("/api/admin/listing-review/{id}",async(string id,HttpRequest req,Auth auth,Db db)=>{
    var u=await auth.Role(req,"superadmin","agency_admin");var l=await db.Find("listings",id)??throw new ApiError(404,"الإعلان غير موجود");
    if(S(u,"role")!="superadmin"&&S(l,"org_id")!=S(u,"org_id"))throw new ApiError(403,"غير مصرح");
    if(S(l,"status")!="pending")throw new ApiError(409,"تمت مراجعة الإعلان بالفعل");
    var d=await Body(req);if(!new[]{"approved","rejected"}.Contains(S(d,"action")))throw new ApiError(400,"قرار غير صالح");
    return Results.Json(new {item=await db.Update("listings",id,new JsonObject{["status"]=S(d,"action")=="approved"?"published":"rejected"})});
});
app.MapMethods("/api/admin/listings/{id}",new[]{"PATCH","DELETE"},async(string id,HttpRequest req,Auth auth,Db db)=>{
    var u=await auth.Role(req,"superadmin","agency_admin");var l=await db.Find("listings",id)??throw new ApiError(404,"الإعلان غير موجود");
    if(S(u,"role")!="superadmin"&&S(l,"org_id")!=S(u,"org_id"))throw new ApiError(403,"غير مصرح");
    if(req.Method=="DELETE"){await db.Exec("DELETE FROM listings WHERE id=@p0",id);return Results.Json(new{ok=true});}
    var d=await Body(req);var p=Patch(d,"title","city","area","description","price","rooms","baths","size");
    var merged=(JsonObject)l.DeepClone();foreach(var kv in p)merged[kv.Key]=kv.Value?.DeepClone();CheckListing(merged);
    return Results.Json(new {item=await db.Update("listings",id,p)});
});
app.MapGet("/api/admin/summary",async(HttpRequest req,Auth auth,Db db)=>{
    var u=await auth.Required(req);if(!await auth.Permission(u,"dashboard_view"))throw new ApiError(403,"غير مصرح بلوحة الإدارة");
    var own=S(u,"role")=="superadmin";var org=S(u,"org_id");var id=S(u,"id");
    var listings=await db.List("SELECT row_to_json(t)::text FROM (SELECT id FROM listings WHERE @p0='superadmin' OR (org_id=@p1 AND @p1<>'') OR created_by=@p2)t",S(u,"role"),org,id);
    var ids=listings.Select(x=>S(x,"id")).ToArray();
    var leads=await db.List("SELECT row_to_json(t)::text FROM (SELECT * FROM leads WHERE listing_id=ANY(@p0) ORDER BY created_at DESC LIMIT 15)t",ids);
    var appointments=await db.List("SELECT row_to_json(t)::text FROM (SELECT * FROM appointments WHERE listing_id=ANY(@p0) ORDER BY created_at DESC LIMIT 15)t",ids);
    var userCount=await db.Value("SELECT count(*) FROM users WHERE @p0='superadmin' OR (org_id=@p1 AND @p1<>'')",S(u,"role"),org);
    return Results.Json(new {listings=ids.Length,leads=leads.Count,appointments=appointments.Count,users=Convert.ToInt32(userCount),recentLeads=leads,recentAppointments=appointments});
});
app.MapGet("/api/admin/reports",async(HttpRequest req,Auth auth,Db db)=>{
    var u=await auth.Required(req);if(!await auth.Permission(u,"reports_view"))throw new ApiError(403,"غير مصرح بالتقارير");
    var all=await db.List("SELECT row_to_json(t)::text FROM (SELECT id,status,transaction FROM listings WHERE @p0='superadmin' OR (org_id=@p1 AND @p1<>'') OR created_by=@p2)t",S(u,"role"),S(u,"org_id"),S(u,"id"));
    var ids=all.Select(x=>S(x,"id")).ToArray();
    var leadCount=await db.Value("SELECT count(*) FROM leads WHERE listing_id=ANY(@p0)",ids);
    var visitCount=await db.Value("SELECT count(*) FROM appointments WHERE listing_id=ANY(@p0)",ids);
    return Results.Json(new {scope=S(u,"role")=="superadmin"?"platform":"own_organization",totals=new{listings=ids.Length,published=all.Count(x=>S(x,"status")=="published"),leads=Convert.ToInt32(leadCount),appointments=Convert.ToInt32(visitCount)},byTransaction=new{sale=all.Count(x=>S(x,"transaction")=="بيع"),rent=all.Count(x=>S(x,"transaction")=="إيجار")}});
});
app.MapGet("/api/admin/location-prices",async(HttpRequest req,Auth auth,Db db)=>{
    await auth.Role(req,"superadmin","agency_admin");
    var items=await db.List(@"SELECT row_to_json(t)::text FROM (
        SELECT city,area,transaction,count(*)::int AS count,
               round(avg(price)) AS average,min(price) AS min,max(price) AS max
        FROM listings WHERE status='published' GROUP BY city,area,transaction ORDER BY city,area
    )t");
    return Results.Json(new {items});
});
app.MapPost("/api/admin/staff",async(HttpRequest req,Auth auth,Db db)=>{
    var admin=await auth.Role(req,"superadmin","agency_admin");var d=await Body(req);var email=S(d,"email").ToLowerInvariant().Trim();
    if(!new[]{"agency_admin","broker"}.Contains(S(d,"role"))||!ValidEmail(email)||S(d,"password").Length<10||S(d,"name").Length<2)throw new ApiError(400,"البيانات غير صالحة");
    if(S(admin,"role")=="agency_admin"&&S(d,"role")=="agency_admin")throw new ApiError(403,"إضافة المديرين للسوبر أدمن فقط");
    if(await db.One("SELECT row_to_json(t)::text FROM (SELECT id FROM users WHERE email=@p0)t",email) is not null)throw new ApiError(409,"البريد مستخدم");
    var org=S(d,"org_id");
    if(S(admin,"role")=="agency_admin")org=S(admin,"org_id");
    if(string.IsNullOrEmpty(org)){org=Guid.NewGuid().ToString();await db.Insert("organizations",new JsonObject{["id"]=org,["name"]=S(d,"organization","New Agency")});}
    else if(await db.Find("organizations",org) is null)throw new ApiError(400,"الشركة غير موجودة");
    var u=await db.Insert("users",new JsonObject{["id"]=Guid.NewGuid().ToString(),["name"]=S(d,"name"),["email"]=email,["pass_hash"]=auth.HashPassword(S(d,"password")),["role"]=S(d,"role"),["org_id"]=org});
    return Results.Json(new {user=auth.Safe(u)},statusCode:201);
});
app.MapPost("/api/featured/request",async(HttpRequest req,Auth auth,Db db)=>{
    var u=await auth.Required(req);var d=await Body(req);var l=await db.Find("listings",S(d,"listing_id"));
    if(l is null||S(l,"owner_user_id")!=S(u,"id"))throw new ApiError(403,"لا يمكنك تمييز هذا الإعلان");
    if(S(l,"status")!="published")throw new ApiError(409,"يجب نشر الإعلان أولاً");
    var days=(int)D(d,"duration_days");if(!new[]{7,14,30}.Contains(days))throw new ApiError(400,"المدة غير صالحة");
    var exists=await db.One("SELECT row_to_json(t)::text FROM (SELECT id FROM featured_requests WHERE listing_id=@p0 AND (status IN ('pending_payment','pending_review') OR (status='approved' AND ends_at>now())) LIMIT 1)t",S(l,"id"));
    if(exists is not null)throw new ApiError(409,"يوجد طلب تمييز قائم لهذا العقار");
    var item=await db.Insert("featured_requests",new JsonObject{["id"]=Guid.NewGuid().ToString(),["listing_id"]=S(l,"id"),["requested_by"]=S(u,"id"),["duration_days"]=days});
    return Results.Json(new {item, message="تم تسجيل الطلب؛ لا يبدأ التمييز قبل تأكيد الدفع وموافقة الإدارة"},statusCode:201);
});
app.MapGet("/api/admin/featured",async(HttpRequest req,Auth auth,Db db)=>{
    var u=await auth.Role(req,"superadmin","agency_admin");
    var items=await db.List(@"SELECT row_to_json(t)::text FROM (
     SELECT f.*,l.title,l.city,l.area,u.name AS advertiser_name FROM featured_requests f
     JOIN listings l ON l.id=f.listing_id JOIN users u ON u.id=f.requested_by
     WHERE @p0='superadmin' OR (l.org_id=@p1 AND @p1<>'')
     ORDER BY f.created_at DESC LIMIT 200)t",S(u,"role"),S(u,"org_id"));
    return Results.Json(new{items});
});
app.MapPost("/api/admin/featured/{id}",async(string id,HttpRequest req,Auth auth,Db db)=>{
    var u=await auth.Role(req,"superadmin","agency_admin");var d=await Body(req);
    var f=await db.Find("featured_requests",id)??throw new ApiError(404,"الطلب غير موجود");
    var l=await db.Find("listings",S(f,"listing_id"));
    if(S(u,"role")!="superadmin"&&S(l,"org_id")!=S(u,"org_id"))throw new ApiError(403,"غير مصرح");
    var action=S(d,"action");var status=S(f,"status");
    if(action=="confirm_payment"){
        if(status!="pending_payment")throw new ApiError(409,"الحالة لا تسمح بتأكيد الدفع");
        if(string.IsNullOrWhiteSpace(S(d,"reference")))throw new ApiError(400,"أدخل مرجع الدفع");
        await db.Exec("UPDATE featured_requests SET status='pending_review',payment_reference=@p1 WHERE id=@p0",id,S(d,"reference")[..Math.Min(120,S(d,"reference").Length)]);
    }else if(action=="approve"){
        if(status!="pending_review"||S(l,"status")!="published")throw new ApiError(409,"يجب تأكيد الدفع ونشر الإعلان أولاً");
        await db.Exec("UPDATE featured_requests SET status='approved',approved_by=@p1,starts_at=now(),ends_at=now()+duration_days*interval '1 day' WHERE id=@p0",id,S(u,"id"));
    }else if(action=="reject"){
        if(!new[]{"pending_payment","pending_review"}.Contains(status))throw new ApiError(409,"لا يمكن رفض طلب مفعل");
        await db.Exec("UPDATE featured_requests SET status='rejected',approved_by=@p1 WHERE id=@p0",id,S(u,"id"));
    }else throw new ApiError(400,"قرار غير صالح");
    return Results.Json(new{ok=true});
});
var mods=new Dictionary<string,(string Table,string[] Required,string[] Fields)> {
 ["projects"]=("projects",new[]{"name"},new[]{"name","city","status"}),
 ["units"]=("project_units",new[]{"project_id","unit_code"},new[]{"project_id","unit_code","price","status"}),
 ["contacts"]=("crm_contacts",new[]{"name"},new[]{"name","phone","email"}),
 ["deals"]=("crm_deals",Array.Empty<string>(),new[]{"contact_id","listing_id","assigned_to","stage","amount"}),
 ["referrals"]=("broker_referrals",new[]{"deal_id","broker_id"},new[]{"deal_id","broker_id","commission_rate","commission_amount","status"}),
 ["contracts"]=("rental_contracts",new[]{"listing_id","tenant_name","start_date","end_date"},new[]{"listing_id","tenant_name","start_date","end_date","rent_amount","status"}),
 ["maintenance"]=("maintenance_tickets",new[]{"title"},new[]{"listing_id","title","status"}),
 ["payments"]=("rent_payments",new[]{"contract_id","amount","due_date"},new[]{"contract_id","amount","due_date","paid_at","status"})
};
app.MapMethods("/api/modules/{module}",new[]{"GET","POST"},async(string module,HttpRequest req,Auth auth,Db db)=>{
    if(!mods.TryGetValue(module,out var def))throw new ApiError(404,"القسم غير موجود");
    var u=await auth.Required(req);var org=S(u,"org_id");
    if(string.IsNullOrEmpty(org))throw new ApiError(403,"لا توجد شركة مفعلة");
    var active=await db.One("SELECT row_to_json(t)::text FROM (SELECT id FROM organization_memberships WHERE user_id=@p0 AND org_id=@p1 AND status='active' LIMIT 1)t",S(u,"id"),org);
    if(!new[]{"superadmin","agency_admin"}.Contains(S(u,"role"))&&active is null)throw new ApiError(403,"غير مصرح");
    if(req.Method=="GET"){
        // Table name from fixed server-side map, never from request text.
        var items=await db.List($"SELECT row_to_json(t)::text FROM (SELECT * FROM {def.Table} WHERE org_id=@p0 ORDER BY created_at DESC LIMIT 200)t",org);
        return Results.Json(new {items});
    }
    var d=await Body(req);foreach(var key in def.Required)if(string.IsNullOrWhiteSpace(S(d,key)))throw new ApiError(400,"مطلوب: "+key);
    var item=new JsonObject{["id"]=Guid.NewGuid().ToString(),["org_id"]=org};
    foreach(var key in def.Fields)if(d.ContainsKey(key)){
        if(d[key] is JsonObject or JsonArray)throw new ApiError(400,"قيمة غير صالحة");
        item[key]=d[key]?.DeepClone();
    }
    return Results.Json(new {item=await db.Insert(def.Table,item)},statusCode:201);
});
app.MapFallback((HttpContext ctx)=> Results.Redirect("/"));
app.Run();

public static class Helpers {
public static async Task<JsonObject> Body(HttpRequest req,int limit=35000){
    if(req.ContentLength>limit)throw new ApiError(413,"الطلب كبير");
    using var input=new StreamReader(req.Body,Encoding.UTF8);
    var raw=await input.ReadToEndAsync();
    if(Encoding.UTF8.GetByteCount(raw)>limit)throw new ApiError(413,"الطلب كبير");
    try {return JsonNode.Parse(string.IsNullOrWhiteSpace(raw)?"{}":raw) as JsonObject ?? throw new ApiError(400,"JSON غير صالح");}
    catch(JsonException){throw new ApiError(400,"JSON غير صالح");}
}
public static string S(JsonNode? d,string key,string fallback=""){
    if(d is not JsonObject o||!o.TryGetPropertyValue(key,out var n)||n is null)return fallback;
    if(n is JsonValue v){try{return v.ToString();}catch{return fallback;}}return fallback;
}
public static decimal D(JsonNode? d,string key){return decimal.TryParse(S(d,key),System.Globalization.NumberStyles.Any,System.Globalization.CultureInfo.InvariantCulture,out var value)?value:0;}
public static bool B(JsonNode? d,string key){return bool.TryParse(S(d,key),out var v)&&v;}
public static bool ValidEmail(string v)=>Regex.IsMatch(v,@"^\S+@\S+\.\S+$")&&v.Length<320;
public static string SafeImage(string value)=>value.StartsWith("https://images.unsplash.com/",StringComparison.Ordinal)?value[..Math.Min(400,value.Length)]:"";
public static void CheckListing(JsonNode d){
    foreach(var key in new[]{"title","city","area","kind","transaction"})
        if(string.IsNullOrWhiteSpace(S(d,key))||S(d,key).Length>150)throw new ApiError(400,"أدخل بيانات العقار كاملة");
    if(!new[]{"شقة","فيلا","دوبلكس","ستوديو","تجاري","أرض"}.Contains(S(d,"kind"))||!new[]{"بيع","إيجار"}.Contains(S(d,"transaction")))throw new ApiError(400,"نوع العقار أو المعاملة غير مدعوم");
    foreach(var key in new[]{"price","rooms","baths","size"})if(!decimal.TryParse(S(d,key),System.Globalization.NumberStyles.Any,System.Globalization.CultureInfo.InvariantCulture,out var n)||n<0||n>=1e13m)throw new ApiError(400,"الأرقام غير صالحة");
    if(D(d,"price")==0||D(d,"size")==0)throw new ApiError(400,"السعر والمساحة يجب أن يكونا أكبر من صفر");
}
public static JsonObject Patch(JsonObject d,params string[] fields){
    var result=new JsonObject();
    foreach(var key in fields)if(d.ContainsKey(key))result[key]=d[key]?.DeepClone();
    return result;
}
}
public sealed class ApiError(int status,string message):Exception(message){public int Status{get;}=status;}
public sealed class Db {
    readonly string? _conn;
    public bool Available=>!string.IsNullOrEmpty(_conn);
    public Db(){
        var raw=Environment.GetEnvironmentVariable("DATABASE_URL");
        if(string.IsNullOrWhiteSpace(raw))return;
        if(!Uri.TryCreate(raw,UriKind.Absolute,out var uri)||!new[]{"postgres","postgresql"}.Contains(uri.Scheme)){_conn=raw;return;}
        var user=uri.UserInfo.Split(':',2);
        _conn=new NpgsqlConnectionStringBuilder{Host=uri.Host,Port=uri.Port>0?uri.Port:5432,
          Database=Uri.UnescapeDataString(uri.AbsolutePath.TrimStart('/')),Username=Uri.UnescapeDataString(user[0]),
          Password=user.Length>1?Uri.UnescapeDataString(user[1]):"",SslMode=Environment.GetEnvironmentVariable("PGSSLMODE")=="disable"?SslMode.Disable:SslMode.Require}.ConnectionString;
    }
    public async Task<NpgsqlConnection> Open(){
        if(!Available)throw new ApiError(503,"قاعدة البيانات غير متصلة");
        var cn=new NpgsqlConnection(_conn);await cn.OpenAsync();return cn;
    }
    public async Task<List<JsonObject>> List(string sql,params object?[] args){
        await using var cn=await Open();await using var cmd=Cmd(cn,sql,args);
        var items=new List<JsonObject>();await using var reader=await cmd.ExecuteReaderAsync();
        while(await reader.ReadAsync())items.Add(JsonNode.Parse(reader.GetString(0))!.AsObject());
        return items;
    }
    public async Task<JsonObject?> One(string sql,params object?[] args){
        var list=await List(sql,args);return list.FirstOrDefault();
    }
    public async Task<object?> Value(string sql,params object?[] args){
        await using var cn=await Open();await using var cmd=Cmd(cn,sql,args);
        return await cmd.ExecuteScalarAsync();
    }
    public async Task<int> Exec(string sql,params object?[] args){
        await using var cn=await Open();await using var cmd=Cmd(cn,sql,args);
        return await cmd.ExecuteNonQueryAsync();
    }
    public Task<JsonObject?> Find(string table,string id){
        if(!SafeTables.Contains(table))throw new ApiError(400,"Invalid table");
        return One($"SELECT row_to_json(t)::text FROM (SELECT * FROM {table} WHERE id=@p0 LIMIT 1)t",id);
    }
    public async Task<JsonObject> Insert(string table,JsonObject o,string key="id"){
        if(!SafeTables.Contains(table))throw new ApiError(400,"Invalid table");
        var cols=o.Select(k=>k.Key).ToArray();
        if(cols.Any(c=>!Regex.IsMatch(c,@"^[a-z_]+$")))throw new ApiError(400,"Invalid column");
        var vals=o.Select(k=>Unpack(k.Value)).ToArray();
        var sql=$"INSERT INTO {table} AS t ({string.Join(",",cols)}) VALUES ({string.Join(",",cols.Select((_,i)=>"@p"+i))}) RETURNING row_to_json(t)::text";
        var result=await Value(sql,vals);return JsonNode.Parse(Convert.ToString(result)!)!.AsObject();
    }
    public async Task<JsonObject> Update(string table,string id,JsonObject o){
        if(!SafeTables.Contains(table)||o.Count==0)throw new ApiError(400,"Invalid update");
        var cols=o.Select(k=>k.Key).ToArray();
        if(cols.Any(c=>!Regex.IsMatch(c,@"^[a-z_]+$")))throw new ApiError(400,"Invalid column");
        var vals=o.Select(k=>Unpack(k.Value)).ToList();vals.Add(id);
        var sql=$"UPDATE {table} AS t SET {string.Join(",",cols.Select((c,i)=>c+"=@p"+i))} WHERE id=@p{cols.Length} RETURNING row_to_json(t)::text";
        var result=await Value(sql,vals.ToArray());return JsonNode.Parse(Convert.ToString(result)!)!.AsObject();
    }
    static readonly HashSet<string> SafeTables=new(new[]{"users","organizations","account_profiles","account_applications","listings","leads","appointments","favorites","featured_requests","projects","project_units","crm_contacts","crm_deals","broker_referrals","rental_contracts","maintenance_tickets","rent_payments"});
    static object Unpack(JsonNode? n) {
        if(n is null)return DBNull.Value;
        using var d=JsonDocument.Parse(n.ToJsonString());var e=d.RootElement;
        return e.ValueKind switch {
            JsonValueKind.String=>e.GetString()!,
            JsonValueKind.Number=>e.TryGetInt32(out var i)?i:e.GetDecimal(),
            JsonValueKind.True=>true,JsonValueKind.False=>false,
            _=>DBNull.Value
        };
    }
    static NpgsqlCommand Cmd(NpgsqlConnection cn,string sql,params object?[] args){
        var cmd=new NpgsqlCommand(sql,cn);
        for(var i=0;i<args.Length;i++)cmd.Parameters.AddWithValue("p"+i,args[i]??DBNull.Value);
        return cmd;
    }
}
public sealed class Auth(Db db){
    readonly string secret=Environment.GetEnvironmentVariable("JWT_SECRET")??"";
    public async Task<JsonObject?> User(HttpRequest req){
        var auth=req.Headers.Authorization.ToString();
        if(!auth.StartsWith("Bearer ",StringComparison.OrdinalIgnoreCase)||secret.Length<40)return null;
        var parts=auth[7..].Split('.');if(parts.Length!=3)return null;
        try{
            var data=Encoding.ASCII.GetBytes(parts[0]+"."+parts[1]);
            using var h=new HMACSHA256(Encoding.UTF8.GetBytes(secret));var sig=h.ComputeHash(data);
            if(!CryptographicOperations.FixedTimeEquals(sig,Base64UrlDecode(parts[2])))return null;
            var header=JsonNode.Parse(Base64UrlDecode(parts[0]))!;
            if(header["alg"]?.ToString()!="HS256")return null;
            var payload=JsonNode.Parse(Base64UrlDecode(parts[1]))!;
            if(!long.TryParse(payload["exp"]?.ToString(),out var exp)||exp<=DateTimeOffset.UtcNow.ToUnixTimeSeconds())return null;
            var user=await db.Find("users",payload["sub"]?.ToString()??"");
            return user is not null&&!B(user,"disabled")?user:null;
        }catch{return null;}
    }
    public async Task<JsonObject> Required(HttpRequest req)=>await User(req)??throw new ApiError(401,"سجل الدخول أولاً");
    public async Task<JsonObject> Role(HttpRequest req,params string[] roles){
        var u=await Required(req);if(!roles.Contains(S(u,"role")))throw new ApiError(403,"غير مصرح بهذه العملية");return u;
    }
    public JsonObject Safe(JsonObject u)=>new(){["id"]=S(u,"id"),["name"]=S(u,"name"),["email"]=S(u,"email"),["role"]=S(u,"role"),["org_id"]=string.IsNullOrEmpty(S(u,"org_id"))?null:S(u,"org_id"),["disabled"]=B(u,"disabled")};
    public async Task<string> Type(JsonObject u){
        if(S(u,"role")=="superadmin")return "superadmin";
        if(S(u,"role")=="agency_admin")return "agency";
        var p=await db.One("SELECT row_to_json(t)::text FROM (SELECT account_type FROM account_profiles WHERE user_id=@p0)t",S(u,"id"));
        return S(p,"account_type",S(u,"role")=="broker"?"broker":"customer");
    }
    public async Task<bool> Permission(JsonObject u,string perm){
        if(new[]{"superadmin","agency_admin"}.Contains(S(u,"role")))return true;
        return await db.One("SELECT row_to_json(t)::text FROM (SELECT user_id FROM user_permissions WHERE user_id=@p0 AND permission=@p1 LIMIT 1)t",S(u,"id"),perm) is not null;
    }
    public bool Manage(JsonObject? u,JsonObject l){
        if(u is null)return false;
        var role=S(u,"role");
        if(role=="superadmin")return true;
        var org=S(u,"org_id");
        return (role=="agency_admin"||role=="broker")&&!string.IsNullOrEmpty(org)&&org==S(l,"org_id");
    }
    public bool VerifyPassword(string password,string stored){
        try{
            var p=stored.Split(':');if(p.Length!=3||p[0]!="scrypt")return false;
            // Node scryptSync(password, saltHexString, 64), defaults N=16384,r=8,p=1.
            var expected=Convert.FromHexString(p[2]);var derived=SCrypt.Generate(Encoding.UTF8.GetBytes(password),Encoding.UTF8.GetBytes(p[1]),16384,8,1,64);
            return CryptographicOperations.FixedTimeEquals(derived,expected);
        }catch{return false;}
    }
    public string HashPassword(string password){
        var salt=Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        var key=SCrypt.Generate(Encoding.UTF8.GetBytes(password),Encoding.UTF8.GetBytes(salt),16384,8,1,64);
        return "scrypt:"+salt+":"+Convert.ToHexString(key).ToLowerInvariant();
    }
    public string Token(string sub){
        if(secret.Length<40)throw new ApiError(503,"JWT_SECRET is not configured");
        var h=Base64Url(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new{alg="HS256",typ="JWT"})));
        var p=Base64Url(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new{sub,exp=DateTimeOffset.UtcNow.AddDays(1).ToUnixTimeSeconds()})));
        using var sig=new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        return h+"."+p+"."+Base64Url(sig.ComputeHash(Encoding.ASCII.GetBytes(h+"."+p)));
    }
    static string Base64Url(byte[] raw)=>Convert.ToBase64String(raw).TrimEnd('=').Replace('+','-').Replace('/','_');
    static byte[] Base64UrlDecode(string s)=>Convert.FromBase64String(s.Replace('-','+').Replace('_','/')+new string('=',(4-s.Length%4)%4));
}
