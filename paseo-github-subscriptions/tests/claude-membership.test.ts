import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MembershipStore, membershipDetail } from '../server/modules/usage-claude-accounts/membership.ts';

function check(day: number, time: string, now: string, expected: string, tone: string) {
  const detail = membershipDetail({ day, time }, Date.parse(now));
  assert.deepEqual(detail, { id: 'membership_renewal', label: '会员到期', value: expected, tone });
}

test('续费按北京时间跨月、跨年，缺日时使用该月最后一天', () => {
  check(9, '20:15', '2026-11-28T09:15:00Z', '12-09 20:15（剩 11天3小时）', 'default');
  check(9, '20:15', '2026-12-08T09:15:00Z', '12-09 20:15（剩 1天3小时）', 'warning');
  check(9, '20:15', '2026-12-09T12:15:01Z', '01-09 20:15（剩 30天23小时）', 'default');
  check(31, '00:15', '2026-04-29T16:00:00Z', '04-30 00:15（剩 15分）', 'danger');
  check(31, '00:15', '2026-04-29T16:20:00Z', '05-31 00:15（剩 30天23小时）', 'default');
  check(31, '20:15', '2026-01-31T12:16:00Z', '02-28 20:15（剩 27天23小时）', 'default');
  check(31, '20:15', '2028-02-29T10:11:00Z', '02-29 20:15（剩 2小时4分）', 'danger');
});

test('分钟、小时和天按完整单位显示，变色按准确剩余时间判定', () => {
  check(9, '20:15', '2026-12-06T12:15:00Z', '12-09 20:15（剩 3天0小时）', 'default');
  check(9, '20:15', '2026-12-06T12:15:01Z', '12-09 20:15（剩 2天23小时）', 'warning');
  check(9, '20:15', '2026-12-08T12:15:00Z', '12-09 20:15（剩 1天0小时）', 'warning');
  check(9, '20:15', '2026-12-08T12:15:01Z', '12-09 20:15（剩 23小时59分）', 'danger');
  check(9, '20:15', '2026-12-09T11:15:00Z', '12-09 20:15（剩 1小时0分）', 'danger');
  check(9, '20:15', '2026-12-09T11:15:01Z', '12-09 20:15（剩 59分）', 'danger');
  check(9, '20:15', '2026-12-09T12:15:00Z', '12-09 20:15（剩 0分）', 'danger');
  assert.equal(membershipDetail(undefined), undefined);
});

test('按账号保存和清除，损坏或读不到文件时拒绝写入并保留原内容', t => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-membership-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const quota = join(dir, 'quota');
  const path = join(quota, 'membership-renewals.json');
  const store = new MembershipStore(quota);
  const first = 'local@example.invalid'; // scan-allow
  const second = 'isolated@example.invalid'; // scan-allow
  assert.deepEqual(store.read(), {});
  assert.equal(store.detail(first), undefined);
  store.set(first, { day: 31, time: '20:15' });
  store.set(second, { day: 1, time: '01:02' });
  assert.equal(statSync(quota).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(new MembershipStore(quota).read()[first]?.day, 31);
  store.set(first, null);
  assert.deepEqual(store.read(), { [second]: { day: 1, time: '01:02' } });

  for (const invalid of ['{', JSON.stringify({ [second]: { day: 32, time: '20:15' } })]) {
    writeFileSync(path, invalid);
    assert.throws(() => store.read(), /格式无效/);
    assert.throws(() => store.set(first, { day: 1, time: '00:00' }), /格式无效/);
    assert.throws(() => store.set(second, null), /格式无效/);
    assert.equal(readFileSync(path, 'utf8'), invalid);
  }
  rmSync(path);
  mkdirSync(path);
  assert.throws(() => store.set(first, { day: 1, time: '00:00' }), /无法读取/);
  assert.ok(statSync(path).isDirectory());
});
