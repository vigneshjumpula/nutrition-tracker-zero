/**
 * The health profile end to end (WEEKLY_BREAKDOWN_PLAN.md sections 6, 8, 9, 11.4, 11.8): the secret, the safety
 * gates and what each stores, versioned target sets, goals and their bounds, weigh-ins, export, erasure.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { addDays, localDateIn } from '../../src/domain/time';
import { api, createProfile, createProfileWithSecret, unique } from '../helpers';

const SAFE = { pregnantOrBreastfeeding: false, eatingDisorder: false, clinicianDiet: false, dietInteractingMedicine: false };
const ASHA = { birthYear: 1996, birthMonth: 3, sexForCalc: 'female', heightCm: 160, weightKg: 60, activity: 'low_active', goal: 'general_health', pace: 'standard', pattern: 'omnivore', referenceSet: 'nasem' };
const CONSENT = '2026-10-v1';

async function onboard(over: Record<string, unknown> = {}, safety: Record<string, unknown> = {}) {
  const p = await createProfileWithSecret();
  const res = await api('PUT', '/me/profile', { userId: p.userId, secret: p.secret, body: { profile: { ...ASHA, ...over }, safety: { ...SAFE, ...safety }, consentVersion: CONSENT } });
  return { ...p, res };
}

const count = async (table: string, userId: string) => (await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE user_id = ?`).bind(userId).first<{ c: number }>())!.c;
const target = (set: any, nutrient: string) => set.targets.find((t: any) => t.nutrient === nutrient);

describe('the per-profile secret (plan 8.3.2)', () => {
  it('is returned once at creation, stored only as a hash, and never returned again', async () => {
    const { userId, secret } = await createProfileWithSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await env.DB.prepare('SELECT secret_hash, webhook_token FROM users WHERE id = ?').bind(userId).first<{ secret_hash: string; webhook_token: string }>();
    expect(row!.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.secret_hash).not.toContain(secret);
    expect(row!.secret_hash).not.toBe(secret);
    for (const res of [await api('GET', '/profiles'), await api('GET', '/me/settings', { userId }), await api('GET', '/me/goals', { userId }), await api('GET', `/days/2026-10-05`, { userId })]) {
      expect(res.text).not.toContain(secret);
      expect(res.text).not.toContain(row!.secret_hash);
    }
  });

  it('is required on every health route: the shared app token alone is refused', async () => {
    const { userId, secret } = await createProfileWithSecret();
    const routes: [string, string, unknown?][] = [
      ['GET', '/me/profile'],
      ['PUT', '/me/profile', { profile: ASHA, safety: SAFE, consentVersion: CONSENT }],
      ['GET', '/me/targets'],
      ['GET', '/me/weights'],
      ['POST', '/me/weights', { weightKg: 60 }],
      ['DELETE', '/me/weights/2026-10-05'],
      ['GET', '/me/export'],
      ['DELETE', '/me/health-data'],
      ['DELETE', '/me'],
    ];
    for (const [method, path, body] of routes) {
      const none = await api(method, path, { userId, body });
      expect([method, path, none.status, none.body.error.code]).toEqual([method, path, 403, 'profile_secret_required']);
      const wrong = await api(method, path, { userId, body, secret: 'x'.repeat(43) });
      expect([method, path, wrong.status, wrong.body.error.code]).toEqual([method, path, 403, 'profile_secret_invalid']);
      const malformed = await api(method, path, { userId, body, secret: 'short' });
      expect([method, path, malformed.status, malformed.body.error.code]).toEqual([method, path, 403, 'profile_secret_invalid']);
    }
    // The right one gets through (the profile has no health data yet).
    expect((await api('GET', '/me/profile', { userId, secret })).status).toBe(200);
  });

  it("does not open another profile: A's secret does not work for B", async () => {
    const a = await createProfileWithSecret();
    const b = await createProfileWithSecret();
    expect((await api('GET', '/me/profile', { userId: b.userId, secret: a.secret })).status).toBe(403);
    expect((await api('GET', '/me/profile', { userId: b.userId, secret: b.secret })).status).toBe(200);
  });

  it('a profile made before secrets existed claims one, once; a second claim is refused', async () => {
    const legacy = await createProfile();
    await env.DB.prepare('UPDATE users SET secret_hash = NULL WHERE id = ?').bind(legacy).run();
    expect((await api('GET', '/me/profile', { userId: legacy })).body.error.code).toBe('profile_secret_required');
    const claim = await api('POST', '/me/secret', { userId: legacy });
    expect(claim.status).toBe(201);
    const secret = claim.body.secret as string;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await api('POST', '/me/secret', { userId: legacy })).status).toBe(409);
    expect((await api('GET', '/me/profile', { userId: legacy, secret })).status).toBe(200);
    // A profile that already has one cannot be claimed either.
    const owned = await createProfileWithSecret();
    expect((await api('POST', '/me/secret', { userId: owned.userId })).body.error.code).toBe('secret_already_set');
  });
});

describe('PUT /me/profile: a personalised profile', () => {
  it('stores the profile and the first target set, and returns the explained targets', async () => {
    const { userId, secret, res } = await onboard();
    expect(res.status).toBe(200);
    expect(res.body.profile).toMatchObject({ mode: 'personalised', birthYear: 1996, birthMonth: 3, sexForCalc: 'female', heightCm: 160, weightKg: 60, activity: 'low_active', goal: 'general_health', numbersHidden: false, dietInteractingMedicine: false, consentVersion: CONSENT });
    const set = res.body.targetSet;
    expect(set).toMatchObject({ mode: 'personalised', id: expect.any(String) });
    expect(set.energy).toMatchObject({ maintenance: 2150, target: 2150, low: 1910, high: 2390 });
    expect([target(set, 'protein').value, target(set, 'fat').value, target(set, 'carbs').value, target(set, 'fiber').value, target(set, 'sodium').value]).toEqual([60, 72, 316, 30, 2300]);
    expect(target(set, 'calcium')).toMatchObject({ value: 1000, upperLevel: 2500, refType: 'RDA', basis: 'nasem-dri-appendix-j', evidence: 'R', origin: 'recommended' });
    expect(target(set, 'iron').value).toBe(18);
    expect(target(set, 'protein').how).toMatch(/1\.0 g for each kg/);
    expect(res.body.warnings).toEqual([]);
    expect([await count('health_profiles', userId), await count('weight_entries', userId), await count('target_sets', userId)]).toEqual([1, 1, 1]);
    const get = await api('GET', '/me/profile', { userId, secret });
    expect(get.body.profile).toEqual(res.body.profile);
    expect(get.body.targetSet.id).toBe(set.id);
  });

  it('needs a consent version the first time, and says what to do', async () => {
    const p = await createProfileWithSecret();
    const res = await api('PUT', '/me/profile', { userId: p.userId, secret: p.secret, body: { profile: ASHA, safety: SAFE } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('consent_required');
    expect(await count('health_profiles', p.userId)).toBe(0);
  });

  it('does not create a second set for a save that says the same thing, and does for one that does not', async () => {
    const { userId, secret } = await onboard();
    const same = await api('PUT', '/me/profile', { userId, secret, body: { profile: ASHA, safety: SAFE } });
    expect(same.status).toBe(200);
    expect(await count('target_sets', userId)).toBe(1);
    const taller = await api('PUT', '/me/profile', { userId, secret, body: { profile: { heightCm: 165 }, safety: SAFE } });
    expect(taller.status).toBe(200);
    expect(taller.body.profile).toMatchObject({ heightCm: 165, weightKg: 60, birthYear: 1996 }); // the rest is kept
    expect(await count('target_sets', userId)).toBe(2);
    expect(taller.body.targetSet.inputs.heightCm).toBe(165);
    // One weigh-in per day: today's was updated, not duplicated.
    expect(await count('weight_entries', userId)).toBe(1);
  });

  it('keeps old sets, so a past day is still judged by the targets it had (plan 6.2)', async () => {
    const { userId, secret, res } = await onboard();
    const first = res.body.targetSet;
    await api('PUT', '/me/profile', { userId, secret, body: { profile: { goal: 'build_muscle' }, safety: SAFE } });
    const rows = (await env.DB.prepare('SELECT id, inputs_json FROM target_sets WHERE user_id = ? ORDER BY created_at, id').bind(userId).all<{ id: string; inputs_json: string }>()).results;
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]!.inputs_json).inputs.goal).toBe('general_health');
    expect(rows.map((r) => r.id)).toContain(first.id);
  });

  it('validates the body and names the field', async () => {
    const p = await createProfileWithSecret();
    const put = (profile: Record<string, unknown>, extra: Record<string, unknown> = { safety: SAFE }) => api('PUT', '/me/profile', { userId: p.userId, secret: p.secret, body: { profile, consentVersion: CONSENT, ...extra } });
    expect((await put({ ...ASHA, heightCm: 100 })).body.error.field).toBe('heightCm');
    expect((await put({ ...ASHA, weightKg: 10 })).body.error.field).toBe('weightKg');
    expect((await put({ ...ASHA, sexForCalc: 'other' })).body.error.field).toBe('sexForCalc');
    expect((await put({ ...ASHA, activity: 'couch' })).body.error.field).toBe('activity');
    expect((await put({ ...ASHA, goal: 'bulk' })).body.error.field).toBe('goal');
    expect((await put({ ...ASHA, birthYear: 1800 })).status).toBe(400);
    expect((await put({ ...ASHA, birthYear: 1900 })).status).toBe(400); // over 100
    expect((await put({ ...ASHA, birthMonth: 13 })).body.error.field).toBe('birthMonth');
    expect((await put({ goal: 'lose' })).status).toBe(400); // incomplete, with nothing stored to take the rest from
    expect((await put(ASHA, { safety: { eatingDisorder: 'yes' } })).body.error.field).toBe('safety.eatingDisorder');
    expect((await put({ ...ASHA, numbersHidden: 'no' })).body.error.field).toBe('numbersHidden');
    expect(await count('health_profiles', p.userId)).toBe(0);
  });

  it('asks for the safety check before a body is saved, and never takes it from storage', async () => {
    const p = await createProfileWithSecret();
    const res = await api('PUT', '/me/profile', { userId: p.userId, secret: p.secret, body: { profile: ASHA, consentVersion: CONSENT } });
    expect(res.body.error.code).toBe('safety_required');
  });
});

describe('the safety gates store the mode and nothing else (plan 8.1, 11.4)', () => {
  const dump = async (userId: string) => {
    const tables = ['health_profiles', 'weight_entries', 'target_sets', 'day_status'];
    const rows = await Promise.all(tables.map((t) => env.DB.prepare(`SELECT * FROM ${t} WHERE user_id = ?`).bind(userId).all()));
    return JSON.stringify(rows.map((r) => r.results));
  };

  const gates: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ['pregnant or breastfeeding', {}, { pregnantOrBreastfeeding: true }],
    ['an eating-disorder history', {}, { eatingDisorder: true }],
    ['a diet from a doctor or dietitian', {}, { clinicianDiet: true }],
    ['under 19 (G1)', { birthYear: 2010 }, {}],
    ['a BMI under 16 (G5)', { weightKg: 40 }, {}],
    ['a BMI over 60 (G5)', { weightKg: 160, heightCm: 130 }, {}],
  ];
  for (const [label, profile, safety] of gates) {
    it(`${label}: reference-only, no targets, no body data, and no trace of the reason`, async () => {
      const { userId, res } = await onboard(profile, safety);
      expect(res.status).toBe(200);
      expect(res.body.profile.mode).toBe('reference_only');
      expect(res.body.targetSet).toBeNull();
      expect(res.body.warnings.map((w: any) => w.id)[0]).toBe('reference_only');
      const stored = await dump(userId);
      // No body measurement, no birth year, no goal, no sex, no activity anywhere in the stored rows.
      expect(stored).not.toMatch(/low_active|general_health|"female"|"male"|"average"|"birth_year":\d|"height_cm":\d|"weight_kg":\d/);
      const row = await env.DB.prepare('SELECT * FROM health_profiles WHERE user_id = ?').bind(userId).first<any>();
      expect(row).toMatchObject({ target_mode: 'reference_only', birth_year: null, sex_for_calc: null, height_cm: null, activity_level: null, goal: null });
      expect([await count('weight_entries', userId), await count('target_sets', userId)]).toEqual([0, 0]);
      // Nothing records which gate it was: no column, no value, in any table.
      expect(stored).not.toMatch(/pregnan|breastfeed|eating|disorder|clinician|doctor|dietitian|under_19|bmi/i);
      expect(JSON.stringify(res.body)).not.toMatch(/pregnan|breastfeed|eating|disorder|clinician|doctor|dietitian/i);
    });
  }

  it('the age and BMI gates may say why (the person just typed the numbers), the safety answers never do', async () => {
    expect((await onboard({ birthYear: 2010 })).res.body.warnings.map((w: any) => w.id)).toEqual(['reference_only', 'under_19']);
    expect((await onboard({ weightKg: 40 })).res.body.warnings.map((w: any) => w.id)).toEqual(['reference_only', 'bmi_out_of_range']);
    expect((await onboard({}, { pregnantOrBreastfeeding: true })).res.body.warnings.map((w: any) => w.id)).toEqual(['reference_only']);
  });

  it('an eating-disorder answer turns low-pressure mode on, unless it is switched off', async () => {
    expect((await onboard({}, { eatingDisorder: true })).res.body.profile.numbersHidden).toBe(true);
    const off = await createProfileWithSecret();
    const res = await api('PUT', '/me/profile', { userId: off.userId, secret: off.secret, body: { profile: { numbersHidden: false }, safety: { ...SAFE, eatingDisorder: true }, consentVersion: CONSENT } });
    expect(res.body.profile.numbersHidden).toBe(false);
  });

  it('does not store the safety answers anywhere: not in the personalised row, nor in a target set', async () => {
    const { userId } = await onboard({}, { dietInteractingMedicine: true });
    const stored = await dump(userId);
    expect(stored).not.toMatch(/pregnan|eating|clinician/i);
    // Only the medicine flag, which changes what is shown, is kept.
    expect((await env.DB.prepare('SELECT diet_interacting_medicine AS m FROM health_profiles WHERE user_id = ?').bind(userId).first<{ m: number }>())!.m).toBe(1);
  });

  it('erases what a personalised profile stored when it becomes reference-only', async () => {
    const { userId, secret } = await onboard();
    expect([await count('weight_entries', userId), await count('target_sets', userId)]).toEqual([1, 1]);
    const res = await api('PUT', '/me/profile', { userId, secret, body: { profile: {}, safety: { ...SAFE, pregnantOrBreastfeeding: true } } });
    expect(res.body.profile.mode).toBe('reference_only');
    expect([await count('weight_entries', userId), await count('target_sets', userId)]).toEqual([0, 0]);
    expect((await env.DB.prepare('SELECT * FROM health_profiles WHERE user_id = ?').bind(userId).first<any>()).height_cm).toBeNull();
    // ... and it cannot go back without answering the check again.
    expect((await api('PUT', '/me/profile', { userId, secret, body: { profile: ASHA } })).body.error.code).toBe('safety_required');
    expect((await api('PUT', '/me/profile', { userId, secret, body: { profile: ASHA, safety: SAFE } })).body.profile.mode).toBe('personalised');
  });
});

describe('goals offered, refused and applied (G6 to G11)', () => {
  it('refuses a loss goal under BMI 25 and applies Maintain with the reason, listing what is available', async () => {
    const { res } = await onboard({ goal: 'lose' });
    expect(res.body.targetSet.inputs).toMatchObject({ goal: 'lose', goalApplied: 'maintain' });
    expect(res.body.warnings.map((w: any) => w.id)).toContain('lose_not_indicated_bmi');
    expect(res.body.targetSet.availableGoals).toEqual(['general_health', 'maintain', 'gain', 'build_muscle']);
  });

  it('offers loss at BMI 25 and above, with the deficit, the floor and the protein for a loss', async () => {
    const { res } = await onboard({ goal: 'lose', birthYear: 1971, heightCm: 155, weightKg: 75, activity: 'inactive' });
    expect(res.body.targetSet.inputs.goalApplied).toBe('lose');
    expect(res.body.targetSet.energy).toMatchObject({ maintenance: 1960, delta: -290, target: 1670 });
    expect(target(res.body.targetSet, 'protein').value).toBe(101);
    expect(res.body.checkIn).toEqual({ due: false, weeks: 0 });
  });

  it('says a BMI under 18.5 has a notice and no loss goal', async () => {
    const { res } = await onboard({ goal: 'lose', heightCm: 175, weightKg: 54 });
    expect(res.body.warnings.map((w: any) => w.id)).toEqual(expect.arrayContaining(['underweight_notice', 'lose_not_indicated_bmi']));
    expect(res.body.targetSet.inputs.goalApplied).toBe('maintain');
  });

  it('turns vitamin K, potassium and sodium into amounts only with the medicine flag', async () => {
    const { res } = await onboard({}, { dietInteractingMedicine: true });
    for (const k of ['vitaminK', 'potassium', 'sodium']) expect(target(res.body.targetSet, k).verdicts).toBe(false);
    expect(target(res.body.targetSet, 'protein').verdicts).toBe(true);
    expect(res.body.warnings.map((w: any) => w.id)).toContain('medicine_amounts_only');
  });

  it('asks the loss goal\'s 12-week check-in when it comes due, and starts the clock again when the safety check is answered', async () => {
    const { userId, secret } = await onboard({ goal: 'lose', birthYear: 1971, heightCm: 155, weightKg: 75, activity: 'inactive' });
    const long = new Date(Date.now() - 13 * 7 * 86_400_000).toISOString().slice(0, 10);
    const row = await env.DB.prepare('SELECT id, inputs_json FROM target_sets WHERE user_id = ?').bind(userId).first<{ id: string; inputs_json: string }>();
    const inputs = JSON.parse(row!.inputs_json);
    inputs.lossStartedOn = long;
    await env.DB.prepare('UPDATE target_sets SET inputs_json = ? WHERE id = ?').bind(JSON.stringify(inputs), row!.id).run();
    expect((await api('GET', '/me/profile', { userId, secret })).body.checkIn).toEqual({ due: true, weeks: 13 });
    // A re-save without the safety check keeps the clock; answering it restarts it.
    expect((await api('PUT', '/me/profile', { userId, secret, body: { profile: { pace: 'gentle' } , safety: undefined} })).status).toBe(200);
    const reasked = await api('PUT', '/me/profile', { userId, secret, body: { profile: { pace: 'standard' }, safety: SAFE } });
    expect(reasked.body.checkIn).toEqual({ due: false, weeks: 0 });
  });
});

describe('preview (plan 9.3): the same computation without saving, and without a secret', () => {
  it('returns targets for the onboarding screen and stores nothing', async () => {
    const { userId } = await createProfileWithSecret();
    const res = await api('POST', '/me/targets/preview', { userId, body: { profile: ASHA, safety: SAFE } });
    expect(res.status).toBe(200);
    expect(res.body.targetSet.id).toBeNull();
    expect(res.body.targetSet.energy).toMatchObject({ maintenance: 2150, low: 1910, high: 2390 });
    expect([await count('health_profiles', userId), await count('weight_entries', userId), await count('target_sets', userId)]).toEqual([0, 0, 0]);
  });

  it('follows the same gates, and never reads stored health data', async () => {
    const { userId, secret } = await onboard();
    const before = await env.DB.prepare('SELECT * FROM health_profiles WHERE user_id = ?').bind(userId).first();
    const under = await api('POST', '/me/targets/preview', { userId, body: { profile: { ...ASHA, birthYear: 2012 }, safety: SAFE } });
    expect(under.body.targetSet).toMatchObject({ mode: 'reference_only', targets: [], energy: null });
    // A partial body is not completed from storage: a preview needs the whole profile.
    expect((await api('POST', '/me/targets/preview', { userId, body: { profile: { heightCm: 170 }, safety: SAFE } })).status).toBe(400);
    expect(await env.DB.prepare('SELECT * FROM health_profiles WHERE user_id = ?').bind(userId).first()).toEqual(before);
    void secret;
  });
});

describe('GET /me/targets', () => {
  it('serves each target with its reason, source and evidence, the typed numbers applied, and the sources cited', async () => {
    const { userId, secret } = await onboard();
    await api('PUT', '/me/goals', { userId, secret, body: { goals: { protein: 80 } } });
    const res = await api('GET', '/me/targets', { userId, secret });
    expect(res.body.mode).toBe('personalised');
    const protein = target(res.body, 'protein');
    expect(protein).toMatchObject({ value: 80, origin: 'custom', basis: 'custom-target' });
    expect(target(res.body, 'calories')).toMatchObject({ value: 2150, kind: 'energy', evidence: 'E', origin: 'recommended' });
    expect(res.body.sources['nasem2023-eer']).toMatchObject({ title: expect.any(String), url: expect.stringMatching(/^https:/) });
    expect(res.body.sources['custom-target']).toBeDefined();
    for (const t of res.body.targets) expect(res.body.sources[t.basis], t.basis).toBeDefined();
    expect(res.body.targetSet.energy.maintenance).toBe(2150);
  });

  it('serves the generic reference with no profile, and only typed numbers in reference-only mode', async () => {
    const p = await createProfileWithSecret();
    const generic = await api('GET', '/me/targets', { userId: p.userId, secret: p.secret });
    expect(generic.body.mode).toBe('generic');
    expect(target(generic.body, 'protein').value).toBe(50);
    const ref = await onboard({}, { clinicianDiet: true });
    await api('PUT', '/me/goals', { userId: ref.userId, secret: ref.secret, body: { goals: { protein: 70, sodium: 1500 }, origin: 'care_team' } });
    const res = await api('GET', '/me/targets', { userId: ref.userId, secret: ref.secret });
    expect(res.body.mode).toBe('reference_only');
    expect(res.body.targets.map((t: any) => [t.nutrient, t.value, t.origin])).toEqual([['protein', 70, 'care_team'], ['sodium', 1500, 'care_team']]);
  });

  it('withholds every number in low-pressure mode (plan 8.2)', async () => {
    const { userId, secret } = await onboard();
    await api('PUT', '/me/profile', { userId, secret, body: { profile: { numbersHidden: true } } });
    const res = await api('GET', '/me/targets', { userId, secret });
    expect(res.body).toMatchObject({ numbersHidden: true, targets: [], sources: {} });
    expect(res.body.targetSet.energy).toBeUndefined();
    // Match numeric JSON values, not coincidental digits inside a random target-set UUID.
    expect(res.text).not.toMatch(/:\s*(?:2150|1910|2390)(?=\s*[,}\]])|"value"\s*:/);
    const goals = await api('GET', '/me/goals', { userId, secret });
    expect(goals.body.hidden).toBe(true);
    expect(goals.body.goals.every((g: any) => g.target === null)).toBe(true);
  });

  it('rejects a bad date', async () => {
    const { userId, secret } = await onboard();
    expect((await api('GET', '/me/targets?date=nope', { userId, secret })).status).toBe(400);
  });

  it('moves the micronutrient references with the birthday: a new set when the age band changes (plan 6.2)', async () => {
    const { userId, secret } = await onboard({ birthYear: 1995, birthMonth: 3 }); // 31 on 12 October 2026
    const row = await env.DB.prepare('SELECT id, inputs_json FROM target_sets WHERE user_id = ?').bind(userId).first<{ id: string; inputs_json: string }>();
    // Pretend the set was made when she was in an earlier band.
    const inputs = JSON.parse(row!.inputs_json);
    inputs.inputs.ageBand = '19-30';
    await env.DB.prepare('UPDATE target_sets SET inputs_json = ? WHERE id = ?').bind(JSON.stringify(inputs), row!.id).run();
    // She was born in March 1995, so today she is 31 and in 31-50: the first request after the change adds a set.
    const res = await api('GET', '/me/targets', { userId, secret });
    expect(res.body.targetSet.inputs.ageBand).toBe('31-50');
    expect(await count('target_sets', userId)).toBe(2);
    expect((await api('GET', '/me/targets', { userId, secret })).body.targetSet.id).toBe(res.body.targetSet.id);
    expect(await count('target_sets', userId)).toBe(2);
  });
});

describe('the Indian reference set, ICMR-NIN 2020 (plan 4.10)', () => {
  it('serves its own limits and sources: sodium 2,000 mg, added sugars 5% of energy, iron, zinc and B12 against the Estimated Average Requirement', async () => {
    const { userId, secret } = await onboard({ referenceSet: 'icmr_nin' });
    const res = await api('GET', '/me/targets', { userId, secret });
    expect(res.status).toBe(200);
    expect(res.body.targetSet).toMatchObject({ referenceSet: 'icmr_nin', inputs: { ageBand: '19-59' } });
    // Energy stays the National Academies' estimate on both sets.
    expect(target(res.body, 'calories')).toMatchObject({ value: 2150, basis: 'nasem2023-eer' });
    expect(target(res.body, 'sodium')).toMatchObject({ value: 2000, kind: 'limit', basis: 'icmr-nin2020' });
    expect(target(res.body, 'addedSugar')).toMatchObject({ value: 27, basis: 'dgi2024' }); // 5% of 2,150 kcal is 26.9 g
    expect(target(res.body, 'potassium')).toMatchObject({ value: 3500, refType: 'AI', basis: 'icmr-nin2020' });
    expect(target(res.body, 'fiber')).toMatchObject({ value: 32, basis: 'icmr-nin2020' }); // 15 g per 1,000 kcal
    // A woman of 19 to 59: allowances of 29 mg iron, 13.2 mg zinc and 2.2 mcg B12, and the averages 15, 11 and 2 that stand in for them.
    expect(target(res.body, 'iron')).toMatchObject({ value: 15, refType: 'EAR', basis: 'icmr-nin2020' });
    expect(target(res.body, 'iron').how).toMatch(/Estimated Average Requirement/);
    expect(target(res.body, 'iron').how).toMatch(/\(29 mg\)/);
    expect(target(res.body, 'zinc')).toMatchObject({ value: 11, refType: 'EAR' });
    expect(target(res.body, 'vitaminB12')).toMatchObject({ value: 2, refType: 'EAR' });
    // Where ICMR gives an allowance it is the allowance.
    expect(target(res.body, 'calcium')).toMatchObject({ value: 1000, refType: 'RDA' });
    expect(target(res.body, 'vitaminC')).toMatchObject({ value: 65, refType: 'RDA' });
    // Every target cites a source the response carries, and the Indian ones are the Indian ones.
    for (const t of res.body.targets) expect(res.body.sources[t.basis], t.basis).toMatchObject({ title: expect.any(String), url: expect.stringMatching(/^https:/) });
    expect(res.body.sources['icmr-nin2020']).toBeDefined();
    expect(res.body.sources['dgi2024']).toBeDefined();
    expect(res.body.targets.some((t: any) => ['nasem-amdr', 'nasem-fibre-ai', 'nasem2019-cdrr', 'nasem2019-potassium-ai'].includes(t.basis))).toBe(false);
  });

  it('does not multiply iron for a plant-based diet, and does not warn about it; the National Academies set still does', async () => {
    const indian = await onboard({ referenceSet: 'icmr_nin', pattern: 'vegan' });
    const a = await api('GET', '/me/targets', { userId: indian.userId, secret: indian.secret });
    expect(target(a.body, 'iron').value).toBe(15);
    expect(a.body.targetSet.warnings.map((w: any) => w.id)).not.toContain('iron_plant_based');
    const us = await onboard({ referenceSet: 'nasem', pattern: 'vegan' });
    const b = await api('GET', '/me/targets', { userId: us.userId, secret: us.secret });
    expect(target(b.body, 'iron').value).toBe(32.4); // 18 mg x 1.8
    expect(b.body.targetSet.warnings.map((w: any) => w.id)).toContain('iron_plant_based');
  });

  it('is chosen from the band the birthday puts a person in: 59 and 60 are on either side of the edge', async () => {
    const fiftyNine = await onboard({ referenceSet: 'icmr_nin', birthYear: 1967, birthMonth: 3 });
    const sixty = await onboard({ referenceSet: 'icmr_nin', birthYear: 1966, birthMonth: 3 });
    const a = await api('GET', '/me/targets', { userId: fiftyNine.userId, secret: fiftyNine.secret });
    const b = await api('GET', '/me/targets', { userId: sixty.userId, secret: sixty.secret });
    expect(a.body.targetSet.inputs.ageBand).toBe('19-59');
    expect(b.body.targetSet.inputs.ageBand).toBe('60+');
    // Her iron average requirement falls with the 60th birthday (15 mg to 11 mg), and her vitamin D allowance rises (15 to 20 mcg).
    expect(target(a.body, 'iron').value).toBe(15);
    expect(target(b.body, 'iron').value).toBe(11);
    expect(target(a.body, 'vitaminD').value).toBe(15);
    expect(target(b.body, 'vitaminD').value).toBe(20);
  });

  it('adds a set when the 60th birthday is crossed, once (plan 6.2)', async () => {
    const { userId, secret } = await onboard({ referenceSet: 'icmr_nin', birthYear: 1966, birthMonth: 3 }); // 60 on 12 October 2026
    const row = await env.DB.prepare('SELECT id, inputs_json FROM target_sets WHERE user_id = ?').bind(userId).first<{ id: string; inputs_json: string }>();
    // Pretend the set was made in the younger band.
    const inputs = JSON.parse(row!.inputs_json);
    inputs.inputs.ageBand = '19-59';
    await env.DB.prepare('UPDATE target_sets SET inputs_json = ? WHERE id = ?').bind(JSON.stringify(inputs), row!.id).run();
    const res = await api('GET', '/me/targets', { userId, secret });
    expect(res.body.targetSet.inputs.ageBand).toBe('60+');
    expect(res.body.targetSet.referenceSet).toBe('icmr_nin');
    expect(await count('target_sets', userId)).toBe(2);
    expect((await api('GET', '/me/targets', { userId, secret })).body.targetSet.id).toBe(res.body.targetSet.id);
    expect(await count('target_sets', userId)).toBe(2);
  });

  it('does not add a set at 30 to 31 or 50 to 51: those are the National Academies edges, not ICMR-NIN\'s', async () => {
    const { userId, secret } = await onboard({ referenceSet: 'icmr_nin', birthYear: 1995, birthMonth: 3 }); // 31 on 12 October 2026
    await api('GET', '/me/targets', { userId, secret });
    expect(await count('target_sets', userId)).toBe(1);
    expect((await api('GET', '/me/targets', { userId, secret })).body.targetSet.inputs.ageBand).toBe('19-59');
  });

  it('switching the set in the profile adds a new set and keeps the old one in the history', async () => {
    const { userId, secret } = await onboard({ referenceSet: 'nasem' });
    const before = await api('GET', '/me/targets', { userId, secret });
    expect(target(before.body, 'sodium').value).toBe(2300);
    const put = await api('PUT', '/me/profile', { userId, secret, body: { profile: { referenceSet: 'icmr_nin' } } });
    expect(put.status).toBe(200);
    const after = await api('GET', '/me/targets', { userId, secret });
    expect(after.body.targetSet.referenceSet).toBe('icmr_nin');
    expect(target(after.body, 'sodium').value).toBe(2000);
    expect(after.body.targetSet.id).not.toBe(before.body.targetSet.id);
    expect(await count('target_sets', userId)).toBe(2);
    const sets = await env.DB.prepare('SELECT reference_set FROM target_sets WHERE user_id = ? ORDER BY created_at, rowid').bind(userId).all<{ reference_set: string }>();
    expect(sets.results.map((r) => r.reference_set)).toEqual(['nasem', 'icmr_nin']);
    // Switching back is another set, not an edit of the old one.
    await api('PUT', '/me/profile', { userId, secret, body: { profile: { referenceSet: 'nasem' } } });
    expect(await count('target_sets', userId)).toBe(3);
  });

  it('is listed as available by /meta (the weekly report is checked in reports.test.ts)', async () => {
    const meta = await api('GET', '/meta');
    expect(meta.body.referenceSets.find((s: any) => s.id === 'icmr_nin')).toMatchObject({ available: true });
    expect(meta.body.referenceSets.find((s: any) => s.id === 'nasem')).toMatchObject({ available: true });
  });
});

describe('goals: recommended and typed side by side, inside their bounds (plan 6.4)', () => {
  it('without the secret: the generic reference plus typed numbers, exactly as before', async () => {
    const { userId } = await onboard();
    const res = await api('GET', '/me/goals', { userId });
    const by = Object.fromEntries(res.body.goals.map((g: any) => [g.key, g]));
    expect(by.calories).toMatchObject({ target: 2000, origin: 'reference', recommended: null, custom: false });
    expect(res.text).not.toMatch(/:\s*2150(?=\s*[,}\]])/);
    const day = await api('GET', '/days/2026-10-05', { userId });
    expect(day.body.goals.calories).toBe(2000);
  });

  it('with the secret: the personal targets, each with its reason, the typed one marked custom', async () => {
    const { userId, secret } = await onboard();
    await api('PUT', '/me/goals', { userId, secret, body: { goals: { protein: 80 } } });
    const res = await api('GET', '/me/goals', { userId, secret });
    const by = Object.fromEntries(res.body.goals.map((g: any) => [g.key, g]));
    expect(by.calories).toMatchObject({ target: 2150, origin: 'recommended', recommended: 2150, custom: false });
    expect(by.protein).toMatchObject({ target: 80, origin: 'custom', recommended: 60, custom: true });
    expect(by.protein.how).toMatch(/1\.0 g for each kg/);
    expect(by.sugar).toMatchObject({ target: null, origin: null });
    expect((await api('GET', '/days/2026-10-05', { userId, secret })).body).toMatchObject({ goals: { calories: 2150, protein: 80 }, customGoals: ['protein'] });
  });

  it('saves a calorie target under the sex-specific floor or over 125% of the estimate, with a warning', async () => {
    const { userId, secret } = await onboard();
    const put = (goals: Record<string, number | null>) => api('PUT', '/me/goals', { userId, secret, body: { goals } });
    const low = await put({ calories: 1100 });
    expect(low.status).toBe(200);
    expect(low.body.notes).toEqual([{ nutrient: 'calories', note: expect.stringMatching(/^Under 1,200 kcal .*doctor or dietitian/) }]);
    const calories = low.body.goals.find((g: any) => g.key === 'calories');
    expect(calories).toMatchObject({ target: 1100, custom: true, recommended: 2150, outsideBounds: true, warning: expect.stringMatching(/^Under 1,200 kcal/) });
    expect(calories.bounds).toMatchObject({ low: 1200, high: 2690 }); // 125% of 2,150, to the nearest 10
    expect((await put({ calories: 799 })).status).toBe(200);
    const high = await put({ calories: 2700 });
    expect(high.status).toBe(200);
    expect(high.body.notes[0].note).toMatch(/more than 125% of your estimated needs/);
    const fine = await put({ calories: 2690 });
    expect(fine.body.notes).toEqual([]);
    expect(fine.body.goals.find((g: any) => g.key === 'calories')).toMatchObject({ target: 2690, outsideBounds: false });
    expect(fine.body.goals.find((g: any) => g.key === 'calories').warning).toBeUndefined();
    expect((await put({ calories: 1200 })).body.notes).toEqual([]);
    // Only a number that cannot be a target is refused.
    expect((await put({ calories: 0 })).status).toBe(400);
  });

  it('saves protein, sodium and micronutrient targets away from the usual values, and says why', async () => {
    const { userId, secret } = await onboard();
    const put = (goals: Record<string, number | null>) => api('PUT', '/me/goals', { userId, secret, body: { goals } });
    const note = async (goals: Record<string, number | null>) => {
      const res = await put(goals);
      expect(res.status).toBe(200);
      return res.body.notes[0]?.note as string | undefined;
    };
    expect(await note({ protein: 40 })).toMatch(/below the recommended allowance of 0\.8 g per kg/); // the allowance is 48 g
    expect(await note({ protein: 150 })).toMatch(/No authority sets an upper limit/);
    expect(await note({ protein: 90 })).toBeUndefined();
    expect(await note({ sodium: 2500 })).toMatch(/past the level where cutting back/);
    expect(await note({ sodium: 1200 })).toMatch(/under 1,500 mg/);
    expect(await note({ calcium: 3000 })).toMatch(/upper level of 2,500 mg/);
    expect(await note({ calcium: 1200 })).toBeUndefined();
    expect(await note({ fat: 400 })).toMatch(/Over the usual range/);
    expect(await note({ fiber: 45 })).toBeUndefined();
    // Every number above was saved as typed.
    const by = Object.fromEntries((await api('GET', '/me/goals', { userId, secret })).body.goals.map((g: any) => [g.key, g]));
    expect(by.protein).toMatchObject({ target: 90, custom: true, outsideBounds: false, bounds: { low: 48, high: 120 } });
    expect(by.sodium).toMatchObject({ target: 1200, custom: true, outsideBounds: true, bounds: { low: 1500, high: 2300 } });
    expect(by.fat).toMatchObject({ target: 400, custom: true, outsideBounds: true });
    // The targets screen shows the recommended value next to the typed one, with the warning.
    const targets = await api('GET', '/me/targets', { userId, secret });
    const sodium = targets.body.targets.find((t: any) => t.nutrient === 'sodium');
    expect(sodium).toMatchObject({ value: 1200, origin: 'custom', recommended: 2300, warning: expect.stringMatching(/under 1,500 mg/) });
    const protein = targets.body.targets.find((t: any) => t.nutrient === 'protein');
    expect(protein).toMatchObject({ value: 90, origin: 'custom', recommended: 60 });
    expect(protein.warning).toBeUndefined();
  });

  it('keeps a value saved outside the bounds, labels it, and resets with null', async () => {
    const { userId, secret } = await onboard();
    await env.DB.prepare(`INSERT INTO user_goals (user_id, nutrient, target) VALUES (?, 'calories', 1000)`).bind(userId).run();
    const res = await api('GET', '/me/goals', { userId, secret });
    const calories = res.body.goals.find((g: any) => g.key === 'calories');
    expect(calories).toMatchObject({ target: 1000, custom: true, outsideBounds: true, warning: expect.stringMatching(/^Under 1,200 kcal/) });
    expect(res.body.warnings).toEqual([{ nutrient: 'calories', id: 'below_floor', floor: 1200 }]);
    const reset = await api('PUT', '/me/goals', { userId, secret, body: { goals: { calories: null } } });
    expect(reset.body.goals.find((g: any) => g.key === 'calories')).toMatchObject({ target: 2150, custom: false });
  });

  it('accepts care-team numbers as typed, with only a typo guard, and only for a reference-only profile', async () => {
    const ref = await onboard({}, { clinicianDiet: true });
    const put = (goals: Record<string, number | null>) => api('PUT', '/me/goals', { userId: ref.userId, secret: ref.secret, body: { goals, origin: 'care_team' } });
    expect((await put({ calories: 1400, protein: 85, carbs: 150 })).status).toBe(200);
    expect((await put({ calories: 300 })).status).toBe(400);
    expect((await put({ calories: 7000 })).status).toBe(400);
    expect((await put({ protein: 5000 })).status).toBe(400);
    const goals = await api('GET', '/me/goals', { userId: ref.userId, secret: ref.secret });
    expect(goals.body.mode).toBe('reference_only');
    const by = Object.fromEntries(goals.body.goals.map((g: any) => [g.key, g]));
    expect(by.calories).toMatchObject({ target: 1400, origin: 'care_team' });
    expect(by.fiber).toMatchObject({ target: null, origin: null }); // no adult reference for someone under a clinician's diet
    // A personalised profile cannot type care-team numbers.
    const own = await onboard();
    expect((await api('PUT', '/me/goals', { userId: own.userId, secret: own.secret, body: { goals: { protein: 70 }, origin: 'care_team' } })).status).toBe(400);
  });
});

describe('weigh-ins (plan 6.2, 7.7)', () => {
  it('stores them, lists them and deletes one', async () => {
    const { userId, secret } = await onboard();
    const post = await api('POST', '/me/weights', { userId, secret, body: { date: '2026-09-20', weightKg: 61 } });
    expect(post.status).toBe(201);
    const list = await api('GET', '/me/weights', { userId, secret });
    expect(list.body.weights.map((w: any) => w.weightKg)).toEqual([61, 60]);
    expect((await api('GET', '/me/weights?from=2026-09-01&to=2026-09-30', { userId, secret })).body.weights).toEqual([{ date: '2026-09-20', weightKg: 61 }]);
    expect((await api('DELETE', '/me/weights/2026-09-20', { userId, secret })).status).toBe(204);
    expect((await api('DELETE', '/me/weights/2026-09-20', { userId, secret })).status).toBe(404);
  });

  it('adds a new target set only for a weight change over 3% or 2 kg, whichever is larger', async () => {
    const { userId, secret } = await onboard({ weightKg: 100, heightCm: 180 });
    // The profile's own today (Asia/Kolkata), not UTC's: they differ for five and a half hours a day.
    const today = localDateIn('Asia/Kolkata');
    const small = await api('POST', '/me/weights', { userId, secret, body: { date: today, weightKg: 102.9 } });
    expect(small.body.changed).toBe(false); // 3% of 100 kg is 3 kg
    expect(await count('target_sets', userId)).toBe(1);
    const big = await api('POST', '/me/weights', { userId, secret, body: { date: today, weightKg: 103.5, confirm: true } });
    expect(big.body.changed).toBe(true);
    expect(big.body.targetSet.inputs.weightKg).toBe(103.5);
    expect(await count('target_sets', userId)).toBe(2);
    // An older weigh-in never moves the targets.
    const old = await api('POST', '/me/weights', { userId, secret, body: { date: '2026-01-01', weightKg: 90 } });
    expect(old.body.changed).toBe(false);
  });

  it('asks for a re-check of a change over 3 kg from the day before', async () => {
    const { userId, secret } = await onboard();
    const today = localDateIn('Asia/Kolkata');
    const yesterday = addDays(today, -1);
    await api('POST', '/me/weights', { userId, secret, body: { date: yesterday, weightKg: 60 } });
    const jump = await api('POST', '/me/weights', { userId, secret, body: { date: today, weightKg: 66 } });
    expect(jump.status).toBe(409);
    expect(jump.body.error).toMatchObject({ code: 'weight_change_large', previousKg: 60 });
    expect((await api('POST', '/me/weights', { userId, secret, body: { date: today, weightKg: 66, confirm: true } })).status).toBe(201);
  });

  it('refuses a weight that does not look right, a future date, and weigh-ins for a reference-only profile', async () => {
    const { userId, secret } = await onboard();
    expect((await api('POST', '/me/weights', { userId, secret, body: { weightKg: 10 } })).body.error.field).toBe('weightKg');
    expect((await api('POST', '/me/weights', { userId, secret, body: { weightKg: 40 } })).status).toBe(400); // BMI 15.6 at 160 cm
    expect((await api('POST', '/me/weights', { userId, secret, body: { date: '2999-01-01', weightKg: 60 } })).body.error.field).toBe('date');
    const ref = await onboard({}, { eatingDisorder: true });
    expect((await api('POST', '/me/weights', { userId: ref.userId, secret: ref.secret, body: { weightKg: 60 } })).body.error.code).toBe('weights_not_available');
  });
});

describe('export and erasure (plan 8.3.3, 11.8)', () => {
  async function populated() {
    const p = await onboard();
    await api('PUT', '/me/goals', { userId: p.userId, secret: p.secret, body: { goals: { protein: 80 } } });
    await env.DB.prepare(`INSERT INTO day_status (user_id, local_date, status, updated_at) VALUES (?, '2026-10-05', 'skip', '2026-10-05T00:00:00Z')`).bind(p.userId).run();
    await api('POST', '/days/2026-10-05/items', { userId: p.userId, body: { items: [{ name: 'idli', quantity: 2, unit: 'piece' }] } });
    return p;
  }

  it('exports all and only the caller\'s health rows, with no secret hash', async () => {
    const a = await populated();
    const b = await populated();
    const res = await api('GET', '/me/export', { userId: a.userId, secret: a.secret });
    expect(res.status).toBe(200);
    expect(res.body.profile).toMatchObject({ target_mode: 'personalised', birth_year: 1996, height_cm: 160 });
    expect(res.body.profile.user_id).toBeUndefined();
    expect(res.body.targetSets).toHaveLength(1);
    expect(res.body.targetSets[0].inputs.inputs.heightCm).toBe(160);
    expect(res.body.weights).toHaveLength(1);
    expect(res.body.dayMarks).toEqual([{ date: '2026-10-05', status: 'skip', updatedAt: '2026-10-05T00:00:00Z' }]);
    expect(res.body.goals).toEqual([expect.objectContaining({ nutrient: 'protein', target: 80, origin: 'custom' })]);
    expect(res.text).not.toContain(b.userId);
    expect(res.text).not.toMatch(/secret_hash|webhook_token/);
  });

  it('DELETE /me/health-data erases the health tables and care-team numbers, and leaves the food log', async () => {
    const p = await populated();
    expect((await api('DELETE', '/me/health-data', { userId: p.userId, secret: p.secret })).status).toBe(204);
    for (const t of ['health_profiles', 'weight_entries', 'target_sets', 'day_status']) expect(await count(t, p.userId), t).toBe(0);
    expect(await count('log_items', p.userId)).toBe(1);
    // The profile and its secret remain, in generic mode, and a number the person typed for themselves stays.
    expect((await api('GET', '/me/profile', { userId: p.userId, secret: p.secret })).body.profile).toEqual({ mode: 'generic' });
    expect(await count('user_goals', p.userId)).toBe(1);
  });

  it('a plain DELETE FROM users fails because of the references: the reason the ordered batch exists', async () => {
    const p = await populated();
    await expect(env.DB.prepare('DELETE FROM users WHERE id = ?').bind(p.userId).run()).rejects.toThrow(/FOREIGN KEY/i);
  });

  it('DELETE /me removes the whole profile, in order, and nulls the names on shared foods', async () => {
    const p = await populated();
    const other = await populated();
    const food = (await api('POST', '/foods', { userId: p.userId, body: { displayName: unique('erase test food'), baseUnit: 'katori', nutrients: { calories: 100 } } })).body.food;
    await env.DB.prepare(`INSERT INTO calls (user_id, local_date, kind, status, transcript, created_at, updated_at) VALUES (?, '2026-10-05', 'test', 'failed', 'a transcript', 't', 't')`).bind(p.userId).run();
    expect((await api('DELETE', '/me', { userId: p.userId, secret: p.secret })).status).toBe(204);
    for (const t of ['users']) expect((await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE id = ?`).bind(p.userId).first<{ c: number }>())!.c).toBe(0);
    for (const t of ['health_profiles', 'weight_entries', 'target_sets', 'day_status', 'log_items', 'calls', 'user_goals']) expect(await count(t, p.userId), t).toBe(0);
    // The shared food stays, without a name on it.
    const row = await env.DB.prepare('SELECT added_by FROM foods WHERE id = ?').bind(food.id).first<{ added_by: string | null }>();
    expect(row).toEqual({ added_by: null });
    // Nothing references the user any more, and the other person is untouched.
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect(await count('health_profiles', other.userId)).toBe(1);
    expect((await api('GET', '/profiles')).body.profiles.map((x: any) => x.id)).not.toContain(p.userId);
    expect((await api('GET', '/me/settings', { userId: p.userId })).status).toBe(404);
  });
});

describe('display-only changes', () => {
  it('toggles low-pressure mode without recomputing anything', async () => {
    const { userId, secret } = await onboard();
    const sets = await count('target_sets', userId);
    const on = await api('PUT', '/me/profile', { userId, secret, body: { profile: { numbersHidden: true } } });
    expect(on.body.profile.numbersHidden).toBe(true);
    expect(await count('target_sets', userId)).toBe(sets);
    expect((await api('PUT', '/me/profile', { userId, secret, body: { profile: { numbersHidden: false } } })).body.profile.numbersHidden).toBe(false);
    expect((await api('PUT', '/me/profile', { userId, secret, body: {} })).status).toBe(400);
  });

  it('needs a profile first', async () => {
    const p = await createProfileWithSecret();
    const res = await api('PUT', '/me/profile', { userId: p.userId, secret: p.secret, body: { profile: { numbersHidden: true }, consentVersion: CONSENT } });
    expect(res.body.error.code).toBe('profile_required');
  });
});
