#!/usr/bin/env python3
import json
import math
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

DIRECTORY = Path.home() / '.claude-guard'
NEAR_RSSI = int(os.environ.get('PROX_NEAR', '-78'))
FAR_RSSI = int(os.environ.get('PROX_FAR', '-88'))
FAR_HOLD = int(os.environ.get('PROX_FAR_HOLD', '120'))
NEAR_HOLD = int(os.environ.get('PROX_NEAR_HOLD', '60'))
POLL = int(os.environ.get('PROX_POLL', '30'))
MANUAL_OVERRIDE = int(os.environ.get('PROX_MANUAL_OVERRIDE', '1800'))


def default_target():
    return {'name': os.environ.get('PROX_DEVICE', '贝贝猫的iPhone'), 'address': None, 'revision': 'legacy'}


def read_target(directory, previous):
    try:
        with (directory / 'proximity-target.json').open('rb') as stream:
            contents = stream.read(4097)
        if len(contents) > 4096:
            raise ValueError('设备配置过大')
        target = json.loads(contents)
        name = target.get('name')
        address = target.get('address')
        revision = target.get('revision')
        if not isinstance(name, str) or not name.strip() or len(name) > 200 or re.search(r'[\x00-\x1f\x7f]', name):
            raise ValueError('设备名称无效')
        if address is not None and (not isinstance(address, str) or not re.fullmatch(r'(?:[0-9A-F]{2}:){5}[0-9A-F]{2}', address)):
            raise ValueError('设备地址无效')
        if not isinstance(revision, str) or not 1 <= len(revision) <= 100:
            raise ValueError('设备配置版本无效')
        return {'name': name.strip(), 'address': address, 'revision': revision}, None
    except FileNotFoundError:
        return default_target(), None
    except (OSError, ValueError, TypeError, AttributeError):
        return previous or default_target(), '设备配置读取失败，保留上次目标'


def parse_devices(report):
    devices = []
    for controller in report['SPBluetoothDataType']:
        for category in ('device_connected', 'device_not_connected'):
            for entry in controller.get(category, []):
                for name, properties in entry.items():
                    address = properties.get('device_address')
                    address = address.replace('-', ':').upper() if isinstance(address, str) else None
                    signal = properties.get('device_rssi')
                    try:
                        signal = float(signal) if not isinstance(signal, bool) else None
                        if signal is not None and (not math.isfinite(signal) or not -127 <= signal < 0):
                            signal = None
                    except (TypeError, ValueError):
                        signal = None
                    device = {'name': name, 'address': address, 'rssi': signal, 'connected': category == 'device_connected'}
                    previous = next((item for item in devices if address and item['address'] == address), None)
                    if previous is None:
                        devices.append(device)
                    elif device['connected']:
                        previous.update(device)
    return devices


def match_device(target, devices):
    matches = [device for device in devices if device['address'] == target['address']] if target['address'] else [device for device in devices if device['name'] == target['name']]
    if len(matches) > 1:
        return None, False, '同名设备有多台，请按地址选择'
    if not matches:
        return None, False, '未发现所选设备'
    return matches[0]['rssi'], True, None if matches[0]['rssi'] is not None else '设备没有可用信号强度'


def sample_rssi(target):
    try:
        output = subprocess.run(['/usr/sbin/system_profiler', 'SPBluetoothDataType', '-json'], capture_output=True, text=True, timeout=22, check=True)
        return match_device(target, parse_devices(json.loads(output.stdout)))
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError, AttributeError):
        return None, False, '蓝牙采样失败'


def advance(previous, target, rssi, seen, now, flag, manual=False, target_error=None):
    state = dict(previous)
    if state.get('target') != target or now - state.get('sampled_at', 0) > POLL + 25:
        state.update(near_since=None, far_since=None)
    state.update(target=target, rssi=rssi, seen=seen, flag=flag, sampled_at=now, target_error=target_error)
    state.setdefault('forced_away', False)
    state.setdefault('override_until', 0)
    if manual:
        state.update(forced_away=flag == '1', override_until=now + MANUAL_OVERRIDE)
    if not target_error and seen and rssi is not None and rssi >= NEAR_RSSI:
        state['near_since'] = state.get('near_since') if state.get('near_since') is not None else now
        state['far_since'] = None
    elif not target_error and seen and rssi is not None and rssi <= FAR_RSSI:
        state['far_since'] = state.get('far_since') if state.get('far_since') is not None else now
        state['near_since'] = None
    else:
        state.update(near_since=None, far_since=None)
    if not state['forced_away'] and state['override_until'] <= now:
        if state.get('far_since') is not None and now - state['far_since'] >= FAR_HOLD:
            state.update(flag='1', flag_target=dict(target))
        elif state.get('near_since') is not None and now - state['near_since'] >= NEAR_HOLD:
            state.update(flag='0', flag_target=dict(target))
    state['updated'] = datetime.fromtimestamp(now, timezone.utc).isoformat()
    return state


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as stream:
        json.dump(value, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def read_flag(path):
    try:
        return path.read_text().strip(), path.stat().st_mtime_ns
    except OSError:
        return '0', 0


def main():
    DIRECTORY.mkdir(mode=0o700, parents=True, exist_ok=True)
    state_path = DIRECTORY / 'proximity-state.json'
    flag_path = DIRECTORY / 'auto-answer.flag'
    try:
        state = json.loads(state_path.read_text())
        if not isinstance(state, dict):
            state = {}
    except (OSError, ValueError):
        state = {}
    state.update(near_since=None, far_since=None)
    previous_flag, previous_mtime = read_flag(flag_path)
    while True:
        target, target_error = read_target(DIRECTORY, state.get('target'))
        rssi, seen, sample_error = sample_rssi(target)
        now = time.time()
        flag, modified = read_flag(flag_path)
        manual = flag != previous_flag or modified != previous_mtime
        state = advance(state, target, rssi, seen, now, flag, manual, target_error)
        state['sample_error'] = sample_error
        if state['flag'] != flag:
            flag_path.write_text(state['flag'] + '\n')
        previous_flag, previous_mtime = read_flag(flag_path)
        atomic_json(state_path, state)
        with (DIRECTORY / 'proximity.log').open('a') as stream:
            stream.write(json.dumps({'at': state['updated'], 'event': 'proximity', 'rssi': rssi, 'seen': seen, 'flag': state['flag'], 'error': target_error or sample_error}, ensure_ascii=False) + '\n')
        time.sleep(POLL)


if __name__ == '__main__':
    main()
