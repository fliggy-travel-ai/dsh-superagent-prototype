# 可在个人云环境变量中设置 PASEO_CLOUD_SESSION_FALLBACK_CWD，作为 Mac 侧的备用目录。
# 发布时替换这两个值。
PASEO_CLOUD_URL='OSS_URL_PLACEHOLDER'
PASEO_CLOUD_SHA256='SHA256_PLACEHOLDER'
(
  tmp=$(mktemp) || exit 0
  trap 'rm -f "$tmp"' EXIT
  if ! curl -fsSL --max-time 60 --retry 2 "$PASEO_CLOUD_URL" -o "$tmp"; then
    echo '警告：云端程序下载失败。' >&2
    exit 0
  fi
  actual=$(sha256sum "$tmp" | cut -d ' ' -f 1)
  if [ "$actual" != "$PASEO_CLOUD_SHA256" ]; then
    echo '警告：云端程序 SHA-256 不匹配，未安装。' >&2
    exit 0
  fi
  mkdir -p /opt/paseo-cloud-session || exit 0
  install -m 755 "$tmp" /opt/paseo-cloud-session/paseo-cloud-session.mjs || exit 0
  node /opt/paseo-cloud-session/paseo-cloud-session.mjs install-claude-config || echo '警告：Claude 配置安装失败。' >&2
)
