import {test,expect} from 'bun:test';
import {Command} from './rea-opencut/commands/base-command';
import {BatchCommand} from './rea-opencut/commands/batch-command';
test('source batch leaves the first mutation applied when the second throws',()=>{
 let state=0;
 class First extends Command {execute(){state++;}undo(){state--;}}
 class Fail extends Command {execute(){throw Error('injected');}undo(){}}
 expect(()=>new BatchCommand([new First(),new Fail()]).execute()).toThrow('injected');
 expect(state).toBe(1);
});
