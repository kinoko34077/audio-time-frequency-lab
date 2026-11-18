function childHasExited(child){
  return child.exitCode!==null||child.signalCode!==null;
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

export async function closeBrowserTree(browser){
  if(!browser)return;
  const child=browser.process();
  let closeError;
  try{
    await browser.close();
  }catch(error){
    closeError=error;
  }
  try{
    await waitForChildExit(child,"isolated Chrome test browser");
  }catch(waitError){
    try{
      await stopChildProcess(child,"isolated Chrome test browser");
    }catch(stopError){
      throw new AggregateError([closeError,waitError,stopError].filter(Boolean),
        "Could not close isolated Chrome test browser");
    }
  }
  if(closeError)throw closeError;
}
