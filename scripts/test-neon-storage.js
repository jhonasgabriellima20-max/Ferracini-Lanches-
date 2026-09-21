const { writeJson } = require('../lib/postgres-storage');

(async () => {
  try{
    await writeJson('__health__/diagnostic.json', { ok:true }, { allowOverwrite:true });
    process.exit(80);
  }catch(err){
    const msg=String(err?.message || err || '').toLowerCase();
    if(msg.includes('permission denied for schema')) process.exit(81);
    if(msg.includes('permission denied for table')) process.exit(82);
    if(msg.includes('permission denied to set role')) process.exit(83);
    if(msg.includes('does not exist') && msg.includes('role')) process.exit(84);
    if(msg.includes('row-level security')) process.exit(85);
    if(msg.includes('jwt')) process.exit(86);
    if(msg.includes('invalid role')) process.exit(87);
    if(msg.includes('insufficient_privilege')) process.exit(88);
    if(msg.includes('42501')) process.exit(89);
    if(Number(err?.status||0)===403) process.exit(90);
    process.exit(91);
  }
})().catch(()=>process.exit(92));
