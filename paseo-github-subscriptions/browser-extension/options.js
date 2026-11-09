const status = document.getElementById('status');
const approval = document.getElementById('approvalEnabled');
chrome.storage.local.get('approvalEnabled').then(data => { approval.checked = data.approvalEnabled === true; });
approval.addEventListener('change', async () => {
  await chrome.storage.local.set({ approvalEnabled: approval.checked });
  status.textContent = approval.checked ? '自动点同意已开启' : '自动点同意已暂停';
});
chrome.storage.local.get(['instanceName', 'adspowerProfile']).then(data => {
  document.getElementById('instanceName').value = data.instanceName || '未命名浏览器环境';
  const profileInput = document.getElementById('adspowerProfile');
  if (profileInput) profileInput.value = data.adspowerProfile || '';
});
document.getElementById('name').addEventListener('submit', async event => {
  event.preventDefault();
  const instanceName = document.getElementById('instanceName').value.trim();
  const adspowerProfile = (document.getElementById('adspowerProfile')?.value || '').trim();
  if (!instanceName || instanceName.length > 120 || adspowerProfile.length > 120) { status.textContent = '环境名称无效'; return; }
  await chrome.storage.local.set({ instanceName, ...(adspowerProfile ? { adspowerProfile } : {}) });
  if (!adspowerProfile) await chrome.storage.local.remove('adspowerProfile');
  status.textContent = '环境名称已保存';
});
document.getElementById('pair').addEventListener('submit', async event => {
  event.preventDefault();
  const url = document.getElementById('url').value.trim(), token = document.getElementById('token').value.trim();
  const match = url.match(/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/sync$/);
  if (!match || Number(match[1]) > 65535 || !/^[a-f0-9]{64}$/.test(token)) { status.textContent = '配对信息格式无效'; return; }
  await chrome.storage.local.set({ pairing: { url, token } });
  document.getElementById('token').value = ''; status.textContent = '配对已保存';
});
document.getElementById('clear').addEventListener('click', async () => {
  await chrome.storage.local.remove('pairing');
  await chrome.storage.local.set({ approvalEnabled: false, syncFailureSince: null });
  approval.checked = false;
  status.textContent = '配对已解除';
});
document.getElementById('resetIdentity').addEventListener('click', async () => {
  if (!confirm('重置后本环境将不再使用原身份的会话绑定。确定重置？')) return;
  await chrome.storage.local.set({ instanceId: crypto.randomUUID(), groups: {} });
  status.textContent = '浏览器环境身份已重置，原绑定不再适用于本环境';
});
