import {connect,device} from './mobile-common.mjs';
// Keep the emulation-owning connection open while reusing the desktop encoder.
const c=await connect();
process.env.ECHOINK_PERF_NAME??=device+'-walkthrough';
const args=process.argv.slice(4);
process.argv=[process.argv[0],new URL('./record.mjs',import.meta.url).pathname,...(args.length?args:['--seconds','12'])];
try{await import('./record.mjs');}finally{c.close();}
