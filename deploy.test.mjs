// deploy.ps1 ships static files to CT 112. The Colyseus game server in wildcard-server/ runs elsewhere
// and must never be copied there. These checks read the script text (PowerShell is not needed to run them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const script = readFileSync(new URL('./deploy.ps1', import.meta.url), 'utf8');
const lines = script.split(/\r?\n/);

test('deploy.ps1 excludes wildcard-server/ from the archive', () => {
  const tarLine = lines.find((l) => /^\s*tar -cf /.test(l));
  assert.ok(tarLine, 'tar -cf line not found');
  assert.match(tarLine, /--exclude=wildcard-server(\s|$)/);
});

test('deploy.ps1 refuses to continue if wildcard-server/ is in the archive, before anything is copied', () => {
  const idxGuard = lines.findIndex((l) => /tar -tf \$tar/.test(l) && /wildcard-server/.test(l));
  const idxThrow = lines.findIndex((l) => /throw .*wildcard-server/.test(l));
  const idxScp = lines.findIndex((l) => /^\s*scp /.test(l));
  assert.ok(idxGuard !== -1, 'archive listing check not found');
  assert.ok(idxThrow !== -1, 'throw not found');
  assert.ok(idxScp !== -1, 'scp not found');
  assert.ok(idxGuard < idxScp && idxThrow < idxScp, 'the guard must run before scp');
});

test('only the exclude, the archive check and its error message mention wildcard-server', () => {
  const mentions = lines.filter((l) => /wildcard-server/.test(l) && !/^\s*#/.test(l));
  assert.equal(mentions.length, 3, mentions.join(' | '));
  for (const l of mentions) assert.match(l, /tar -cf|\$leaked/);
});
