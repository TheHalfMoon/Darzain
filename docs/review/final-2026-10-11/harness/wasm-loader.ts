import {plugin} from 'bun';
import path from 'node:path';
await plugin({name:'native-wasm-module-loader',setup(build){
 build.onLoad({filter:/\.wasm$/},async args=>{
  const bytes=await Bun.file(args.path).arrayBuffer();
  const module=new WebAssembly.Module(bytes);
  const exports=WebAssembly.Module.exports(module).map(e=>e.name);
  const glue=path.join(path.dirname(args.path),'opencut_wasm_bg.js');
  return {loader:'js',contents:`import * as glue from ${JSON.stringify(glue)}; const bytes=await Bun.file(${JSON.stringify(args.path)}).arrayBuffer();const instance=new WebAssembly.Instance(new WebAssembly.Module(bytes),{'./opencut_wasm_bg.js':glue});${exports.map(name=>`export const ${name}=instance.exports[${JSON.stringify(name)}];`).join('')}`};
 });
}});
