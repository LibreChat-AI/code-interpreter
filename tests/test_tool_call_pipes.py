import unittest
from unittest.mock import patch

from tool_call_pipes import wait_for_killed_descendant


class DescendantReapingTest(unittest.TestCase):
    def test_already_reaped_by_parent(self):
        with patch('tool_call_pipes.os.waitpid', side_effect=ChildProcessError), \
             patch('tool_call_pipes.os.path.exists', return_value=False):
            wait_for_killed_descendant(123)

    def test_waits_for_adoption(self):
        with patch('tool_call_pipes.os.waitpid', side_effect=[ChildProcessError, (123, 9)]), \
             patch('tool_call_pipes.os.path.exists', return_value=True), \
             patch('tool_call_pipes.time.sleep'):
            wait_for_killed_descendant(123)

    def test_rejects_wrong_exit_status(self):
        with patch('tool_call_pipes.os.waitpid', return_value=(123, 0)):
            with self.assertRaises(AssertionError):
                wait_for_killed_descendant(123)

    def test_live_nonchild_still_fails_at_deadline(self):
        with patch('tool_call_pipes.os.waitpid', side_effect=ChildProcessError), \
             patch('tool_call_pipes.os.path.exists', return_value=True), \
             patch('tool_call_pipes.time.monotonic', side_effect=[0, 0, 6]), \
             patch('tool_call_pipes.time.sleep'), \
             patch('tool_call_pipes.os.kill') as kill:
            with self.assertRaisesRegex(AssertionError, 'orphan survived'):
                wait_for_killed_descendant(123)
            kill.assert_called_once_with(123, 9)


if __name__ == '__main__':
    unittest.main()
