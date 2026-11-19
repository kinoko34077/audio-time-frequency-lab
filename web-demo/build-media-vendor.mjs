import {copyFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const vendor=resolve(root,'web-demo/vendor');
const output=resolve(vendor,'mediabunny-1.66.1.mjs');
const distribution=resolve(root,'node_modules/mediabunny/dist/bundles/mediabunny.min.mjs');
const license=resolve(root,'node_modules/mediabunny/LICENSE');
await mkdir(vendor,{recursive:true});
await copyFile(distribution,output);
await copyFile(license,resolve(vendor,'mediabunny-MPL-2.0.txt'));
await writeFile(resolve(vendor,'THIRD_PARTY_NOTICES.md'),
  '# Third party notices\n\n'+
  '`mediabunny-1.66.1.mjs` is the unmodified local Mediabunny 1.66.1 minified ESM browser distribution.\n'+
  'Mediabunny is licensed under MPL-2.0; see `mediabunny-MPL-2.0.txt`.\n'+
  'The bundle is built from the exact dependency pinned in the repository lockfile.\n');
console.log(`Copied the Mediabunny 1.66.1 ESM distribution to ${output}`);
