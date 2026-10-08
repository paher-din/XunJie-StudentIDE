import { parentPort } from 'node:worker_threads';

parentPort.on('message', async data => {
  try {
    const provider = await (['javascript', 'typescript'].includes(data.syntax) ? import('./diagnostics-typescript.mjs') : import('./diagnostics-markup.mjs'));
    parentPort.postMessage({ diagnostics: (await provider.diagnose(data)).slice(0, 100) });
  } catch (failure) { parentPort.postMessage({ error: failure.message }); }
});
