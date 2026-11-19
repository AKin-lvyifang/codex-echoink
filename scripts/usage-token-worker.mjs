import {build} from 'esbuild';

export const usageTokenWorkerPlugin={name:'usage-token-worker',setup(b){
  b.onLoad({filter:/[\\/]usage[\\/]token-worker-source\.ts$/},async()=>{
    const result=await build({stdin:{contents:`import {Tiktoken} from 'js-tiktoken/lite';
let tokenizer;self.onmessage=event=>{const {id,text,ranks}=event.data;
try{if(ranks){tokenizer=new Tiktoken(ranks);return;}self.postMessage({id,count:tokenizer.encode(text,[],[]).length});}
catch{self.postMessage({id,error:'token_worker_failed'});}};`,resolveDir:process.cwd(),loader:'js'},
      bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',minify:true,logLevel:'silent'});
    return {loader:'js',contents:`export const usageTokenWorkerSource=${JSON.stringify(result.outputFiles[0].text)};`};
  });
}};
