const {app,BrowserWindow,shell}=require('electron');
const url=process.env.SAKANGO_URL || 'https://sakango-web.onrender.com';
app.whenReady().then(()=>{const win=new BrowserWindow({width:1360,height:900,minWidth:900,minHeight:600,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});win.loadURL(url);win.webContents.setWindowOpenHandler(({url:target})=>{if(target.startsWith('https://'))shell.openExternal(target);return {action:'deny'};});});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
