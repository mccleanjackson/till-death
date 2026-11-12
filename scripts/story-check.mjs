// Structural checks for a story JSON. Prints only counts/problems — never story text.
export const ROLE_IDS = ['avery', 'blair', 'cameron', 'drew', 'ellis', 'finley', 'gray', 'harper', 'jasmine', 'tessa'];

export function checkStory(s, label = 'story') {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(`${label}: ${msg}`); };
  for (const k of ['title', 'intro', 'roles', 'coupleStories', 'rounds', 'solution']) need(s[k], `missing "${k}"`);
  const roles = s.roles || [];
  need(roles.length === 10, `expected 10 roles, got ${roles.length}`);
  const ids = roles.map(r => r.id);
  need(new Set(ids).size === ids.length, 'duplicate role ids');
  for (const r of roles) {
    for (const k of ['id', 'name', 'couple', 'partner', 'publicBio', 'secret', 'alibi']) need(typeof r[k] === 'string' && r[k], `role ${r.id} missing ${k}`);
    need(Array.isArray(r.knows), `role ${r.id} knows must be an array`);
    const partner = roles.find(x => x.id === r.partner);
    need(partner && partner.partner === r.id, `role ${r.id} partner not reciprocal`);
    need(s.coupleStories?.[r.couple], `no coupleStory for "${r.couple}"`);
  }
  const killers = roles.filter(r => r.killerBrief);
  need(killers.length === 1, `expected exactly 1 killerBrief, got ${killers.length}`);
  need(ids.includes(s.solution?.killer), 'solution.killer is not a role id');
  need(killers[0]?.id === s.solution?.killer, 'killerBrief role does not match solution.killer');
  need((s.rounds || []).length === 3, 'expected 3 rounds');
  for (const [i, rd] of (s.rounds || []).entries()) need(rd.title && Array.isArray(rd.exhibits) && rd.exhibits.length, `round ${i + 1} incomplete`);
  return problems;
}
