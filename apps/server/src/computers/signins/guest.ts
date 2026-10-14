/** Public Chromium CDP over a loopback endpoint belonging to the exact browser PID supplied by
 * the native adapter. Cookies arrive only through SSH stdin. The command and its sole receipt
 * carry no secrets. Failure stages use exit codes without printing private values.
 * Storage.setCookies and Storage.getCookies are the public browser-endpoint CDP methods. */
export const signInGuest = String.raw`
const fs=require('node:fs/promises'),path=require('node:path');
let failureStage=10;
const deadline=setTimeout(()=>process.exit(2),25000);
async function endpoint(pid){
 if(!Number.isSafeInteger(pid)||pid<1)throw Error();
 const args=(await fs.readFile('/proc/'+pid+'/cmdline','utf8')).split('\0');
 const exe=path.basename(await fs.readlink('/proc/'+pid+'/exe'));
 if(!/^(chrome|chromium|google-chrome|google-chrome-stable)$/.test(exe)||args.some(x=>/(^| )--type=/.test(x)))throw Error();
 // Chromium may rewrite argv as a single process title. Only unambiguous flags are accepted.
 const flag=name=>{const exact=args.find(x=>x.startsWith(name+'='));if(exact&& !exact.includes(' '))return exact.slice(name.length+1);const match=args.join(' ').match(new RegExp('(?:^| )'+name+'=([^ ]+)(?= --|$)'));return match?match[1]:undefined;};
 const portArg=flag('--remote-debugging-port');
 if(!portArg)throw Error();
 let port=Number(portArg);
 if(port===0){
  const user=flag('--user-data-dir');
  if(!user)throw Error();
  port=Number((await fs.readFile(path.join(user,'DevToolsActivePort'),'utf8')).split('\n')[0]);
 }
 if(!Number.isInteger(port)||port<1||port>65535)throw Error();
 const version=await(await fetch('http://127.0.0.1:'+port+'/json/version')).json();
 const url=new URL(version.webSocketDebuggerUrl);
 if(url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||url.port!==String(port))throw Error();
 return url.href;
}
async function connect(address){
 const socket=new WebSocket(address),pending=new Map();let next=0;
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
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
 const input=JSON.parse(text);failureStage=20;const address=await endpoint(input.pid);failureStage=30;const cdp=await connect(address);
 try{
  if(!Array.isArray(input.cookies)||input.cookies.length<1||input.cookies.length>1000)throw Error();
  failureStage=40;await cdp.call('Storage.setCookies',{cookies:input.cookies});
  failureStage=50;const receipt=await cdp.call('Storage.getCookies',{});
  for(const wanted of input.cookies){
   const domain=wanted.domain||new URL(wanted.url).hostname;
   const actual=receipt.cookies.find(cookie=>cookie.name===wanted.name&&cookie.path===wanted.path&&cookie.domain===domain);
   if(!actual||actual.value!==wanted.value||actual.secure!==wanted.secure||actual.httpOnly!==wanted.httpOnly)throw Error();
   if(wanted.sameSite&&actual.sameSite!==wanted.sameSite)throw Error();
   if(wanted.expires===undefined?!actual.session:actual.session||Math.abs(actual.expires-wanted.expires)>1)throw Error();
  }
  process.stdout.write(JSON.stringify({cookies:input.cookies.length}));
 }finally{cdp.socket.close();}
}
main().then(()=>{clearTimeout(deadline);process.exit(0);},()=>{clearTimeout(deadline);process.exit(failureStage);});
`

/** Shell quoting is only for this fixed program; no cookie or model-supplied word enters argv. */
export const signInCommand = `node -e '${signInGuest.replaceAll("'", "'\\''")}'`
