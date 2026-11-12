// Local stand-in for Supabase's RPC endpoint, running the real schema.sql in in-memory Postgres.
// Uses the PRACTICE story only, so it is spoiler-free. Usage: npm run mock  (then run `npm run dev` with .env.mock values)
import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 54399);
const dir = mkdtempSync(join(tmpdir(), 'td-mock-'));
copyFileSync(join(root, 'scripts/demo-story.json'), join(dir, 'story.json'));
execFileSync('node', [join(root, 'scripts/make-seed.mjs'), '--host', 'avery'], { env: { ...process.env, TD_PRIVATE_DIR: dir }, stdio: 'ignore' });
const codes = JSON.parse(readFileSync(join(dir, 'codes.json'), 'utf8'));

const db = new PGlite();
await db.exec('create role anon nologin; create role authenticated nologin;');
await db.exec(readFileSync(join(root, 'supabase/schema.sql'), 'utf8'));
await db.exec(readFileSync(join(dir, 'seed.sql'), 'utf8'));
await db.exec('grant usage on schema public to anon; set role anon;');

const ALLOWED = new Set(['td_state', 'td_advance', 'td_vote', 'td_set_name', 'td_reset', 'td_ready']);
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
let queue = Promise.resolve(); // PGlite is single-connection; serialise requests

createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const m = req.url.match(/^\/rest\/v1\/rpc\/(\w+)/);
  if (!m || !ALLOWED.has(m[1])) { res.writeHead(404, cors); return res.end('{}'); }
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    queue = queue.then(async () => {
      const args = body ? JSON.parse(body) : {};
      const names = Object.keys(args);
      const sql = `select public.${m[1]}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as v`;
      try {
        const r = await db.query(sql, names.map(n => args[n]));
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify(r.rows[0].v));
      } catch (e) {
        res.writeHead(400, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: e.code || 'P0001', message: e.message, hint: e.hint || null, details: null }));
      }
    });
  });
}).listen(PORT, () => {
  console.log(`Mock Supabase on http://localhost:${PORT}`);
  for (const [role, code] of Object.entries(codes.party)) console.log(`  ${role.padEnd(8)} ${code}${role === 'avery' ? '  (host)' : ''}`);
});
