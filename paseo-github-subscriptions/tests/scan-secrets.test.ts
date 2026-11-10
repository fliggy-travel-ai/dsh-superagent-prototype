import test from 'node:test';
import assert from 'node:assert/strict';
import { scanText } from '../scripts/scan-secrets.ts';

// 测试数据用拼接构造，避免本文件自己被扫描命中。
const relay = 'private' + 'relay';
const gh = 'gh' + 'p_';

test('真实邮箱命中，示例域名和测试域名放行', () => {
  assert.deepEqual(scanText('a.ts', 'contact: jane.doe@gmail.com').map(f => f.kind), ['邮箱']); // scan-allow: 扫描测试数据
  assert.deepEqual(scanText('a.ts', 'old-ext@example.com user@foo.invalid x@y.test noreply@users.noreply.github.com'), []);
});

test('Apple 隐藏邮箱总是命中', () => {
  assert.deepEqual(scanText('a.md', `abc@${relay}.appleid.com`).map(f => f.kind).sort(), ['Apple 隐藏邮箱', '邮箱']);
  assert.deepEqual(scanText('a.md', `说明 ${relay} 的处理`).map(f => f.kind), ['Apple 隐藏邮箱']);
});

test('真实格式的令牌命中，测试占位令牌放行', () => {
  assert.deepEqual(scanText('a.ts', `const t = '${gh}Q7w9ZkP2mN4xR8vT1yB6cD3fG5hJ0kL2nP4q';`).map(f => f.kind), ['GitHub 令牌']);
  assert.deepEqual(scanText('a.ts', `'${gh}supersecrettokenvalue' '${gh}daemonintegrationtesttoken0000000000' '${gh}abcdefghijklmnopqrstuvwxyz0123456789'`), []);
  assert.deepEqual(scanText('a.ts', `'github_pat_TEST_SECRET_NOT_REAL'`), []);
  assert.deepEqual(scanText('a.ts', `key = "sk-ant-api03-Zq8vN2mK7pL4xR9tW1yB5cD"`).map(f => f.kind), ['API 密钥']); // scan-allow: 扫描测试数据
  assert.deepEqual(scanText('a.ts', `slack ${'xox' + 'b-'}9081726354-Qm7rTz2Kp4Wn`).map(f => f.kind), ['Slack 令牌']);
});

test('webhook 地址命中，示例域名放行', () => {
  assert.deepEqual(scanText('a.json', '"url": "https://hooks.slack.com/services/T000/B000/XXXX"').map(f => f.kind), ['webhook 地址']); // scan-allow: 扫描测试数据
  assert.deepEqual(scanText('a.json', '"url": "https://open.feishu.cn/open-apis/bot/v2/hook/abc"').map(f => f.kind), ['webhook 地址']); // scan-allow: 扫描测试数据
  assert.deepEqual(scanText('a.json', 'https://hooks.example.net/path?key=secret http://127.0.0.1:8787/hook'), []);
  assert.deepEqual(scanText('a.md', 'https://github.com/fliggy-travel-ai/deepseek-harness/issues/1737'), []);
});

test('行内 scan-allow 标记放行这一行；锁文件不查邮箱', () => {
  assert.deepEqual(scanText('a.ts', 'jane.doe@gmail.com // scan-allow: 上游作者'), []);
  assert.deepEqual(scanText('package-lock.json', '"author": "i@izs.me"'), []); // scan-allow: 扫描测试数据
});

test('结果给出行号，不包含命中的原文', () => {
  const [finding] = scanText('a.ts', `line1\nconst t = '${gh}Q7w9ZkP2mN4xR8vT1yB6cD3fG5hJ0kL2nP4q';`);
  assert.equal(finding!.line, 2);
  assert.ok(!JSON.stringify(finding).includes('Q7w9ZkP2'));
});
