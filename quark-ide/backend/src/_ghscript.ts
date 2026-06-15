import { getFileTree, getFileContent, commitMultipleFiles } from './services/github.js';

async function main() {
  const cmd = process.argv[2];
  const arg = process.argv[3];

  if (cmd === 'tree') {
    const files = await getFileTree('Trade-SnipeOS', 'main');
    console.log(files.map((f) => f.path).join('\n'));
  } else if (cmd === 'read') {
    const content = await getFileContent(arg, 'Trade-SnipeOS');
    console.log(content);
  } else if (cmd === 'commit') {
    // Read payload from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    const sha = await commitMultipleFiles(payload.files, payload.message, 'Trade-SnipeOS', 'main');
    console.log('COMMIT_SHA:' + sha);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
