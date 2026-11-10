/** Public Chromium CDP over a loopback endpoint belonging to the exact browser PID supplied by
 * the native adapter. Cookies arrive only through SSH stdin. The command and its sole receipt
 * carry no secrets. Failure stages use exit codes without printing private values.
 * Storage.setCookies and Storage.getCookies are the public browser-endpoint CDP methods. */
const signInGuest = String.raw`
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),childProcess=require('node:child_process');
const session='Vivid-signin-'+require('node:crypto').randomUUID(),nativeCalls=new Set();
let failureStage=10,nativeUsed=false,finishing=false,consentAttempt;
// Post-work native cleanup allocation. Source: unmeasured. Expiry rejects cleanup only.
const CLEANUP_CALL_MILLIS=2500;
const deadline=setTimeout(()=>finish(2),20000);
// Native preparation can enable Chrome's consent server without a launch flag. Its
// DevToolsActivePort file supplies the exact route; /json/version deliberately returns 404.
// As in cua-driver platform-linux/browser_platform.rs, attest its loopback socket to this PID.
async function ownsPort(pid,port){
 const owned=new Set();
 for(const fd of await fs.readdir('/proc/'+pid+'/fd')){
  let link;try{link=await fs.readlink('/proc/'+pid+'/fd/'+fd);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  const match=/^socket:\[(\d+)\]$/.exec(link);if(match)owned.add(match[1]);
 }
 const rows=(await fs.readFile('/proc/'+pid+'/net/tcp','utf8')).trim().split('\n').slice(1);
 return rows.some(line=>{const row=line.trim().split(/\s+/);return row.length>=10&&row[3]==='0A'&&row[1]==='0100007F:'+port.toString(16).toUpperCase().padStart(4,'0')&&owned.has(row[9]);});
}
async function endpoint(pid){
 if(!Number.isSafeInteger(pid)||pid<1)throw Error();
 const args=(await fs.readFile('/proc/'+pid+'/cmdline','utf8')).split('\0');
 const exe=path.basename(await fs.readlink('/proc/'+pid+'/exe'));
 if(!/^(chrome|chromium|google-chrome|google-chrome-stable)$/.test(exe)||args.some(x=>/(^| )--type=/.test(x)))throw Error();
 // Chromium may rewrite argv as a single process title. Only unambiguous flags are accepted.
 const flag=name=>{const exact=args.find(x=>x.startsWith(name+'='));if(exact&& !exact.includes(' '))return exact.slice(name.length+1);const match=args.join(' ').match(new RegExp('(?:^| )'+name+'=([^ ]+)(?= --|$)'));return match?match[1]:undefined;};
 const user=flag('--user-data-dir');
 if(user){
  let active;try{active=await fs.readFile(path.join(user,'DevToolsActivePort'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(active!==undefined){
   const lines=active.trim().split('\n'),port=Number(lines[0]);
   if(lines.length!==2||!Number.isInteger(port)||port<1||port>65535||!/^\/devtools\/browser(?:\/[A-Za-z0-9-]+)?$/.test(lines[1])||!await ownsPort(pid,port))throw Error();
   return {address:'ws://127.0.0.1:'+port+lines[1],consent:flag('--remote-debugging-port')===undefined};
  }
 }
 // Older Chrome can expose a fixed launch port without an active-port file.
 const port=Number(flag('--remote-debugging-port'));
 if(!Number.isInteger(port)||port<1||port>65535||!await ownsPort(pid,port))throw Error();
 const version=await(await fetch('http://127.0.0.1:'+port+'/json/version')).json();
 const url=new URL(version.webSocketDebuggerUrl);
 if(url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||url.port!==String(port))throw Error();
 return {address:url.href,consent:false};
}
// The existing driver's public CLI scopes native snapshot tokens to this operation.
// Cookies never enter these calls; its binary/socket are the product bootstrap's fixed paths.
async function native(tool,args,timeout){
 nativeUsed=true;
 const binary=path.join(os.homedir(),'.local/share/vivid/computer/driver');
 const socket='/run/user/'+process.getuid()+'/vivid-driver.sock';
 return new Promise((resolve,reject)=>{
  const child=childProcess.execFile(binary,['call',tool,'--socket',socket],{timeout,maxBuffer:4194304},(failure,stdout)=>{
   nativeCalls.delete(child);
   if(failure)return reject(Error());
   try{const result=JSON.parse(stdout);if(result.isError===true||result.status==='refused'||result.effect==='refused'||typeof result.code==='string')return reject(Error());resolve(result);}catch{reject(Error());}
  });
  nativeCalls.add(child);
  child.stdin.end(JSON.stringify({...args,session}));
 });
}
function prompt(nodes){
 const matches=nodes.filter(node=>node.in_web_content!==true&&node.role==='alert'&&node.label==='Allow remote debugging?');
 if(matches.length>1)throw Error();return matches[0];
}
// Web content cannot authorize debugging. Require Chrome's exact native alert, its security
// explanation and one enabled child button, as cua-driver's browser_consent_ui.rs does.
function consentControl(state,label){
 const alert=prompt(state.elements);if(!alert)throw Error();
 const indexed=new Map(state.elements.map(node=>[node.element_index,node]));
 const inside=node=>{
  const seen=new Set();let current=node;
  while(current){
   if(current.in_web_content===true||['document','document web','document frame'].includes(current.role)||seen.has(current.element_index))return false;
   if(current.element_index===alert.element_index)return true;
   seen.add(current.element_index);current=indexed.get(current.parent_index);
  }
  return false;
 };
 const children=state.elements.filter(inside),text=children.map(node=>typeof node.label==='string'?node.label.toLowerCase():'').join(' ');
 if(!text.includes('external app wants full control')||!text.includes('saved data, cookies and site data')||!text.includes('navigate to any url'))throw Error();
 const buttons=children.filter(node=>['push button','button'].includes(node.role)&&node.label===label&&node.enabled===true);
 // The installed driver's describe-click contract binds an accessibility index to its
 // exact snapshot. This invokes Chrome's native action; synthetic foreground pixels leave
 // this security dialog open even when the public click receipt says unverifiable.
 if(buttons.length!==1||!Number.isSafeInteger(buttons[0].element_index)||buttons[0].element_index<0||typeof state.snapshot_id!=='string'||!/^s[0-9a-f]{8}$/.test(state.snapshot_id))throw Error();
 return {element_index:buttons[0].element_index,snapshot_id:state.snapshot_id};
}
async function consentAction(window,label,timeout){
 const state=await native('get_window_state',{...window,include_screenshot:false},timeout);
 if(state.pid!==window.pid||state.window_id!==window.window_id)throw Error();
 await native('click',{...window,...consentControl(state,label),delivery_mode:'background'},timeout);
}
async function connect(target,window){
 if(target.consent){
  if(!window||!Number.isSafeInteger(window.window_id)||window.window_id<1)throw Error();
  const before=await native('get_window_state',{...window,include_screenshot:false},10000);
  if(before.pid!==window.pid||before.window_id!==window.window_id||prompt(before.elements))throw Error();
 }
 const socket=new WebSocket(target.address),pending=new Map();let next=0;
 if(target.consent)consentAttempt={window,socket};
 const opened=new Promise((resolve,reject)=>{socket.addEventListener('open',()=>{consentAttempt=undefined;resolve();},{once:true});socket.addEventListener('error',reject,{once:true});});
 try{
  if(target.consent){
   const approval=(async()=>{
    const receipt=await native('verify_state',{...window,expect:[{element:{selector:{role:'heading',label_contains:'Allow remote debugging?'},exists:true}}],stable_samples:1,timeout_ms:4000},10000);
    if(receipt.status!=='satisfied'||socket.readyState!==WebSocket.CONNECTING)throw Error();
    await consentAction(window,'Allow',10000);
   })();
   await Promise.all([opened,approval]);
  }else await opened;
 }catch(error){socket.close();throw error;}
 const ended=()=>{for(const item of pending.values())item.reject(Error());pending.clear();};
 socket.addEventListener('close',ended);socket.addEventListener('error',ended);
 socket.addEventListener('message',event=>{
  let message;try{message=JSON.parse(event.data);}catch{return ended();}
  const item=pending.get(message.id);if(!item)return;
  pending.delete(message.id);message.error?item.reject(Error()):item.resolve(message.result);
 });
 return {socket,call:(method,params)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));})};
}
async function main(){
 let text='';for await(const chunk of process.stdin){text+=chunk;if(text.length>1048576)throw Error();if(text.includes('\n'))break;}
 const input=JSON.parse(text);failureStage=20;const address=await endpoint(input.pid);failureStage=30;const cdp=await connect(address,{pid:input.pid,window_id:input.window_id});
 try{
  if(!Array.isArray(input.cookies)||input.cookies.length<1||input.cookies.length>1000)throw Error();
  // Chrome M104 caps newly written cookies at 400 days. Bound the requested value first so
  // exact readback checks the effective expiry without extending the source cookie's life.
  // https://developer.chrome.com/blog/cookie-max-age-expires
  const maximum=Date.now()/1000+400*86400;
  const cookies=input.cookies.map(cookie=>cookie.expires===undefined?cookie:{...cookie,expires:Math.min(cookie.expires,maximum)});
  failureStage=40;await cdp.call('Storage.setCookies',{cookies});
  failureStage=50;const receipt=await cdp.call('Storage.getCookies',{});
  for(const wanted of cookies){
   const domain=wanted.domain||new URL(wanted.url).hostname;
   const actual=receipt.cookies.find(cookie=>cookie.name===wanted.name&&cookie.path===wanted.path&&cookie.domain===domain);
   if(!actual||actual.value!==wanted.value||actual.secure!==wanted.secure||actual.httpOnly!==wanted.httpOnly)throw Error();
   if(wanted.sameSite&&actual.sameSite!==wanted.sameSite)throw Error();
   if(wanted.expires===undefined?!actual.session:actual.session||Math.abs(actual.expires-wanted.expires)>1)throw Error();
  }
  process.stdout.write(JSON.stringify({cookies:input.cookies.length}));
 }finally{cdp.socket.close();}
}
// Chrome can retain a failed connection's prompt after its socket closes. Cancel only this
// attempt's unique trusted alert. Three 2.5-second calls after the 20-second work deadline
// leave time below SSH's 30-second limit, including a loaded accessibility tree walk.
// Cleanup cannot replace a successful copy's receipt or the original failure stage.
async function finish(code){
 if(finishing)return;finishing=true;clearTimeout(deadline);
 for(const child of nativeCalls)child.kill('SIGTERM');
 const attempt=consentAttempt;consentAttempt=undefined;
 if(attempt){
  attempt.socket.close();
  try{await consentAction(attempt.window,'Cancel',CLEANUP_CALL_MILLIS);}catch{}
 }
 if(nativeUsed){try{await native('end_session',{},CLEANUP_CALL_MILLIS);}catch{}}
 process.exit(code);
}
main().then(()=>finish(0),()=>finish(failureStage));
`

/** Shell quoting is only for this fixed program; no cookie or model-supplied word enters argv. */
export const signInCommand = `node -e '${signInGuest.replaceAll("'", "'\\''")}'`
