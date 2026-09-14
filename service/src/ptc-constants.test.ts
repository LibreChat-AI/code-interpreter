import { expect, test } from 'bun:test';
import { isReservedPtcFilename } from './ptc-constants';

test('reserves replay inputs and output control channels after normalization', () => {
  for (const name of ['_ptc_history.json', '_ptc_pending_result.json', '_PTC_PENDING_RESULT.JSON', 'sub/../_ptc_pending_result.json', 'sub\\_ptc_pending_result.json']) {
    expect(isReservedPtcFilename(name)).toBe(true);
  }
  expect(isReservedPtcFilename('_ptc_data.csv')).toBe(false);
});
