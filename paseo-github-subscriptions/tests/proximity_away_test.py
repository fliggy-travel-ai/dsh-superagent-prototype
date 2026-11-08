import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('proximity', Path(__file__).parents[1] / 'scripts/proximity-away.py')
proximity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proximity)


class ProximityTest(unittest.TestCase):
    def setUp(self):
        self.target = {'name': '随身手机', 'address': None, 'revision': 'first'}

    def sample(self, state, now, signal=-60, target=None, **values):
        return proximity.advance(state, target or self.target, signal, signal is not None, now, state.get('flag', '0'), **values)

    def test_same_flag_acquires_new_owner_after_hold(self):
        state = {}
        for now in (1000, 1030, 1060):
            state = self.sample(state, now)
        self.assertEqual(state['flag'], '0')
        self.assertEqual(state['flag_target'], self.target)

    def test_target_revision_resets_hold_and_previous_owner(self):
        old = dict(self.target, revision='older')
        state = {'target': old, 'flag_target': old, 'flag': '1', 'near_since': 900, 'sampled_at': 990}
        state = self.sample(state, 1000)
        self.assertEqual(state['near_since'], 1000)
        self.assertEqual(state['flag_target'], old)
        state = self.sample(state, 1030, target=dict(self.target, name='另一手机', revision='second'))
        state = self.sample(state, 1060, target=dict(self.target, revision='third'))
        self.assertEqual(state['near_since'], 1060)
        self.assertEqual(state['flag'], '1')

    def test_missing_signal_and_intermediate_signal_reset_hold(self):
        state = self.sample({}, 1000)
        state = self.sample(state, 1030, signal=None)
        self.assertIsNone(state['near_since'])
        state = self.sample(state, 1060)
        self.assertNotIn('flag_target', state)
        state = self.sample(state, 1090, signal=-83)
        self.assertIsNone(state['near_since'])
        state = self.sample(state, 1120, target_error='配置损坏')
        self.assertIsNone(state['near_since'])

    def test_manual_override_survives_device_change(self):
        state = proximity.advance({}, self.target, None, False, 1000, '1', manual=True)
        for now in (1030, 1060, 1090):
            state = self.sample(state, now, target=dict(self.target, revision='second'))
        self.assertTrue(state['forced_away'])
        self.assertEqual(state['flag'], '1')
        state = proximity.advance(state, self.target, -95, True, 1120, '0', manual=True)
        for now in (1150, 1180, 1210, 1240):
            state = self.sample(state, now, signal=-95)
        self.assertEqual(state['flag'], '0')
        self.assertFalse(state['forced_away'])

    def test_exact_name_address_and_ambiguity(self):
        devices = proximity.parse_devices({'SPBluetoothDataType': [{'device_connected': [
            {'随身手机': {'device_address': 'aa-bb-cc-dd-ee-01', 'device_rssi': '-65'}},
            {'随身手机': {'device_address': 'aa-bb-cc-dd-ee-02', 'device_rssi': '-95'}},
            {'随身手机 Pro': {'device_rssi': '-60'}},
            {'同名耳机': {}}, {'同名耳机': {}}
        ]}]})
        self.assertEqual(len(devices), 5)
        self.assertFalse(proximity.match_device(self.target, devices)[1])
        self.assertEqual(proximity.match_device(dict(self.target, address='AA:BB:CC:DD:EE:02'), devices)[:2], (-95, True))
        self.assertFalse(proximity.match_device(dict(self.target, address='AA:BB:CC:DD:EE:03'), devices)[1])
        self.assertFalse(proximity.match_device(dict(self.target, name='随身'), devices)[1])

    def test_invalid_config_keeps_previous_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'proximity-target.json'
            path.write_text(json.dumps(self.target))
            self.assertEqual(proximity.read_target(root, None), (self.target, None))
            for text in ('{broken', 'x' * 4097, json.dumps(dict(self.target, name='bad\nname'))):
                path.write_text(text)
                target, error = proximity.read_target(root, self.target)
                self.assertEqual(target, self.target)
                self.assertIsNotNone(error)


if __name__ == '__main__':
    unittest.main()
