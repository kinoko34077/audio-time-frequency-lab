import {spawn} from "node:child_process";

function childHasExited(child){
  return !child?.pid||child.exitCode!==null||child.signalCode!==null;
}

function waitForChildExit(child,label,timeoutMs=5000){
  if(childHasExited(child))return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const onExit=()=>{
      clearTimeout(timer);
      resolve();
    };
    const timer=setTimeout(()=>{
      child.removeListener("exit",onExit);
      reject(Error(`${label} PID ${child.pid} did not exit within ${timeoutMs}ms`));
    },timeoutMs);
    child.once("exit",onExit);
    if(childHasExited(child))onExit();
  });
}

export async function stopChildProcess(child,label){
  if(!child||childHasExited(child))return;
  const exited=waitForChildExit(child,label);
  child.kill();
  await exited;
}

function killWindowsProcessTree(child,timeoutMs=5000){
  return new Promise(resolve=>{
    const killer=spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{
      stdio:"ignore",windowsHide:true
    });
    let settled=false;
    const finish=success=>{
      if(settled)return;
      settled=true;clearTimeout(timer);resolve(success);
    };
    const timer=setTimeout(()=>{
      try{killer.kill();}catch{}
      finish(false);
    },timeoutMs);
    killer.once("error",()=>finish(false));
    killer.once("exit",code=>finish(code===0));
  });
}

async function forceStopBrowser(child,label){
  if(!child||childHasExited(child))return;
  const treeStopped=process.platform!=="win32"||
    await killWindowsProcessTree(child);
  if(!childHasExited(child))child.kill();
  await waitForChildExit(child,label);
  if(!treeStopped)throw Error(
    `${label} PID ${child.pid} process tree kill failed; descendant shutdown is unverified`);
}

export async function closeBrowserTree(browser){
  if(!browser)return;
  const child=browser.process();
  let closeError;
  let closeTimer;
  const closePromise=Promise.resolve().then(()=>browser.close());
  closePromise.catch(()=>{});
  try{
    await Promise.race([closePromise,new Promise((_,reject)=>{
      closeTimer=setTimeout(()=>reject(Error(
        "isolated Chrome browser.close() did not finish within 8 seconds")),8000);
    })]);
  }catch(error){
    closeError=error;
  }finally{
    clearTimeout(closeTimer);
  }
  try{
    if(closeError)await forceStopBrowser(child,"isolated Chrome test browser");
    else await waitForChildExit(child,"isolated Chrome test browser");
  }catch(waitError){
    closeError??=waitError;
    try{
      await forceStopBrowser(child,"isolated Chrome test browser");
    }catch(stopError){
      throw new AggregateError([closeError,waitError,stopError].filter(Boolean),
        `Could not close isolated Chrome test browser: ${stopError.message}`);
    }
    throw new AggregateError([closeError,waitError].filter(Boolean),
      `Chrome test browser did not close cleanly: ${waitError.message}`);
  }
  if(closeError)throw closeError;
}

export async function cleanupTestProcesses(browser,children=[],label="browser test child"){
  const results=await Promise.allSettled([
    closeBrowserTree(browser),
    ...children.map((child,index)=>stopChildProcess(child,`${label} ${index+1}`))
  ]);
  const errors=results.filter(result=>result.status==="rejected")
    .map(result=>result.reason);
  if(errors.length)throw new AggregateError(errors,
    "Could not stop browser test processes");
}
